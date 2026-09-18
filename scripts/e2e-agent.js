const http = require("node:http");
const { randomUUID } = require("node:crypto");

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (normalized === "localhost" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  const octets = normalized.split(".");
  return octets.length === 4
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
    && Number(octets[0]) === 127;
}

function resolveE2EBaseUrl(env = process.env) {
  if (String(env.NODE_ENV || "").trim().toLowerCase() === "production") {
    throw new Error("Refusing to run the development Agent E2E test with NODE_ENV=production.");
  }

  const rawUrl = String(env.CHAQ_E2E_SERVER_URL || "http://127.0.0.1:24537/api").trim();
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("CHAQ_E2E_SERVER_URL must be a valid HTTP(S) URL.");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("CHAQ_E2E_SERVER_URL must be an HTTP(S) URL without credentials, a query, or a fragment.");
  }
  if (!isLoopbackHostname(parsed.hostname) && String(env.CHAQ_ALLOW_REMOTE_E2E || "").trim() !== "1") {
    throw new Error("Refusing to run Agent E2E against a non-loopback URL. Set CHAQ_ALLOW_REMOTE_E2E=1 explicitly for a disposable remote environment.");
  }
  return parsed.toString().replace(/\/$/, "");
}

function positiveTimeout(value, fallback, name) {
  const parsed = Number(value || fallback);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    throw new Error(`${name} must be a positive integer no greater than 2147483647.`);
  }
  return parsed;
}

function createRequest(baseUrl, fetchImpl, requestTimeoutMs) {
  return async (path, init = {}, sessionToken) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`Request ${init.method || "GET"} ${path} timed out after ${requestTimeoutMs}ms.`)), requestTimeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        redirect: "error",
        signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
        headers: {
          "content-type": "application/json",
          ...(sessionToken ? { "x-session-token": sessionToken } : {}),
          ...init.headers
        }
      });
      const data = await response.json().catch(() => null);
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!response.ok) {
        throw new Error(`${init.method || "GET"} ${path} failed (${response.status}): ${JSON.stringify(data)}`);
      }
      return data;
    } finally {
      clearTimeout(timeout);
    }
  };
}

async function waitFor(predicate, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timed out after ${timeoutMs}ms.`);
}

async function startMockModel() {
  const server = http.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const input = JSON.parse(body || "{}");
      const content = JSON.stringify({
        reasonSummary: "Acknowledge the message and establish durable work context.",
        actions: [
          { type: "reply", content: "Agent runtime verified: I observed the conversation, made a plan, and completed my actions." },
          { type: "remember", memoryKind: "semantic", content: "The owner values concrete end-to-end verification.", salience: 0.8 },
          { type: "create_goal", title: "Maintain reliable Agent behavior", description: "Keep runtime behavior observable and testable.", priority: 80 },
          { type: "create_task", title: "Review the latest Agent run", description: "Inspect events and outcomes after execution.", priority: 70 },
          { type: "publish_post", content: "Finished a full observe, decide, act, and reflect cycle. Reliability grows from visible evidence.", mood: "focused", location: "Chaq lab" }
        ],
        reflection: "The full observe, decide, act, and reflect cycle completed successfully."
      });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: input.model || "chaq-e2e-model",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 240, completion_tokens: 160, total_tokens: 400 }
      }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock model did not bind to a TCP port.");
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

async function main(env = process.env, dependencies = {}) {
  const baseUrl = resolveE2EBaseUrl(env);
  const timeoutMs = Math.max(10_000, positiveTimeout(env.CHAQ_E2E_TIMEOUT_MS, 90_000, "CHAQ_E2E_TIMEOUT_MS"));
  const requestTimeoutMs = positiveTimeout(env.CHAQ_E2E_REQUEST_TIMEOUT_MS, 15_000, "CHAQ_E2E_REQUEST_TIMEOUT_MS");
  const request = createRequest(baseUrl, dependencies.fetch || globalThis.fetch, requestTimeoutMs);
  const useMockModel = env.CHAQ_E2E_MOCK_MODEL === "1";
  const login = await request("/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: env.CHAQ_E2E_USERNAME || "admin", password: env.CHAQ_E2E_PASSWORD || "123456" })
  });
  const token = login.sessionToken;
  let selectedProviderId = env.CHAQ_E2E_PROVIDER_ID || null;
  let selectedModel = env.CHAQ_E2E_MODEL || null;
  let createdProvider = null;
  let mock = null;
  let agent = null;
  let resultSummary;
  let failure;
  const cleanupFailures = [];
  const suffix = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  try {
    if (useMockModel) {
      mock = await (dependencies.startMockModel || startMockModel)();
      selectedModel = `chaq-e2e-${suffix}`;
      // Omit id so the API creates a dedicated provider. Never borrow a real
      // provider or overwrite its endpoint, API key, models, or prices.
      createdProvider = await request("/models/admin/providers", {
        method: "POST",
        body: JSON.stringify({
          kind: "custom",
          name: `Agent E2E ${suffix}`,
          baseUrl: mock.baseUrl,
          apiKey: "chaq-e2e-mock-only",
          models: [{ id: selectedModel, label: selectedModel, contextWindow: 8192 }],
          enabled: true,
          promptTokenPrice: 0,
          completionTokenPrice: 0,
          contextWindow: 8192
        })
      }, token);
      selectedProviderId = createdProvider.id;
    }
    agent = await request("/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "Chaq E2E Agent",
        handle: `e2e-${suffix}`,
        avatarUrl: null,
        tagline: "Automated validation agent",
        biography: "",
        persona: "A careful validation agent.",
        tone: "Concise and direct.",
        values: ["reliability"],
        worldview: "Validate behavior through concrete evidence.",
        boundaries: "Do not perform external actions.",
        identity: { traits: ["careful"], interests: ["testing"] },
        tags: ["e2e"],
        autonomyMode: "copilot",
        visibility: "private",
        modelProviderId: selectedProviderId,
        model: selectedModel,
        temperature: 0.7,
        initiative: 50,
        reflectionDepth: 1,
        scheduleEveryMinutes: 60,
        dailyTokenBudget: 1000,
        dailyActionBudget: 10
      })
    }, token);
    const conversation = await request(`/conversations/with-agent/${agent.id}`, {
      method: "POST",
      body: "{}"
    }, token);
    await request(`/conversations/${conversation.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "Confirm that the Agent worker received this message." })
    }, token);

    const result = await waitFor(async () => {
      const [detail, messages] = await Promise.all([
        request(`/agents/${agent.id}`, {}, token),
        request(`/conversations/${conversation.id}/messages`, {}, token)
      ]);
      const failed = detail.recentRuns.find((run) => run.status === "failed" || run.status === "cancelled");
      if (failed) throw new Error(`Agent run ${failed.status}: ${failed.error || "unknown error"}`);
      const completed = detail.recentRuns.some((run) => run.status === "completed");
      const agentReply = messages.find((message) => message.authorKind === "agent" && message.authorId === agent.id);
      return completed && agentReply ? { detail, messages, agentReply } : null;
    }, timeoutMs);

    const profile = await request(`/agents/${agent.id}/profile`, {}, token);
    if (!profile.posts.some((post) => post.content.includes("visible evidence"))) {
      throw new Error("Agent completed its run without publishing the planned profile post.");
    }

    resultSummary = {
      ok: true,
      modelConfigured: Boolean(selectedProviderId && selectedModel),
      mockModel: useMockModel,
      agentId: agent.id,
      completedRuns: result.detail.recentRuns.filter((run) => run.status === "completed").length,
      eventCount: result.detail.recentEvents.length,
      messageCount: result.messages.length,
      memoryCount: result.detail.memories.length,
      goalCount: result.detail.goals.length,
      taskCount: result.detail.tasks.length,
      profilePostCount: profile.posts.length,
      replyPreview: result.agentReply.content.slice(0, 120)
    };
  } catch (error) {
    failure = error;
  } finally {
    const cleanup = async (label, operation) => {
      try {
        await operation();
      } catch (error) {
        cleanupFailures.push(new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
      }
    };
    if (agent) {
      await cleanup(`Could not archive test agent ${agent.id}`, () => request(`/agents/${agent.id}`, {
        method: "POST",
        body: JSON.stringify({ status: "archived" })
      }, token));
    }
    if (createdProvider) {
      await cleanup(`Could not disable test provider ${createdProvider.id}`, () => request(`/models/admin/providers/${createdProvider.id}/status`, {
        method: "POST",
        body: JSON.stringify({ enabled: false })
      }, token));
    }
    if (mock) await cleanup("Could not stop the mock model", () => new Promise((resolve, reject) => {
      mock.server.close((error) => error ? reject(error) : resolve());
      mock.server.closeAllConnections?.();
    }));
  }
  if (cleanupFailures.length) {
    const errors = failure ? [failure, ...cleanupFailures] : cleanupFailures;
    throw new AggregateError(errors, errors.map((error) => error instanceof Error ? error.message : String(error)).join("\n"));
  }
  if (failure) throw failure;
  (dependencies.log || console.log)(JSON.stringify(resultSummary, null, 2));
  return resultSummary;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

module.exports = { isLoopbackHostname, resolveE2EBaseUrl, createRequest, main };
