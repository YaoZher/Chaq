const http = require("node:http");
const { randomUUID } = require("node:crypto");
const { isLoopbackHostname, resolveE2EBaseUrl } = require("./e2e-agent");

const modelContextWindow = 4096;
const modelTokenPrice = 0.01;
const serviceFee = 7;
const requiredCallerBalance = Math.ceil(modelContextWindow * modelTokenPrice) + serviceFee;

function resolveBillingConfig(env = process.env) {
  const baseUrl = resolveE2EBaseUrl(env);
  // The model listener belongs to this process and cannot serve a remote API.
  if (!isLoopbackHostname(new URL(baseUrl).hostname)) {
    throw new Error("Billing E2E requires a loopback API URL, even with CHAQ_ALLOW_REMOTE_E2E=1.");
  }
  const billingUser = String(env.CHAQ_E2E_BILLING_USER || "").trim();
  if (!billingUser) throw new Error("Set CHAQ_E2E_BILLING_USER to an existing non-admin test account before running billing E2E.");
  const requestTimeoutMs = Number(env.CHAQ_E2E_REQUEST_TIMEOUT_MS || 15_000);
  const timeoutMs = Number(env.CHAQ_E2E_TIMEOUT_MS || 45_000);
  if (![requestTimeoutMs, timeoutMs].every((value) => Number.isFinite(value) && value > 0 && value <= 300_000)) {
    throw new Error("E2E request and polling timeouts must be positive numbers no greater than 300000ms.");
  }
  return {
    baseUrl,
    billingUser,
    billingPassword: env.CHAQ_E2E_BILLING_PASSWORD || "123456",
    adminUser: env.CHAQ_E2E_USERNAME || "admin",
    adminPassword: env.CHAQ_E2E_PASSWORD || "123456",
    requestTimeoutMs,
    timeoutMs
  };
}

function createRequest(baseUrl, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  return async (path, init = {}, token) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        redirect: "error",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(token ? { "x-session-token": token } : {}),
          ...init.headers
        }
      });
      const data = await response.json().catch(() => null);
      if (controller.signal.aborted) throw new Error("Request aborted.");
      if (!response.ok) throw new Error(`${init.method || "GET"} ${path} failed (${response.status}).`);
      return data;
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`${init.method || "GET"} ${path} timed out after ${timeoutMs}ms.`, { cause: error });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, Math.min(750, Math.max(0, deadline - Date.now()))));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for the billing reply.`);
}

async function startMockModel() {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") return res.writeHead(404).end();
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let input;
      try {
        input = JSON.parse(body || "{}");
      } catch {
        res.writeHead(400).end();
        return;
      }
      const content = JSON.stringify({
        reasonSummary: "Reply to the new contact.",
        actions: [{ type: "reply", content: "Contact and billing flow verified." }],
        reflection: "The caller funded this reply and the creator received the configured service fee."
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: `billing-${Date.now()}`,
        model: input?.model || "chaq-billing-test",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    })
  };
}

async function runBillingE2E({ env = process.env, fetchImpl = fetch, startMockModelImpl = startMockModel } = {}) {
  const config = resolveBillingConfig(env);
  const request = createRequest(config.baseUrl, { fetchImpl, timeoutMs: config.requestTimeoutMs });
  const post = (path, body, token) => request(path, { method: "POST", body: JSON.stringify(body) }, token);
  const suffix = randomUUID().replace(/-/g, "");
  const providerName = `Billing E2E ${suffix}`;
  const model = `chaq-billing-${suffix}`;
  const agentHandle = `billing-${suffix}`;
  const agentName = `Billing E2E ${suffix}`;
  let adminToken;
  let userToken;
  let mock;
  let provider;
  let agent;
  let providerAttempted = false;
  let agentAttempted = false;
  let contactAttempted = false;
  let result;
  let failure;
  const cleanupErrors = [];
  const cleanup = async (label, action) => {
    try {
      await action();
    } catch (error) {
      cleanupErrors.push(new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
    }
  };

  try {
    const adminLogin = await post("/auth/login", { username: config.adminUser, password: config.adminPassword });
    adminToken = adminLogin.sessionToken;
    if (String(adminLogin.user?.role).toLowerCase() !== "admin") throw new Error("Billing E2E creator must be an admin test account.");
    const userLogin = await post("/auth/login", { username: config.billingUser, password: config.billingPassword });
    userToken = userLogin.sessionToken;
    if (!userLogin.user?.id || userLogin.user.id === adminLogin.user.id || String(userLogin.user.role).toLowerCase() !== "user") {
      throw new Error("Billing E2E caller must be a separate non-admin test account.");
    }
    if (!Number.isFinite(userLogin.user.tokenBalance) || userLogin.user.tokenBalance < requiredCallerBalance) {
      throw new Error(`Billing E2E caller needs at least ${requiredCallerBalance} test tokens for the temporary model reservation; the expected final debit is 8.`);
    }
    mock = await startMockModelImpl();
    providerAttempted = true;
    // Omit id: the API creates an independent provider instead of upserting an existing one.
    provider = await post("/models/admin/providers", {
      kind: "custom",
      name: providerName,
      baseUrl: mock.baseUrl,
      apiKey: "chaq-e2e-key",
      models: [{ id: model, label: model, contextWindow: modelContextWindow }],
      enabled: true,
      promptTokenPrice: modelTokenPrice,
      completionTokenPrice: modelTokenPrice,
      contextWindow: modelContextWindow
    }, adminToken);
    if (!provider?.id) throw new Error("The test provider response did not include an id.");
    agentAttempted = true;
    agent = await post("/agents", {
      name: agentName,
      handle: agentHandle,
      tagline: "Cross-account billing validation",
      persona: "A concise validation agent.",
      tone: "Direct.",
      identity: { traits: ["reliable"], interests: ["testing"] },
      values: ["clarity"],
      worldview: "Observable behavior builds trust.",
      boundaries: "No external actions.",
      tags: ["e2e"],
      autonomyMode: "copilot",
      visibility: "public",
      serviceFee,
      modelProviderId: provider.id,
      model,
      temperature: 0,
      initiative: 50,
      reflectionDepth: 1,
      scheduleEveryMinutes: 60,
      dailyTokenBudget: 1000,
      dailyActionBudget: 10
    }, adminToken);
    if (!agent?.id) throw new Error("The test agent response did not include an id.");

    const beforeUser = await request("/users/me", {}, userToken);
    const beforeAdmin = await request("/users/me", {}, adminToken);
    contactAttempted = true;
    await post(`/agents/${agent.id}/contact`, {}, userToken);
    const conversation = await post(`/conversations/with-agent/${agent.id}`, {}, userToken);
    await post(`/conversations/${conversation.id}/messages`, { content: "Verify the public Agent billing flow." }, userToken);
    await waitFor(async () => {
      const messages = await request(`/conversations/${conversation.id}/messages`, {}, userToken);
      return messages.some((message) => message.authorKind === "agent" && message.content.includes("billing flow verified"));
    }, config.timeoutMs);

    const afterUser = await request("/users/me", {}, userToken);
    const afterAdmin = await request("/users/me", {}, adminToken);
    const userDebit = beforeUser.tokenBalance - afterUser.tokenBalance;
    const adminCredit = afterAdmin.tokenBalance - beforeAdmin.tokenBalance;
    if (userDebit !== 8) throw new Error(`Expected caller debit 8, received ${userDebit}.`);
    if (adminCredit !== 7) throw new Error(`Expected creator credit 7, received ${adminCredit}.`);
    const contacts = await request("/agents/contacts", {}, userToken);
    if (!contacts.some((contact) => contact.agent.id === agent.id)) throw new Error("Agent contact was not persisted.");
    const discovered = await request(`/agents/discover?query=${encodeURIComponent(agent.handle)}`, {}, userToken);
    if (!discovered.some((item) => item.id === agent.id && item.isContact)) throw new Error("Agent discovery did not expose contact state.");
    const [userWallet, adminWallet] = await Promise.all([
      request("/users/me/wallet", {}, userToken),
      request("/users/me/wallet", {}, adminToken)
    ]);
    if (userWallet.serviceFeesPaid < 7) throw new Error("Caller wallet did not include the service fee.");
    const earning = adminWallet.agentEarnings.find((item) => item.agentId === agent.id);
    if (!earning || earning.amount !== 7) throw new Error("Creator wallet did not group the Agent earning.");
    result = { ok: true, agentId: agent.id, conversationId: conversation.id, userDebit, adminCredit, walletEarning: earning.amount };
  } catch (error) {
    failure = error;
  } finally {
    // A timeout can occur after the server committed creation. Recover only this run's unique resources.
    if (providerAttempted && !provider?.id) {
      await cleanup(`Locate test provider ${providerName}`, async () => {
        const providers = await request("/models/admin/providers", {}, adminToken);
        provider = providers.find((item) => item.name === providerName && item.baseUrl === mock.baseUrl && item.models?.some((itemModel) => itemModel.id === model));
        if (!provider) throw new Error("Creation outcome is uncertain; no matching provider was visible. Inspect this name if the server later completes the request.");
      });
    }
    if (agentAttempted && !agent?.id) {
      await cleanup(`Locate test agent ${agentHandle}`, async () => {
        const agents = await request("/agents", {}, adminToken);
        agent = agents.find((item) => item.handle === agentHandle && item.name === agentName);
        if (!agent) throw new Error("Creation outcome is uncertain; no matching agent was visible. Inspect this handle if the server later completes the request.");
      });
    }
    if (agent?.id) {
      // Archiving also deletes contacts, so remove this caller's contact first.
      if (contactAttempted) await cleanup(`Remove test contact ${agent.id}`, () => post(`/agents/${agent.id}/contact/remove`, {}, userToken));
      await cleanup(`Archive test agent ${agent.id}`, () => post(`/agents/${agent.id}`, { status: "archived" }, adminToken));
    }
    if (provider?.id) await cleanup(`Disable test provider ${provider.id}`, () => post(`/models/admin/providers/${provider.id}/status`, { enabled: false }, adminToken));
    if (mock) await cleanup("Close mock model", () => mock.close());
    if (userToken) await cleanup("Revoke caller test session", () => post("/auth/logout", {}, userToken));
    if (adminToken) await cleanup("Revoke admin test session", () => post("/auth/logout", {}, adminToken));
  }
  if (cleanupErrors.length) {
    const errors = [...(failure ? [failure] : []), ...cleanupErrors];
    throw new AggregateError(errors, errors.map((error) => error.message).join("\n"));
  }
  if (failure) throw failure;
  return result;
}

if (require.main === module) {
  runBillingE2E().then((result) => console.log(JSON.stringify(result))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = { createRequest, resolveBillingConfig, runBillingE2E, startMockModel };
