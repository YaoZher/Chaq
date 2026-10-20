const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const path = require("node:path");
const { parseEnv, previewProjectPaths, previewValues, readPreviewLogin, serializePreviewEnv } = require("./prepare-preview-env");

test("preview paths are always rooted in the repository instead of machine overrides", () => {
  const root = path.resolve("E:\\workspace\\Chaq");
  const paths = previewProjectPaths(root);
  assert.equal(paths.previewEnv, path.join(root, ".chaq-data", "preview.env"));
  assert.equal(paths.postgresData, path.join(root, ".chaq-data", "postgres-data"));
  assert.equal(paths.projectLogs, path.join(root, ".logs"));
});

test("show-login is strictly read-only and rejects missing or invalid credentials", (context) => {
  const fixtures = path.join(process.cwd(), ".chaq-data");
  fs.mkdirSync(fixtures, { recursive: true });
  const directory = fs.mkdtempSync(path.join(fixtures, "preview-login-test-"));
  const file = path.join(directory, "preview.env");
  context.after(() => fs.rmSync(directory, { force: true, recursive: true }));

  assert.throws(() => readPreviewLogin(file), /does not exist yet/);
  fs.writeFileSync(file, "CHAQ_PREVIEW_USERNAME=preview\nCHAQ_PREVIEW_PASSWORD=invalid\n", "utf8");
  assert.throws(() => readPreviewLogin(file), /missing or invalid/);
  fs.writeFileSync(file, "CHAQ_PREVIEW_USERNAME=preview\nCHAQ_PREVIEW_PASSWORD=StrongPass9\n", "utf8");
  assert.equal(readPreviewLogin(file).values.CHAQ_PREVIEW_USERNAME, "preview");
});

test("local preview environment is loopback-only and preserves generated credentials", () => {
  let generated = 0;
  const createSecret = () => `generated-secret-${String(++generated).padStart(40, "x")}`;
  const first = previewValues({}, createSecret);
  const second = previewValues(first, () => { throw new Error("credentials should be preserved"); });

  assert.equal(first.NODE_ENV, "production");
  assert.equal(first.CHAQ_RUNTIME_PROFILE, "local-preview");
  assert.equal(first.CHAQ_MAIL_MODE, "log");
  assert.equal(first.SERVER_HOST, "127.0.0.1");
  assert.match(first.PUBLIC_API_URL, /^http:\/\/127\.0\.0\.1:24538\/api$/);
  assert.match(first.DATABASE_URL, /\/chaq_preview\?schema=public$/);
  assert.equal(first.REDIS_URL, "redis://127.0.0.1:46379/1");
  assert.equal(first.TRUST_PROXY, "");
  assert.equal(first.PAYMENT_ACCOUNT_NUMBER, "");
  assert.equal(second.MODEL_SECRET_KEY, first.MODEL_SECRET_KEY);
  assert.equal(second.SESSION_HASH_SECRET, first.SESSION_HASH_SECRET);
  assert.equal(second.CHAQ_PREVIEW_PASSWORD, first.CHAQ_PREVIEW_PASSWORD);
});

test("local preview serialization round-trips values containing spaces and equals signs", () => {
  const text = serializePreviewEnv({ SIMPLE: "value", COMPLEX: "one two=three" });
  assert.deepEqual(parseEnv(text), { SIMPLE: "value", COMPLEX: "one two=three" });
});

test("unsafe inherited preview endpoints and mail settings are overwritten", () => {
  const values = previewValues({
    SERVER_HOST: "0.0.0.0",
    PUBLIC_API_URL: "https://remote.example/api",
    SMTP_HOST: "smtp.example.test",
    TRUST_PROXY: "true",
    PAYMENT_ACCOUNT_NUMBER: "unsafe"
  }, () => "a-secure-generated-secret-value-that-is-long-enough");

  assert.equal(values.SERVER_HOST, "127.0.0.1");
  assert.equal(values.PUBLIC_API_URL, "http://127.0.0.1:24538/api");
  assert.equal(values.TRUST_PROXY, "");
  assert.equal(values.PAYMENT_ACCOUNT_NUMBER, "");
  assert.equal("SMTP_HOST" in values, false);
});

test("explicit local test credentials survive preview regeneration without weakening default credentials", () => {
  const createSecret = () => "a-secure-generated-secret-value-that-is-long-enough";
  const enabled = previewValues({
    CHAQ_ALLOW_LOCAL_TEST_PASSWORDS: "1",
    CHAQ_PREVIEW_USERNAME: "admin",
    CHAQ_PREVIEW_PASSWORD: "123456"
  }, createSecret);
  assert.equal(enabled.CHAQ_PREVIEW_PASSWORD, "123456");
  assert.equal(enabled.CHAQ_ALLOW_LOCAL_TEST_PASSWORDS, "1");
  assert.equal(previewValues(enabled, createSecret).CHAQ_PREVIEW_PASSWORD, "123456");

  for (const flag of [undefined, "0", "true"]) {
    const ordinary = previewValues({ CHAQ_ALLOW_LOCAL_TEST_PASSWORDS: flag, CHAQ_PREVIEW_PASSWORD: "123456" }, createSecret);
    assert.equal(ordinary.CHAQ_ALLOW_LOCAL_TEST_PASSWORDS, "0");
    assert.notEqual(ordinary.CHAQ_PREVIEW_PASSWORD, "123456");
    assert.match(ordinary.CHAQ_PREVIEW_PASSWORD, /^(?=.*[A-Za-z])(?=.*\d).{8,64}$/);
  }
});

test("show-login accepts opted-in test credentials only from an isolated preview environment", (context) => {
  const fixtureRoot = path.resolve(__dirname, "..", ".chaq-data", "test-tmp");
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(fixtureRoot, "preview-test-login-"));
  context.after(() => {
    assert.equal(path.dirname(directory), fixtureRoot);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const file = path.join(directory, "preview.env");
  const values = previewValues({
    CHAQ_ALLOW_LOCAL_TEST_PASSWORDS: "1",
    CHAQ_PREVIEW_USERNAME: "admin",
    CHAQ_PREVIEW_PASSWORD: "123456"
  });
  const serialized = serializePreviewEnv(values);
  fs.writeFileSync(file, serialized, "utf8");
  assert.equal(readPreviewLogin(file).values.CHAQ_PREVIEW_PASSWORD, "123456");
  assert.equal(fs.readFileSync(file, "utf8"), serialized);
  for (const overrides of [
    { CHAQ_RUNTIME_PROFILE: "production" },
    { CHAQ_ALLOW_LOCAL_TEST_PASSWORDS: "0" },
    { SERVER_HOST: "0.0.0.0" },
    { DATABASE_URL: "postgresql://chaq:chaq@127.0.0.1:45432/chaq" },
    { REDIS_URL: "redis://127.0.0.1:46379/0" }
  ]) {
    fs.writeFileSync(file, serializePreviewEnv({ ...values, ...overrides }), "utf8");
    assert.throws(() => readPreviewLogin(file), /missing or invalid/);
  }
});
