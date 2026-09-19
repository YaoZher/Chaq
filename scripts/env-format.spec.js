const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { parse: parseDotenv } = require(require.resolve("dotenv", { paths: [require.resolve("@nestjs/config")] }));
const { formatDotenvValue, formatEnvValue, parseEnv } = require("./env-format");
const { parseEnvFile } = require("./create-admin-user");
const { parseEnv: parsePreviewEnv, readPreviewLogin, serializePreviewEnv } = require("./prepare-preview-env");
const { loadEnvironment, parseEnv: parseProductionEnv } = require("./validate-production-env");

function environmentFixture(context, text) {
  const fixtureRoot = path.resolve(__dirname, "..", ".chaq-data", "test-tmp");
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(fixtureRoot, "env-format-"));
  context.after(() => {
    assert.equal(path.dirname(directory), fixtureRoot);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const file = path.join(directory, "fixture.env");
  fs.writeFileSync(file, text, "utf8");
  return file;
}

test("generated preview values round-trip through preview and production parsers", () => {
  const values = {
    CHAQ_PREVIEW_PASSWORD: 'Alpha123"local\\secret',
    CHAQ_PG_DATA_DIR: "C:\\Work Space\\Chaq\\.chaq-data\\postgres-data",
    CHAQ_PREVIEW_DISPLAY_NAME: "Local 'preview' #1",
    DATABASE_URL: "postgresql://chaq:pass@127.0.0.1:45432/chaq_preview?schema=public",
    EMPTY: ""
  };
  const serialized = serializePreviewEnv(values);
  for (const parse of [parseEnv, parsePreviewEnv, parseProductionEnv]) {
    assert.deepEqual(parse(serialized), values);
  }
});

test("raw and single-quoted values preserve literal Windows paths and escapes", () => {
  assert.deepEqual(parseEnv(String.raw`
RAW=C:\temp\new folder
SINGLE='C:\temp\new folder'
PASSWORD='Alpha123\n"literal'
HASH=one#two=three
`), {
    RAW: String.raw`C:\temp\new folder`,
    SINGLE: String.raw`C:\temp\new folder`,
    PASSWORD: String.raw`Alpha123\n"literal`,
    HASH: "one#two=three"
  });
});

test("shared environment writer preserves development Windows paths that resemble JSON escapes", () => {
  for (const value of [
    String.raw`C:\temp folder\new\runtime`,
    String.raw`C:\temp\new\runtime`,
    String.raw`\\server\work space\Chaq`,
    'Alpha123"local\\secret',
    "one#two='three'",
    "line one\nline two",
    ""
  ]) {
    assert.equal(parseEnv(`VALUE=${formatEnvValue(value)}\n`).VALUE, value);
  }
});

test("workspace values round-trip through the dotenv parser used by Nest", () => {
  for (const value of [
    String.raw`C:\temp folder\new\runtime`,
    String.raw`C:\temp\new\runtime`,
    String.raw`\\server\work space\Chaq` + "\\",
    String.raw`C:\User's work #1\new\runtime`,
    "C:\\User's work` area\\new\\runtime\\",
    'Alpha123"local\\secret',
    "one#two='three'",
    "all 'three\" quote` types",
    " leading and trailing spaces ",
    "line one\nline two\r\nline three\r",
    "line with 'single' and `backtick` quotes\n",
    "quoted \u2028line\u2029 separators",
    "quoted 'single' \u2028line\u2029 separators",
    "quoted 'single' `backtick` \u2028line\u2029 separators",
    "",
    "plain",
    17
  ]) {
    const serialized = formatDotenvValue(value);
    assert.doesNotMatch(serialized, /[\r\n]/u);
    assert.deepEqual(parseDotenv(`VALUE=${serialized}\nAFTER=untouched\n`), {
      VALUE: String(value),
      AFTER: "untouched"
    });
  }
});

test("workspace serialization rejects unsupported values without revealing them", () => {
  for (const value of ["private#'\"`value", 'private "value"\nsecond line', "private\\new 'quote`\n", '=\u2028\'"`\'\u2029a']) {
    assert.throws(() => formatDotenvValue(value), (error) => {
      assert.equal(error.message, "The workspace .env format cannot represent this value losslessly on one line.");
      assert.equal(error.message.includes(value), false);
      return true;
    });
  }
});

test("development preparation preserves secrets and paths in internal and workspace formats on repeated runs", (context) => {
  const fixture = environmentFixture(context, "");
  const projectDirectory = path.dirname(fixture);
  const scriptDirectory = path.join(projectDirectory, "scripts");
  const workspaceDirectory = path.join(projectDirectory, "apps", "server");
  const environmentDirectory = path.join(projectDirectory, "Local runtime's #cache");
  const internalDirectory = path.join(environmentDirectory, "Chaq");
  for (const directory of [scriptDirectory, workspaceDirectory, internalDirectory]) fs.mkdirSync(directory, { recursive: true });
  for (const filename of ["prepare-env.js", "env-format.js", "env-paths.js"]) {
    fs.copyFileSync(path.join(__dirname, filename), path.join(scriptDirectory, filename));
  }
  const secrets = {
    MODEL_SECRET_KEY: String.raw`Alpha123"local\new\runtime`,
    SESSION_HASH_SECRET: String.raw`Local's #key\new\runtime`
  };
  const internalFile = path.join(internalDirectory, "server.env");
  const workspaceFile = path.join(workspaceDirectory, ".env");
  fs.writeFileSync(internalFile, Object.entries(secrets).map(([key, value]) => `${key}=${formatEnvValue(value)}`).join("\n"), "utf8");
  fs.writeFileSync(workspaceFile, "CUSTOM_SETTING='Keep # this'\n", "utf8");

  for (let iteration = 0; iteration < 2; iteration += 1) {
    const result = spawnSync(process.execPath, [path.join(scriptDirectory, "prepare-env.js")], {
      cwd: projectDirectory,
      env: { ...process.env, CHAQ_ENV_ROOT: environmentDirectory },
      encoding: "utf8",
      windowsHide: true
    });
    assert.equal(result.status, 0, result.stderr);
    const internalValues = parseEnv(fs.readFileSync(internalFile, "utf8"));
    const workspaceValues = parseDotenv(fs.readFileSync(workspaceFile, "utf8"));
    assert.deepEqual(workspaceValues, { CUSTOM_SETTING: "Keep # this", ...internalValues });
    for (const [key, value] of Object.entries(secrets)) assert.equal(workspaceValues[key], value);
    assert.equal(workspaceValues.CHAQ_PG_BIN, path.join(internalDirectory, "postgresql", "bin"));
    assert.equal(workspaceValues.CHAQ_PG_DATA_DIR, path.join(internalDirectory, "postgres-data"));
  }
});

test("double-quoted JSON escapes are decoded and legacy non-JSON quotes stay compatible", () => {
  assert.deepEqual(parseEnv(String.raw`
JSON="first\nsecond\t\"quoted\""
LEGACY="C:\Work Space\Chaq"
UNESCAPED_QUOTE="Alpha123"local"
`), {
    JSON: 'first\nsecond\t"quoted"',
    LEGACY: String.raw`C:\Work Space\Chaq`,
    UNESCAPED_QUOTE: 'Alpha123"local'
  });
});

test("ordinary environment lines retain whitespace, comments and duplicate-key behavior", () => {
  assert.deepEqual(parseEnv("\uFEFF # ignored\r\nA = one=two \r\nB=\" three four \"\r\nEMPTY=\r\nA=last\r\ninvalid\r\n=value\r\n"), {
    A: "last",
    B: " three four ",
    EMPTY: ""
  });
  assert.deepEqual(parseEnv(undefined), {});
});

test("generated credentials and paths agree between account setup, validation and displayed login", (context) => {
  const values = {
    CHAQ_PREVIEW_USERNAME: "preview",
    CHAQ_PREVIEW_PASSWORD: 'Alpha123"local\\secret',
    CHAQ_ADMIN_PASSWORD: 'Alpha123"local\\secret',
    CHAQ_PG_DATA_DIR: "C:\\Work Space\\Chaq\\.chaq-data\\postgres-data"
  };
  const file = environmentFixture(context, serializePreviewEnv(values));
  const accountEnvironment = {};
  parseEnvFile(file, accountEnvironment);
  assert.deepEqual(accountEnvironment, values);
  assert.deepEqual(loadEnvironment(["--env-file", file], {}).env, values);
  assert.equal(readPreviewLogin(file).values.CHAQ_PREVIEW_PASSWORD, accountEnvironment.CHAQ_ADMIN_PASSWORD);
});

test("account setup keeps existing non-empty environment values and first non-empty file assignments", (context) => {
  const file = environmentFixture(context, "PRESENT=file\nMISSING=first\nMISSING=second\nEMPTY=\nEMPTY=filled\n");
  const environment = { PRESENT: "inherited", EMPTY: "" };
  parseEnvFile(file, environment);
  assert.deepEqual(environment, { PRESENT: "inherited", MISSING: "first", EMPTY: "filled" });
  assert.equal(loadEnvironment(["--env-file", file], { PRESENT: "inherited" }).env.PRESENT, "inherited");
});
