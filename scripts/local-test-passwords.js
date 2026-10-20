const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function localUrl(value, protocols, port, pathname) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    if (!protocols.includes(url.protocol) || !loopbackHosts.has(url.hostname) || url.hash) return null;
    if (port !== undefined && url.port !== port) return null;
    if (pathname !== undefined && url.pathname !== pathname) return null;
    return url;
  } catch {
    return null;
  }
}

function allowsLocalTestPasswords(environment = {}) {
  if (environment.CHAQ_ALLOW_LOCAL_TEST_PASSWORDS !== "1"
    || environment.CHAQ_RUNTIME_PROFILE !== "local-preview"
    || !loopbackHosts.has(environment.SERVER_HOST)) return false;

  const api = localUrl(environment.PUBLIC_API_URL, ["http:", "https:"]);
  const database = localUrl(environment.DATABASE_URL, ["postgres:", "postgresql:"], "45432", "/chaq_preview");
  const redis = localUrl(environment.REDIS_URL, ["redis:"], "46379", "/1");
  return Boolean(api && !api.username && !api.password && !api.search
    && database && [...database.searchParams].every(([key, value]) => key === "schema" && value === "public")
    && redis && !redis.search);
}

function validAccountPassword(password, environment = {}) {
  if (typeof password !== "string" || password.length > 64 || /[\r\n]/.test(password)) return false;
  if (allowsLocalTestPasswords(environment)) return password.length >= 6;
  return password.length >= 8 && /[A-Za-z]/.test(password) && /\d/.test(password);
}

module.exports = { allowsLocalTestPasswords, validAccountPassword };
