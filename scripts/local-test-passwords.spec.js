const assert = require("node:assert/strict");
const test = require("node:test");
const { assertPassword } = require("./create-admin-user");
const { allowsLocalTestPasswords, validAccountPassword } = require("./local-test-passwords");

function localEnvironment(overrides = {}) {
  return {
    NODE_ENV: "production",
    CHAQ_RUNTIME_PROFILE: "local-preview",
    CHAQ_ALLOW_LOCAL_TEST_PASSWORDS: "1",
    SERVER_HOST: "127.0.0.1",
    PUBLIC_API_URL: "http://127.0.0.1:24538/api",
    DATABASE_URL: "postgresql://chaq:chaq@127.0.0.1:45432/chaq_preview?schema=public",
    REDIS_URL: "redis://127.0.0.1:46379/1",
    ...overrides
  };
}

test("short test passwords require both explicit opt-in and every isolated preview endpoint", () => {
  const isolated = localEnvironment();
  assert.equal(allowsLocalTestPasswords(isolated), true);
  assert.doesNotThrow(() => assertPassword("123456", isolated));

  const unsafeOverrides = [
    { CHAQ_ALLOW_LOCAL_TEST_PASSWORDS: undefined },
    { CHAQ_ALLOW_LOCAL_TEST_PASSWORDS: "true" },
    { CHAQ_ALLOW_LOCAL_TEST_PASSWORDS: "0" },
    { CHAQ_RUNTIME_PROFILE: undefined },
    { CHAQ_RUNTIME_PROFILE: "production" },
    { SERVER_HOST: "0.0.0.0" },
    { SERVER_HOST: "::" },
    { PUBLIC_API_URL: "https://remote.example/api" },
    { PUBLIC_API_URL: "http://127.0.0.1.example.test/api" },
    { PUBLIC_API_URL: "http://127.0.0.1@remote.example/api" },
    { PUBLIC_API_URL: "not-a-url" },
    { DATABASE_URL: "postgresql://chaq:chaq@remote.example:45432/chaq_preview" },
    { DATABASE_URL: "postgresql://chaq:chaq@127.0.0.1:5432/chaq_preview" },
    { DATABASE_URL: "postgresql://chaq:chaq@127.0.0.1:45432/chaq" },
    { DATABASE_URL: "postgresql://chaq:chaq@127.0.0.1:45432/chaq_preview?host=remote.example" },
    { DATABASE_URL: "postgresql://chaq:chaq@127.0.0.1:45432/chaq_preview?schema=production" },
    { REDIS_URL: "redis://remote.example:46379/1" },
    { REDIS_URL: "redis://127.0.0.1:6379/1" },
    { REDIS_URL: "redis://127.0.0.1:46379/0" },
    { REDIS_URL: "redis://127.0.0.1:46379/1?db=0" }
  ];
  for (const overrides of unsafeOverrides) {
    const environment = localEnvironment(overrides);
    assert.equal(allowsLocalTestPasswords(environment), false, JSON.stringify(overrides));
    assert.throws(() => assertPassword("123456", environment), /8-64 characters/, JSON.stringify(overrides));
  }
});

test("local test password boundaries do not change ordinary administrator password requirements", () => {
  const isolated = localEnvironment();
  for (const value of ["123456", "x".repeat(64)]) assert.equal(validAccountPassword(value, isolated), true);
  for (const value of ["12345", "x".repeat(65), "123456\n", "123456\r", undefined, 123456]) {
    assert.equal(validAccountPassword(value, isolated), false);
  }
  for (const environment of [{}, { NODE_ENV: "production" }, { CHAQ_ALLOW_LOCAL_TEST_PASSWORDS: "1" }]) {
    assert.doesNotThrow(() => assertPassword("StrongPass9", environment));
    for (const value of ["123456", "12345678", "abcdefgh", "Alpha9", "A9".repeat(33), "StrongPass9\n"]) {
      assert.throws(() => assertPassword(value, environment), /8-64 characters/);
    }
  }
  assert.throws(() => assertPassword("12345", isolated), /6-64 characters/);
});

test("localhost and IPv6 loopback use the same isolated database and Redis boundaries", () => {
  for (const host of ["localhost", "[::1]"]) {
    assert.equal(allowsLocalTestPasswords(localEnvironment({
      SERVER_HOST: host === "[::1]" ? "::1" : host,
      PUBLIC_API_URL: `http://${host}:24538/api`,
      DATABASE_URL: `postgresql://chaq:chaq@${host}:45432/chaq_preview`,
      REDIS_URL: `redis://${host}:46379/1`
    })), true);
  }
});
