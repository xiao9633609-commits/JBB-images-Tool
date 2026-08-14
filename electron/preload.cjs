const { contextBridge, ipcRenderer } = require("electron");

const gptImageApi = {
  request: (input) => ipcRenderer.invoke("network:request", input),
  cancel: (requestId) => ipcRenderer.invoke("network:cancel", requestId),
  readImage: (input) => ipcRenderer.invoke("network:read-image", input),
  saveImage: (input) => ipcRenderer.invoke("network:save-image", input),
};

contextBridge.exposeInMainWorld("jbb", {
  window: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
    close: () => ipcRenderer.invoke("window:close"),
    confirmClose: () => ipcRenderer.invoke("window:confirm-close"),
    onPrepareClose: (callback) => {
      const listener = () => callback();
      ipcRenderer.on("window:prepare-close", listener);
      return () => ipcRenderer.removeListener("window:prepare-close", listener);
    },
    getState: () => ipcRenderer.invoke("window:get-state"),
    getMetrics: () => ipcRenderer.invoke("window:get-metrics"),
    setPreset: (preset) => ipcRenderer.invoke("window:set-preset", preset),
    onMetrics: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("window:metrics", listener);
      return () => ipcRenderer.removeListener("window:metrics", listener);
    },
  },
  storage: {
    readJson: (name, fallback) => ipcRenderer.invoke("storage:read-json", name, fallback),
    writeJson: (name, value) => ipcRenderer.invoke("storage:write-json", name, value),
    readText: (name, fallback) => ipcRenderer.invoke("storage:read-text", name, fallback),
    writeText: (name, value) => ipcRenderer.invoke("storage:write-text", name, value),
    removeData: (name) => ipcRenderer.invoke("storage:remove-data", name),
    readBinary: (payload) => ipcRenderer.invoke("storage:read-binary", payload),
    writeBinary: (payload) => ipcRenderer.invoke("storage:write-binary", payload),
    removeBinary: (payload) => ipcRenderer.invoke("storage:remove-binary", payload),
    existsBinary: (payload) => ipcRenderer.invoke("storage:exists-binary", payload),
    getRoots: () => ipcRenderer.invoke("storage:get-roots"),
    chooseOutputDirectory: () => ipcRenderer.invoke("storage:choose-output-directory"),
    setOutputDirectory: (input) => ipcRenderer.invoke("storage:set-output-directory", input),
    resetOutputDirectory: () => ipcRenderer.invoke("storage:reset-output-directory"),
  },
  legacyImport: {
    chooseDirectory: () => ipcRenderer.invoke("legacy-import:choose-directory"),
    preview: (input) => ipcRenderer.invoke("legacy-import:preview", input),
    run: (input) => ipcRenderer.invoke("legacy-import:run", input),
  },
  release: {
    getProfileReset: () => ipcRenderer.invoke("release:get-profile-reset"),
    completeProfileReset: () => ipcRenderer.invoke("release:complete-profile-reset"),
    checkUpdate: () => ipcRenderer.invoke("release:check-update"),
    openInstaller: () => ipcRenderer.invoke("release:open-installer"),
  },
  image: {
    copy: (input) => ipcRenderer.invoke("image:copy", input),
    showInFolder: (input) => ipcRenderer.invoke("image:show-in-folder", input),
  },
  project: {
    exportImages: (input) => ipcRenderer.invoke("project:export-images", input),
  },
  settings: {
    getConnection: () => ipcRenderer.invoke("settings:get-connection"),
    saveConnection: (input) => ipcRenderer.invoke("settings:save-connection", input),
    clearLocal: () => ipcRenderer.invoke("settings:clear-local"),
    listModels: (input) => ipcRenderer.invoke("settings:list-models", input),
  },
  taskLogs: {
    list: () => ipcRenderer.invoke("task-logs:list"),
    clear: () => ipcRenderer.invoke("task-logs:clear"),
    create: (input) => ipcRenderer.invoke("task-logs:create", input),
    update: (id, patch) => ipcRenderer.invoke("task-logs:update", { id, patch }),
  },
  network: {
    probe: () => ipcRenderer.invoke("network:probe"),
  },
  inspiration: {
    sync: (input) => ipcRenderer.invoke("inspiration:sync", input),
    cancel: () => ipcRenderer.invoke("inspiration:cancel"),
    reload: () => ipcRenderer.invoke("inspiration:reload"),
    getStatus: () => ipcRenderer.invoke("inspiration:get-status"),
    getSources: () => ipcRenderer.invoke("inspiration:get-sources"),
    openSource: (url) => ipcRenderer.invoke("inspiration:open-source", { url }),
    onStatus: (callback) => ipcRenderer.on("inspiration:status", (_event, payload) => callback(payload)),
  },
  gptImageApi,
});

// Keep compatibility with renderer versions that access the bridge directly.
contextBridge.exposeInMainWorld("gptImageApi", gptImageApi);
