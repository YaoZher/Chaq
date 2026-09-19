const fs = require("node:fs");
const { previewEnv } = require("./env-paths");
const { parseEnv } = require("./env-format");

async function smokeLocalPreview(options = {}) {
  const envFile = options.envFile || previewEnv;
  const baseUrl = options.baseUrl || "http://127.0.0.1:24538/api";
  const fetchImpl = options.fetchImpl || fetch;
  const env = parseEnv(fs.readFileSync(envFile, "utf8"));
  const username = env.CHAQ_PREVIEW_USERNAME;
  const password = env.CHAQ_PREVIEW_PASSWORD;
  if (!username || !password) throw new Error(`Preview credentials are missing from ${envFile}.`);

  const login = await fetchImpl(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  if (!login.ok) throw new Error(`Preview login failed (${login.status}): ${await login.text()}`);
  const session = await login.json();
  if (!session.sessionToken) throw new Error("Preview login returned no session token.");

  const me = await fetchImpl(`${baseUrl}/users/me`, {
    headers: { "x-session-token": session.sessionToken }
  });
  if (!me.ok) throw new Error(`Preview session check failed (${me.status}): ${await me.text()}`);
  const user = await me.json();

  const logout = await fetchImpl(`${baseUrl}/auth/logout`, {
    method: "POST",
    headers: { "x-session-token": session.sessionToken }
  });
  if (!logout.ok) throw new Error(`Preview logout failed (${logout.status}): ${await logout.text()}`);
  return { role: user.role, username: user.username };
}

if (require.main === module) {
  smokeLocalPreview()
    .then((user) => console.log(`[smoke] Local preview login/session/logout passed for ${user.username} (${user.role}).`))
    .catch((error) => {
      console.error(`[ERROR] ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}

module.exports = { smokeLocalPreview };
