const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const test = require("node:test");

const projectRoot = path.resolve(__dirname, "..");
const fixtureParent = path.join(projectRoot, ".chaq-data", "test-tmp");
const windowsOnly = { skip: process.platform !== "win32", timeout: 45_000 };

async function waitFor(predicate, description, processState) {
  const deadline = Date.now() + 20_000;
  while (!predicate()) {
    if (processState && (processState.child.exitCode !== null || processState.child.signalCode !== null)) {
      throw new Error(`Process exited before ${description}: ${processState.output()}`);
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}.`);
    await delay(50);
  }
}

function fixture(t) {
  fs.mkdirSync(fixtureParent, { recursive: true });
  // Spaces and a shell metacharacter exercise the real public batch entry.
  const root = fs.mkdtempSync(path.join(fixtureParent, "Chaq preview & "));
  const toolsDirectory = path.join(root, "tools");
  fs.mkdirSync(toolsDirectory);
  for (const name of ["start-preview.bat", "start-preview.ps1"]) {
    const contents = fs.readFileSync(path.join(projectRoot, "tools", name), "utf8");
    fs.writeFileSync(path.join(toolsDirectory, name), contents.replace(/\r?\n/g, "\r\n"));
  }
  const runtime = [
    "@echo off",
    `"${process.execPath.replace(/%/g, "%%")}" "%~dp0preview-fixture.cjs"`,
    "exit /b %errorlevel%",
    ""
  ].join("\r\n");
  fs.writeFileSync(path.join(toolsDirectory, "start-preview-runtime.bat"), runtime);
  fs.writeFileSync(path.join(toolsDirectory, "preview-fixture.cjs"), `
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const control = JSON.parse(fs.readFileSync(path.join(root, "control.json"), "utf8"));
fs.appendFileSync(path.join(root, "runs.txt"), process.pid + "\\n");
fs.writeFileSync(path.join(root, "started.txt"), "ready");
async function run() {
  while (control.wait && !fs.existsSync(path.join(root, "release.txt"))) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  process.exit(control.code);
}
run();
`);

  const children = [];
  function start(command, args) {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, CHAQ_NONINTERACTIVE: "1" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const result = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal, output }));
    });
    // Keep failures observed even when a readiness assertion fails first.
    result.catch(() => {});
    const processState = { child, result, output: () => output };
    children.push(processState);
    return processState;
  }

  t.after(async () => {
    fs.writeFileSync(path.join(root, "release.txt"), "release");
    for (const { child, result } of children) {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      }
      await result.catch(() => {});
    }
    const relative = path.relative(fixtureParent, path.resolve(root));
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  return {
    root,
    start,
    configure: (control) => fs.writeFileSync(path.join(root, "control.json"), JSON.stringify(control)),
    launch: () => start(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "tools\\start-preview.bat"]),
    waitStarted: (processState) => waitFor(() => fs.existsSync(path.join(root, "started.txt")), "the synthetic preview runtime", processState),
    release: () => fs.writeFileSync(path.join(root, "release.txt"), "release"),
    runCount: () => fs.readFileSync(path.join(root, "runs.txt"), "utf8").trim().split(/\r?\n/).length
  };
}

test("preview startup ignores a concurrent click and releases the lock after success", windowsOnly, async (t) => {
  const preview = fixture(t);
  preview.configure({ wait: true, code: 0 });
  const first = preview.launch();
  await preview.waitStarted(first);

  const duplicate = await preview.launch().result;
  assert.equal(duplicate.code, 0, duplicate.output);
  assert.match(duplicate.output, /already starting/);
  assert.equal(first.child.exitCode, null);
  assert.equal(preview.runCount(), 1);

  preview.release();
  const completed = await first.result;
  assert.equal(completed.code, 0, completed.output);
  const restarted = await preview.launch().result;
  assert.equal(restarted.code, 0, restarted.output);
  assert.equal(preview.runCount(), 2);
});

test("preview startup preserves failure status and permits a subsequent retry", windowsOnly, async (t) => {
  const preview = fixture(t);
  preview.configure({ wait: false, code: 42 });
  const failed = await preview.launch().result;
  assert.equal(failed.code, 42, failed.output);

  preview.configure({ wait: false, code: 0 });
  const retried = await preview.launch().result;
  assert.equal(retried.code, 0, retried.output);
  assert.equal(preview.runCount(), 2);
});

test("preview startup locks are separate for independent checkouts", windowsOnly, async (t) => {
  const firstPreview = fixture(t);
  const secondPreview = fixture(t);
  firstPreview.configure({ wait: true, code: 0 });
  secondPreview.configure({ wait: true, code: 0 });
  const first = firstPreview.launch();
  const second = secondPreview.launch();
  await Promise.all([firstPreview.waitStarted(first), secondPreview.waitStarted(second)]);
  assert.equal(firstPreview.runCount(), 1);
  assert.equal(secondPreview.runCount(), 1);
  firstPreview.release();
  secondPreview.release();
  for (const result of await Promise.all([first.result, second.result])) {
    assert.equal(result.code, 0, result.output);
  }
});

test("preview startup recovers when a lock-owning process exits unexpectedly", windowsOnly, async (t) => {
  const preview = fixture(t);
  preview.configure({ wait: false, code: 0 });
  const holderScript = path.join(preview.root, "tools", "hold-lock.ps1");
  fs.writeFileSync(holderScript, `
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\\', '/')
$algorithm = [Security.Cryptography.SHA256]::Create()
$hash = [BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($projectRoot.ToUpperInvariant()))).Replace('-', '')
$algorithm.Dispose()
$guard = [Threading.Mutex]::new($false, "Local\\ChaqPreviewStartup-$hash")
[void]$guard.WaitOne()
[IO.File]::WriteAllText((Join-Path $projectRoot 'held.txt'), 'ready')
Start-Sleep -Seconds 120
`);
  const holder = preview.start("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "RemoteSigned", "-File", holderScript]);
  await waitFor(() => fs.existsSync(path.join(preview.root, "held.txt")), "the synthetic mutex holder", holder);
  const duplicate = await preview.launch().result;
  assert.equal(duplicate.code, 0, duplicate.output);
  assert.match(duplicate.output, /already starting/);
  assert.equal(fs.existsSync(path.join(preview.root, "started.txt")), false);

  holder.child.kill();
  await holder.result;
  const recovered = await preview.launch().result;
  assert.equal(recovered.code, 0, recovered.output);
  assert.equal(preview.runCount(), 1);
});
