const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { isLoopbackHostname, resolveE2EBaseUrl, createRequest, main } = require("./e2e-agent");

test("Agent E2E accepts loopback URLs by default", () => {
  assert.equal(resolveE2EBaseUrl({ CHAQ_E2E_SERVER_URL: "http://localhost:24537/api/" }), "http://localhost:24537/api");
  assert.equal(resolveE2EBaseUrl({ CHAQ_E2E_SERVER_URL: "http://127.42.1.9:24537/api" }), "http://127.42.1.9:24537/api");
  assert.equal(resolveE2EBaseUrl({ CHAQ_E2E_SERVER_URL: "http://[::1]:24537/api" }), "http://[::1]:24537/api");
  assert.equal(isLoopbackHostname("127.255.255.255"), true);
});

test("Agent E2E rejects remote URLs unless explicitly allowed", () => {
  assert.throws(
    () => resolveE2EBaseUrl({ CHAQ_E2E_SERVER_URL: "https://staging.chaq.test/api" }),
    /non-loopback URL/
  );
  assert.equal(
    resolveE2EBaseUrl({
      CHAQ_E2E_SERVER_URL: "https://staging.chaq.test/api",
      CHAQ_ALLOW_REMOTE_E2E: "1"
    }),
    "https://staging.chaq.test/api"
  );
});

test("Agent E2E always rejects production mode", () => {
  assert.throws(
    () => resolveE2EBaseUrl({
      NODE_ENV: "production",
      CHAQ_E2E_SERVER_URL: "http://127.0.0.1:24537/api",
      CHAQ_ALLOW_REMOTE_E2E: "1"
    }),
    /NODE_ENV=production/
  );
});

test("Agent E2E rejects ambiguous or non-HTTP targets", () => {
  assert.throws(() => resolveE2EBaseUrl({ CHAQ_E2E_SERVER_URL: "not a URL" }), /valid HTTP/);
  assert.throws(() => resolveE2EBaseUrl({ CHAQ_E2E_SERVER_URL: "file:///tmp/chaq" }), /HTTP\(S\)/);
  assert.throws(
    () => resolveE2EBaseUrl({ CHAQ_E2E_SERVER_URL: "http://127.0.0.1:24537/api?target=remote" }),
    /without credentials/
  );
});

function fixture(failures = {}) {
  const calls = [];
  const logs = [];
  const createdProviders = [];
  let closedMocks = 0;
  let providerCounter = 0;
  const dependencies = {
    log: (message) => logs.push(message),
    startMockModel: async () => ({
      baseUrl: "http://127.0.0.1:39999/v1",
      server: {
        close: (callback) => { closedMocks += 1; callback(); },
        closeAllConnections: () => undefined
      }
    }),
    fetch: async (url, init) => {
      const path = new URL(url).pathname.replace(/^\/api/, "");
      const body = init.body ? JSON.parse(init.body) : undefined;
      const method = init.method || "GET";
      calls.push({ path, method, body, token: init.headers["x-session-token"] });
      const operation = `${method} ${path}`;
      if (failures[operation]) return Response.json({ message: failures[operation] }, { status: 500 });
      if (operation === "POST /auth/login") return Response.json({ sessionToken: "test-admin-token" });
      if (operation === "POST /models/admin/providers") {
        assert.equal(body.id, undefined, "mock creation must never update an existing provider");
        const provider = { ...body, id: `owned-provider-${++providerCounter}` };
        createdProviders.push(provider);
        return Response.json(provider);
      }
      if (/^POST \/models\/admin\/providers\/owned-provider-\d+\/status$/.test(operation)) {
        return Response.json({ ok: true });
      }
      if (operation === "POST /agents") return Response.json({ id: "owned-agent" });
      if (operation === "POST /conversations/with-agent/owned-agent") return Response.json({ id: "owned-conversation" });
      if (operation === "POST /conversations/owned-conversation/messages") return Response.json({ id: "input-message" });
      if (operation === "GET /agents/owned-agent") return Response.json({
        recentRuns: [{ status: "completed" }], recentEvents: [], memories: [], goals: [], tasks: []
      });
      if (operation === "GET /conversations/owned-conversation/messages") return Response.json([
        { id: "agent-reply", authorKind: "agent", authorId: "owned-agent", content: "Verified" }
      ]);
      if (operation === "GET /agents/owned-agent/profile") return Response.json({ posts: [{ content: "visible evidence" }] });
      if (operation === "POST /agents/owned-agent") return Response.json({ id: "owned-agent", ...body });
      throw new Error(`Unexpected test request: ${operation}`);
    }
  };
  return { dependencies, calls, logs, createdProviders, closedMocks: () => closedMocks };
}

test("mock Agent E2E creates its own provider/model even when a real provider is explicitly configured", async () => {
  const state = fixture();
  const env = {
    CHAQ_E2E_MOCK_MODEL: "1",
    CHAQ_E2E_PROVIDER_ID: "real-provider",
    CHAQ_E2E_MODEL: "real-model"
  };
  for (let index = 0; index < 2; index += 1) {
    assert.equal((await main(env, state.dependencies)).ok, true);
  }
  assert.equal(state.createdProviders.length, 2);
  assert.notEqual(state.createdProviders[0].models[0].id, state.createdProviders[1].models[0].id);
  assert.notEqual(state.createdProviders[0].name, state.createdProviders[1].name);
  const agentCreations = state.calls.filter((call) => call.path === "/agents");
  for (const [index, provider] of state.createdProviders.entries()) {
    assert.equal(provider.kind, "custom");
    assert.equal(provider.baseUrl, "http://127.0.0.1:39999/v1");
    assert.equal(agentCreations[index].body.modelProviderId, provider.id);
    assert.equal(agentCreations[index].body.model, provider.models[0].id);
  }
  assert.equal(state.calls.some((call) => call.method === "GET" && call.path === "/models/admin/providers"), false);
  assert.equal(state.calls.some((call) => call.path.includes("real-provider") || call.body?.id === "real-provider"), false);
  assert.equal(state.calls.filter((call) => call.body?.status === "archived").length, 2);
  assert.deepEqual(state.calls.filter((call) => call.path.endsWith("/status")).map((call) => ({ path: call.path, body: call.body })), [
    { path: "/models/admin/providers/owned-provider-1/status", body: { enabled: false } },
    { path: "/models/admin/providers/owned-provider-2/status", body: { enabled: false } }
  ]);
  assert.equal(state.closedMocks(), 2);
  assert.equal(state.logs.length, 2);
});

test("real-model Agent E2E preserves explicit provider/model selection and only archives its own agent", async () => {
  const state = fixture();
  await main({ CHAQ_E2E_PROVIDER_ID: "real-provider", CHAQ_E2E_MODEL: "real-model" }, state.dependencies);
  const agent = state.calls.find((call) => call.path === "/agents").body;
  assert.equal(agent.modelProviderId, "real-provider");
  assert.equal(agent.model, "real-model");
  assert.equal(state.calls.some((call) => call.path.startsWith("/models/")), false);
  assert.equal(state.calls.filter((call) => call.body?.status === "archived").length, 1);
  assert.equal(state.closedMocks(), 0);
});

test("mock Agent E2E disables its new provider when agent creation fails", async () => {
  const state = fixture({ "POST /agents": "agent creation failed" });
  await assert.rejects(main({ CHAQ_E2E_MOCK_MODEL: "1" }, state.dependencies), /agent creation failed/);
  assert.deepEqual(state.calls.at(-1).body, { enabled: false });
  assert.equal(state.calls.at(-1).path, "/models/admin/providers/owned-provider-1/status");
  assert.equal(state.calls.some((call) => call.body?.status === "archived"), false);
  assert.equal(state.closedMocks(), 1);
  assert.equal(state.logs.length, 0);
});

test("mock Agent E2E stops its mock without updating any provider when provider creation fails", async () => {
  const state = fixture({ "POST /models/admin/providers": "provider creation failed" });
  await assert.rejects(main({ CHAQ_E2E_MOCK_MODEL: "1" }, state.dependencies), /provider creation failed/);
  assert.equal(state.calls.some((call) => call.path.endsWith("/status")), false);
  assert.equal(state.closedMocks(), 1);
  assert.equal(state.logs.length, 0);
});

test("Agent E2E preserves the original failure and reports every cleanup failure without skipping later cleanup", async () => {
  const state = fixture({
    "GET /agents/owned-agent/profile": "profile request failed",
    "POST /agents/owned-agent": "archive failed",
    "POST /models/admin/providers/owned-provider-1/status": "disable failed"
  });
  await assert.rejects(main({ CHAQ_E2E_MOCK_MODEL: "1" }, state.dependencies), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 3);
    assert.match(error.message, /profile request failed/);
    assert.match(error.message, /Could not archive test agent owned-agent/);
    assert.match(error.message, /Could not disable test provider owned-provider-1/);
    return true;
  });
  assert.equal(state.closedMocks(), 1);
  assert.equal(state.logs.length, 0);
});

test("Agent E2E does not report success when cleanup fails after a successful run", async () => {
  const state = fixture({ "POST /models/admin/providers/owned-provider-1/status": "disable failed" });
  await assert.rejects(main({ CHAQ_E2E_MOCK_MODEL: "1" }, state.dependencies), /Could not disable test provider/);
  assert.equal(state.closedMocks(), 1);
  assert.equal(state.logs.length, 0);
});

test("Agent E2E requests abort after their deadline", async () => {
  let aborted = false;
  const request = createRequest("http://127.0.0.1:24537/api", async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => {
      aborted = true;
      reject(init.signal.reason);
    }, { once: true });
  }), 15);
  await assert.rejects(request("/slow"), /GET \/slow timed out after 15ms/);
  assert.equal(aborted, true);
});

test("Agent E2E rejects redirects without forwarding credentials or the request body to another origin", async (t) => {
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
  const request = createRequest(`http://127.0.0.1:${redirector.address().port}/api`, fetch, 2000);
  const body = JSON.stringify({ password: "test-only-password" });

  await assert.rejects(request("/auth/login", { method: "POST", body, redirect: "follow" }, "test-only-token"), { name: "TypeError" });
  assert.deepEqual(originalRequest, { method: "POST", token: "test-only-token", body });
  assert.equal(destinationRequests, 0);
});

test("Agent E2E validates timeout configuration before logging in or starting a mock", async () => {
  const state = fixture();
  for (const value of ["NaN", "Infinity", "-1", "0", "2147483648"]) {
    await assert.rejects(main({ CHAQ_E2E_REQUEST_TIMEOUT_MS: value }, state.dependencies), /CHAQ_E2E_REQUEST_TIMEOUT_MS/);
    await assert.rejects(main({ CHAQ_E2E_TIMEOUT_MS: value }, state.dependencies), /CHAQ_E2E_TIMEOUT_MS/);
  }
  assert.equal(state.calls.length, 0);
  assert.equal(state.closedMocks(), 0);
});
