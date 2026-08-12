const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const sourcePath = path.join(root, "renderer", "prompt-assistant-intent.js");
const publicPath = path.join(root, "renderer", "public", "prompt-assistant-intent.js");
const indexHtml = fs.readFileSync(path.join(root, "renderer", "index.html"), "utf8");
global.window = global;
require(sourcePath);
const intent = global.JBBPromptAssistantIntent;

assert.equal(fs.readFileSync(sourcePath, "utf8"), fs.readFileSync(publicPath, "utf8"));
assert.match(indexHtml, /<script src="\.\/prompt-assistant-intent\.js"><\/script>/);
const mainRequestSource = indexHtml.slice(
  indexHtml.indexOf("async function requestPromptAssistant"),
  indexHtml.indexOf("function getCanvasPromptOptimizationSources")
);
assert.match(mainRequestSource, /const parsedResult = parseAssistantReply[\s\S]+guardResult\(userText, parsedResult\)[\s\S]+completedResult = result/);
assert.ok(mainRequestSource.indexOf("guardResult(userText, parsedResult)") < mainRequestSource.indexOf("pendingTaskSet = result"));

assert.deepEqual(intent.resolveAssistantRequestIntent("帮我生成一张牛马上班图的提示词"), {
  promptOnly: true,
  explicitImageExecution: false,
  explicitBatchExecution: false
});
assert.deepEqual(intent.resolveAssistantRequestIntent("直接生成一组 6 张产品图"), {
  promptOnly: false,
  explicitImageExecution: true,
  explicitBatchExecution: true
});
assert.deepEqual(intent.resolveAssistantRequestIntent("优化提示词，然后立即生成图片"), {
  promptOnly: false,
  explicitImageExecution: true,
  explicitBatchExecution: false
});

const singleGeneration = {
  reply: "已准备好提示词。",
  action: "generate_image",
  revisedPrompt: "一头穿西装的牛走在通勤人群中。",
  tasks: []
};

const promptOnly = intent.guardResult("帮我生成一张牛马上班图的提示词", singleGeneration);
assert.equal(promptOnly.action, "revise_prompt");
assert.equal(promptOnly.intentGuard.reason, "prompt_authoring");
assert.equal(promptOnly.revisedPrompt, singleGeneration.revisedPrompt);
assert.match(promptOnly.reply, /不会自动创建生图任务/);

const optimizeOnly = intent.guardResult("优化一下当前提示词", {
  action: "create_task_set",
  revisedPrompt: "",
  tasks: [{ prompt: "优化后的完整提示词" }, { prompt: "不应自动提交的第二条" }]
});
assert.equal(optimizeOnly.action, "revise_prompt");
assert.equal(optimizeOnly.revisedPrompt, "优化后的完整提示词");
assert.deepEqual(optimizeOnly.tasks, []);

const explicitSingle = intent.guardResult("帮我生成一张牛马上班图", singleGeneration);
assert.equal(explicitSingle.action, "generate_image");
assert.equal(explicitSingle.intentGuard.blocked, false);

const optimizeThenGenerate = intent.guardResult("优化提示词，然后立即生成图片", singleGeneration);
assert.equal(optimizeThenGenerate.action, "generate_image");
assert.equal(optimizeThenGenerate.intentGuard.blocked, false);

const vagueSingle = intent.guardResult("这个创意看起来怎么样", singleGeneration);
assert.equal(vagueSingle.action, "revise_prompt");
assert.equal(vagueSingle.intentGuard.reason, "generation_not_explicit");
assert.match(vagueSingle.reply, /未创建任务/);

const taskSet = {
  reply: "已规划产品组图。",
  action: "create_task_set",
  revisedPrompt: "",
  tasks: [{ prompt: "正面" }, { prompt: "侧面" }, { prompt: "细节" }]
};

const discussion = intent.guardResult("我想看看一组产品图方案", taskSet);
assert.equal(discussion.action, "none");
assert.equal(discussion.intentGuard.reason, "generation_not_explicit");
assert.equal(discussion.revisedPrompt, "");
assert.match(discussion.reply, /组图讨论或意图仍不明确/);

const missingMultiScope = intent.guardResult("直接生成产品图片", taskSet);
assert.equal(missingMultiScope.action, "generate_image");
assert.equal(missingMultiScope.intentGuard.reason, "multi_scope_not_explicit");
assert.equal(missingMultiScope.revisedPrompt, "正面");
assert.deepEqual(missingMultiScope.tasks, []);
assert.match(missingMultiScope.reply, /只创建 1 个生图任务/);

const explicitBatch = intent.guardResult("直接生成一组 6 张产品图", taskSet);
assert.equal(explicitBatch.action, "create_task_set");
assert.equal(explicitBatch.tasks.length, 3);

const batchPrefix = intent.guardResult("请批量生成产品图", taskSet);
assert.equal(batchPrefix.action, "create_task_set");

const chineseTaskCount = intent.guardResult("帮我创建三个生图任务", taskSet);
assert.equal(chineseTaskCount.action, "create_task_set");

const explicitSeveral = intent.guardResult("帮我生成几张不同角度的产品图", taskSet);
assert.equal(explicitSeveral.action, "create_task_set");

process.stdout.write("prompt assistant intent tests passed\n");
