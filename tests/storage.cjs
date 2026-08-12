const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createStorage } = require("../electron/storage.cjs");

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "jbbimg-storage-test-"));
  try {
    const storage = createStorage({
      dataRoot: path.join(tempRoot, "data"),
      outputsRoot: path.join(tempRoot, "outputs"),
      logsRoot: path.join(tempRoot, "logs"),
    });
    await storage.ensure();

    const saved = await storage.writeBinary({
      mediaType: "reference",
      filename: "canvas/reference.png",
      data: Buffer.from([137, 80, 78, 71]),
    });
    const loaded = await storage.readBinary({
      mediaType: "reference",
      filename: saved.filename,
    });
    assert.equal(loaded.data.byteLength, 4);
    assert.equal(loaded.mimeType, "image/png");

    await storage.writeJson("canvases.json", { version: 2, documents: {} });
    assert.deepEqual(await storage.readJson("canvases.json", null), {
      version: 2,
      documents: {},
    });

    await assert.rejects(
      storage.writeBinary({
        mediaType: "reference",
        filename: "../outside.png",
        data: Buffer.from([1]),
      }),
      /路径|输出/,
    );
  } finally {
    const resolvedTemp = path.resolve(tempRoot);
    const systemTemp = path.resolve(os.tmpdir());
    if (resolvedTemp.startsWith(`${systemTemp}${path.sep}`)) {
      await fs.rm(resolvedTemp, { recursive: true, force: true });
    }
  }
}

main().then(() => {
  process.stdout.write("storage tests passed\n");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
