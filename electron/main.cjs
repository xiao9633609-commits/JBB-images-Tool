const { app, BrowserWindow, ipcMain, dialog, screen, shell, clipboard, nativeImage, protocol, net, session } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { createStorage } = require("./storage.cjs");
const { createRequestLogService } = require("./request-logs.cjs");
const { fetchLatestRelease, isAllowedReleaseUrl, RELEASES_URL } = require("./release-check.cjs");
const { inspectLegacyImport, importLegacyHistory } = require("./legacy-import.cjs");
const { createInspirationService } = require("./inspiration.cjs");
const { migrateLegacy } = require("./migrate.cjs");
const {
  PROFILE_RESET_VERSION,
  prepareReleaseProfileReset,
  completeReleaseProfileReset
} = require("./profile-reset.cjs");

protocol.registerSchemesAsPrivileged([{
  scheme: "jbb-image",
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
    corsEnabled: true,
  },
}]);

// 源码运行时只有显式传入 --dev 才连接 Vite 开发服务器；
// 普通 `npm start` 应加载最近一次构建的 dist 页面，避免白屏。
const isDev = !app.isPackaged && process.argv.includes("--dev");
const projectRoot = path.resolve(__dirname, "..");
const packagedUserRoot = path.join(app.getPath("appData"), "JBBimg");
const dataRoot = app.isPackaged ? path.join(packagedUserRoot, "data") : path.join(projectRoot, "data");
const outputsRoot = app.isPackaged ? path.join(app.getPath("pictures"), "JBBimg") : path.join(projectRoot, "outputs");
const logsRoot = app.isPackaged ? path.join(packagedUserRoot, "logs") : path.join(projectRoot, "logs");
const storage = createStorage({ dataRoot, outputsRoot, logsRoot });
const requestLogs = createRequestLogService({ dataRoot });
const thumbnailCacheRoot = path.join(dataRoot, "thumbnail-cache");
const THUMBNAIL_EDGE = 448;
const THUMBNAIL_QUALITY = 82;
const THUMBNAIL_CONCURRENCY = 2;
const thumbnailJobs = new Map();
const thumbnailQueue = [];
let activeThumbnailJobs = 0;
let mainWindow;
let focusMainWindowWhenReady = false;
let releaseProfileResetPending = false;
let latestReleaseCheck = null;
const activeRequests = new Map();
const SAFE_CONNECT_RETRY_CODES = new Set([
  "ERR_PROXY_CONNECTION_FAILED",
  "ERR_NAME_NOT_RESOLVED",
  "ERR_CONNECTION_REFUSED",
  "ERR_ADDRESS_UNREACHABLE",
  "ERR_NETWORK_CHANGED",
  "ERR_INTERNET_DISCONNECTED"
]);
const SAFE_POST_RETRY_CODES = new Set([
  "ERR_PROXY_CONNECTION_FAILED",
  "ERR_NAME_NOT_RESOLVED",
  "ERR_CONNECTION_REFUSED",
  "ERR_ADDRESS_UNREACHABLE"
]);
const DEFAULT_WINDOW_SIZE = Object.freeze({ width: 1360, height: 760 });
const MINIMUM_WINDOW_SIZE = Object.freeze({ width: 1040, height: 680 });
const WINDOW_EDGE_MARGIN = 24;
const WINDOW_PRESETS = Object.freeze({
  auto: null,
  "1280x720": { width: 1280, height: 720 },
  "1360x760": { width: 1360, height: 760 },
  "1440x900": { width: 1440, height: 900 },
  "1600x900": { width: 1600, height: 900 },
  "1920x1080": { width: 1920, height: 1080 },
  "2560x1440": { width: 2560, height: 1440 },
  "3840x2160": { width: 3840, height: 2160 },
});
const MINIMUM_WINDOW_ZOOM = 0.25;
let activeWindowPreset = "auto";
let activeDisplayId = "";
let displayAdaptationTimer = null;
let metricsNotificationTimer = null;
let allowMainWindowClose = false;
let mainWindowClosePending = false;
let mainWindowCloseTimer = null;
const inspiration = createInspirationService({ dataRoot, logsRoot, onEvent: (payload) => mainWindow?.webContents.send("inspiration:status", payload) });
const JBB_PRIMARY_BASE_URL = "https://downstream.jbbtoken.cn/v1";
const JBB_FALLBACK_BASE_URL = "https://cn.jbbt.cc/v1";
const JBB_BASE_URLS = new Set([JBB_PRIMARY_BASE_URL, JBB_FALLBACK_BASE_URL].map((value) => value.toLowerCase()));
const externalSourceHosts = new Set([
  "image.prompt123.cn", "www.aiwind.org", "opennana.com", "prompthub.xin", "www.prompthub.xin",
  "aiart.pics", "www.aiart.pics", "youmind.com", "www.youmind.com", "prompthero.com", "www.prompthero.com",
  "2slides.com", "www.2slides.com"
]);

function focusExistingMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    focusMainWindowWhenReady = true;
    return false;
  }
  focusMainWindowWhenReady = false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  mainWindow.moveTop();
  return true;
}

function normalizeExternalSourceUrl(value) {
  const parsed = new URL(String(value || ""));
  if (parsed.protocol !== "https:" || !externalSourceHosts.has(parsed.hostname)) throw new Error("只允许打开已登记的灵感来源链接");
  parsed.username = ""; parsed.password = "";
  return parsed.href;
}

function normalizeApiBaseUrl(input, apiMode = "compatible") {
  const raw = String(input || "").trim();
  if (!raw || raw === "金贝贝") return apiMode === "official" ? "https://api.openai.com/v1" : JBB_PRIMARY_BASE_URL;
  const parsed = new URL(raw); if (!/^https?:$/.test(parsed.protocol)) throw new Error("中转站地址只支持 http 或 https 协议");
  if (parsed.username || parsed.password) throw new Error("中转站地址不能包含用户名或密码");
  parsed.search = ""; parsed.hash = ""; parsed.pathname = parsed.pathname.replace(/\/+$/, ""); if (!/\/v1$/i.test(parsed.pathname)) parsed.pathname = `${parsed.pathname}/v1`.replace(/\/+/g, "/"); return parsed.toString().replace(/\/$/, "");
}
function displayBaseUrl(value) { const normalized = String(value || "").trim().replace(/\/+$/, ""); return JBB_BASE_URLS.has(normalized.toLowerCase()) ? "金贝贝" : normalized; }
function parseEnv(text = "") { const values = {}; for (const line of String(text).split(/\r?\n/)) { const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/); if (match) values[match[1]] = match[2].replace(/^("|')(.*)\1$/, "$2"); } return values; }
function serializeEnv(values = {}) { return `${Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(String(value ?? ""))}`).join("\n")}\n`; }
async function readCredentials() { return parseEnv(await storage.readText(".env", "")); }
async function getConnectionStatus() { const credentials = await readCredentials(); return { baseUrl: displayBaseUrl(credentials.GPT_IMAGE_STUDIO_BASE_URL), apiKeyConfigured: Boolean(credentials.GPT_IMAGE_STUDIO_API_KEY) }; }
async function saveConnection(input = {}) { const credentials = await readCredentials(); credentials.GPT_IMAGE_STUDIO_BASE_URL = normalizeApiBaseUrl(input.baseUrl, input.apiMode); if (String(input.apiKey || "").trim()) credentials.GPT_IMAGE_STUDIO_API_KEY = String(input.apiKey).trim(); await storage.writeText(".env", serializeEnv(credentials)); return getConnectionStatus(); }
async function clearLocalSettings() { await storage.removeData("settings.json"); await storage.removeData(".env"); return { cleared: true }; }
async function listModels(input = {}) {
  const credentials = await readCredentials(); const apiKey = String(input.apiKey || credentials.GPT_IMAGE_STUDIO_API_KEY || "").trim(); if (!apiKey) return { ok: false, error: "请先填写生图 API Key" }; let baseUrl; try { baseUrl = normalizeApiBaseUrl(input.baseUrl || credentials.GPT_IMAGE_STUDIO_BASE_URL, input.apiMode); } catch (error) { return { ok: false, error: error.message }; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await net.fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }, signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, status: response.status, baseUrl, error: payload?.error?.message || `读取模型失败，HTTP ${response.status}` };
    const source = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
    return { ok: true, baseUrl, models: [...new Set(source.map((item) => typeof item === "string" ? item : item?.id).filter(Boolean))].sort() };
  } catch (error) {
    return { ok: false, baseUrl, error: error.name === "AbortError" ? "读取模型超时" : error.message };
  } finally {
    clearTimeout(timer);
  }
}
function getNetworkErrorDetails(error) {
  const cause = error?.cause && typeof error.cause === "object" ? error.cause : {};
  const message = String(error?.message || "网络请求失败");
  const messageCode = message.match(/(?:net::)?(ERR_[A-Z0-9_]+)/)?.[1] || "";
  return {
    name: String(error?.name || "Error"),
    message,
    code: String(error?.code || cause.code || messageCode),
    errno: String(error?.errno || cause.errno || ""),
    syscall: String(error?.syscall || cause.syscall || ""),
    address: String(error?.address || cause.address || ""),
    port: Number(error?.port || cause.port || 0)
  };
}
function shouldRetryConnectionError(error, method = "GET") {
  const details = getNetworkErrorDetails(error);
  if (!SAFE_CONNECT_RETRY_CODES.has(details.code)) return false;
  const normalizedMethod = String(method || "GET").toUpperCase();
  if (normalizedMethod === "POST") return SAFE_POST_RETRY_CODES.has(details.code);
  return ["GET", "HEAD", "OPTIONS"].includes(normalizedMethod);
}
async function resolveSystemProxyRoute(url) {
  try {
    return String(await session.defaultSession.resolveProxy(String(url)) || "DIRECT");
  } catch (error) {
    return `UNKNOWN (${getNetworkErrorDetails(error).message})`;
  }
}
async function fetchWithSystemProxy(url, options = {}) {
  return net.fetch(String(url), options);
}
function normalizeImageFilename(input = "") {
  if (input === null || input === undefined) return "";
  if (typeof input !== "string") throw new Error("图片文件名必须是字符串");
  const value = input.replace(/\\/g, "/");
  if (!value.trim()) return "";
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error("图片文件名包含无效控制字符");
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) throw new Error("图片路径必须是输出目录内的相对路径");
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("图片路径包含无效目录段");
  if (parts.some((part) => /[<>:"|?*]/.test(part) || /[. ]$/.test(part))) throw new Error("图片路径包含 Windows 不支持的文件名字符");
  return parts.join(path.sep);
}

function resolveImagePath(filename = "") {
  const root = path.resolve(storage.imagesRoot);
  const normalized = normalizeImageFilename(filename);
  if (!normalized) return root;
  const candidate = path.resolve(root, normalized);
  const relative = path.relative(root, candidate);
  if (relative && (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) throw new Error("图片路径越界");
  return candidate;
}

function resolveVideoPath(filename = "") {
  const root = path.resolve(storage.videosRoot);
  const normalized = normalizeImageFilename(filename);
  if (!normalized) return root;
  const candidate = path.resolve(root, normalized);
  const relative = path.relative(root, candidate);
  if (relative && (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) throw new Error("视频路径越界");
  return candidate;
}

function getImageFilename(input = {}) {
  if (typeof input === "string" || input === null || input === undefined) return normalizeImageFilename(input || "");
  if (typeof input !== "object" || Array.isArray(input)) throw new Error("图片目录参数无效");
  if (input.outputFile !== undefined && input.outputFile !== null) {
    if (typeof input.outputFile !== "string") throw new Error("outputFile 必须是字符串");
    if (input.outputFile.trim()) return normalizeImageFilename(input.outputFile);
  }
  return normalizeImageFilename(input.filename);
}

async function assertPathInsideImageRoot(filePath, { allowMissing = false } = {}) {
  const realRoot = await fs.realpath(path.resolve(storage.imagesRoot));
  let target = filePath;
  while (true) {
    try {
      target = await fs.realpath(target);
      break;
    } catch (error) {
      if (!allowMissing || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) throw error;
      const parent = path.dirname(target);
      if (parent === target) throw error;
      target = parent;
    }
  }
  const relative = path.relative(realRoot, target);
  if (relative && (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) throw new Error("图片路径越界");
}

function getThumbnailCachePath(sourcePath) {
  const cacheKey = crypto.createHash("sha256").update(path.resolve(sourcePath)).digest("hex");
  return path.join(thumbnailCacheRoot, `${cacheKey}.jpg`);
}

function runThumbnailQueue() {
  while (activeThumbnailJobs < THUMBNAIL_CONCURRENCY && thumbnailQueue.length) {
    const queued = thumbnailQueue.shift();
    activeThumbnailJobs += 1;
    Promise.resolve()
      .then(queued.task)
      .then(queued.resolve, queued.reject)
      .finally(() => {
        activeThumbnailJobs -= 1;
        runThumbnailQueue();
      });
  }
}

function enqueueThumbnailTask(task) {
  return new Promise((resolve, reject) => {
    thumbnailQueue.push({ task, resolve, reject });
    runThumbnailQueue();
  });
}

async function createImageThumbnail(sourcePath, cachePath, sourceStat) {
  await fs.mkdir(thumbnailCacheRoot, { recursive: true });
  const existingStat = await fs.stat(cachePath).catch(() => null);
  if (existingStat?.isFile() && existingStat.size > 0 && existingStat.mtimeMs >= sourceStat.mtimeMs) {
    return cachePath;
  }

  let thumbnail;
  try {
    thumbnail = await nativeImage.createThumbnailFromPath(sourcePath, {
      width: THUMBNAIL_EDGE,
      height: THUMBNAIL_EDGE,
    });
  } catch {
    const original = nativeImage.createFromPath(sourcePath);
    if (!original.isEmpty()) {
      const size = original.getSize();
      const scale = Math.min(1, THUMBNAIL_EDGE / Math.max(size.width, size.height));
      thumbnail = original.resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
        quality: "good",
      });
    }
  }
  if (!thumbnail || thumbnail.isEmpty()) throw new Error("图片缩略图生成失败");

  const temporaryPath = `${cachePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, thumbnail.toJPEG(THUMBNAIL_QUALITY));
  await fs.rename(temporaryPath, cachePath).catch(async (error) => {
    await fs.rm(temporaryPath, { force: true });
    if (error.code !== "EEXIST") throw error;
  });
  return cachePath;
}

async function ensureImageThumbnail(sourcePath) {
  const cachePath = getThumbnailCachePath(sourcePath);
  const sourceStat = await fs.stat(sourcePath);
  if (!sourceStat.isFile()) throw Object.assign(new Error("图片文件不存在"), { code: "ENOENT" });
  if (thumbnailJobs.has(cachePath)) return thumbnailJobs.get(cachePath);
  const job = enqueueThumbnailTask(() => createImageThumbnail(sourcePath, cachePath, sourceStat))
    .finally(() => thumbnailJobs.delete(cachePath));
  thumbnailJobs.set(cachePath, job);
  return job;
}

async function removeImageThumbnail(filename) {
  const sourcePath = resolveImagePath(filename);
  await fs.rm(getThumbnailCachePath(sourcePath), { force: true });
}

async function clearThumbnailCache() {
  await fs.rm(thumbnailCacheRoot, { recursive: true, force: true });
  await fs.mkdir(thumbnailCacheRoot, { recursive: true });
}

function imageProtocolError(error) {
  const missing = error?.code === "ENOENT" || error?.code === "ENOTDIR";
  return new Response(missing ? "Image not found" : "Image unavailable", {
    status: missing ? 404 : 500,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function registerImageProtocol() {
  protocol.handle("jbb-image", async (request) => {
    try {
      const requestUrl = new URL(request.url);
      if (requestUrl.hostname !== "local") return new Response("Not found", { status: 404 });
      const filename = getImageFilename(requestUrl.searchParams.get("file") || "");
      if (!filename) return new Response("Missing image", { status: 400 });
      const mediaType = requestUrl.searchParams.get("media") === "video" ? "video" : "image";
      if (mediaType === "video") {
        resolveVideoPath(filename);
        const result = await storage.readBinary({ mediaType: "video", filename });
        if (!result?.data) return new Response("Video not found", { status: 404 });
        const bytes = new Uint8Array(result.data);
        const range = String(request.headers.get("range") || "").match(/^bytes=(\d*)-(\d*)$/i);
        const commonHeaders = {
          "Content-Type": result.mimeType || "video/mp4",
          "Cache-Control": "no-store",
          "Accept-Ranges": "bytes"
        };
        if (range) {
          const start = range[1] ? Number(range[1]) : 0;
          const end = range[2] ? Math.min(Number(range[2]), bytes.byteLength - 1) : bytes.byteLength - 1;
          if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= bytes.byteLength) {
            return new Response(null, { status: 416, headers: { ...commonHeaders, "Content-Range": `bytes */${bytes.byteLength}` } });
          }
          const chunk = bytes.slice(start, end + 1);
          return new Response(request.method === "HEAD" ? null : chunk, {
            status: 206,
            headers: {
              ...commonHeaders,
              "Content-Length": String(chunk.byteLength),
              "Content-Range": `bytes ${start}-${end}/${bytes.byteLength}`
            }
          });
        }
        return new Response(request.method === "HEAD" ? null : bytes, {
          headers: { ...commonHeaders, "Content-Length": String(bytes.byteLength) }
        });
      }
      const sourcePath = resolveImagePath(filename);
      await assertPathInsideImageRoot(sourcePath);
      const requestedPath = requestUrl.pathname === "/thumbnail"
        ? await ensureImageThumbnail(sourcePath)
        : sourcePath;
      return net.fetch(pathToFileURL(requestedPath).toString());
    } catch (error) {
      return imageProtocolError(error);
    }
  });
}

async function openImageDirectory(folderPath) {
  const error = await shell.openPath(folderPath);
  if (error) throw new Error(error);
}

function sanitizeExportName(value, fallback = "未命名项目") {
  const cleaned = String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!cleaned) return fallback;
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned) ? `_${cleaned}` : cleaned;
}

async function uniqueExportPath(candidate, isDirectory = false) {
  if (!(await fs.access(candidate).then(() => true).catch(() => false))) return candidate;
  const parent = path.dirname(candidate);
  const extension = isDirectory ? "" : path.extname(candidate);
  const stem = isDirectory ? path.basename(candidate) : path.basename(candidate, extension);
  let index = 2;
  let next;
  do {
    next = path.join(parent, `${stem}-${index++}${extension}`);
  } while (await fs.access(next).then(() => true).catch(() => false));
  return next;
}

async function exportProjectImages(input = {}) {
  const projects = Array.isArray(input.projects) ? input.projects : [];
  if (!projects.length) return { ok: false, error: "请先选择要导出的项目" };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择项目图片导出位置",
    buttonLabel: "导出到此处",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths?.[0]) return { ok: true, canceled: true };

  const destinationRoot = path.resolve(result.filePaths[0]);
  let exportedCount = 0;
  let missingCount = 0;
  const exportedProjects = [];
  for (const project of projects) {
    const projectFolder = await uniqueExportPath(
      path.join(destinationRoot, sanitizeExportName(project?.name)),
      true
    );
    await fs.mkdir(projectFolder, { recursive: true });
    const files = [...new Set((Array.isArray(project?.files) ? project.files : []).map((value) => String(value || "")).filter(Boolean))];
    let projectExportedCount = 0;
    for (const filename of files) {
      try {
        const source = resolveImagePath(filename);
        await assertPathInsideImageRoot(source);
        const stat = await fs.stat(source);
        if (!stat.isFile()) throw Object.assign(new Error("图片文件不存在"), { code: "ENOENT" });
        const relative = normalizeImageFilename(filename);
        const requestedDestination = path.join(projectFolder, relative);
        await fs.mkdir(path.dirname(requestedDestination), { recursive: true });
        const destination = await uniqueExportPath(requestedDestination);
        await fs.copyFile(source, destination);
        exportedCount += 1;
        projectExportedCount += 1;
      } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
          missingCount += 1;
          continue;
        }
        throw error;
      }
    }
    exportedProjects.push({ id: String(project?.id || ""), name: String(project?.name || ""), path: projectFolder, exportedCount: projectExportedCount });
  }
  return { ok: true, canceled: false, destinationRoot, exportedCount, missingCount, projects: exportedProjects };
}

function normalizeWindowPreset(value) {
  return Object.hasOwn(WINDOW_PRESETS, String(value || "")) ? String(value) : "auto";
}

function getCurrentWindowDisplay() {
  if (!mainWindow || mainWindow.isDestroyed()) return screen.getPrimaryDisplay();
  return screen.getDisplayMatching(mainWindow.getBounds());
}

function displayDipToPhysicalPixels(value, scaleFactor) {
  // Electron rounds display bounds to whole DIP, which can create half-pixel artifacts at 150% scaling.
  return Math.max(1, Math.round(((Number(value) || 0) * scaleFactor) / 2) * 2);
}

function getDisplaySizing(display = getCurrentWindowDisplay()) {
  const scaleFactor = Number(display.scaleFactor) || 1;
  const workArea = display.workArea;
  const safeWidth = Math.max(1, workArea.width - (WINDOW_EDGE_MARGIN * 2));
  const safeHeight = Math.max(1, workArea.height - (WINDOW_EDGE_MARGIN * 2));
  return {
    display,
    scaleFactor,
    workArea,
    safeWidth,
    safeHeight,
    minimumWidth: Math.min(MINIMUM_WINDOW_SIZE.width, safeWidth),
    minimumHeight: Math.min(MINIMUM_WINDOW_SIZE.height, safeHeight),
    physicalSize: {
      width: displayDipToPhysicalPixels(display.bounds.width, scaleFactor),
      height: displayDipToPhysicalPixels(display.bounds.height, scaleFactor),
    },
    physicalWorkAreaSize: {
      width: displayDipToPhysicalPixels(workArea.width, scaleFactor),
      height: displayDipToPhysicalPixels(workArea.height, scaleFactor),
    },
  };
}

function normalizeWindowPresetForDisplay(preset, display = getCurrentWindowDisplay()) {
  const normalizedPreset = normalizeWindowPreset(preset);
  const requested = WINDOW_PRESETS[normalizedPreset];
  if (!requested) return normalizedPreset;
  const { physicalSize } = getDisplaySizing(display);
  if (requested.width <= physicalSize.width && requested.height <= physicalSize.height) {
    return normalizedPreset;
  }
  return Object.entries(WINDOW_PRESETS)
    .filter(([, size]) => size && size.width <= physicalSize.width && size.height <= physicalSize.height)
    .sort(([, left], [, right]) => (right.width * right.height) - (left.width * left.height))[0]?.[0] || "auto";
}

function resolveWindowSize(preset = "auto", display = screen.getPrimaryDisplay()) {
  const normalizedPreset = normalizeWindowPreset(preset);
  const sizing = getDisplaySizing(display);
  const requested = WINDOW_PRESETS[normalizedPreset];
  const target = requested || DEFAULT_WINDOW_SIZE;
  if (!requested) {
    const width = Math.min(sizing.safeWidth, Math.max(sizing.minimumWidth, target.width));
    const height = Math.min(sizing.safeHeight, Math.max(sizing.minimumHeight, target.height));
    return {
      preset: normalizedPreset,
      width,
      height,
      requestedWidth: target.width,
      requestedHeight: target.height,
      fitScale: 1,
      fitPercent: 100,
      adapted: false,
      constrained: width !== target.width || height !== target.height,
    };
  }

  const rawFitScale = Math.min(1, sizing.workArea.width / target.width, sizing.workArea.height / target.height);
  const fitScale = Math.max(MINIMUM_WINDOW_ZOOM, rawFitScale);
  const width = Math.min(
    sizing.workArea.width,
    Math.max(sizing.minimumWidth, Math.floor(target.width * fitScale))
  );
  const height = Math.min(
    sizing.workArea.height,
    Math.max(sizing.minimumHeight, Math.floor(target.height * fitScale))
  );
  const adapted = fitScale < 0.9999;
  return {
    preset: normalizedPreset,
    width,
    height,
    requestedWidth: target.width,
    requestedHeight: target.height,
    fitScale,
    fitPercent: Math.round(fitScale * 100),
    adapted,
    constrained: adapted,
  };
}

function getWindowPresetAvailability(display = getCurrentWindowDisplay()) {
  const sizing = getDisplaySizing(display);
  const presets = Object.entries(WINDOW_PRESETS).map(([value, requested]) => {
    const width = requested?.width || DEFAULT_WINDOW_SIZE.width;
    const height = requested?.height || DEFAULT_WINDOW_SIZE.height;
    const resolved = resolveWindowSize(value, display);
    const fitsAtFullScale = !requested || (width <= sizing.workArea.width && height <= sizing.workArea.height);
    const withinPhysicalResolution = !requested || (width <= sizing.physicalSize.width && height <= sizing.physicalSize.height);
    return {
      value,
      width,
      height,
      enabled: true,
      visible: value === "auto" || withinPhysicalResolution,
      fitsAtFullScale,
      withinPhysicalResolution,
      fitScale: resolved.fitScale,
      fitPercent: resolved.fitPercent,
      actualWidth: resolved.width,
      actualHeight: resolved.height,
      recommended: false,
    };
  });
  const recommended = presets
    .filter((entry) => entry.value !== "auto" && entry.withinPhysicalResolution && entry.fitsAtFullScale)
    .sort((left, right) => (right.width * right.height) - (left.width * left.height))[0];
  if (recommended) recommended.recommended = true;
  return presets;
}

function getWindowMetrics(reason = "current") {
  const display = getCurrentWindowDisplay();
  const sizing = getDisplaySizing(display);
  const target = resolveWindowSize(activeWindowPreset, display);
  const presets = getWindowPresetAvailability(display);
  const recommended = presets.find((entry) => entry.recommended) || null;
  const windowBounds = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : null;
  return {
    reason,
    displayId: String(display.id),
    displayLabel: display.label || `Display ${display.id}`,
    scaleFactor: sizing.scaleFactor,
    scalePercent: Math.round(sizing.scaleFactor * 100),
    physicalSize: sizing.physicalSize,
    physicalWorkAreaSize: sizing.physicalWorkAreaSize,
    bounds: display.bounds,
    workArea: sizing.workArea,
    workAreaSize: { width: sizing.workArea.width, height: sizing.workArea.height },
    safeWorkAreaSize: { width: sizing.safeWidth, height: sizing.safeHeight },
    recommendedPreset: recommended?.value || "",
    recommendedSize: recommended ? { width: recommended.width, height: recommended.height } : null,
    requestedSize: { width: target.requestedWidth, height: target.requestedHeight },
    targetSize: { width: target.width, height: target.height },
    fitScale: target.fitScale,
    fitPercent: target.fitPercent,
    adapted: target.adapted,
    windowBounds,
    preset: activeWindowPreset,
    constrained: target.constrained,
    maximized: Boolean(mainWindow?.isMaximized()),
    presets,
  };
}

function getCenteredWindowBounds(display, width, height) {
  const { workArea } = getDisplaySizing(display);
  return {
    x: workArea.x + Math.max(0, Math.floor((workArea.width - width) / 2)),
    y: workArea.y + Math.max(0, Math.floor((workArea.height - height) / 2)),
    width,
    height,
  };
}

function applyMinimumWindowSize(display = getCurrentWindowDisplay()) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const sizing = getDisplaySizing(display);
  mainWindow.setMinimumSize(sizing.minimumWidth, sizing.minimumHeight);
}

function applyWindowZoom(fitScale = 1) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  const zoomFactor = Math.min(1, Math.max(MINIMUM_WINDOW_ZOOM, Number(fitScale) || 1));
  mainWindow.webContents.setZoomFactor(zoomFactor);
}

function notifyWindowMetrics(reason = "changed") {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send("window:metrics", getWindowMetrics(reason));
}

function scheduleWindowMetrics(reason = "changed") {
  if (metricsNotificationTimer) clearTimeout(metricsNotificationTimer);
  metricsNotificationTimer = setTimeout(() => {
    metricsNotificationTimer = null;
    notifyWindowMetrics(reason);
  }, 80);
}

async function readWindowPreset(display = screen.getPrimaryDisplay()) {
  const settings = await storage.readJson("settings.json", {});
  return normalizeWindowPresetForDisplay(settings?.windowPreset, display);
}

function applyWindowPreset(preset, display = getCurrentWindowDisplay(), reason = "preset") {
  activeWindowPreset = normalizeWindowPresetForDisplay(preset, display);
  const next = resolveWindowSize(activeWindowPreset, display);
  if (mainWindow) {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    applyMinimumWindowSize(display);
    applyWindowZoom(next.fitScale);
    mainWindow.setBounds(getCenteredWindowBounds(display, next.width, next.height));
  }
  activeDisplayId = String(display.id);
  const metrics = getWindowMetrics(reason);
  scheduleWindowMetrics(reason);
  return { ...next, metrics };
}

function adaptWindowToCurrentDisplay(reason = "display-change") {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const display = getCurrentWindowDisplay();
  const nextDisplayId = String(display.id);
  const displayChanged = nextDisplayId !== activeDisplayId;
  activeWindowPreset = normalizeWindowPresetForDisplay(activeWindowPreset, display);
  activeDisplayId = nextDisplayId;
  applyMinimumWindowSize(display);
  if (displayChanged || reason === "display-metrics-changed" || reason === "window-unmaximize") {
    if (mainWindow.isMaximized()) {
      applyWindowZoom(resolveWindowSize(activeWindowPreset, display).fitScale);
      scheduleWindowMetrics(reason);
    } else {
      applyWindowPreset(activeWindowPreset, display, reason);
    }
  } else {
    scheduleWindowMetrics(reason);
  }
}

function scheduleDisplayAdaptation(reason = "display-change") {
  if (displayAdaptationTimer) clearTimeout(displayAdaptationTimer);
  displayAdaptationTimer = setTimeout(() => {
    displayAdaptationTimer = null;
    adaptWindowToCurrentDisplay(reason);
  }, 220);
}

function registerDisplayEvents() {
  screen.on("display-metrics-changed", (_event, display) => {
    if (String(display.id) === String(getCurrentWindowDisplay().id)) {
      scheduleDisplayAdaptation("display-metrics-changed");
    }
  });
  screen.on("display-added", () => scheduleDisplayAdaptation("display-added"));
  screen.on("display-removed", () => scheduleDisplayAdaptation("display-removed"));
}

async function createWindow() {
  const display = screen.getPrimaryDisplay();
  const windowPreset = await readWindowPreset(display);
  activeWindowPreset = windowPreset;
  const sizing = getDisplaySizing(display);
  const initialWindowSize = resolveWindowSize(windowPreset, display);
  const { width, height } = initialWindowSize;
  const initialBounds = getCenteredWindowBounds(display, width, height);
  allowMainWindowClose = false;
  mainWindowClosePending = false;
  mainWindow = new BrowserWindow({ ...initialBounds, minWidth: sizing.minimumWidth, minHeight: sizing.minimumHeight, frame: false, show: false, backgroundColor: "#f8fafc", title: "金贝贝生图工具 · JBBimg 0.3.108", icon: path.join(__dirname, "../renderer/public/jbb-icon.png"), webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, "preload.cjs") } });
  applyWindowZoom(initialWindowSize.fitScale);
  activeDisplayId = String(display.id);
  mainWindow.on("move", () => scheduleDisplayAdaptation("window-move"));
  mainWindow.on("resize", () => scheduleWindowMetrics("window-resize"));
  mainWindow.on("maximize", () => scheduleWindowMetrics("window-maximize"));
  mainWindow.on("unmaximize", () => scheduleDisplayAdaptation("window-unmaximize"));
  mainWindow.on("close", (event) => {
    if (allowMainWindowClose || mainWindow?.isDestroyed()) return;
    event.preventDefault();
    if (mainWindowClosePending) return;
    mainWindowClosePending = true;
    mainWindowCloseTimer = setTimeout(() => {
      mainWindowCloseTimer = null;
      allowMainWindowClose = true;
      mainWindow?.close();
    }, 8000);
    try {
      if (mainWindow.webContents.isDestroyed()) throw new Error("renderer unavailable");
      mainWindow.webContents.send("window:prepare-close");
    } catch {
      if (mainWindowCloseTimer) clearTimeout(mainWindowCloseTimer);
      mainWindowCloseTimer = null;
      allowMainWindowClose = true;
      mainWindow.close();
    }
  });
  mainWindow.on("closed", () => {
    if (mainWindowCloseTimer) clearTimeout(mainWindowCloseTimer);
    mainWindowCloseTimer = null;
    mainWindowClosePending = false;
    mainWindow = null;
  });
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    if (focusMainWindowWhenReady) focusExistingMainWindow();
    scheduleWindowMetrics("ready");
  });
  if (isDev) await mainWindow.loadURL("http://127.0.0.1:5174"); else await mainWindow.loadFile(path.join(__dirname, "../dist/renderer/index.html"));
}
function registerIpc() {
  ipcMain.handle("window:minimize", () => mainWindow?.minimize()); ipcMain.handle("window:toggle-maximize", () => { if (mainWindow?.isMaximized()) mainWindow.restore(); else mainWindow?.maximize(); scheduleWindowMetrics("window-toggle-maximize"); return { maximized: mainWindow?.isMaximized() ?? false }; }); ipcMain.handle("window:close", () => mainWindow?.close()); ipcMain.handle("window:confirm-close", () => { if (!mainWindowClosePending || !mainWindow || mainWindow.isDestroyed()) return false; if (mainWindowCloseTimer) clearTimeout(mainWindowCloseTimer); mainWindowCloseTimer = null; allowMainWindowClose = true; mainWindow.close(); return true; }); ipcMain.handle("window:get-state", () => ({ maximized: mainWindow?.isMaximized() ?? false })); ipcMain.handle("window:get-metrics", () => getWindowMetrics("requested"));
  ipcMain.handle("window:set-preset", (_event, preset) => applyWindowPreset(preset));
  ipcMain.handle("release:get-profile-reset", () => ({
    pending: releaseProfileResetPending,
    version: PROFILE_RESET_VERSION
  }));
  ipcMain.handle("release:complete-profile-reset", async () => {
    if (!releaseProfileResetPending) return { pending: false, completed: true, version: PROFILE_RESET_VERSION };
    const result = await completeReleaseProfileReset({ dataRoot });
    releaseProfileResetPending = false;
    return result;
  });
  ipcMain.handle("release:check-update", async () => {
    try {
      latestReleaseCheck = await fetchLatestRelease({
        currentVersion: app.getVersion(),
        fetchImpl: (url, options) => net.fetch(url, options)
      });
      return latestReleaseCheck;
    } catch (error) {
      const message = error?.name === "AbortError" ? "版本检测超时，请稍后重试。" : (error.message || "版本检测失败");
      await fs.mkdir(logsRoot, { recursive: true }).catch(() => {});
      await fs.appendFile(
        path.join(logsRoot, "version-check.log"),
        `${new Date().toISOString()} ${error?.name || "Error"} ${message}\n`
      ).catch(() => {});
      return {
        ok: false,
        currentVersion: app.getVersion(),
        error: message
      };
    }
  });
  ipcMain.handle("release:open-installer", async () => {
    if (!latestReleaseCheck) {
      try {
        latestReleaseCheck = await fetchLatestRelease({
          currentVersion: app.getVersion(),
          fetchImpl: (url, options) => net.fetch(url, options)
        });
      } catch {
        latestReleaseCheck = null;
      }
    }
    const target = latestReleaseCheck?.updateAvailable && latestReleaseCheck?.installer?.url
      ? latestReleaseCheck.installer.url
      : latestReleaseCheck?.releaseUrl || RELEASES_URL;
    if (!isAllowedReleaseUrl(target)) return { ok: false, error: "安装包地址校验失败" };
    await shell.openExternal(target);
    return { ok: true, url: target };
  });
  ipcMain.handle("storage:read-json", (_event, name, fallback) => storage.readJson(name, fallback)); ipcMain.handle("storage:write-json", (_event, name, value) => storage.writeJson(name, value)); ipcMain.handle("storage:read-text", (_event, name, fallback) => storage.readText(name, fallback)); ipcMain.handle("storage:write-text", (_event, name, value) => storage.writeText(name, value)); ipcMain.handle("storage:remove-data", (_event, name) => storage.removeData(name)); ipcMain.handle("storage:read-binary", (_event, input) => storage.readBinary(input)); ipcMain.handle("storage:write-binary", (_event, input) => storage.writeBinary(input)); ipcMain.handle("storage:remove-binary", async (_event, input) => { const removed = await storage.removeBinary(input); if (String(input?.mediaType || "image").toLowerCase() === "image") await removeImageThumbnail(input?.filename).catch(() => {}); return removed; }); ipcMain.handle("storage:exists-binary", (_event, input) => storage.existsBinary(input)); ipcMain.handle("storage:get-roots", () => storage.getRoots());
  ipcMain.handle("storage:choose-output-directory", async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: "选择图片和视频输出文件夹", properties: ["openDirectory", "createDirectory"] });
    if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
    return { canceled: false, path: result.filePaths[0] };
  });
  ipcMain.handle("storage:set-output-directory", async (_event, input = {}) => {
      try { const roots = await storage.setOutputRoot(input.path, { migrate: input.migrate !== false }); await clearThumbnailCache(); return { ok: true, roots }; }
    catch (error) { return { ok: false, error: error.message || "输出文件夹切换失败" }; }
  });
  ipcMain.handle("storage:reset-output-directory", async () => {
      try { const roots = await storage.resetOutputRoot({ migrate: true }); await clearThumbnailCache(); return { ok: true, roots }; }
    catch (error) { return { ok: false, error: error.message || "恢复默认输出文件夹失败" }; }
  });
  ipcMain.handle("legacy-import:choose-directory", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择旧版记录所在文件夹",
      message: "仅用于本次读取和复制历史任务与图片，不会设为当前程序目录或修改连接配置",
      properties: ["openDirectory"]
    });
    if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
    try {
      const preview = await inspectLegacyImport(result.filePaths[0]);
      return { canceled: false, path: result.filePaths[0], preview };
    } catch (error) {
      return { canceled: false, path: result.filePaths[0], ok: false, error: error.message || "无法读取旧版记录" };
    }
  });
  ipcMain.handle("legacy-import:preview", async (_event, input = {}) => {
    try { return await inspectLegacyImport(input.path); }
    catch (error) { return { ok: false, error: error.message || "无法读取旧版记录" }; }
  });
  ipcMain.handle("legacy-import:run", async (_event, input = {}) => {
    try { return await importLegacyHistory({ selectedPath: input.path, storage, mode: input.mode }); }
    catch (error) { return { ok: false, error: error.message || "旧版记录导入失败" }; }
  });
  ipcMain.handle("project:export-images", async (_event, input = {}) => {
    try { return await exportProjectImages(input); }
    catch (error) { return { ok: false, error: error.message || "项目图片导出失败" }; }
  });
  ipcMain.handle("settings:get-connection", () => getConnectionStatus()); ipcMain.handle("settings:save-connection", (_event, input) => saveConnection(input)); ipcMain.handle("settings:clear-local", () => clearLocalSettings()); ipcMain.handle("settings:list-models", (_event, input) => listModels(input));
  ipcMain.handle("network:probe", async () => ({ ok: true, checkedAt: new Date().toISOString() }));
  ipcMain.handle("inspiration:sync", (_event, input) => inspiration.sync(Boolean(input?.force))); ipcMain.handle("inspiration:cancel", () => inspiration.cancel()); ipcMain.handle("inspiration:reload", () => inspiration.reload()); ipcMain.handle("inspiration:get-status", () => inspiration.getStatus()); ipcMain.handle("inspiration:get-sources", () => inspiration.getSources());
  ipcMain.handle("inspiration:open-source", async (_event, input) => { try { const url = normalizeExternalSourceUrl(input?.url); await shell.openExternal(url); return { ok: true }; } catch (error) { return { ok: false, error: error.message || "无法打开来源" }; } });
  ipcMain.handle("task-logs:list", () => requestLogs.list());
  ipcMain.handle("task-logs:clear", () => requestLogs.clear());
  ipcMain.handle("task-logs:create", (_event, input) => requestLogs.create(input));
  ipcMain.handle("task-logs:update", (_event, { id, patch } = {}) => requestLogs.update(id, patch));
  ipcMain.handle("network:request", async (_event, input = {}) => {
    const requestId = String(input.requestId || crypto.randomUUID());
    const logId = String(input.logId || "");
    const controller = new AbortController();
    activeRequests.set(requestId, controller);
    try {
      const headers = { ...(input.headers || {}) };
      let body = input.body;
      if (Array.isArray(input.formDataEntries)) {
        const form = new FormData();
        for (const entry of input.formDataEntries) {
          if (entry?.kind === "file") {
            const bytes = entry.data instanceof ArrayBuffer ? entry.data : Uint8Array.from(entry.data || []);
            form.append(entry.name, new Blob([bytes], { type: entry.mimeType || "application/octet-stream" }), entry.filename || "upload.bin");
          } else form.append(entry.name, String(entry.value ?? ""));
        }
        body = form;
        delete headers["Content-Type"];
        delete headers["content-type"];
      }
      const method = String(input.method || "GET").toUpperCase();
      const proxyRoute = await resolveSystemProxyRoute(input.url);
      const maxAttempts = 2;
      for (let retryIndex = 0; retryIndex < maxAttempts; retryIndex += 1) {
        const attemptRequestId = retryIndex === 0 ? requestId : `${requestId}-retry-${retryIndex}`;
        const attemptStartedAt = Date.now();
        if (logId) await requestLogs.startAttempt(logId, {
          ...input,
          requestId: attemptRequestId,
          proxyRoute,
          retryIndex
        }, input.logSeed || {}).catch(() => {});
        try {
          const response = await fetchWithSystemProxy(input.url, { method, headers, body, signal: controller.signal });
          const result = {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            headers: Object.fromEntries(response.headers.entries()),
            body: await response.text(),
            proxyRoute
          };
          if (logId) await requestLogs.finishAttempt(logId, attemptRequestId, {
            response: { ...result, durationMs: Date.now() - attemptStartedAt }
          }).catch(() => {});
          return result;
        } catch (error) {
          const details = getNetworkErrorDetails(error);
          const retrying = input.retryConnection !== false && retryIndex === 0 && !controller.signal.aborted && shouldRetryConnectionError(error, method);
          if (logId) await requestLogs.finishAttempt(logId, attemptRequestId, {
            error: { ...details, proxyRoute, retrying, durationMs: Date.now() - attemptStartedAt }
          }).catch(() => {});
          if (retrying) {
            await new Promise((resolve) => setTimeout(resolve, 650));
            continue;
          }
          if (error.name === "AbortError") return { aborted: true, reason: "canceled", proxyRoute };
          return { transportError: details.message, transportDetails: details, proxyRoute };
        }
      }
      return { transportError: "网络请求失败", proxyRoute };
    } catch (error) {
      const details = getNetworkErrorDetails(error);
      return error.name === "AbortError"
        ? { aborted: true, reason: "canceled" }
        : { transportError: details.message, transportDetails: details };
    } finally {
      activeRequests.delete(requestId);
    }
  });
  ipcMain.handle("network:cancel", (_event, id) => { const controller = activeRequests.get(String(id)); if (!controller) return false; controller.abort(); return true; });
  ipcMain.handle("network:read-image", async (_event, { src, logId, headers: requestHeaders } = {}) => {
    const startedAt = Date.now();
    try {
      const proxyRoute = await resolveSystemProxyRoute(src);
      const response = await fetchWithSystemProxy(src, { cache: "no-store", headers: requestHeaders || {} });
      const headers = Object.fromEntries(response.headers.entries());
      if (!response.ok) {
        const error = `HTTP ${response.status}`;
        if (logId) await requestLogs.addDownload(logId, {
          url: src,
          status: response.status,
          statusText: response.statusText,
          headers,
          durationMs: Date.now() - startedAt,
          proxyRoute,
          error
        }).catch(() => {});
        return { transportError: error };
      }
      const data = await response.arrayBuffer();
      const mimeType = response.headers.get("content-type") || "application/octet-stream";
      if (logId) await requestLogs.addDownload(logId, {
        url: src,
        status: response.status,
        statusText: response.statusText,
        headers,
        mimeType,
        bytes: data.byteLength,
        durationMs: Date.now() - startedAt,
        proxyRoute
      }).catch(() => {});
      return { data, mimeType };
    } catch (error) {
      if (logId) await requestLogs.addDownload(logId, {
        url: src,
        durationMs: Date.now() - startedAt,
        error: error.message
      }).catch(() => {});
      return { transportError: error.message };
    }
  });
  ipcMain.handle("network:save-image", async (_event, input = {}) => { try { let bytes; let mimeType = input.mimeType || "image/png"; if (input.data) bytes = Buffer.from(input.data instanceof ArrayBuffer ? new Uint8Array(input.data) : input.data); else { const response = await fetchWithSystemProxy(input.src); if (!response.ok) throw new Error(`图片下载失败，HTTP ${response.status}`); mimeType = response.headers.get("content-type") || mimeType; bytes = Buffer.from(await response.arrayBuffer()); } const filename = String(input.filename || "image.png").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_"); const result = await dialog.showSaveDialog(mainWindow, { title: "保存生成图片", defaultPath: path.join(storage.imagesRoot, filename), filters: [{ name: "Image", extensions: [path.extname(filename).slice(1) || "png"] }] }); if (result.canceled || !result.filePath) return { canceled: true }; await fs.mkdir(path.dirname(result.filePath), { recursive: true }); await fs.writeFile(result.filePath, bytes); return { saved: true, filePath: result.filePath }; } catch (error) { return { saved: false, error: error.message }; } });
  ipcMain.handle("image:copy", async (_event, input = {}) => {
    try {
      const bytes = input.data instanceof ArrayBuffer
        ? Buffer.from(new Uint8Array(input.data))
        : Buffer.from(input.data || []);
      const image = nativeImage.createFromBuffer(bytes);
      if (image.isEmpty()) throw new Error("图片数据无效");
      clipboard.writeImage(image);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message || "图片复制失败" };
    }
  });
  ipcMain.handle("image:show-in-folder", async (_event, input = {}) => {
    try {
      const filename = getImageFilename(input);
      const filePath = resolveImagePath(filename);
      if (!filename) {
        await assertPathInsideImageRoot(filePath);
        await openImageDirectory(filePath);
        return { ok: true, action: "open-directory", directoryPath: filePath };
      }
      let isFile = false;
      try {
        const stat = await fs.stat(filePath);
        isFile = stat.isFile();
        if (isFile) await assertPathInsideImageRoot(filePath);
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      }
      if (isFile) {
        shell.showItemInFolder(filePath);
        return { ok: true, action: "select-file", filePath };
      }
      const folderPath = path.dirname(filePath);
      await assertPathInsideImageRoot(folderPath, { allowMissing: true });
      await openImageDirectory(folderPath);
      return { ok: true, action: "open-directory", directoryPath: folderPath, missing: true };
    } catch (error) {
      return { ok: false, error: error.message || "图片目录打开失败" };
    }
  });
}
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    focusExistingMainWindow();
  });
  app.whenReady().then(async () => {
    const profileReset = await prepareReleaseProfileReset({
      packaged: app.isPackaged,
      dataRoot,
      logsRoot,
      userDataRoot: app.getPath("userData"),
      seedRoot: app.isPackaged ? path.join(process.resourcesPath, "inspiration-seed") : ""
    });
    releaseProfileResetPending = profileReset.pending;
    if (releaseProfileResetPending) {
      await Promise.allSettled([
        session.defaultSession.clearCache(),
        session.defaultSession.clearCodeCaches({}),
        session.defaultSession.clearStorageData({ storages: ["cachestorage", "serviceworkers", "shadercache"] })
      ]);
    }
    await storage.ensure();
    await requestLogs.interruptRunning().catch(() => 0);
    await fs.mkdir(thumbnailCacheRoot, { recursive: true });
    registerImageProtocol();
    if (!app.isPackaged) {
      await migrateLegacy({ projectRoot, dataRoot, outputsRoot, migrationsRoot: storage.migrationsRoot });
    }
    for (const filename of ["inspiration-sync.ps1", "run-inspiration-sync.cmd", "jbb-sync-handler.ps1", "jbb-sync-token.txt", "jbb-sync-protocol-status.json", "README-inspiration-sync.txt"]) {
      await fs.rm(path.join(dataRoot, filename), { force: true });
    }
    await fs.rm(path.join(dataRoot, "创作灵感同步-安装与卸载"), { recursive: true, force: true });
    registerIpc();
    registerDisplayEvents();
    await createWindow();
    await inspiration.start();
    app.on("activate", () => {
      if (!BrowserWindow.getAllWindows().length) createWindow();
      else focusExistingMainWindow();
    });
  }).catch((error) => {
    fs.mkdir(logsRoot, { recursive: true })
      .then(() => fs.appendFile(path.join(logsRoot, "main.log"), `${new Date().toISOString()} startup ${error.stack || error.message}\n`))
      .catch(() => {});
  });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  process.on("uncaughtException", (error) => { fs.appendFile(path.join(logsRoot, "main.log"), `${new Date().toISOString()} ${error.stack || error.message}\n`).catch(() => {}); });
}
