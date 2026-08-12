const path = require("node:path");
const fs = require("node:fs/promises");

const PROFILE_RESET_VERSION = "0.3.7";
const PROFILE_RESET_ID = `clean-profile-${PROFILE_RESET_VERSION}`;
const PROFILE_RESET_MARKER = `${PROFILE_RESET_ID}.json`;
const DATA_FILES_TO_REMOVE = Object.freeze([
  ".env",
  "settings.json",
  "tasks.json",
  "projects.json",
  "canvases.json",
  "output-directory.json"
]);
const DATA_DIRECTORIES_TO_REMOVE = Object.freeze([
  "canvas-assets",
  "thumbnail-cache"
]);
const USER_CACHE_DIRECTORIES_TO_REMOVE = Object.freeze([
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "blob_storage",
  "Session Storage",
  "Shared Dictionary"
]);
const INSPIRATION_SEED_FILES = Object.freeze([
  "inspiration-feed.json",
  "inspiration-sync-state.json"
]);

async function pathExists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(temporary, file);
}

function getProfileResetMarkerPath(dataRoot) {
  return path.join(dataRoot, "migrations", PROFILE_RESET_MARKER);
}

async function readProfileResetMarker(dataRoot) {
  try {
    return JSON.parse(await fs.readFile(getProfileResetMarkerPath(dataRoot), "utf8"));
  } catch {
    return null;
  }
}

async function installInspirationSeed({ dataRoot, seedRoot }) {
  if (!seedRoot) return;
  for (const filename of INSPIRATION_SEED_FILES) {
    const destination = path.join(dataRoot, filename);
    if (await pathExists(destination)) continue;
    const source = path.join(seedRoot, filename);
    if (!(await pathExists(source))) continue;
    await fs.copyFile(source, destination);
  }
}

async function prepareReleaseProfileReset({ packaged, dataRoot, logsRoot, userDataRoot, seedRoot }) {
  if (!packaged) return { pending: false, skipped: true, version: PROFILE_RESET_VERSION };
  const existingMarker = await readProfileResetMarker(dataRoot);
  if (existingMarker?.completed === true) {
    await installInspirationSeed({ dataRoot, seedRoot });
    return { pending: false, skipped: false, version: PROFILE_RESET_VERSION };
  }

  await fs.mkdir(dataRoot, { recursive: true });
  await Promise.all(
    DATA_FILES_TO_REMOVE.map((filename) => fs.rm(path.join(dataRoot, filename), { force: true }))
  );
  await Promise.all(
    DATA_DIRECTORIES_TO_REMOVE.map((directory) => fs.rm(path.join(dataRoot, directory), { recursive: true, force: true }))
  );

  if (logsRoot) {
    await fs.rm(logsRoot, { recursive: true, force: true });
    await fs.mkdir(logsRoot, { recursive: true });
  }

  if (userDataRoot) {
    await Promise.allSettled(
      USER_CACHE_DIRECTORIES_TO_REMOVE.map((directory) =>
        fs.rm(path.join(userDataRoot, directory), { recursive: true, force: true })
      )
    );
  }

  await installInspirationSeed({ dataRoot, seedRoot });
  await writeJsonAtomic(getProfileResetMarkerPath(dataRoot), {
    version: PROFILE_RESET_VERSION,
    completed: false,
    mainProcessCompletedAt: new Date().toISOString()
  });
  return { pending: true, skipped: false, version: PROFILE_RESET_VERSION };
}

async function completeReleaseProfileReset({ dataRoot }) {
  await writeJsonAtomic(getProfileResetMarkerPath(dataRoot), {
    version: PROFILE_RESET_VERSION,
    completed: true,
    completedAt: new Date().toISOString()
  });
  return { pending: false, completed: true, version: PROFILE_RESET_VERSION };
}

module.exports = {
  PROFILE_RESET_VERSION,
  PROFILE_RESET_ID,
  PROFILE_RESET_MARKER,
  DATA_FILES_TO_REMOVE,
  DATA_DIRECTORIES_TO_REMOVE,
  USER_CACHE_DIRECTORIES_TO_REMOVE,
  INSPIRATION_SEED_FILES,
  getProfileResetMarkerPath,
  readProfileResetMarker,
  prepareReleaseProfileReset,
  completeReleaseProfileReset
};
