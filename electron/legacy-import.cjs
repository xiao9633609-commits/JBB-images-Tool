const path = require("node:path");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const LEGACY_RECOVERY_PROMPT = "旧版文件恢复：原任务索引已缺失，无法还原原始提示词。";

function normalizeLegacyPath(value) {
  const normalized = String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => !part || part === "." || part === ".." || /[\x00-\x1f]/.test(part))) return "";
  return normalized;
}

function safeResolve(root, relative) {
  const candidate = path.resolve(root, relative);
  const base = path.resolve(root);
  const relation = path.relative(base, candidate);
  if (relation && (relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation))) throw new Error("旧版记录包含越界文件路径");
  return candidate;
}

async function pathStat(candidate) {
  try { return await fs.stat(candidate); } catch { return null; }
}

async function isFile(filePath) {
  return Boolean((await pathStat(filePath))?.isFile());
}

async function isDirectory(directoryPath) {
  return Boolean((await pathStat(directoryPath))?.isDirectory());
}

function isLegacyOutputDirectoryName(name) {
  return /^outputs?$/i.test(String(name || "")) || /^output\d+$/i.test(String(name || ""));
}

async function hasLegacyOutputDirectory(root) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.some((entry) => entry.isDirectory() && isLegacyOutputDirectoryName(entry.name));
}

async function locateLegacyRoot(selectedPath) {
  const selected = path.resolve(String(selectedPath || ""));
  const selectedName = path.basename(selected);
  const candidates = [];
  if (selectedName.toLowerCase() === "data") candidates.push({ root: path.dirname(selected), data: selected });
  if (isLegacyOutputDirectoryName(selectedName)) candidates.push({ root: path.dirname(selected), data: path.join(path.dirname(selected), "data"), selectedOutput: selected });
  candidates.push({ root: selected, data: path.join(selected, "data") });
  candidates.push({ root: selected, data: selected });
  for (const candidate of candidates) {
    const tasksPath = path.join(candidate.data, "tasks.json");
    if (await isFile(tasksPath) || await hasLegacyOutputDirectory(candidate.root)) {
      return {
        ...candidate,
        outputs: path.join(candidate.root, "outputs"),
        tasksPath,
        taskFilePresent: await isFile(tasksPath)
      };
    }
  }
  throw new Error("未找到旧版 data/tasks.json 或 outputs/output1 图片目录，请选择旧版授权的根目录");
}

async function readJsonFile(filePath, fallback = null) {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw new Error(`读取 ${path.basename(filePath)} 失败：${error.message}`); }
}

async function getLegacyOutputDirectories(roots) {
  const entries = await fs.readdir(roots.root, { withFileTypes: true }).catch(() => []);
  const directories = entries
    .filter((entry) => entry.isDirectory() && isLegacyOutputDirectoryName(entry.name))
    .map((entry) => path.join(roots.root, entry.name));
  if (roots.selectedOutput && await isDirectory(roots.selectedOutput)) directories.unshift(roots.selectedOutput);
  if (await isDirectory(roots.outputs)) directories.push(roots.outputs);
  return [...new Set(directories.map((directory) => path.resolve(directory)))]
    .sort((left, right) => {
      const leftName = path.basename(left).toLowerCase();
      const rightName = path.basename(right).toLowerCase();
      const priority = (name) => name === "output1" ? 0 : name === "outputs" ? 1 : 2;
      return priority(leftName) - priority(rightName) || leftName.localeCompare(rightName);
    });
}

async function walkLegacyImages(directory, outputRoot = directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkLegacyImages(fullPath, outputRoot));
      continue;
    }
    if (!entry.isFile() || !IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    const stat = await fs.stat(fullPath);
    files.push({
      sourcePath: fullPath,
      outputRoot,
      relativePath: path.relative(outputRoot, fullPath).split(path.sep).join("/"),
      name: entry.name,
      size: stat.size,
      mtimeMs: stat.mtimeMs
    });
  }
  return files;
}

function readJpegDimensions(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + length + 2 > buffer.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
    }
    offset += length + 2;
  }
  return null;
}

function readWebpDimensions(buffer) {
  if (buffer.length < 30 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") return null;
  const kind = buffer.toString("ascii", 12, 16);
  if (kind === "VP8X") return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
  if (kind === "VP8L" && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (kind === "VP8 " && buffer.length >= 30) return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  return null;
}

function readImageDimensions(buffer, extension) {
  const ext = String(extension || "").toLowerCase();
  if (ext === ".png" && buffer.length >= 24 && buffer.toString("hex", 0, 8) === "89504e470d0a1a0a") {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if ([".jpg", ".jpeg"].includes(ext) && buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) return readJpegDimensions(buffer);
  if (ext === ".gif" && buffer.length >= 10 && /^GIF8[79]a$/.test(buffer.toString("ascii", 0, 6))) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (ext === ".webp") return readWebpDimensions(buffer);
  return null;
}

async function analyzeImageFile(file) {
  const bytes = await fs.readFile(file.sourcePath);
  return {
    ...file,
    hash: crypto.createHash("sha256").update(bytes).digest("hex"),
    dimensions: readImageDimensions(bytes, path.extname(file.name))
  };
}

async function buildLegacyInventory(roots) {
  const outputDirectories = await getLegacyOutputDirectories(roots);
  const files = [];
  for (const directory of outputDirectories) files.push(...await walkLegacyImages(directory));
  const analyzed = [];
  for (const file of files) analyzed.push(await analyzeImageFile(file));
  const byHash = new Map();
  for (const file of analyzed) {
    if (!byHash.has(file.hash)) byHash.set(file.hash, []);
    byHash.get(file.hash).push(file);
  }
  const uniqueImages = [...byHash.entries()].map(([hash, copies]) => ({ ...copies[0], hash, copies }));
  return {
    outputDirectories,
    files: analyzed,
    filesByPath: new Map(analyzed.map((file) => [path.resolve(file.sourcePath).toLowerCase(), file])),
    uniqueImages,
    duplicateFiles: Math.max(0, analyzed.length - uniqueImages.length)
  };
}

function getLegacyOutputCandidates(outputDirectories, outputFile) {
  const normalized = normalizeLegacyPath(outputFile);
  if (!normalized) return [];
  const parts = normalized.split("/");
  const candidates = [];
  for (const outputRoot of outputDirectories) {
    if (["img", "images", "video", "videos"].includes(parts[0].toLowerCase())) candidates.push(safeResolve(outputRoot, parts.join(path.sep)));
    else {
      candidates.push(safeResolve(path.join(outputRoot, "img"), parts.join(path.sep)));
      candidates.push(safeResolve(outputRoot, parts.join(path.sep)));
    }
  }
  return [...new Set(candidates)];
}

async function findExistingFile(candidates) {
  for (const candidate of candidates) if (await isFile(candidate)) return candidate;
  return "";
}

function stripOutputDirectory(outputFile) {
  const normalized = normalizeLegacyPath(outputFile);
  if (!normalized) return "";
  const parts = normalized.split("/");
  return ["img", "images"].includes(parts[0].toLowerCase()) ? parts.slice(1).join("/") : normalized;
}

async function fileHash(filePath) {
  return crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

function historyRecords(history) {
  return {
    images: Array.isArray(history?.images) ? history.images : [],
    failedTasks: Array.isArray(history?.failedTasks) ? history.failedTasks : []
  };
}

function parseLegacyFilename(filename) {
  const extension = path.extname(filename).toLowerCase();
  const stem = path.basename(filename, extension);
  const match = stem.match(/^(.*?)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-([a-z0-9]+)$/i);
  if (!match) return { model: "旧版图片", createdAt: "", extension };
  const stamp = match[2].replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "T$1:$2:$3.$4Z");
  const createdAt = Number.isFinite(new Date(stamp).getTime()) ? new Date(stamp).toISOString() : "";
  return { model: match[1] || "旧版图片", createdAt, extension };
}

function createRecoveredImageRecord(source, destination) {
  const parsed = parseLegacyFilename(source.name);
  const createdAt = parsed.createdAt || new Date(source.mtimeMs || Date.now()).toISOString();
  const actualSize = source.dimensions?.width && source.dimensions?.height
    ? `${source.dimensions.width}x${source.dimensions.height}`
    : "";
  const recordId = `legacy-file-${source.hash.slice(0, 32)}`;
  return {
    recordId,
    outputFile: destination,
    revisedPrompt: "",
    metadata: {
      recordId,
      outputFile: destination,
      model: parsed.model,
      prompt: LEGACY_RECOVERY_PROMPT,
      createdAt,
      durationMs: 0,
      actualSize,
      size: "",
      outputFormat: parsed.extension === ".jpg" ? "jpeg" : parsed.extension.replace(/^\./, "") || "png",
      quality: "auto",
      background: "auto",
      moderation: "auto",
      count: 1,
      referenceFiles: [],
      referenceFileNames: [],
      legacyRecovered: true,
      legacySourceName: source.name
    }
  };
}

async function inspectLegacyImport(selectedPath) {
  const roots = await locateLegacyRoot(selectedPath);
  const history = roots.taskFilePresent ? await readJsonFile(roots.tasksPath, {}) : {};
  if (!history || typeof history !== "object") throw new Error("旧版 tasks.json 格式无效");
  const { images, failedTasks } = historyRecords(history);
  const inventory = await buildLegacyInventory(roots);
  const indexedHashes = new Set();
  let missingImages = 0;
  for (const record of images) {
    const sourcePath = await findExistingFile(getLegacyOutputCandidates(inventory.outputDirectories, record?.outputFile));
    if (!sourcePath) { missingImages += 1; continue; }
    const analyzed = inventory.filesByPath.get(path.resolve(sourcePath).toLowerCase());
    indexedHashes.add(analyzed?.hash || await fileHash(sourcePath));
  }
  const recoveredImages = inventory.uniqueImages.filter((file) => !indexedHashes.has(file.hash)).length;
  const availableImages = indexedHashes.size + recoveredImages;
  return {
    ok: true,
    rootPath: roots.root,
    dataPath: roots.data,
    taskFilePresent: roots.taskFilePresent,
    images: images.length,
    indexedImages: images.length,
    availableIndexedImages: indexedHashes.size,
    recoveredImages,
    availableImages,
    sourceImageFiles: inventory.files.length,
    duplicateFiles: inventory.duplicateFiles,
    missingImages,
    failedTasks: failedTasks.length,
    total: availableImages + failedTasks.length
  };
}

async function nextAvailablePath(targetRoot, relative, used) {
  const normalized = normalizeLegacyPath(relative) || `legacy-${Date.now()}.bin`;
  const parsed = path.posix.parse(normalized);
  for (let index = 1; index < 100000; index += 1) {
    const candidate = index === 1 ? normalized : path.posix.join(parsed.dir, `${parsed.name}-${index}${parsed.ext}`);
    if (used.has(candidate.toLowerCase()) || await isFile(safeResolve(targetRoot, candidate))) continue;
    used.add(candidate.toLowerCase());
    return candidate;
  }
  throw new Error("无法为导入图片生成可用文件名");
}

async function importLegacyHistory({ selectedPath, storage, mode = "all" }) {
  const normalizedMode = ["all", "indexed", "recovered"].includes(mode) ? mode : "all";
  const importIndexed = normalizedMode === "all" || normalizedMode === "indexed";
  const importRecovered = normalizedMode === "all" || normalizedMode === "recovered";
  const importFailures = normalizedMode === "all" || normalizedMode === "indexed";
  const roots = await locateLegacyRoot(selectedPath);
  const history = roots.taskFilePresent ? await readJsonFile(roots.tasksPath, {}) : {};
  if (!history || typeof history !== "object") throw new Error("旧版 tasks.json 格式无效");
  const { images, failedTasks } = historyRecords(history);
  const inventory = await buildLegacyInventory(roots);
  const current = await storage.readJson("tasks.json", { images: [], failedTasks: [] });
  const knownIds = new Set([
    ...(Array.isArray(current?.images) ? current.images : []).map((record) => String(record?.recordId || record?.metadata?.recordId || "")).filter(Boolean),
    ...(Array.isArray(current?.failedTasks) ? current.failedTasks : []).map((record) => String(record?.recordId || "")).filter(Boolean)
  ]);
  const knownOutputFiles = new Set((Array.isArray(current?.images) ? current.images : []).map((record) => normalizeLegacyPath(record?.outputFile)).filter(Boolean).map((name) => name.toLowerCase()));
  const destinationUsed = new Set(knownOutputFiles);
  const knownHashes = new Set();
  for (const record of Array.isArray(current?.images) ? current.images : []) {
    const outputFile = normalizeLegacyPath(record?.outputFile);
    if (!outputFile) continue;
    const currentFile = safeResolve(storage.imagesRoot, outputFile);
    if (await isFile(currentFile)) knownHashes.add(await fileHash(currentFile));
  }

  const importedImages = [];
  const indexedSourceHashes = new Set();
  const copiedPaths = [];
  let importedIndexedImages = 0;
  let recoveredImages = 0;
  let skippedDuplicates = 0;
  let skippedMissing = 0;
  try {
    for (const record of images) {
      const sourcePath = await findExistingFile(getLegacyOutputCandidates(inventory.outputDirectories, record?.outputFile));
      if (!sourcePath) {
        if (importIndexed) skippedMissing += 1;
        continue;
      }
      const analyzed = inventory.filesByPath.get(path.resolve(sourcePath).toLowerCase()) || await analyzeImageFile({
        sourcePath,
        outputRoot: path.dirname(sourcePath),
        relativePath: path.basename(sourcePath),
        name: path.basename(sourcePath),
        size: (await fs.stat(sourcePath)).size,
        mtimeMs: (await fs.stat(sourcePath)).mtimeMs
      });
      indexedSourceHashes.add(analyzed.hash);
      if (!importIndexed) continue;
      const recordId = String(record?.recordId || record?.metadata?.recordId || "");
      if ((recordId && knownIds.has(recordId)) || knownHashes.has(analyzed.hash)) { skippedDuplicates += 1; continue; }
      const originalName = stripOutputDirectory(record?.outputFile) || analyzed.name;
      const destination = await nextAvailablePath(storage.imagesRoot, originalName, destinationUsed);
      const destinationPath = safeResolve(storage.imagesRoot, destination);
      await fs.mkdir(path.dirname(destinationPath), { recursive: true });
      await fs.copyFile(sourcePath, destinationPath);
      copiedPaths.push(destinationPath);
      knownHashes.add(analyzed.hash);
      const metadata = { ...(record?.metadata || {}), outputFile: destination, referenceFiles: [] };
      if (recordId) metadata.recordId = recordId;
      importedImages.push({ ...record, recordId: recordId || undefined, outputFile: destination, metadata });
      importedIndexedImages += 1;
      if (recordId) knownIds.add(recordId);
    }

    if (importRecovered) {
      for (const source of inventory.uniqueImages) {
        if (indexedSourceHashes.has(source.hash) || knownHashes.has(source.hash)) continue;
        const destination = await nextAvailablePath(storage.imagesRoot, source.name, destinationUsed);
        const destinationPath = safeResolve(storage.imagesRoot, destination);
        await fs.mkdir(path.dirname(destinationPath), { recursive: true });
        await fs.copyFile(source.sourcePath, destinationPath);
        copiedPaths.push(destinationPath);
        knownHashes.add(source.hash);
        importedImages.push(createRecoveredImageRecord(source, destination));
        recoveredImages += 1;
      }
    }
  } catch (error) {
    await Promise.allSettled(copiedPaths.map((filePath) => fs.rm(filePath, { force: true })));
    throw error;
  }

  const importedFailures = [];
  if (importFailures) {
    for (const failure of failedTasks) {
      const recordId = String(failure?.recordId || "");
      if (recordId && knownIds.has(recordId)) { skippedDuplicates += 1; continue; }
      importedFailures.push({ ...failure, referenceFiles: [] });
      if (recordId) knownIds.add(recordId);
    }
  }
  const copiedImages = importedIndexedImages + recoveredImages;
  const log = {
    version: 2,
    mode: normalizedMode,
    importedAt: new Date().toISOString(),
    sourceRoot: roots.root,
    taskFilePresent: roots.taskFilePresent,
    copiedImages,
    importedIndexedImages,
    recoveredImages,
    sourceImageFiles: inventory.files.length,
    sourceDuplicateFiles: inventory.duplicateFiles,
    importedFailures: importedFailures.length,
    skippedDuplicates,
    skippedMissing
  };
  const logName = `legacy-import-${Date.now()}.json`;
  await fs.mkdir(storage.migrationsRoot, { recursive: true });
  await fs.writeFile(path.join(storage.migrationsRoot, logName), JSON.stringify(log, null, 2), "utf8");
  return {
    ok: true,
    mode: normalizedMode,
    sourceRoot: roots.root,
    copiedImages,
    importedIndexedImages,
    recoveredImages,
    sourceImageFiles: inventory.files.length,
    sourceDuplicateFiles: inventory.duplicateFiles,
    importedFailures: importedFailures.length,
    skippedDuplicates,
    skippedMissing,
    taskHistory: { version: 2, savedAt: new Date().toISOString(), images: importedImages, failedTasks: importedFailures, batches: [], desktopTasks: [] }
  };
}

module.exports = {
  inspectLegacyImport,
  importLegacyHistory,
  locateLegacyRoot,
  normalizeLegacyPath,
  parseLegacyFilename,
  readImageDimensions
};
