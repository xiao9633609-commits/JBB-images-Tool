const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  PROFILE_RESET_VERSION,
  DATA_FILES_TO_REMOVE,
  DATA_DIRECTORIES_TO_REMOVE,
  USER_CACHE_DIRECTORIES_TO_REMOVE,
  readProfileResetMarker,
  prepareReleaseProfileReset,
  completeReleaseProfileReset
} = require("../electron/profile-reset.cjs");

async function write(file, value = "test") {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value);
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "jbbimg-profile-reset-"));
  try {
    const dataRoot = path.join(tempRoot, "data");
    const logsRoot = path.join(tempRoot, "logs");
    const userDataRoot = path.join(tempRoot, "user-data");
    const seedRoot = path.join(tempRoot, "seed");
    const outputsRoot = path.join(tempRoot, "outputs");

    await Promise.all(DATA_FILES_TO_REMOVE.map((name) => write(path.join(dataRoot, name))));
    await Promise.all(DATA_DIRECTORIES_TO_REMOVE.map((name) => write(path.join(dataRoot, name, "old.bin"))));
    await Promise.all(USER_CACHE_DIRECTORIES_TO_REMOVE.map((name) => write(path.join(userDataRoot, name, "cache.bin"))));
    await write(path.join(userDataRoot, "Local Storage", "leveldb", "favorites"));
    await write(path.join(userDataRoot, "IndexedDB", "workspace"));
    await write(path.join(logsRoot, "main.log"));
    await write(path.join(outputsRoot, "images", "keep.png"));
    await write(path.join(dataRoot, "inspiration-feed.json"), JSON.stringify({ source: "existing" }));
    await write(path.join(seedRoot, "inspiration-feed.json"), JSON.stringify({ source: "seed" }));
    await write(path.join(seedRoot, "inspiration-sync-state.json"), JSON.stringify({ status: "seed" }));

    const prepared = await prepareReleaseProfileReset({
      packaged: true,
      dataRoot,
      logsRoot,
      userDataRoot,
      seedRoot
    });
    assert.equal(prepared.pending, true);
    assert.equal(prepared.version, PROFILE_RESET_VERSION);

    for (const name of DATA_FILES_TO_REMOVE) assert.equal(await exists(path.join(dataRoot, name)), false, name);
    for (const name of DATA_DIRECTORIES_TO_REMOVE) assert.equal(await exists(path.join(dataRoot, name)), false, name);
    for (const name of USER_CACHE_DIRECTORIES_TO_REMOVE) assert.equal(await exists(path.join(userDataRoot, name)), false, name);
    assert.equal(await exists(path.join(userDataRoot, "Local Storage", "leveldb", "favorites")), true);
    assert.equal(await exists(path.join(userDataRoot, "IndexedDB", "workspace")), true);
    assert.equal(await exists(path.join(outputsRoot, "images", "keep.png")), true);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataRoot, "inspiration-feed.json"), "utf8")), { source: "existing" });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataRoot, "inspiration-sync-state.json"), "utf8")), { status: "seed" });
    assert.deepEqual(await fs.readdir(logsRoot), []);

    const pendingMarker = await readProfileResetMarker(dataRoot);
    assert.equal(pendingMarker.completed, false);
    await completeReleaseProfileReset({ dataRoot });
    const completedMarker = await readProfileResetMarker(dataRoot);
    assert.equal(completedMarker.completed, true);

    const secondRun = await prepareReleaseProfileReset({ packaged: true, dataRoot, logsRoot, userDataRoot, seedRoot });
    assert.equal(secondRun.pending, false);
  } finally {
    const resolvedTemp = path.resolve(tempRoot);
    const systemTemp = path.resolve(os.tmpdir());
    if (resolvedTemp.startsWith(`${systemTemp}${path.sep}`)) {
      await fs.rm(resolvedTemp, { recursive: true, force: true });
    }
  }
}

main().then(() => {
  process.stdout.write("profile reset tests passed\n");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
