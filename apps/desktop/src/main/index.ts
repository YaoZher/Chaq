import { app, BrowserWindow, dialog, ipcMain, safeStorage, screen } from "electron";
import type { IpcMainInvokeEvent, OpenDialogOptions } from "electron";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ChatMessage, SkillAutoMessageSettings, SkillDraft, SkillSourceKind, SkillSummary } from "@chaq/shared";
import { LocalDatabase } from "./local-db";
import { MAX_IMAGE_FILE_BYTES, MAX_IMPORT_FILE_BYTES, readFileWithLimit } from "./limited-file-reader";
import { RememberedSessionVault } from "./remembered-session-vault";
import { createStorageLayout, selectWritableStorageRoot, storageRootCandidates } from "./storage-paths";
import { normalizeSessionToken, UtilityBootstrapTokenStore } from "./utility-bootstrap-tokens";

let mainWindow: BrowserWindow | null = null;
let localDb: LocalDatabase;
let rememberedSessionVault: RememberedSessionVault;
const utilityBootstrapTokens = new UtilityBootstrapTokenStore();

const rendererFileUrl = pathToFileURL(join(__dirname, "../renderer/index.html"));
const developmentRendererUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;

const storageReady = configureStoragePaths();

// electron-vite shares electron.exe with other local apps, so its strict port
// check is the reliable development lock. Packaged Chaq keeps the OS lock.
const hasSingleInstanceLock = storageReady
  && (Boolean(developmentRendererUrl) || app.requestSingleInstanceLock());
if (!hasSingleInstanceLock) app.quit();

app.on("second-instance", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

function configureStoragePaths(): boolean {
  try {
    const candidates = storageRootCandidates({
      isPackaged: app.isPackaged,
      executablePath: process.execPath,
      moduleDir: __dirname,
      desktopPath: app.getPath("desktop"),
      environmentRoot: process.env.CHAQ_ENV_ROOT,
      projectRoot: process.env.CHAQ_PROJECT_ROOT
    });
    const root = selectWritableStorageRoot(candidates);
    if (!root) {
      throw new Error(`没有可写的数据目录。已尝试：${candidates.join("、")}`);
    }
    const layout = createStorageLayout(root, process.env.CHAQ_RUNTIME_CACHE);
    mkdirSync(layout.userData, { recursive: true });
    mkdirSync(layout.diskCache, { recursive: true });
    mkdirSync(layout.sessionData, { recursive: true });
    const previousLocalStorage = join(layout.userData, "Local Storage");
    const migratedLocalStorage = join(layout.sessionData, "Local Storage");
    if (!existsSync(migratedLocalStorage) && existsSync(previousLocalStorage)) {
      cpSync(previousLocalStorage, migratedLocalStorage, { recursive: true });
    }
    app.setPath("userData", layout.userData);
    app.setPath("sessionData", layout.sessionData);
    app.commandLine.appendSwitch("disk-cache-dir", layout.diskCache);
    if (!app.isPackaged && process.env.NODE_ENV !== "production" && /^\d{2,5}$/.test(process.env.CHAQ_DEVTOOLS_PORT ?? "")) {
      app.commandLine.appendSwitch("remote-debugging-port", process.env.CHAQ_DEVTOOLS_PORT);
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Chaq storage initialization failed: ${message}`);
    dialog.showErrorBox("Chaq 无法启动", `无法初始化本地数据目录。\n\n${message}`);
    app.quit();
    return false;
  }
}

function isTrustedRendererUrl(target: string): boolean {
  try {
    const targetUrl = new URL(target);
    if (developmentRendererUrl) {
      return targetUrl.origin === new URL(developmentRendererUrl).origin;
    }
    return targetUrl.protocol === "file:" && targetUrl.pathname === rendererFileUrl.pathname;
  } catch {
    return false;
  }
}

function assertTrustedIpcSender(event: IpcMainInvokeEvent): void {
  const senderUrl = event.senderFrame?.url ?? event.sender.getURL();
  if (!isTrustedRendererUrl(senderUrl)) {
    throw new Error("Blocked IPC call from an untrusted renderer.");
  }
}

function assertMainWindowIpcSender(event: IpcMainInvokeEvent): void {
  assertTrustedIpcSender(event);
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (!mainWindow || senderWindow !== mainWindow || (event.senderFrame && event.senderFrame !== event.sender.mainFrame)) {
    throw new Error("Blocked credential-vault access outside the main application window.");
  }
}

function hardenWindow(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, target) => {
    if (!isTrustedRendererUrl(target)) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event, target) => {
    if (!isTrustedRendererUrl(target)) event.preventDefault();
  });
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  window.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error(`Preload failed (${preloadPath}): ${error.message}`);
  });
  window.webContents.on("did-fail-load", (_event, code, description, target) => {
    console.error(`Renderer load failed (${code}) ${description}: ${target}`);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    console.error(`Renderer process exited: ${details.reason} (${details.exitCode})`);
  });
  window.webContents.on("console-message", (_event, level, message, line, source) => {
    if (level >= 2) console.error(`Renderer console [${source}:${line}]: ${message}`);
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 620,
    minWidth: 380,
    minHeight: 560,
    title: "Chaq",
    frame: false,
    resizable: false,
    transparent: false,
    backgroundColor: "#121217",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  hardenWindow(mainWindow);

  if (developmentRendererUrl) {
    void mainWindow.loadURL(developmentRendererUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function registerIpc(): void {
  ipcMain.handle("skills:list", () => localDb.listSkills());
  ipcMain.handle("skills:get", (_event, id: string) => localDb.getSkill(id));
  ipcMain.handle("skills:cache", (_event, skills: SkillSummary[]) => localDb.cacheSkills(skills));
  ipcMain.handle("skills:create", (_event, payload: { skill: SkillDraft; sourceKind?: SkillSourceKind; id?: string }) =>
    localDb.createSkill(payload.skill, payload.sourceKind, payload.id)
  );
  ipcMain.handle("skills:update", (_event, payload: { id: string; skill: SkillDraft; sourceKind?: SkillSourceKind }) =>
    localDb.updateSkill(payload.id, payload.skill, payload.sourceKind)
  );
  ipcMain.handle("skills:delete", (_event, id: string) => localDb.deleteSkill(id));
  ipcMain.handle("skills:versions", (_event, skillId: string) => localDb.listVersions(skillId));
  ipcMain.handle("skills:auto-settings:get", (_event, skillId: string) => localDb.getSkillAutoMessageSettings(skillId));
  ipcMain.handle("skills:auto-settings:save", (_event, settings: SkillAutoMessageSettings) =>
    localDb.saveSkillAutoMessageSettings(settings)
  );

  ipcMain.handle("messages:list", (_event, skillId: string) => localDb.listMessages(skillId));
  ipcMain.handle("messages:add", (_event, payload: { skillId: string; role: ChatMessage["role"]; content: string; modelLabel?: string | null }) =>
    localDb.addMessage(payload)
  );
  ipcMain.handle("messages:clear", (_event, skillId: string) => localDb.clearMessages(skillId));

  ipcMain.handle("imports:open-file", async () => {
    const options: OpenDialogOptions = {
      properties: ["openFile"],
      filters: [
        { name: "Chat exports", extensions: ["txt", "csv", "json", "html", "htm", "md", "markdown"] },
        { name: "All files", extensions: ["*"] }
      ]
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    const filePath = result.filePaths[0];
    const bytes = await readFileWithLimit(filePath, MAX_IMPORT_FILE_BYTES, "导入文件");
    return {
      filePath,
      fileName: filePath.split(/[\\/]/).pop() ?? "import.txt",
      content: bytes.toString("utf8")
    };
  });
  ipcMain.handle("imports:save", (_event, payload: Parameters<LocalDatabase["saveImport"]>[0]) => localDb.saveImport(payload));

  ipcMain.handle("files:open-background-image", () => openImageFile());
  ipcMain.handle("files:open-image", () => openImageFile());

  ipcMain.handle("window:minimize", (event) => {
    const target = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    target?.minimize();
  });
  ipcMain.handle("window:maximize", (event) => {
    const target = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    if (!target) return;
    if (target.isMaximized()) {
      target.unmaximize();
    } else {
      target.maximize();
    }
  });
  ipcMain.handle("window:close", (event) => {
    const target = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    if (target && target === mainWindow) {
      app.quit();
      return;
    }
    target?.close();
  });
  ipcMain.handle("auth:consume-window-bootstrap", (event) => {
    assertTrustedIpcSender(event);
    if (event.senderFrame && event.senderFrame !== event.sender.mainFrame) {
      throw new Error("Blocked bootstrap credential request from a child frame.");
    }
    return utilityBootstrapTokens.consume(event.sender.id);
  });
  ipcMain.handle("auth:remembered-session:save", (event, payload: { accountId: string; sessionToken: string; expiresAt: string }) => {
    assertMainWindowIpcSender(event);
    rememberedSessionVault.save(payload);
  });
  ipcMain.handle("auth:remembered-session:get", (event, accountId: string) => {
    assertMainWindowIpcSender(event);
    return rememberedSessionVault.get(accountId);
  });
  ipcMain.handle("auth:remembered-session:delete", (event, accountId: string) => {
    assertMainWindowIpcSender(event);
    rememberedSessionVault.delete(accountId);
  });
  ipcMain.handle("auth:broadcast-logout", (event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      // The sender already cleared its session synchronously. Echoing its old
      // logout could cancel a new login started while the IPC was in flight.
      if (!window.isDestroyed() && window.webContents.id !== event.sender.id) window.webContents.send("auth:logged-out");
    }
  });
  ipcMain.handle("window:set-mode", (_event, mode: "login" | "main") => {
    if (!mainWindow) return;
    if (mode === "main") {
      mainWindow.setResizable(true);
      mainWindow.setMinimumSize(1080, 720);
      mainWindow.setSize(1280, 820);
      mainWindow.center();
    } else {
      mainWindow.setResizable(false);
      mainWindow.setMinimumSize(380, 560);
      mainWindow.setSize(420, 620);
      mainWindow.center();
    }
  });
  ipcMain.handle("window:set-opacity", (_event, opacity: number) => {
    mainWindow?.setOpacity(Math.min(1, Math.max(0.7, opacity)));
  });
  ipcMain.handle("window:flash-frame", (event, enabled: boolean) => {
    const target = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    target?.flashFrame(Boolean(enabled));
  });
  ipcMain.handle("window:open-settings", (_event, token?: string | null) => {
    openUtilityWindow({ settingsWindow: "1" }, token, { width: 980, height: 640, title: "Chaq Settings" });
  });
  ipcMain.handle("window:open-profile", (event, payload?: string | null | { token?: string | null; anchor?: AnchorRect | null }) => {
    const token = typeof payload === "object" && payload ? payload.token : payload;
    const anchor = typeof payload === "object" && payload ? payload.anchor : null;
    const parent = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    const position = parent && anchor ? profilePopupPosition(parent, anchor, 300, 340) : {};
    openUtilityWindow({ profileWindow: "1" }, token, { width: 300, height: 340, title: "Chaq Profile", ...position });
  });
  ipcMain.handle("window:open-profile-edit", (_event, token?: string | null) => {
    openUtilityWindow({ profileEditWindow: "1" }, token, { width: 760, height: 560, title: "Chaq Edit Profile" });
  });
}

type AnchorRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

async function openImageFile(): Promise<{ fileName: string; dataUrl: string } | null> {
  const options: OpenDialogOptions = {
    properties: ["openFile"],
    filters: [
      { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }
    ]
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) {
    return null;
  }
  const filePath = result.filePaths[0];
  const extension = filePath.split(".").pop()?.toLowerCase();
  const mimeType = extension === "jpg" || extension === "jpeg"
    ? "image/jpeg"
    : extension === "webp"
      ? "image/webp"
      : extension === "gif"
        ? "image/gif"
        : "image/png";
  const bytes = await readFileWithLimit(filePath, MAX_IMAGE_FILE_BYTES, "图片");
  return {
    fileName: filePath.split(/[\\/]/).pop() ?? "image",
    dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}`
  };
}

function profilePopupPosition(parent: BrowserWindow, anchor: AnchorRect, width: number, height: number): { x: number; y: number } {
  const bounds = parent.getBounds();
  const rawX = bounds.x + Math.round(anchor.x) - 12;
  const rawY = bounds.y + Math.round(anchor.y) - 12;
  const display = screen.getDisplayMatching({ x: rawX, y: rawY, width, height }).workArea;
  return {
    x: Math.min(display.x + display.width - width, Math.max(display.x, rawX)),
    y: Math.min(display.y + display.height - height, Math.max(display.y, rawY))
  };
}

function openUtilityWindow(
  queryInput: Record<string, string>,
  token: unknown,
  options: { width: number; height: number; title: string; x?: number; y?: number }
): void {
  const bootstrapToken = normalizeSessionToken(token);
  if (!bootstrapToken) throw new Error("登录状态无效，无法打开工具窗口。请重新登录后重试。");
  const utilityWindow = new BrowserWindow({
    width: options.width,
    height: options.height,
    x: options.x,
    y: options.y,
    minWidth: options.width,
    maxWidth: options.width,
    minHeight: options.height,
    maxHeight: options.height,
    resizable: false,
    frame: false,
    title: options.title,
    backgroundColor: "#111116",
    parent: mainWindow ?? undefined,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  hardenWindow(utilityWindow);
  utilityBootstrapTokens.issue(utilityWindow.webContents.id, bootstrapToken);
  utilityWindow.on("closed", () => {
    utilityBootstrapTokens.revoke(utilityWindow.webContents.id);
  });
  const query = new URLSearchParams(queryInput);
  if (developmentRendererUrl) {
    void utilityWindow.loadURL(`${developmentRendererUrl}?${query.toString()}`);
  } else {
    void utilityWindow.loadFile(join(__dirname, "../renderer/index.html"), { query: Object.fromEntries(query.entries()) });
  }
}

function createCodec() {
  return {
    encrypt(value: string): string {
      if (safeStorage.isEncryptionAvailable()) {
        return `safe:${safeStorage.encryptString(value).toString("base64")}`;
      }
      return `plain:${Buffer.from(value, "utf8").toString("base64")}`;
    },
    decrypt(value: string): string {
      if (value.startsWith("safe:")) {
        return safeStorage.decryptString(Buffer.from(value.slice(5), "base64"));
      }
      if (value.startsWith("plain:")) {
        return Buffer.from(value.slice(6), "base64").toString("utf8");
      }
      return value;
    }
  };
}

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  localDb = await LocalDatabase.create(join(app.getPath("userData"), "chaq.db"), createCodec());
  rememberedSessionVault = new RememberedSessionVault(
    join(app.getPath("userData"), "remembered-sessions.json"),
    {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (value) => safeStorage.encryptString(value),
      decryptString: (value) => safeStorage.decryptString(value)
    }
  );
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (process.platform !== "darwin") {
      return;
    }
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}).catch((error) => {
  console.error(error);
  app.quit();
});

app.on("before-quit", (event) => {
  if (typeof localDb === "undefined") {
    return;
  }
  try {
    localDb.close();
  } catch (error) {
    event.preventDefault();
    const message = error instanceof Error ? error.message : String(error);
    console.error("Failed to flush the local database before quitting.", error);
    dialog.showErrorBox("Chaq 无法安全退出", `本地数据尚未成功保存，请检查数据目录后重试。\n\n${message}`);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
