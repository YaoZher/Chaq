const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");

function argument(name) {
  const value = process.argv.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value || !path.isAbsolute(value)) throw new Error(`Missing absolute ${name} argument.`);
  return value;
}

const output = argument("--session-test-dist");
app.setPath("userData", argument("--session-test-profile"));
app.disableHardwareAcceleration();
let window;
let completed = false;
const blockedRequests = [];

function finish(code, message) {
  if (completed) return;
  completed = true;
  clearTimeout(timeout);
  if (message) console.error(`[session-test] ${message}`);
  app.exit(code);
}

const timeout = setTimeout(() => finish(1, "Renderer lifecycle checks exceeded 35 seconds."), 35_000);

ipcMain.on("session-test:complete", (event, results) => {
  if (event.sender !== window?.webContents || !Array.isArray(results) || !results.length) {
    finish(1, "Invalid test result report.");
    return;
  }
  let failed = 0;
  for (const result of results) {
    if (!result || typeof result.name !== "string" || typeof result.passed !== "boolean") {
      finish(1, "Invalid test result entry.");
      return;
    }
    if (!result.passed) failed += 1;
    console.log(`[${result.passed ? "PASS" : "FAIL"}] ${result.name}`);
    if (result.error) console.error(result.error);
  }
  if (blockedRequests.length) {
    failed += 1;
    console.error(`[session-test] Unexpected network requests were blocked: ${blockedRequests.join(", ")}`);
  }
  console.log(`[session-test] ${results.length - results.filter((result) => !result.passed).length}/${results.length} passed; ${failed} failure(s).`);
  finish(failed ? 1 : 0);
});

app.whenReady().then(async () => {
  window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "session-lifecycle-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      partition: "session-lifecycle-test"
    }
  });
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const external = !details.url.startsWith("file:");
    if (external) blockedRequests.push(new URL(details.url).origin);
    callback({ cancel: external });
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("render-process-gone", (_event, details) => finish(1, `Renderer exited: ${details.reason}.`));
  await window.loadFile(path.join(output, "session-lifecycle.html"));
}).catch((error) => finish(1, error instanceof Error ? error.stack : String(error)));
