const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "renderer", "index.html"), "utf8");
const assistantActions = fs.readFileSync(path.join(root, "renderer", "canvas-assistant-actions.js"), "utf8");
const assistantActionsPublic = fs.readFileSync(path.join(root, "renderer", "public", "canvas-assistant-actions.js"), "utf8");
const assistantBridge = fs.readFileSync(path.join(root, "renderer", "canvas-assistant-bridge.js"), "utf8");
const assistantBridgePublic = fs.readFileSync(path.join(root, "renderer", "public", "canvas-assistant-bridge.js"), "utf8");
const assistantUi = fs.readFileSync(path.join(root, "renderer", "canvas-assistant-ui.js"), "utf8");
const assistantUiPublic = fs.readFileSync(path.join(root, "renderer", "public", "canvas-assistant-ui.js"), "utf8");
const assistantCss = fs.readFileSync(path.join(root, "renderer", "canvas-assistant.css"), "utf8");
const assistantCssPublic = fs.readFileSync(path.join(root, "renderer", "public", "canvas-assistant.css"), "utf8");

function sectionBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

function sectionBetweenLast(source, start, end) {
  const startIndex = source.lastIndexOf(start);
  assert.notEqual(startIndex, -1, `missing final section start: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing final section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

function createUiHarness() {
  const state = { messages: [], mountOptions: null };
  return {
    state,
    ui: {
      mount(options) { state.mountOptions = options; },
      renderMessages(messages) { state.messages = messages.map((message) => ({ ...message })); },
      renderPlan() {},
      setBusy() {},
      setError() {},
      setContext() {},
      setDisabled() {},
      setOpen() {},
      destroy() {}
    }
  };
}

async function main() {
  assert.equal(assistantActions, assistantActionsPublic);
  assert.equal(assistantBridge, assistantBridgePublic);
  assert.equal(assistantUi, assistantUiPublic);
  assert.equal(assistantCss, assistantCssPublic);

  // Long messages keep their complete content in session persistence; collapsing is presentation-only.
  global.window = global;
  require(path.join(root, "renderer", "canvas-assistant-bridge.js"));
  const longMessage = Array.from({ length: 12 }, (_, index) => `第 ${index + 1} 行：${"完整原文".repeat(12)}`).join("\n");
  const persisted = [];
  const messageHarness = createUiHarness();
  const messageSession = global.JBBCanvasAssistantBridge.createSession({
    actions: {
      summarizePlan: () => "无画布操作",
      executePlan: async () => ({ status: "executed", remoteSubmissions: 0 }),
      requestAssistantPlan: async () => ({
        plan: { projectId: "project-a", reply: "已收到下一条消息", operations: [], requiresConfirmation: false },
        summary: "已收到下一条消息"
      })
    },
    ui: messageHarness.ui,
    adapter: {
      getCurrentProjectId: () => "project-a",
      getContext: () => ({ project: "测试项目", selection: "未选择节点" })
    },
    setMessages: (_projectId, messages) => persisted.push(messages)
  });
  await messageSession.send(longMessage);
  const latestPersisted = persisted.at(-1);
  assert.equal(latestPersisted.find((message) => message.role === "user").content, longMessage);
  assert.equal(messageHarness.state.messages.find((message) => message.role === "user").content, longMessage);
  messageSession.destroy();

  const messageRendering = sectionBetween(assistantUi, "function renderMessages(messages)", "function normalizeOperations(plan)");
  assert.match(messageRendering, /const messageText = formatMessageContent\(item\)/);
  assert.match(messageRendering, /createMessageCopyButton\(messageText\)/);
  assert.match(messageRendering, /const collapseCandidate = index < list\.length - 1/);
  assert.match(messageRendering, /dataset\.messageCollapseCandidate = String\(collapseCandidate\)/);
  assert.match(messageRendering, /jbb-canvas-assistant__message-disclosure/);
  assert.match(messageRendering, /setAttribute\("aria-controls", content\.id\)/);
  assert.match(messageRendering, /setAttribute\("aria-expanded", "false"\)/);
  assert.match(messageRendering, /addEventListener\("click"/);
  assert.match(assistantUi, /disclosure\.textContent = nextExpanded \? "收起" : "已折叠 · 展开"/);
  assert.match(assistantUi, /content\.scrollHeight > fourLineHeight \+ 1/);
  assert.match(assistantCss, /\.jbb-canvas-assistant__message\.is-collapsible\.is-collapsed \.jbb-canvas-assistant__message-content\s*{[^}]*-webkit-line-clamp:\s*4/s);
  assert.match(assistantCss, /\.jbb-canvas-assistant__message-disclosure:focus-visible/);

  // A batch plan submits every generation node. Any adapter failure rejects the plan instead of reporting success.
  await import(pathToFileURL(path.join(root, "renderer", "canvas-assistant-actions.js")).href);
  const actions = global.CanvasAssistantActions;
  const batchPlan = {
    projectId: "project-a",
    requiresConfirmation: false,
    operations: ["gen-1", "gen-2", "gen-3"].map((nodeId, index) => ({
      id: `submit-${index + 1}`,
      type: "submit_generation",
      args: { nodeId }
    })),
    _existingNodeIds: new Set(["gen-1", "gen-2", "gen-3"])
  };
  const submittedNodeIds = [];
  const batchResult = await actions.executePlan(batchPlan, {
    getCurrentProjectId: () => "project-a",
    submitGeneration: async ({ nodeId }) => {
      submittedNodeIds.push(nodeId);
      return { submitted: true };
    }
  });
  assert.deepEqual(submittedNodeIds, ["gen-1", "gen-2", "gen-3"]);
  assert.equal(batchResult.remoteSubmissions, 3);

  const failedNodeIds = [];
  await assert.rejects(() => actions.executePlan(batchPlan, {
    getCurrentProjectId: () => "project-a",
    submitGeneration: async ({ nodeId }) => {
      failedNodeIds.push(nodeId);
      if (nodeId === "gen-2") throw Object.assign(new Error("submit failed"), {
        code: "GENERATION_SUBMIT_FAILED",
        nodeId
      });
      return { submitted: true };
    }
  }), (error) => error.code === "GENERATION_SUBMIT_FAILED" && error.nodeId === "gen-2");
  assert.deepEqual(failedNodeIds, ["gen-1", "gen-2"]);

  const canvasAssistantAdapter = sectionBetween(html, "function createCanvasAssistantAdapter()", "function initializeCanvasAssistant()");
  assert.match(canvasAssistantAdapter, /submitCanvasGeneration\(item, \{ \.\.\.args, skipCooldown: true, source: "canvas-assistant" \}\)/);
  assert.match(canvasAssistantAdapter, /if \(!submitted\)\s*{/);
  assert.match(canvasAssistantAdapter, /error\.code = "GENERATION_SUBMIT_FAILED"/);
  assert.match(canvasAssistantAdapter, /error\.nodeId = item\.id/);
  const canvasSubmission = sectionBetween(html, "async function submitCanvasGeneration(generateNode, options = {})", "function updateCanvasTaskNode(");
  assert.match(canvasSubmission, /const skipCooldown = options\.skipCooldown === true/);
  assert.match(canvasSubmission, /\(!skipCooldown && Date\.now\(\) < state\.submissionCooldownUntil\)/);

  // Prompt, reference image, generator, and result titles share the same double-click/F2 rename path.
  assert.match(html, /titleCustomized: Boolean\(item\.titleCustomized\)/);
  const titleEditor = sectionBetween(html, "function beginCanvasNodeTitleEdit", "function appendCanvasSizeOptions");
  assert.match(titleEditor, /item\.title = nextTitle/);
  assert.match(titleEditor, /item\.titleCustomized = true/);
  assert.match(titleEditor, /saveCanvasLayout\(\)/);
  assert.match(titleEditor, /addEventListener\("dblclick"/);
  assert.match(titleEditor, /event\.key !== "Enter" && event\.key !== "F2"/);
  assert.match(titleEditor, /event\.key === "Escape"/);
  const canvasRendering = sectionBetween(html, "function renderCanvasNodes(options = {})", "function renderCanvasEdges()");
  assert.match(canvasRendering, /createCanvasEditableTitle\(item, "提示词", "canvas-prompt-floating-title"\)/);
  assert.match(canvasRendering, /createCanvasEditableTitle\(item, "统一生图", "canvas-generator-floating-title"\)/);
  assert.match(canvasRendering, /const defaultTitle = item\.type === "result"/);
  assert.match(canvasRendering, /createCanvasEditableTitle\(item, defaultTitle, "canvas-reference-image-label"\)/);

  // Generator outputs expose explicit labels while preserving the existing prompt/reference labels.
  const edgeLabels = sectionBetween(html, "function getCanvasEdgeLabel(edge)", "function getCanvasMentionRange(textarea)");
  assert.match(edgeLabels, /source\.type === "generate" && target\.type === "task"\) return "生成任务"/);
  assert.match(edgeLabels, /source\.type === "generate" && target\.type === "result"\) return "生成结果"/);
  assert.match(edgeLabels, /source\.type === "prompt"\) return "提示词"/);

  // Missing image cleanup only runs after storage is confirmed, checks recoverable files, and removes orphan edges.
  const missingCheck = sectionBetween(html, "async function isCanvasImageSourceConfirmedMissing", "async function pruneMissingCanvasImageReferences()");
  assert.match(missingCheck, /if \(!state\.storageReady \|\| !source\) return false/);
  assert.match(missingCheck, /availableRecordIds\.has\(recordId\)\) return false/);
  assert.match(missingCheck, /state\.outputDirectoryHandle\.getFileHandle\(outputFile\)/);
  assert.match(missingCheck, /window\.jbb\.storage\.readBinary\(\{/);
  assert.match(missingCheck, /if \(stored\?\.data\) return false/);
  const missingPrune = sectionBetween(html, "async function pruneMissingCanvasImageReferences()", "function removeCanvasImageRecords(recordIds)");
  assert.match(missingPrune, /if \(!state\.storageReady \|\| !state\.outputDirectoryHandle \|\| !state\.dataDirectoryHandle\) return 0/);
  assert.match(missingPrune, /\["image", "result"\]\.includes\(item\.type\)/);
  assert.match(missingPrune, /currentSources\.map\(\(source\) => isCanvasImageSourceConfirmedMissing/);
  assert.match(missingPrune, /documentValue\.items = documentValue\.items\.filter/);
  assert.match(missingPrune, /documentValue\.edges = documentValue\.edges\.filter/);
  assert.match(missingPrune, /refreshCanvasDocumentReferenceModes\(documentValue\)/);
  assert.match(html, /await restoreTaskHistory\(storedTasks\)[\s\S]*await pruneMissingCanvasImageReferences\(\)/);

  // Workbench failure cards have a visible text retry action with an adequate stable width.
  const failedCard = sectionBetween(html, "function createFailedTaskCard(failure, index)", "const displayTaskStatuses");
  assert.match(failedCard, /"button button-primary failed-task-retry"/);
  assert.match(failedCard, /retryLabel\.textContent = "重试"/);
  assert.match(failedCard, /details\.append\(detailsButton, copyButton, retryButton\)/);
  assert.match(html, /\.failed-task-retry\s*{[^}]*display:\s*inline-flex[^}]*min-width:\s*56px/s);
  assert.match(html, /\.gallery \.failed-task-details\s*{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 16\.67cqw 30cqw/s);
  assert.match(html, /\.gallery \.failed-task-card\s*{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\)/s);
  assert.doesNotMatch(html, /\.gallery \.failed-task-card\s*{[^}]*grid-template-rows:\s*100cqw/s);

  // A title click or double-click does not move the node or create an undo entry before a real drag starts.
  const nodeDragStart = sectionBetween(html, "function beginCanvasNodeDrag", "function startCanvasNodeDrag");
  assert.match(nodeDragStart, /activated: false/);
  assert.doesNotMatch(nodeDragStart, /pushCanvasHistory\(\)/);
  const pointerMove = sectionBetweenLast(html, "function handleCanvasPointerMove(event)", "function finishCanvasPointerInteraction(event)");
  assert.match(pointerMove, /interaction\.type === "node" && !interaction\.activated/);
  assert.match(pointerMove, /if \(dragDistance < 4\) return/);
  assert.match(pointerMove, /interaction\.activated = true/);
  assert.match(pointerMove, /if \(!interaction\.duplicateOnDrag\) pushCanvasHistory\(\)/);

  // Canvas task nodes expose failed/timeout details and a retry action; successful result nodes expose status.
  assert.match(canvasRendering, /const isTaskError = \["failed", "timeout"\]\.includes\(item\.taskState\)/);
  assert.match(canvasRendering, /topOverlay\.setAttribute\("role", isTaskError \? "alert" : "status"\)/);
  assert.match(canvasRendering, /topOverlay\.setAttribute\("aria-live", isTaskError \? "assertive" : "polite"\)/);
  assert.match(canvasRendering, /\["failed", "timeout", "interrupted", "canceled"\]\.includes\(item\.taskState\)/);
  assert.match(canvasRendering, /retry\.textContent = "重试"/);
  assert.match(canvasRendering, /retryCanvasTaskNode\(item\)/);
  assert.match(canvasRendering, /resultStatus\.className = "canvas-result-status-badge"/);
  assert.match(canvasRendering, /resultStatus\.setAttribute\("role", "status"\)/);

  process.stdout.write("canvas workflow regression tests passed\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
