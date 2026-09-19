// Generated preview values use JSON string escaping. Raw and single-quoted
// values remain literal; legacy double-quoted values that are not valid JSON
// retain their contents as well.
function* parseEnvEntries(text) {
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.slice(1, -1);
      }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    yield [key, value];
  }
}

function parseEnv(text) {
  return Object.fromEntries(parseEnvEntries(text));
}

function formatEnvValue(value) {
  const text = String(value);
  return /[\s#"']/u.test(text) ? JSON.stringify(text) : text;
}

// Nest reads the workspace .env with dotenv, which does not decode JSON
// escapes. Keep generated assignments on one line so repeated preparation can
// replace them without leaving part of a previous multiline value behind.
function formatDotenvValue(value) {
  const text = String(value);
  if (!/[\s#"'`]/u.test(text)) return text;
  if (!/['\r\n]/u.test(text)) return `'${text}'`;
  if (!/[`\r\n]/u.test(text)) return `\`${text}\``;
  if (!text.includes('"') && !/\\[nr]/u.test(text)) {
    return `"${text.replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
  }
  // Dotenv strips quotes at Unicode line boundaries in unquoted values too.
  if (!/[#\r\n\u2028\u2029]/u.test(text) && text.trim() === text && !/^["'`]/u.test(text)) return text;
  throw new Error("The workspace .env format cannot represent this value losslessly on one line.");
}

module.exports = { formatDotenvValue, formatEnvValue, parseEnv, parseEnvEntries };
