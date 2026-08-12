const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function readJson(file, fallback) { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; } }
async function hash(file) { return new Promise((resolve, reject) => { const h = crypto.createHash("sha256"); const stream = require("node:fs").createReadStream(file); stream.on("data", (chunk) => h.update(chunk)); stream.on("end", () => resolve(h.digest("hex"))); stream.on("error", reject); }); }

async function migrateLegacy({ projectRoot, dataRoot, outputsRoot, migrationsRoot }) {
  const sourceWork = path.resolve(projectRoot, "..");
  const sourceData = path.join(sourceWork, "data");
  const sourceOutputs = path.join(sourceWork, "outputs");
  const sourceProjectData = path.resolve(projectRoot, "..", "..");
  const targetImages = path.join(outputsRoot, "images");
  await fs.mkdir(targetImages, { recursive: true });
  const log = { version: 1, migratedAt: new Date().toISOString(), sources: [], files: [], conflicts: [] };
  const candidates = [];
  for (const source of [sourceOutputs, path.join(projectRoot, "outputs")]) {
    if (!await exists(source)) continue;
    for (const entry of await fs.readdir(source, { withFileTypes: true })) if (entry.isFile() && /\.(png|jpe?g|webp|gif)$/i.test(entry.name)) candidates.push({ source: path.join(source, entry.name), name: entry.name });
  }
  for (const candidate of candidates) {
    const target = path.join(targetImages, candidate.name);
    if (await exists(target)) { if (await hash(target) !== await hash(candidate.source)) log.conflicts.push({ file: candidate.name, source: candidate.source, reason: "target-exists-different" }); else log.files.push({ file: candidate.name, action: "already-present" }); if (path.dirname(candidate.source) === path.join(projectRoot, "outputs")) await fs.rm(candidate.source, { force: true }); continue; }
    await fs.copyFile(candidate.source, target); log.files.push({ file: candidate.name, action: "copied", source: candidate.source });
    if (path.dirname(candidate.source) === path.join(projectRoot, "outputs")) await fs.rm(candidate.source, { force: true });
  }
  const oldTasks = await readJson(path.join(dataRoot, "tasks.json"), { version: 1, images: [], failedTasks: [] });
  const rootTasks = await readJson(path.join(sourceProjectData, "data", "tasks.json"), null);
  if (rootTasks?.tasks?.length) { oldTasks.desktopTasks = Array.isArray(oldTasks.desktopTasks) ? oldTasks.desktopTasks : []; const known = new Set(oldTasks.desktopTasks.map((task) => task.id)); for (const task of rootTasks.tasks) if (task?.id && !known.has(task.id)) oldTasks.desktopTasks.push(task); await fs.writeFile(path.join(dataRoot, "tasks.json"), JSON.stringify(oldTasks, null, 2), "utf8"); log.sources.push({ source: path.join(sourceProjectData, "data", "tasks.json"), imported: rootTasks.tasks.length }); }
  const rootProjects = await readJson(path.join(sourceProjectData, "data", "projects.json"), null); const targetProjects = await readJson(path.join(dataRoot, "projects.json"), { schemaVersion: 1, projects: [] });
  if (rootProjects?.projects?.length) { const known = new Set((targetProjects.projects || []).map((project) => project.id)); for (const project of rootProjects.projects) if (project?.id && !known.has(project.id)) targetProjects.projects.push(project); await fs.writeFile(path.join(dataRoot, "projects.json"), JSON.stringify(targetProjects, null, 2), "utf8"); log.sources.push({ source: path.join(sourceProjectData, "data", "projects.json"), imported: rootProjects.projects.length }); }
  await fs.mkdir(migrationsRoot, { recursive: true }); await fs.writeFile(path.join(migrationsRoot, "migration-log.json"), JSON.stringify(log, null, 2), "utf8");
  return log;
}

module.exports = { migrateLegacy };
