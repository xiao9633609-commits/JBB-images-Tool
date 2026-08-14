const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { deduplicateInspirationItems } = require("../electron/inspiration.cjs");

const excerpt = {
  id: "prompthub-short",
  sourceId: "prompthub_gpt_image",
  title: "卧室自拍｜照片级提示词",
  prompt: "照片级真实的自拍，照片中是一位可爱年轻东亚女性，肤色白皙，柔和的椭圆脸庞，大而自然的灰褐色眼睛，一只眼睛调皮地闭上一眨眼，嘴唇放松带着微妙微笑，直顺的深棕色头发...",
  promptKind: "full",
  publishedAt: "2026-08-14T00:00:00.000Z"
};
const full = {
  id: "opennana-full",
  sourceId: "opennana",
  title: "卧室自拍提示词",
  prompt: `${excerpt.prompt.replace(/\.\.\.$/, "")}，前额有稀疏透明的刘海，长而柔和的分层波浪发延伸至肩部以下。姿势自然，背景为明亮的现代酒店卧室。`,
  promptKind: "full",
  publishedAt: "2026-08-13T00:00:00.000Z"
};

const deduplicated = deduplicateInspirationItems([excerpt, full]);
assert.equal(deduplicated.length, 1);
assert.equal(deduplicated[0].id, full.id);
assert.equal(deduplicated[0].prompt, full.prompt);
assert.deepEqual(deduplicated[0].duplicateIds, [excerpt.id]);

const divergent = deduplicateInspirationItems([
  { id: "one", prompt: `${"相同的详细提示词内容".repeat(12)}版本甲`, promptKind: "full" },
  { id: "two", prompt: `${"相同的详细提示词内容".repeat(12)}版本乙`, promptKind: "full" }
]);
assert.equal(divergent.length, 2, "complete prompts that diverge after a common prefix must remain separate");

const twoExcerpts = deduplicateInspirationItems([
  { id: "excerpt-one", prompt: `${"公开摘要内容".repeat(16)}...`, promptKind: "excerpt" },
  { id: "excerpt-two", prompt: `${"公开摘要内容".repeat(16)}...`, promptKind: "excerpt" }
]);
assert.equal(twoExcerpts.length, 2, "two truncated excerpts are not enough evidence to merge records");

const renderer = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
assert.match(renderer, /function migrateDeduplicatedInspirationFavorites\(items\)/);
assert.match(renderer, /function deduplicateSyncedInspirations\(items\)/);
assert.match(renderer, /state\.inspirationSyncedItems = deduplicateSyncedInspirations/);
assert.match(renderer, /migrateDeduplicatedInspirationFavorites\(state\.inspirationSyncedItems\)/);

process.stdout.write("inspiration deduplication tests passed\n");
