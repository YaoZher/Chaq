const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { createRequest, resolveBillingConfig, runBillingE2E } = require("./e2e-agent-contact-billing");

const testEnv = { CHAQ_E2E_BILLING_USER: "billing-test" };

function fixture(options = {}) {
  const existingProvider = { id: "existing-provider", name: "Existing provider", apiKey: "existing-test-secret", enabled: true };
  const existingAgent = { id: "existing-agent", name: "Existing agent", handle: "existing", status: "active" };
  const initialProvider = structuredClone(existingProvider);
  const initialAgent = structuredClone(existingAgent);
  const state = { calls: [], provider: null, agent: null, contact: false, billed: false, mockStarts: 0, mockCloses: 0, logouts: [] };
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/api/, "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    const method = init.method || "GET";
    const token = init.headers["x-session-token"];
    const call = { path, method, token, body, redirect: init.redirect };
    state.calls.push(call);
    if (options.failBefore) options.failBefore(call, state);
    let result;
    if (path === "/auth/login") {
      const admin = body.username === (options.adminUser || "admin");
      if (!admin && options.loginFailure) throw new Error("Caller login failed.");
      result = {
        sessionToken: admin ? "admin-session" : "caller-session",
        user: { id: admin ? "admin-id" : (options.callerId || "caller-id"), role: admin ? (options.adminRole || "ADMIN") : (options.callerRole || "USER"), tokenBalance: options.balance ?? 100 }
      };
    } else if (path === "/auth/logout") {
      state.logouts.push(token);
      result = { ok: true };
    } else if (path === "/models/admin/providers" && method === "POST") {
      assert.equal(body.id, undefined, "Provider creation must never include an existing id.");
      state.provider = { ...body, id: "billing-provider" };
      if (options.dropProviderResponse) throw new Error("Lost provider response.");
      result = state.provider;
    } else if (path === "/models/admin/providers") {
      result = [existingProvider, ...(state.provider ? [state.provider] : [])];
    } else if (path === "/models/admin/providers/billing-provider/status") {
      assert.deepEqual(body, { enabled: false }, "Cleanup must only change enabled state.");
      if (options.disableFailure) throw new Error("Provider disable failed.");
      state.provider.enabled = false;
      result = state.provider;
    } else if (path === "/agents" && method === "POST") {
      assert.equal(body.modelProviderId, "billing-provider");
      assert.equal(body.model, state.provider.models[0].id);
      state.agent = { ...body, id: "billing-agent", status: "active" };
      if (options.dropAgentResponse) throw new Error("Lost agent response.");
      result = state.agent;
    } else if (path === "/agents") {
      result = [existingAgent, ...(state.agent ? [state.agent] : [])];
    } else if (path === "/agents/billing-agent" && method === "POST") {
      assert.deepEqual(body, { status: "archived" });
      if (options.archiveFailure) throw new Error("Agent archive failed.");
      state.agent.status = body.status;
      state.contact = false;
      result = state.agent;
    } else if (path === "/agents/billing-agent/contact") {
      state.contact = true;
      if (options.contactFailure) throw new Error("Lost contact response.");
      result = { ok: true };
    } else if (path === "/agents/billing-agent/contact/remove") {
      if (!state.contact) return new Response(JSON.stringify({ message: "Agent contact not found." }), { status: 404 });
      if (options.contactRemoveFailure) throw new Error("Contact removal failed.");
      state.contact = false;
      result = { ok: true };
    } else if (path === "/conversations/with-agent/billing-agent") {
      result = { id: "billing-conversation" };
    } else if (path === "/conversations/billing-conversation/messages" && method === "POST") {
      state.billed = true;
      result = { id: "caller-message" };
    } else if (path === "/conversations/billing-conversation/messages") {
      result = options.noReply ? [] : [{ authorKind: "agent", content: "Contact and billing flow verified." }];
    } else if (path === "/users/me") {
      const balanceChange = state.billed ? (token === "admin-session" ? 7 : -(options.debit ?? 8)) : 0;
      result = { tokenBalance: (options.balance ?? 100) + balanceChange };
    } else if (path === "/users/me/wallet") {
      result = token === "admin-session" ? { agentEarnings: [{ agentId: "billing-agent", amount: 7 }] } : { serviceFeesPaid: 7 };
    } else if (path === "/agents/contacts") {
      result = state.contact ? [{ agent: state.agent }] : [];
    } else if (path === "/agents/discover") {
      result = [{ ...state.agent, isContact: state.contact }];
    } else {
      assert.fail(`Unexpected API request: ${method} ${path}`);
    }
    return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
  };
  return {
    state,
    run: (env = {}) => runBillingE2E({
      env: { ...testEnv, ...env },
      fetchImpl,
      startMockModelImpl: async () => {
        state.mockStarts += 1;
        return { baseUrl: "http://127.0.0.1:43119/v1", close: async () => { state.mockCloses += 1; } };
      }
    }),
    assertUnrelatedUnchanged() {
      assert.deepEqual(existingProvider, initialProvider);
      assert.deepEqual(existingAgent, initialAgent);
      assert.equal(state.calls.some((call) => call.path.includes("existing-provider") || call.path.includes("existing-agent")), false);
    }
  };
}

function assertCleaned(state) {
  assert.equal(state.provider.enabled, false);
  assert.equal(state.agent.status, "archived");
  assert.equal(state.contact, false);
  assert.equal(state.mockCloses, 1);
  assert.deepEqual(state.logouts, ["caller-session", "admin-session"]);
}

test("billing config rejects production, remote targets, missing caller and invalid timeouts before requests", async () => {
  const f = fixture();
  await assert.rejects(f.run({ NODE_ENV: "production" }), /NODE_ENV=production/);
  await assert.rejects(f.run({ CHAQ_E2E_SERVER_URL: "https://other.example/api", CHAQ_ALLOW_REMOTE_E2E: "1" }), /requires a loopback/);
  await assert.rejects(f.run({ CHAQ_E2E_BILLING_USER: " " }), /existing non-admin/);
  await assert.rejects(f.run({ CHAQ_E2E_REQUEST_TIMEOUT_MS: "invalid" }), /timeouts must be positive/);
  await assert.rejects(f.run({ CHAQ_E2E_TIMEOUT_MS: "Infinity" }), /timeouts must be positive/);
  assert.equal(f.state.calls.length, 0);
  assert.equal(f.state.mockStarts, 0);
  assert.equal(resolveBillingConfig({ ...testEnv, CHAQ_E2E_SERVER_URL: "http://[::1]:24537/api/" }).baseUrl, "http://[::1]:24537/api");
});

test("billing workflow uses a fresh provider and model and preserves all existing resources", async () => {
  const f = fixture({ adminUser: "test-admin" });
  const result = await f.run({ CHAQ_E2E_USERNAME: "test-admin", CHAQ_E2E_PASSWORD: "admin-test-password", CHAQ_E2E_BILLING_PASSWORD: "caller-test-password" });
  assert.deepEqual(result, { ok: true, agentId: "billing-agent", conversationId: "billing-conversation", userDebit: 8, adminCredit: 7, walletEarning: 7 });
  assertCleaned(f.state);
  f.assertUnrelatedUnchanged();
  const providerCreates = f.state.calls.filter((call) => call.path === "/models/admin/providers");
  assert.equal(providerCreates.length, 1, "A successful run neither selects nor rewrites any existing provider.");
  assert.equal(providerCreates[0].method, "POST");
  assert.match(f.state.provider.name, /^Billing E2E [a-f0-9]{32}$/);
  assert.match(f.state.provider.models[0].id, /^chaq-billing-[a-f0-9]{32}$/);
  assert.equal(f.state.calls.every((call) => call.redirect === "error"), true);
  const logins = f.state.calls.filter((call) => call.path === "/auth/login");
  assert.deepEqual(logins.map((call) => call.body), [{ username: "test-admin", password: "admin-test-password" }, { username: "billing-test", password: "caller-test-password" }]);
});

test("consecutive billing runs use different provider names and models", async () => {
  const first = fixture();
  const second = fixture();
  await first.run();
  await second.run();
  assert.notEqual(first.state.provider.name, second.state.provider.name);
  assert.notEqual(first.state.provider.models[0].id, second.state.provider.models[0].id);
  assert.notEqual(first.state.agent.handle, second.state.agent.handle);
});

test("caller login failure revokes the admin session without creating a mock or provider", async () => {
  const f = fixture({ loginFailure: true });
  await assert.rejects(f.run(), /Caller login failed/);
  assert.equal(f.state.mockStarts, 0);
  assert.equal(f.state.provider, null);
  assert.deepEqual(f.state.logouts, ["admin-session"]);
});

test("billing refuses invalid account roles, shared identity and insufficient reservation funds before creating resources", async () => {
  for (const options of [{ adminRole: "USER" }, { callerRole: "ADMIN" }, { callerId: "admin-id" }, { balance: 8 }, { balance: 47 }]) {
    const f = fixture(options);
    await assert.rejects(f.run(), /test account|at least 48 test tokens/);
    assert.equal(f.state.mockStarts, 0);
    assert.equal(f.state.provider, null);
    assert.ok(f.state.logouts.includes("admin-session"));
    f.assertUnrelatedUnchanged();
  }
});

test("48 test tokens cover the model reservation while the expected final debit remains 8", async () => {
  const f = fixture({ balance: 48 });
  const result = await f.run();
  assert.equal(result.userDebit, 8);
  assert.equal(result.adminCredit, 7);
  assert.equal(f.state.provider.contextWindow, 4096);
  assert.equal(f.state.provider.promptTokenPrice, 0.01);
  assert.equal(f.state.provider.completionTokenPrice, 0.01);
  assertCleaned(f.state);
});

test("a provider created before its response is lost is recovered by this run's unique identity and disabled", async () => {
  const f = fixture({ dropProviderResponse: true });
  await assert.rejects(f.run(), /Lost provider response/);
  assert.equal(f.state.provider.enabled, false);
  assert.equal(f.state.agent, null);
  assert.equal(f.state.mockCloses, 1);
  assert.deepEqual(f.state.logouts, ["caller-session", "admin-session"]);
  f.assertUnrelatedUnchanged();
});

test("an agent created before its response is lost is recovered and archived", async () => {
  const f = fixture({ dropAgentResponse: true });
  await assert.rejects(f.run(), /Lost agent response/);
  assertCleaned(f.state);
  f.assertUnrelatedUnchanged();
});

test("a contact created before its response is lost is still removed", async () => {
  const f = fixture({ contactFailure: true });
  await assert.rejects(f.run(), /Lost contact response/);
  assertCleaned(f.state);
  f.assertUnrelatedUnchanged();
});

test("runtime and balance validation failures both clean every created resource", async () => {
  for (const options of [
    { failBefore: (call) => { if (call.path === "/conversations/billing-conversation/messages" && call.method === "POST") throw new Error("Worker unavailable."); } },
    { debit: 9 }
  ]) {
    const f = fixture(options);
    await assert.rejects(f.run(), /Worker unavailable|Expected caller debit 8/);
    assertCleaned(f.state);
    f.assertUnrelatedUnchanged();
  }
});

test("a polling timeout cleans the provider, agent, contact, listener and sessions", async () => {
  const f = fixture({ noReply: true });
  await assert.rejects(f.run({ CHAQ_E2E_TIMEOUT_MS: "1" }), /waiting for the billing reply/);
  assertCleaned(f.state);
});

test("cleanup failures are reported together with the original failure and do not stop remaining cleanup", async () => {
  const f = fixture({ contactFailure: true, archiveFailure: true, disableFailure: true });
  await assert.rejects(f.run(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /Lost contact response/);
    assert.match(error.message, /Archive test agent billing-agent: Agent archive failed/);
    assert.match(error.message, /Disable test provider billing-provider: Provider disable failed/);
    assert.equal(error.errors.length, 3);
    return true;
  });
  assert.equal(f.state.contact, false);
  assert.equal(f.state.mockCloses, 1);
  assert.deepEqual(f.state.logouts, ["caller-session", "admin-session"]);
  f.assertUnrelatedUnchanged();
});

test("cleanup failure prevents a successful workflow from reporting success", async () => {
  const f = fixture({ disableFailure: true });
  await assert.rejects(f.run(), /Disable test provider billing-provider: Provider disable failed/);
  assert.equal(f.state.agent.status, "archived");
  assert.equal(f.state.contact, false);
  assert.equal(f.state.mockCloses, 1);
});

test("contact removal failure still archives the agent and clears its contacts", async () => {
  const f = fixture({ contactRemoveFailure: true });
  await assert.rejects(f.run(), /Remove test contact billing-agent: Contact removal failed/);
  assertCleaned(f.state);
  f.assertUnrelatedUnchanged();
});

test("ambiguous failed creation reports the unique resource name without touching existing providers", async () => {
  const f = fixture({ failBefore: (call) => { if (call.path === "/models/admin/providers" && call.method === "POST") throw new Error("Create request failed."); } });
  await assert.rejects(f.run(), (error) => {
    assert.match(error.message, /Create request failed/);
    assert.match(error.message, /Locate test provider Billing E2E [a-f0-9]{32}/);
    assert.match(error.message, /Creation outcome is uncertain/);
    return true;
  });
  assert.equal(f.state.mockCloses, 1);
  f.assertUnrelatedUnchanged();
});

test("request deadlines abort a stalled fetch", async () => {
  let aborted = false;
  const request = createRequest("http://127.0.0.1/api", {
    timeoutMs: 5,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
    })
  });
  await assert.rejects(request("/slow"), /GET \/slow timed out after 5ms/);
  assert.equal(aborted, true);
});

test("request errors report status without including an arbitrary response body", async () => {
  const request = createRequest("http://127.0.0.1/api", { fetchImpl: async () => new Response(JSON.stringify({ error: "sensitive test data" }), { status: 503 }) });
  await assert.rejects(request("/unavailable"), (error) => {
    assert.equal(error.message, "GET /unavailable failed (503).");
    return true;
  });
});

test("billing requests reject redirects without forwarding credentials or request bodies", async (t) => {
  let destinationRequests = 0;
  let originalRequest;
  const destination = http.createServer((_request, response) => {
    destinationRequests += 1;
    response.setHeader("content-type", "application/json");
    response.end("{}");
  });
  const redirector = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      originalRequest = { method: request.method, token: request.headers["x-session-token"], body };
      response.writeHead(307, { location: `http://127.0.0.1:${destination.address().port}/redirected` });
      response.end();
    });
  });
  t.after(async () => {
    await Promise.all([redirector, destination].map((server) => new Promise((resolve, reject) => {
      if (!server.listening) return resolve();
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    })));
  });
  for (const server of [destination, redirector]) {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  }
  const request = createRequest(`http://127.0.0.1:${redirector.address().port}/api`, { timeoutMs: 2000 });
  const body = JSON.stringify({ password: "test-only-password" });

  await assert.rejects(request("/auth/login", { method: "POST", body, redirect: "follow" }, "test-only-token"), { name: "TypeError" });
  assert.deepEqual(originalRequest, { method: "POST", token: "test-only-token", body });
  assert.equal(destinationRequests, 0);
});
