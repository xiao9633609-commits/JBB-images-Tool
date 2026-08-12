const path = require("node:path");
const fs = require("node:fs/promises");

const DATA_FILES = new Set([
  ".env",
  "settings.json",
  "tasks.json",
  "projects.json",
  "canvases.json",
  "inspiration-feed.json",
  "inspiration-sync-state.json",
  "output-directory.json",
]);

function resolveInside(root, relativePath) {
  const base = path.resolve(root);
  const candidate = path.resolve(base, String(relativePath || ""));
  if (candidate !== base && !candidate.startsWith(`${base}${path.sep}`)) throw new Error("路径越界");
  return candidate;
}

function safeDataName(name) {
  const value = String(name || "");
  if (value.includes("/") || value.includes("\\") || !DATA_FILES.has(value)) throw new Error("数据文件名无效");
  return value;
}

function safeMediaPath(relativePath) {
  const value = String(relativePath || "").replace(/\\/g, "/");
  if (!value || value.startsWith("/") || /^[A-Za-z]:/.test(value)) throw new Error("输出路径无效");
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || /[\x00-\x1f]/.test(segment))) {
    throw new Error("输出路径无效");
  }
  return segments.join(path.sep);
}

function mimeFor(name) {
  const ext = path.extname(name).toLowerCase();
  return ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime" })[ext] || "application/octet-stream";
}

function createStorage({ dataRoot, outputsRoot, logsRoot: configuredLogsRoot }) {
  const defaultOutputsRoot = path.resolve(outputsRoot);
  let activeOutputsRoot = defaultOutputsRoot;
  let imagesRoot = path.join(activeOutputsRoot, "images");
  let videosRoot = path.join(activeOutputsRoot, "videos");
  const canvasAssetsRoot = path.join(dataRoot, "canvas-assets");
  const migrationsRoot = path.join(dataRoot, "migrations");
  const logsRoot = configuredLogsRoot || path.join(path.dirname(outputsRoot), "logs");
  async function loadOutputDirectoryConfig() {
    try {
      const stored = JSON.parse(await fs.readFile(resolveInside(dataRoot, "output-directory.json"), "utf8"));
      const candidate = path.resolve(String(stored?.root || ""));
      if (candidate) activeOutputsRoot = candidate;
    } catch (error) {
      if (error.code !== "ENOENT") activeOutputsRoot = defaultOutputsRoot;
    }
    imagesRoot = path.join(activeOutputsRoot, "images");
    videosRoot = path.join(activeOutputsRoot, "videos");
  }

  async function ensure() {
    await fs.mkdir(dataRoot, { recursive: true });
    await loadOutputDirectoryConfig();
    await Promise.all([activeOutputsRoot, imagesRoot, videosRoot, canvasAssetsRoot, migrationsRoot, logsRoot].map((dir) => fs.mkdir(dir, { recursive: true })));
  }

  async function moveDirectoryContents(source, destination) {
    await fs.mkdir(destination, { recursive: true });
    let entries = [];
    try { entries = await fs.readdir(source, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return 0; throw error; }
    let moved = 0;
    for (const entry of entries) {
      const from = path.join(source, entry.name);
      let to = path.join(destination, entry.name);
      if (entry.isDirectory()) {
        moved += await moveDirectoryContents(from, to);
        try { await fs.rm(from, { recursive: false, force: true }); } catch {}
        continue;
      }
      if (await fs.access(to).then(() => true).catch(() => false)) {
        const ext = path.extname(entry.name);
        const stem = path.basename(entry.name, ext);
        let suffix = 1;
        do { to = path.join(destination, `${stem}-${suffix++}${ext}`); } while (await fs.access(to).then(() => true).catch(() => false));
      }
      try {
        await fs.rename(from, to);
      } catch (error) {
        if (error.code !== "EXDEV") throw error;
        await fs.copyFile(from, to);
        await fs.rm(from, { force: true });
      }
      moved += 1;
    }
    return moved;
  }

  function getRoots() {
    return { data: dataRoot, outputs: activeOutputsRoot, images: imagesRoot, videos: videosRoot, canvasAssets: canvasAssetsRoot, migrations: migrationsRoot, logs: logsRoot, defaultOutputs: defaultOutputsRoot };
  }

  async function setOutputRoot(root, { migrate = true } = {}) {
    const candidate = path.resolve(String(root || ""));
    if (!candidate || candidate === path.parse(candidate).root) throw new Error("输出文件夹路径无效");
    if (candidate === activeOutputsRoot) return getRoots();
    const oldRoot = activeOutputsRoot;
    if (candidate.startsWith(`${oldRoot}${path.sep}`)) throw new Error("新输出文件夹不能位于当前输出文件夹内部");
    const oldImages = imagesRoot;
    const oldVideos = videosRoot;
    const newImages = path.join(candidate, "images");
    const newVideos = path.join(candidate, "videos");
    await fs.mkdir(newImages, { recursive: true });
    await fs.mkdir(newVideos, { recursive: true });
    const movedImages = migrate ? await moveDirectoryContents(oldImages, newImages) : 0;
    const movedVideos = migrate ? await moveDirectoryContents(oldVideos, newVideos) : 0;
    activeOutputsRoot = candidate;
    imagesRoot = newImages;
    videosRoot = newVideos;
    await writeJson("output-directory.json", { root: activeOutputsRoot, migratedAt: new Date().toISOString(), movedImages, movedVideos });
    return { ...getRoots(), movedImages, movedVideos };
  }

  async function resetOutputRoot(options = {}) {
    return setOutputRoot(defaultOutputsRoot, options);
  }

  async function readJson(name, fallback = null) {
    try { return JSON.parse(await fs.readFile(resolveInside(dataRoot, safeDataName(name)), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
  }
  async function writeJson(name, value) {
    const file = resolveInside(dataRoot, safeDataName(name));
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(value, null, 2), "utf8");
    await fs.rename(temp, file);
    return { name };
  }
  async function readText(name, fallback = "") {
    try { return await fs.readFile(resolveInside(dataRoot, safeDataName(name)), "utf8"); }
    catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
  }
  async function writeText(name, value) {
    const file = resolveInside(dataRoot, safeDataName(name));
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, String(value ?? ""), "utf8");
    await fs.rename(temp, file);
    return { name };
  }
  async function removeData(name) {
    await fs.rm(resolveInside(dataRoot, safeDataName(name)), { force: true });
    return true;
  }
  function mediaRoot(mediaType) {
    const normalized = String(mediaType || "image").toLowerCase();
    if (normalized === "video") return videosRoot;
    if (normalized === "reference") return canvasAssetsRoot;
    return imagesRoot;
  }
  async function readBinary({ mediaType = "image", filename }) {
    const safe = safeMediaPath(filename);
    const file = resolveInside(mediaRoot(mediaType), safe);
    try {
      const data = await fs.readFile(file);
      const stat = await fs.stat(file);
      const normalized = safe.split(path.sep).join("/");
      return { data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), mimeType: mimeFor(safe), lastModified: stat.mtimeMs, filename: normalized };
    } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  async function writeBinary({ mediaType = "image", filename, data, base64 }) {
    const safe = safeMediaPath(filename);
    const bytes = base64 ? Buffer.from(String(base64).split(",").pop(), "base64") : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : data || []);
    const file = resolveInside(mediaRoot(mediaType), safe);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
    const normalized = safe.split(path.sep).join("/");
    return { filename: normalized, relativePath: path.posix.join("outputs", mediaType === "video" ? "videos" : "images", normalized) };
  }
  async function removeBinary({ mediaType = "image", filename }) { await fs.rm(resolveInside(mediaRoot(mediaType), safeMediaPath(filename)), { force: true }); return true; }
  async function existsBinary({ mediaType = "image", filename }) { try { await fs.access(resolveInside(mediaRoot(mediaType), safeMediaPath(filename))); return true; } catch { return false; } }

  return { get dataRoot() { return dataRoot; }, get outputsRoot() { return activeOutputsRoot; }, get imagesRoot() { return imagesRoot; }, get videosRoot() { return videosRoot; }, migrationsRoot, logsRoot, ensure, getRoots, setOutputRoot, resetOutputRoot, readJson, writeJson, readText, writeText, removeData, readBinary, writeBinary, removeBinary, existsBinary };
}

module.exports = { createStorage, resolveInside };
