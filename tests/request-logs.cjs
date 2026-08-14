const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createRequestLogService } = require("../electron/request-logs.cjs");

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "jbbimg-request-logs-test-"));
  let clock = Date.parse("2026-08-13T00:00:00.000Z");
  try {
    const logs = createRequestLogService({ dataRoot: tempRoot, now: () => clock });

    await logs.create({
      id: "redaction-test",
      taskId: 1,
      config: { model: "gpt-image-2", apiKey: "sk-secret-value" }
    });
    await logs.startAttempt("redaction-test", {
      requestId: "request-1",
      url: "https://example.com/v1/images?token=secret&mode=test",
      method: "POST",
      headers: { Authorization: "Bearer secret-token", Cookie: "session=secret" },
      body: JSON.stringify({ prompt: "test", api_key: "secret" }),
      formDataEntries: [{ name: "image", kind: "file", filename: "ref.png", mimeType: "image/png", data: Buffer.alloc(16) }]
    });
    await logs.finishAttempt("redaction-test", "request-1", {
      response: { status: 200, headers: { "set-cookie": "secret" }, body: JSON.stringify({ url: "https://cdn.example.com/a.png?signature=secret" }) }
    });

    let items = await logs.list();
    const serialized = JSON.stringify(items[0]);
    assert.equal(serialized.includes("secret-token"), false);
    assert.equal(serialized.includes("sk-secret-value"), false);
    assert.equal(serialized.includes('"api_key":"secret"'), false);
    assert.match(serialized, /REDACTED/);
    assert.match(serialized, /16/);
    const embeddedImage = "data:image/png;base64," + Buffer.alloc(64, 7).toString("base64");
    await logs.startAttempt("redaction-test", {
      requestId: "video-base64-request",
      url: "https://example.com/v1/videos",
      method: "POST",
      body: JSON.stringify({ model: "H3video-2k", input_reference: embeddedImage })
    });
    items = await logs.list();
    const videoRequest = items[0].attempts.find((attempt) => attempt.requestId === "video-base64-request");
    assert.equal(JSON.stringify(videoRequest).includes(embeddedImage), false);
    assert.equal(videoRequest.request.body.input_reference, "data:[embedded-image-omitted]");
    await logs.update("redaction-test", { status: "completed" });

    await logs.create({ id: "interrupted-test", taskId: 2, status: "running" });
    assert.equal(await logs.interruptRunning(), 1);
    items = await logs.list();
    const interrupted = items.find((item) => item.id === "interrupted-test");
    assert.equal(interrupted.status, "interrupted");
    assert.equal(interrupted.error.code, "app_restarted");

    for (let index = 0; index < 52; index += 1) {
      clock += 1000;
      await logs.create({ id: `limit-${index}`, taskId: index + 2, config: { model: "gpt-image-2" } });
    }
    items = await logs.list();
    assert.equal(items.length, 50);
    assert.equal(items.some((item) => item.id === "limit-51"), true);
    assert.equal(items.some((item) => item.id === "limit-0"), false);

    clock += 6 * 60 * 60 * 1000 + 1;
    items = await logs.list();
    assert.equal(items.length, 0);
  } finally {
    const resolvedTemp = path.resolve(tempRoot);
    const systemTemp = path.resolve(os.tmpdir());
    if (resolvedTemp.startsWith(`${systemTemp}${path.sep}`)) {
      await fs.rm(resolvedTemp, { recursive: true, force: true });
    }
  }
}

main().then(() => {
  process.stdout.write("request log tests passed\n");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
