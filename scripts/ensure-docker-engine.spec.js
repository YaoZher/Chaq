const assert = require("node:assert/strict");
const test = require("node:test");
const {
  ensureDockerEngine,
  findDockerDesktop,
  localDockerHosts,
  probeDockerEngine,
  startDockerDesktop
} = require("./ensure-docker-engine");

function harness(overrides = {}) {
  let time = 0;
  const calls = { starts: [], probes: [], logs: [] };
  return {
    calls,
    options: {
      platform: "win32",
      environment: {},
      timeoutMs: 24000,
      now: () => time,
      sleep: async (ms) => { time += ms; },
      findDesktop: async () => "D:\\Tools\\Docker\\Docker Desktop.exe",
      startDesktop: async (options) => { calls.starts.push(options); },
      probe: async (options) => { calls.probes.push(options); return { ready: calls.starts.length > 0 }; },
      log: (message) => calls.logs.push(message),
      ...overrides
    }
  };
}

test("a ready local Linux engine is reused without locating or starting Desktop", async () => {
  const fixture = harness({
    environment: { DOCKER_CONFIG: "D:\\Chaq Data\\docker", DOCKER_TLS_VERIFY: "1" },
    probe: async () => ({ ready: true }),
    findDesktop: () => { throw new Error("Desktop lookup must not run"); }
  });
  const result = await ensureDockerEngine(fixture.options);
  assert.equal(result.started, false);
  assert.equal(result.dockerEnvironment.DOCKER_HOST, "npipe:////./pipe/dockerDesktopLinuxEngine");
  assert.equal(result.dockerEnvironment.DOCKER_CONFIG, "D:\\Chaq Data\\docker");
  assert.equal(result.dockerEnvironment.DOCKER_CONTEXT, "");
  assert.equal(result.dockerEnvironment.DOCKER_TLS_VERIFY, "");
  assert.equal(fixture.calls.starts.length, 0);
});

test("cold Windows startup waits for Linux readiness and starts Desktop once", async () => {
  const fixture = harness();
  const result = await ensureDockerEngine(fixture.options);
  assert.equal(result.started, true);
  assert.equal(fixture.calls.starts.length, 1);
  assert.equal(fixture.calls.probes.length, 3);
  assert.ok(fixture.calls.logs.some((message) => /ready/.test(message)));
});

test("Desktop startup has a deadline and periodic progress, even when probes never succeed", async () => {
  const fixture = harness({ probe: async () => ({ ready: false, detail: "WSL is unavailable" }) });
  await assert.rejects(ensureDockerEngine(fixture.options), /within 24 seconds.*WSL is unavailable/);
  assert.equal(fixture.calls.starts.length, 1);
  assert.ok(fixture.calls.logs.filter((message) => /still starting/.test(message)).length >= 2);
});

test("Windows container mode fails clearly without starting or switching the engine", async () => {
  const fixture = harness({ probe: async () => ({ ready: false, windowsContainers: true }) });
  await assert.rejects(ensureDockerEngine(fixture.options), /Switch Docker Desktop to Linux containers/);
  assert.equal(fixture.calls.starts.length, 0);
});

test("missing CLI and missing Desktop produce distinct actionable errors", async () => {
  const missingCli = harness({ probe: async () => ({ ready: false, missingCli: true }) });
  await assert.rejects(ensureDockerEngine(missingCli.options), /Docker CLI was not found/);
  const missingDesktop = harness({ findDesktop: async () => null, probe: async () => ({ ready: false }) });
  await assert.rejects(ensureDockerEngine(missingDesktop.options), /Docker Desktop was not found/);
  assert.equal(missingCli.calls.starts.length + missingDesktop.calls.starts.length, 0);
});

test("non-Windows machines reuse ready local sockets but do not attempt Desktop startup", async () => {
  const ready = harness({ platform: "linux", environment: { DOCKER_HOST: "unix:///run/user/1000/docker.sock" }, probe: async () => ({ ready: true }) });
  assert.equal((await ensureDockerEngine(ready.options)).started, false);
  const stopped = harness({ platform: "linux", probe: async () => ({ ready: false }) });
  await assert.rejects(ensureDockerEngine(stopped.options), /Start Docker Engine or Docker Desktop/);
  assert.equal(stopped.calls.starts.length, 0);
});

test("remote endpoints and custom contexts are rejected before any Docker invocation", async () => {
  for (const environment of [
    { DOCKER_HOST: "tcp://127.0.0.1:2375" },
    { DOCKER_HOST: "ssh://example.test" },
    { DOCKER_HOST: "npipe:////other-host/pipe/docker_engine" },
    { DOCKER_CONTEXT: "production" }
  ]) {
    const fixture = harness({ environment });
    await assert.rejects(ensureDockerEngine(fixture.options), /remote|local Docker/);
    assert.equal(fixture.calls.probes.length, 0);
  }
  assert.deepEqual(localDockerHosts({ DOCKER_HOST: "npipe:////./pipe/custom-local-engine" }, "win32"), ["npipe:////./pipe/custom-local-engine"]);
});

test("Docker readiness commands use a bounded explicit local endpoint and never inherit TLS/context", () => {
  const host = "npipe:////./pipe/docker_engine";
  const result = probeDockerEngine({
    host, timeoutMs: 350,
    environment: { DOCKER_CONTEXT: "production", DOCKER_HOST: "ssh://example.test", DOCKER_TLS_VERIFY: "1" },
    spawn: (file, args, options) => {
      assert.equal(file, "docker");
      assert.deepEqual(args, ["--host", host, "info", "--format", "{{.OSType}}"]);
      assert.equal(options.timeout, 350);
      assert.equal(options.windowsHide, true);
      assert.equal(options.env.DOCKER_HOST, host);
      assert.equal(options.env.DOCKER_CONTEXT, "");
      assert.equal(options.env.DOCKER_TLS_VERIFY, "");
      return { status: 0, stdout: "linux\r\n" };
    }
  });
  assert.equal(result.ready, true);
});

test("a timed-out or missing Docker process is not treated as ready", () => {
  const options = { environment: {}, host: "unix:///var/run/docker.sock" };
  assert.equal(probeDockerEngine({ ...options, spawn: () => ({ status: null, error: { code: "ETIMEDOUT", message: "timed out" } }) }).ready, false);
  assert.equal(probeDockerEngine({ ...options, spawn: () => ({ status: null, error: { code: "ENOENT" } }) }).missingCli, true);
});

test("Docker Desktop is discovered beside a custom PATH installation without registry reads", () => {
  const cli = "E:\\Custom Apps\\DockerDesktop\\resources\\bin\\docker.exe";
  const desktop = "E:\\Custom Apps\\DockerDesktop\\Docker Desktop.exe";
  const found = findDockerDesktop({
    environment: { Path: '"E:\\Custom Apps\\DockerDesktop\\resources\\bin"' },
    exists: (candidate) => [cli, desktop].includes(candidate),
    realpath: (candidate) => candidate,
    spawn: () => { throw new Error("Registry lookup must not run"); }
  });
  assert.equal(found, desktop);
});

test("Desktop resolver follows a Docker CLI symlink into its installation", () => {
  const desktop = "D:\\Docker\\Docker Desktop.exe";
  assert.equal(findDockerDesktop({
    environment: { PATH: "C:\\Tools" },
    exists: (candidate) => ["C:\\Tools\\docker.exe", desktop].includes(candidate),
    realpath: () => "D:\\Docker\\resources\\bin\\docker.exe",
    spawn: () => { throw new Error("Registry lookup must not run"); }
  }), desktop);
});

test("Desktop resolver supports registry installation paths and environment expansion", () => {
  const desktop = "F:\\Apps\\Docker Desktop\\Docker Desktop.exe";
  assert.equal(findDockerDesktop({
    environment: { ProgramFiles: "F:\\Apps" },
    exists: (candidate) => candidate === desktop,
    spawn: (file, args, options) => {
      assert.equal(file, "reg.exe");
      assert.equal(args[0], "query");
      assert.equal(options.windowsHide, true);
      assert.equal(options.timeout, 2000);
      return { status: 0, stdout: "    InstallLocation    REG_EXPAND_SZ    %PROGRAMFILES%\\Docker Desktop\r\n" };
    }
  }), desktop);
});

test("Desktop startup uses the supported detached CLI with bounded execution", () => {
  let count = 0;
  startDockerDesktop({ executablePath: "D:\\Docker\\Docker Desktop.exe", environment: {}, spawn: (file, args, options) => {
    count += 1;
    assert.equal(file, "docker");
    assert.deepEqual(args, ["desktop", "start", "--detach", "--timeout", "10"]);
    assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 15000);
    return { status: 0 };
  } });
  assert.equal(count, 1);
});

test("old Docker versions fall back to hidden executable startup with the path passed as data", () => {
  const executablePath = "D:\\Apps & Tools\\$(unexpected)\\Docker Desktop.exe";
  let count = 0;
  startDockerDesktop({ executablePath, environment: {}, spawn: (file, args, options) => {
    count += 1;
    if (count === 1) return { status: 1, stderr: "docker: 'desktop' is not a docker command." };
    assert.equal(file, "powershell.exe");
    assert.ok(args.at(-1).includes("-WindowStyle Hidden"));
    assert.equal(args.at(-1).includes(executablePath), false);
    assert.equal(options.env.CHAQ_DOCKER_DESKTOP_EXE, executablePath);
    assert.equal(options.windowsHide, true);
    return { status: 0 };
  } });
  assert.equal(count, 2);
});

test("Desktop permission or WSL errors are not disguised as unsupported CLI fallback", () => {
  for (const detail of ["Access is denied", "WSL distribution failed to start"]) {
    let count = 0;
    assert.throws(() => startDockerDesktop({ executablePath: "D:\\Docker Desktop.exe", environment: {}, spawn: () => {
      count += 1;
      return { status: 1, stderr: detail };
    } }), /resolve its WSL, virtualization, or permission error/);
    assert.equal(count, 1);
  }
});
