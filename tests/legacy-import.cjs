const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { inspectLegacyImport, importLegacyHistory } = require("../electron/legacy-import.cjs");

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "jbb-legacy-import-"));
  try {
    const legacyRoot = path.join(tempRoot, "legacy");
    const targetRoot = path.join(tempRoot, "target-images");
    const migrationsRoot = path.join(tempRoot, "migrations");
    await fs.mkdir(path.join(legacyRoot, "data"), { recursive: true });
    await fs.mkdir(path.join(legacyRoot, "outputs", "img"), { recursive: true });
    await fs.mkdir(path.join(legacyRoot, "output1", "img"), { recursive: true });
    await fs.mkdir(targetRoot, { recursive: true });
    const orphanImageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    await fs.writeFile(path.join(legacyRoot, "outputs", "img", "duplicate.png"), "duplicate", "utf8");
    await fs.writeFile(path.join(legacyRoot, "outputs", "img", "new.png"), "new-image", "utf8");
    await fs.writeFile(path.join(legacyRoot, "output1", "img", "new.png"), "new-image", "utf8");
    await fs.writeFile(path.join(legacyRoot, "output1", "img", "gpt-image-2-2026-08-03T12-34-56-789Z-a1b2c3d4e5.png"), orphanImageBytes);
    await fs.writeFile(path.join(legacyRoot, "data", "tasks.json"), JSON.stringify({
      version: 1,
      images: [
        { recordId: "existing-image", outputFile: "img/duplicate.png", metadata: { recordId: "existing-image" } },
        { recordId: "new-image", outputFile: "img/new.png", metadata: { recordId: "new-image" } },
        { recordId: "missing-image", outputFile: "img/missing.png", metadata: { recordId: "missing-image" } }
      ],
      failedTasks: [
        { recordId: "existing-failure", reason: "duplicate" },
        { recordId: "new-failure", reason: "legacy failure" }
      ]
    }), "utf8");
    await fs.writeFile(path.join(legacyRoot, "data", "settings.json"), JSON.stringify({
      baseUrl: "https://legacy.example.invalid/v1",
      apiKey: "legacy-key-must-not-be-imported"
    }), "utf8");
    await fs.writeFile(path.join(legacyRoot, "data", ".env"), "OPENAI_API_KEY=legacy-secret-must-not-be-imported\n", "utf8");

    const preview = await inspectLegacyImport(path.join(legacyRoot, "output1"));
    assert.equal(preview.images, 3);
    assert.equal(preview.availableImages, 3);
    assert.equal(preview.availableIndexedImages, 2);
    assert.equal(preview.recoveredImages, 1);
    assert.equal(preview.sourceImageFiles, 4);
    assert.equal(preview.duplicateFiles, 1);
    assert.equal(preview.missingImages, 1);
    assert.equal(preview.failedTasks, 2);
    assert.equal(preview.total, 5);

    const storageReads = [];
    const storage = {
      imagesRoot: targetRoot,
      migrationsRoot,
      readJson: async (name) => {
        storageReads.push(name);
        return {
        images: [{ recordId: "existing-image", outputFile: "current.png" }],
        failedTasks: [{ recordId: "existing-failure" }]
        };
      }
    };
    await fs.writeFile(path.join(targetRoot, "current.png"), "current", "utf8");
    const result = await importLegacyHistory({ selectedPath: legacyRoot, storage });
    assert.equal(result.ok, true);
    assert.equal(result.copiedImages, 2);
    assert.equal(result.importedIndexedImages, 1);
    assert.equal(result.recoveredImages, 1);
    assert.equal(result.sourceDuplicateFiles, 1);
    assert.equal(result.importedFailures, 1);
    assert.equal(result.skippedDuplicates, 2);
    assert.equal(result.skippedMissing, 1);
    assert.equal(result.taskHistory.images.find((record) => !record.metadata.legacyRecovered).outputFile, "new.png");
    const recovered = result.taskHistory.images.find((record) => record.metadata.legacyRecovered);
    assert.equal(recovered.metadata.model, "gpt-image-2");
    assert.equal(recovered.metadata.prompt, "旧版文件恢复：原任务索引已缺失，无法还原原始提示词。");
    assert.equal(recovered.metadata.createdAt, "2026-08-03T12:34:56.789Z");
    assert.equal(recovered.metadata.actualSize, "1x1");
    assert.equal(await fs.readFile(path.join(targetRoot, "new.png"), "utf8"), "new-image");
    assert.deepEqual(await fs.readFile(path.join(targetRoot, recovered.outputFile)), orphanImageBytes);
    assert.equal((await fs.readdir(migrationsRoot)).length, 1);
    assert.deepEqual(storageReads, ["tasks.json"]);
    assert.doesNotMatch(JSON.stringify(result), /legacy-key-must-not-be-imported|legacy-secret-must-not-be-imported|legacy\.example\.invalid/);

    async function createModeStorage(name) {
      const imagesRoot = path.join(tempRoot, `${name}-images`);
      const modeMigrationsRoot = path.join(tempRoot, `${name}-migrations`);
      await fs.mkdir(imagesRoot, { recursive: true });
      await fs.writeFile(path.join(imagesRoot, "current.png"), "current", "utf8");
      return {
        imagesRoot,
        migrationsRoot: modeMigrationsRoot,
        readJson: storage.readJson
      };
    }

    const indexedStorage = await createModeStorage("indexed");
    const indexedResult = await importLegacyHistory({ selectedPath: legacyRoot, storage: indexedStorage, mode: "indexed" });
    assert.equal(indexedResult.mode, "indexed");
    assert.equal(indexedResult.copiedImages, 1);
    assert.equal(indexedResult.importedIndexedImages, 1);
    assert.equal(indexedResult.recoveredImages, 0);
    assert.equal(indexedResult.importedFailures, 1);
    assert.equal(indexedResult.taskHistory.images.length, 1);
    assert.equal(indexedResult.taskHistory.failedTasks.length, 1);

    const recoveredStorage = await createModeStorage("recovered");
    const recoveredResult = await importLegacyHistory({ selectedPath: legacyRoot, storage: recoveredStorage, mode: "recovered" });
    assert.equal(recoveredResult.mode, "recovered");
    assert.equal(recoveredResult.copiedImages, 1);
    assert.equal(recoveredResult.importedIndexedImages, 0);
    assert.equal(recoveredResult.recoveredImages, 1);
    assert.equal(recoveredResult.importedFailures, 0);
    assert.equal(recoveredResult.skippedMissing, 0);
    assert.equal(recoveredResult.taskHistory.images.length, 1);
    assert.equal(recoveredResult.taskHistory.failedTasks.length, 0);
    assert.equal(recoveredResult.taskHistory.images[0].metadata.legacyRecovered, true);

    const filesOnlyRoot = path.join(tempRoot, "files-only");
    await fs.mkdir(path.join(filesOnlyRoot, "output1", "img"), { recursive: true });
    await fs.writeFile(path.join(filesOnlyRoot, "output1", "img", "legacy.png"), "files-only", "utf8");
    const filesOnlyPreview = await inspectLegacyImport(filesOnlyRoot);
    assert.equal(filesOnlyPreview.taskFilePresent, false);
    assert.equal(filesOnlyPreview.recoveredImages, 1);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().then(() => console.log("legacy import tests passed")).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
