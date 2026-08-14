const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "renderer", "index.html"), "utf8");
const canvasAssistantUi = fs.readFileSync(path.join(root, "renderer", "canvas-assistant-ui.js"), "utf8");
const canvasAssistantUiPublic = fs.readFileSync(path.join(root, "renderer", "public", "canvas-assistant-ui.js"), "utf8");
const canvasAssistantCss = fs.readFileSync(path.join(root, "renderer", "canvas-assistant.css"), "utf8");
const canvasAssistantCssPublic = fs.readFileSync(path.join(root, "renderer", "public", "canvas-assistant.css"), "utf8");
const promptIntentSourcePath = path.join(root, "renderer", "prompt-assistant-intent.js");
const promptIntentPublicPath = path.join(root, "renderer", "public", "prompt-assistant-intent.js");
require(promptIntentSourcePath);
const promptIntent = global.JBBPromptAssistantIntent;

function sectionBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

function cssRule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS rule: ${selector}`);
  return match[1];
}

// Workbench assistant: prompt writing is a local edit; task creation requires a distinct action.
const assistantProtocol = sectionBetween(
  html,
  "const ASSISTANT_SYSTEM_PROMPT = [",
  "].join(\"\\n\");"
);
assert.match(assistantProtocol, /提示词\/prompt.*action 必须使用 revise_prompt，不得创建或提交生图任务/);
assert.match(assistantProtocol, /明确命令现在执行生图.*明确表达批量、多张、组图、系列图、多个任务或具体数量.*action 才使用 create_task_set/);
assert.match(assistantProtocol, /单张改写使用 revise_prompt、填写 revised_prompt 并令 tasks 为空/);
assert.match(assistantProtocol, /明确组图执行使用 create_task_set、令 revised_prompt 为空并返回 2 到 9 个任务/);

const replyParser = sectionBetween(
  html,
  "function parseAssistantReply(payload)",
  "function setAssistantBusy(busy)"
);
assert.match(replyParser, /create_prompt:\s*"revise_prompt"/);
assert.match(replyParser, /tasks\.length >= 2 && normalizedAction === "create_task_set"/);
assert.match(replyParser, /revisedPrompt && normalizedAction === "generate_image"/);
assert.match(replyParser, /revisedPrompt:\s*action === "create_task_set" \? "" : revisedPrompt/);
assert.match(replyParser, /tasks:\s*action === "create_task_set" \? tasks : \[\]/);

const assistantRequest = sectionBetween(
  html,
  "async function requestPromptAssistant(options = {})",
  "function getCanvasPromptOptimizationSources(promptNodeId)"
);
assert.match(html, /<script src="\.\/prompt-assistant-intent\.js"><\/script>/);
assert.equal(
  fs.readFileSync(promptIntentSourcePath, "utf8"),
  fs.readFileSync(promptIntentPublicPath, "utf8")
);
assert.match(assistantRequest, /const parsedResult = parseAssistantReply\(await parseSuccessResponse\(response\)\)/);
assert.match(assistantRequest, /const result = window\.JBBPromptAssistantIntent\.guardResult\(userText, parsedResult\)/);
assert.match(assistantRequest, /completedResult\?\.action === "generate_image"/);
assert.match(assistantRequest, /await submitAssistantSingleTask\(generatedPrompt\)/);
assert.match(assistantRequest, /result\.action === "create_task_set" && result\.tasks\.length >= 2/);
assert.match(assistantRequest, /await submitAssistantTaskSet\(pendingTaskSet\.tasks, pendingTaskSet\.setType\)/);
assert.doesNotMatch(
  sectionBetween(assistantRequest, "if (completedResult?.action === \"generate_image\"", "if (pendingTaskSet && taskSetMessage)"),
  /submitAssistantTaskSet/
);
const guardIndex = assistantRequest.indexOf("guardResult(userText, parsedResult)");
const singleSubmitIndex = assistantRequest.indexOf("submitAssistantSingleTask(generatedPrompt)");
const batchSubmitIndex = assistantRequest.indexOf("submitAssistantTaskSet(pendingTaskSet.tasks");
assert.ok(guardIndex >= 0 && guardIndex < singleSubmitIndex, "single-task submission must run after the local intent guard");
assert.ok(guardIndex < batchSubmitIndex, "batch submission must run after the local intent guard");

// Canvas one-click optimization uses failures from only the directly connected control nodes.
const canvasOptimizationContext = sectionBetween(
  html,
  "function getCanvasPromptOptimizationGeneratorIds(promptNodeId)",
  "function abortCanvasPromptOptimizations(itemIds = null)"
);
assert.match(canvasOptimizationContext, /edge\.from === promptNodeId/);
assert.match(canvasOptimizationContext, /item\.taskSourceNodeId === generatorId/);
assert.match(canvasOptimizationContext, /\["failed", "timeout"\]\.includes\(item\.taskState\)/);
assert.match(canvasOptimizationContext, /window\.jbb\?\.taskLogs\?\.list/);
assert.match(canvasOptimizationContext, /log\?\.config\?\.requestPrompt/);
assert.match(canvasOptimizationContext, /接口错误：\$\{context\.message\}/);
assert.match(canvasOptimizationContext, /Gemini Omni Flash \/ Veo 3\.1 Fast/);
assert.match(canvasOptimizationContext, /vertical、horizontal、portrait、landscape、widescreen、close-up/);
const canvasOptimizationRequest = sectionBetween(
  html,
  "async function optimizeCanvasPromptNode(item, textarea, button)",
  "function resetPromptAssistant()"
);
assert.match(canvasOptimizationRequest, /await getCanvasPromptOptimizationErrorContexts\(item\.id\)/);
assert.match(canvasOptimizationRequest, /接口错误修正规则/);
assert.match(canvasOptimizationRequest, /关联控制节点最近一次失败信息/);
assert.match(canvasOptimizationRequest, /revisedPrompt = sanitizeStructuredVideoPrompt\(revisedPrompt\)/);
assert.match(canvasOptimizationRequest, /已根据最近错误优化提示词/);

// Local intent matrix: model output alone must never authorize generation.
const expectedIntents = [
  ["帮我生成一张牛马上班图的提示词", true, false, false],
  ["请编写 6 张产品组图的提示词", true, false, false],
  ["优化提示词并直接生成三张图", false, true, true],
  ["直接生成一张牛马上班图", false, true, false],
  ["我想看看一组产品图方案", false, false, false],
  ["直接生成一组 6 张产品图", false, true, true],
  ["帮我生成几张不同角度的产品图", false, true, true]
];
expectedIntents.forEach(([text, promptOnly, explicitImageExecution, explicitBatchExecution]) => {
  assert.deepEqual(promptIntent.resolveAssistantRequestIntent(text), {
    promptOnly,
    explicitImageExecution,
    explicitBatchExecution
  }, text);
});

const modelTaskSet = {
  reply: "已规划产品组图。",
  action: "create_task_set",
  revisedPrompt: "",
  tasks: [{ prompt: "主视觉" }, { prompt: "侧面" }, { prompt: "细节" }]
};
const promptAuthoringGuard = promptIntent.guardResult("请编写 6 张产品组图的提示词", modelTaskSet);
assert.equal(promptAuthoringGuard.action, "revise_prompt");
assert.equal(promptAuthoringGuard.revisedPrompt, "主视觉");
assert.deepEqual(promptAuthoringGuard.tasks, []);
assert.equal(promptAuthoringGuard.intentGuard.reason, "prompt_authoring");

const discussionGuard = promptIntent.guardResult("我想看看一组产品图方案", modelTaskSet);
assert.equal(discussionGuard.action, "none");
assert.deepEqual(discussionGuard.tasks, []);
assert.equal(discussionGuard.intentGuard.reason, "generation_not_explicit");

const singleOnlyGuard = promptIntent.guardResult("直接生成一张产品图", modelTaskSet);
assert.equal(singleOnlyGuard.action, "generate_image");
assert.equal(singleOnlyGuard.revisedPrompt, "主视觉");
assert.deepEqual(singleOnlyGuard.tasks, []);
assert.equal(singleOnlyGuard.intentGuard.reason, "multi_scope_not_explicit");

const explicitBatchGuard = promptIntent.guardResult("直接生成一组 6 张产品图", modelTaskSet);
assert.equal(explicitBatchGuard.action, "create_task_set");
assert.equal(explicitBatchGuard.tasks.length, 3);
assert.equal(explicitBatchGuard.intentGuard.blocked, false);

// Prompt editor: button state, focus behavior, blur collapse, and Escape all share one state path.
assert.match(
  html,
  /id="prompt-expand-toggle"[^>]*aria-controls="prompt"[^>]*aria-expanded="false"[^>]*aria-label="展开提示词编辑框"/
);
const promptExpandFunctions = sectionBetween(
  html,
  "function syncPromptExpandButton()",
  "function syncComposerClearActions()"
);
assert.match(promptExpandFunctions, /setAttribute\("aria-expanded", String\(expanded\)\)/);
assert.match(promptExpandFunctions, /expanded \? "收起提示词编辑框" : "展开提示词编辑框"/);
assert.match(promptExpandFunctions, /classList\.toggle\("is-expanded", expanded\)/);
assert.match(promptExpandFunctions, /classList\.toggle\("is-prompt-expanded", expanded\)/);
assert.match(promptExpandFunctions, /classList\.remove\("is-editing", "is-expanded"\)/);
assert.match(promptExpandFunctions, /elements\.prompt\.scrollTop = 0/);

const promptBindings = sectionBetween(
  html,
  "elements.prompt.addEventListener(\"focus\"",
  "elements.batchTrigger.addEventListener"
);
assert.match(promptBindings, /promptExpandToggle\.addEventListener\("click", \(\) => \{/);
assert.match(promptBindings, /setPromptExpanded\(!elements\.composerPrompt\.classList\.contains\("is-expanded"\)\)/);
assert.match(promptBindings, /elements\.prompt\.addEventListener\("blur", \(event\) => \{\s*collapsePromptEditor\(event\)/);

const globalEscapeHandling = sectionBetween(
  html,
  "if (!elements.taskSelectionContextMenu.hidden && event.key === \"Escape\")",
  "if (event.key === \"Escape\" && mobileStudioQuery.matches)"
);
assert.match(globalEscapeHandling, /composerPrompt\.classList\.contains\("is-expanded"\)/);
assert.match(globalEscapeHandling, /assistantInput\.closest\("\.assistant-input-shell"\)\?\.classList\.contains\("is-expanded"\)/);
assert.match(globalEscapeHandling, /setAssistantInputExpanded\(false\)/);
assert.match(globalEscapeHandling, /event\.preventDefault\(\)/);
assert.match(globalEscapeHandling, /setPromptExpanded\(false\)/);

// Workbench assistant: taller input, explicit expansion control, and hidden visual scrollbars.
assert.match(html, /id="assistant-messages"[^>]*role="log"[^>]*tabindex="0"/);
assert.match(html, /id="assistant-input-expand"[^>]*aria-controls="assistant-input"[^>]*aria-expanded="false"/);
const workbenchMessagesRule = cssRule(html, ".assistant-messages");
assert.match(workbenchMessagesRule, /overflow-y:\s*auto/);
assert.match(workbenchMessagesRule, /scrollbar-width:\s*none/);
const pageMainRule = cssRule(html, ".page-main");
assert.match(pageMainRule, /scrollbar-width:\s*none/);
assert.match(html, /\.page-main::\-webkit-scrollbar\s*\{[^}]*display:\s*none/s);
const workbenchInputRule = cssRule(html, "textarea.control.assistant-input");
assert.match(workbenchInputRule, /min-height:\s*96px/);
assert.match(workbenchInputRule, /overflow-y:\s*auto/);
assert.match(workbenchInputRule, /scrollbar-width:\s*none/);
assert.match(html, /\.assistant-input-shell\.is-expanded textarea\.control\.assistant-input\s*\{/);
assert.match(html, /function setAssistantInputExpanded\(expanded, focusInput = true\)/);

// Canvas assistant: conceal the visual scrollbar without disabling wheel/keyboard/programmatic scroll.
assert.equal(canvasAssistantUi, canvasAssistantUiPublic);
assert.equal(canvasAssistantCss, canvasAssistantCssPublic);
const messageRule = cssRule(canvasAssistantCss, ".jbb-canvas-assistant__messages");
assert.match(messageRule, /overflow-y:\s*auto/);
assert.match(messageRule, /overflow-x:\s*hidden/);
assert.match(messageRule, /scrollbar-width:\s*none/);
const webkitScrollbarRule = cssRule(canvasAssistantCss, ".jbb-canvas-assistant__messages::-webkit-scrollbar");
assert.match(webkitScrollbarRule, /display:\s*none/);
assert.match(canvasAssistantUi, /mounted\.messageList\.scrollTop = mounted\.messageList\.scrollHeight/);
assert.match(canvasAssistantUi, /root\.addEventListener\("wheel", \(event\) => event\.stopPropagation\(\), \{ passive: true \}\)/);

process.stdout.write("assistant interaction contract tests passed\n");
