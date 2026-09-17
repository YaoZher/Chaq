const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sessionTest", {
  complete: (results) => ipcRenderer.send("session-test:complete", results)
});
