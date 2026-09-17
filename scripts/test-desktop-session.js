const { spawn } = require("node:child_process");
const { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const tests = path.join(root, "apps", "desktop", "tests");
const temporaryRoot = path.join(root, ".chaq-data", "test-tmp");

async function main() {
  const electron = require("electron");
  if (typeof electron !== "string" || !existsSync(electron)) {
    throw new Error("The Electron runtime is missing. Run npm run electron:install first.");
  }
  mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(path.join(temporaryRoot, "desktop-session-"));
  try {
    const { build } = await import("vite");
    const { default: react } = await import("@vitejs/plugin-react");
    const output = path.join(directory, "renderer");
    await build({
      configFile: false,
      envFile: false,
      root: tests,
      base: "./",
      publicDir: false,
      logLevel: "warn",
      mode: "test",
      plugins: [react()],
      define: {
        "process.env.NODE_ENV": JSON.stringify("development"),
        "import.meta.env.VITE_SERVER_URL": JSON.stringify("https://session-test.invalid/api"),
        "import.meta.env.VITE_FORCE_SERVER_URL": JSON.stringify("1")
      },
      build: {
        outDir: output,
        emptyOutDir: false,
        minify: false,
        rollupOptions: { input: path.join(tests, "session-lifecycle.html") }
      }
    });
    console.log("[session-test] Running React lifecycle checks in an isolated hidden Electron window.");
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const status = await new Promise((resolve, reject) => {
      const child = spawn(electron, [
        path.join(tests, "session-lifecycle-main.cjs"),
        `--session-test-dist=${output}`,
        `--session-test-profile=${path.join(directory, "profile")}`
      ], {
        cwd: root,
        env: environment,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      child.stdout.pipe(process.stdout);
      child.stderr.pipe(process.stderr);
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("The isolated Electron session tests exceeded 45 seconds."));
      }, 45_000);
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("exit", (code, signal) => {
        clearTimeout(timeout);
        if (signal) reject(new Error(`Electron session tests exited after ${signal}.`));
        else resolve(code ?? 1);
      });
    });
    process.exitCode = status;
  } finally {
    // Only remove the unique directory created by this invocation.
    const actualDirectory = realpathSync(directory);
    const relative = path.relative(realpathSync(temporaryRoot), actualDirectory);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Refusing to remove a test directory outside the test temporary root.");
    }
    rmSync(actualDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  }
}

main().catch((error) => {
  console.error(`[session-test] ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
