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
  assert.match(canvasSubmission, /normalizeCanvasWorkMode\(generateNode\.workMode\) === "video"/);
  assert.match(canvasSubmission, /submitCanvasVideoGeneration\(generateNode, \{ \.\.\.options, prompt \}\)/);
  const videoSubmission = sectionBetween(html, "function createCanvasVideoConfig", "async function submitCanvasGeneration");
  assert.match(videoSubmission, /getVideoApiKey\(\)/);
  assert.match(videoSubmission, /mediaType: "video"/);
  assert.match(videoSubmission, /taskKind: "video-generation"/);
  assert.match(videoSubmission, /当前已配置的请求协议不支持/);
  assert.match(videoSubmission, /const referenceMode = getCanvasReferenceModeValue/);
  assert.match(videoSubmission, /const references = referenceMode === "text" \? \[\] : collectedReferences/);
  assert.match(videoSubmission, /videoRatio: ratio/);
  assert.match(videoSubmission, /videoDurationRule: profile\.duration\?\.type/);
  assert.match(videoSubmission, /videoDurationVerified: verifiedDurations\.includes\(seconds\)/);
  assert.match(html, /retryConnection: false/);
  assert.match(html, /form\.append\("input_reference", referenceFile/);
  assert.match(html, /payload\.input_reference = reference/);
  assert.match(html, /await waitForRetry\(Number\(profile\.pollIntervalMs \|\| 4000\), config\.signal\)/);
  assert.match(html, /mediaType: "video",\s*filename,\s*data: downloaded\.data/);
  assert.match(html, /persistCanvasVideoRemoteTaskId\(task, taskId\)/);
  assert.match(html, /config\.videoRemoteTaskId = remoteTaskId/);

  // Newly created generator outputs must use the shared collision-aware placement path.
  const canvasPlacement = sectionBetween(html, "function isCanvasPositionFree", "function getCanvasGeneratorBranchItems");
  assert.match(canvasPlacement, /const items = Array\.isArray\(options\.items\) \? options\.items : state\.canvasItems/);
  assert.match(canvasPlacement, /function getCanvasGeneratorOutputPreferredPosition/);
  assert.match(canvasPlacement, /function placeCanvasGeneratorOutputNode/);
  assert.match(canvasPlacement, /findCanvasFreePosition\(item, preferred, \{ items \}\)/);
  assert.match(videoSubmission, /placeCanvasGeneratorOutputNode\(generateNode, taskNode\)/);
  assert.match(canvasSubmission, /placeCanvasGeneratorOutputNode\(generateNode, taskNode\)/);
  const canvasResultHydration = sectionBetween(html, "function hydrateCanvasResultsForProject", "function openCanvasProject");
  assert.match(canvasResultHydration, /placeCanvasGeneratorOutputNode\(source, result, documentValue\.items, documentValue\.edges\)/);
  assert.match(html, /继续查询，不会重新创建/);

  // Grok 1.5 uses JSON for text-to-video and multipart only when uploading a reference image.
  const grokProfile = sectionBetween(html, '"grok-imagine-video-1.5-preview": Object.freeze({', '"video-ds-2.0": Object.freeze({');
  assert.match(grokProfile, /transport: "mode-dependent"/);
  assert.match(grokProfile, /textTransport: "json", referenceTransport: "multipart", requestSchema: "grok-video-1\.5"/);
  assert.match(grokProfile, /type: "range", min: 1, max: 15, step: 1, defaultText: 5, defaultReference: 5, verified: \[1, 5\]/);
  assert.match(grokProfile, /sizes: Object\.freeze\(\["1280x720", "720x1280"\]\)/);
  assert.match(grokProfile, /defaultRatio: "9:16"/);
  assert.match(grokProfile, /defaultTextSize: "720x1280", defaultReferenceSize: "720x1280"/);
  assert.match(grokProfile, /pollIntervalMs: 8000, requireVideoUrlOnComplete: true/);
  assert.match(grokProfile, /downloadPriority: "video_url", maxWaitMs: 10 \* 60 \* 1000/);

  // The three downstream SD2 aliases follow the 2026-08-14 tested JBB contract.
  const sd20Profile = sectionBetween(html, '"video-ds-2.0": Object.freeze({', '"video-ds-2.0-fast": Object.freeze({');
  const sd20FastProfile = sectionBetween(html, '"video-ds-2.0-fast": Object.freeze({', '"as-sd2.0-fast": Object.freeze({');
  const asSd20FastProfile = sectionBetween(html, '"as-sd2.0-fast": Object.freeze({', '"sora-v3-431-fast": Object.freeze({');
  for (const profile of [sd20Profile, sd20FastProfile, asSd20FastProfile]) {
    assert.match(profile, /transport: "mode-dependent"/);
    assert.match(profile, /textTransport: "json", referenceTransport: "multipart", requestSchema: "jbb-sd2"/);
    assert.match(profile, /sizes: Object\.freeze\(\["1280x720"\]\)/);
    assert.match(profile, /referenceModes: Object\.freeze\(\["text", "single"\]\), maxReferenceImages: 1/);
    assert.match(profile, /pollIntervalMs: 5000, maxWaitMs: 30 \* 60 \* 1000/);
  }
  for (const profile of [sd20Profile, sd20FastProfile]) {
    assert.match(profile, /type: "range", min: 3, max: 15, step: 1, defaultText: 5, defaultReference: 8, verified: \[5, 8\]/);
  }
  assert.match(asSd20FastProfile, /type: "range", min: 3, max: 15, step: 1, defaultText: 5, defaultReference: 5, verified: \[5\]/);

  // All three Sora V3 entries share the same JSON/Data URL protocol and parameter limits.
  const soraFastProfile = sectionBetween(html, '"sora-v3-431-fast": Object.freeze({', '"sora-v3-431-pro": Object.freeze({');
  const sora431ProProfile = sectionBetween(html, '"sora-v3-431-pro": Object.freeze({', '"sora-v3-pro": Object.freeze({');
  const soraProProfile = sectionBetween(html, '"sora-v3-pro": Object.freeze({', '"h3video-2k": Object.freeze({');
  for (const profile of [soraFastProfile, sora431ProProfile, soraProProfile]) {
    assert.match(profile, /transport: "base64", requestSchema: "sora-v3"/);
    assert.match(profile, /type: "range", min: 5, max: 15, step: 1, defaultText: 5, defaultReference: 5, verified: \[5\]/);
    for (const ratio of ["9:16", "16:9", "1:1", "4:3", "3:4", "21:9"]) {
      assert.match(profile, new RegExp(`"${ratio.replace(":", "\\:")}": "480p"`));
    }
    assert.match(profile, /defaultRatio: "16:9"/);
    assert.match(profile, /pollIntervalMs: 5000, maxWaitMs: 10 \* 60 \* 1000/);
  }

  // Veo 3.1 Fast follows the same verified downstream contract as Gemini Omni Flash.
  const veoProfile = sectionBetween(html, '"veo31-fast": Object.freeze({', '"gemini-omni-flash": Object.freeze({');
  const geminiProfile = sectionBetween(html, '"gemini-omni-flash": Object.freeze({', "    });\n    const NON_CONVERSATION_MODEL_KEYWORDS");
  for (const profile of [veoProfile, geminiProfile]) {
    assert.match(profile, /transport: "mode-dependent"/);
    assert.match(profile, /textTransport: "json", referenceTransport: "multipart", requestSchema: "gemini-veo"/);
    assert.match(profile, /text: \[4, 6, 8, 10\], reference: \[4, 6, 8, 10\], defaultText: 6, defaultReference: 8/);
    assert.match(profile, /sizes: Object\.freeze\(\["1280x720", "720x1280"\]\)/);
    assert.match(profile, /defaultTextSize: "720x1280", defaultReferenceSize: "720x1280"/);
    assert.match(profile, /pollIntervalMs: 8000, requireVideoUrlOnComplete: true/);
    assert.match(profile, /downloadPriority: "video_url"/);
  }
  const videoPayload = sectionBetween(html, "function buildJbbVideoPayload", "function getJbbVideoTransport");
  assert.match(videoPayload, /if \(hasReference\) \{\s*payload\.seconds = seconds;\s*\} else \{\s*payload\.duration = seconds;\s*payload\.aspect_ratio = getVideoAspectRatio/s);
  assert.match(videoPayload, /profile\.requestSchema === "sora-v3"\) \{\s*payload\.seconds = seconds;\s*payload\.aspect_ratio = getVideoAspectRatio/s);
  assert.match(videoPayload, /\} else \{\s*payload\.seconds = seconds;\s*\}/s);
  assert.match(videoPayload, /prompt: promptForRequest\(config\)/);
  const videoPromptSanitizerSource = sectionBetween(html, "function sanitizeStructuredVideoPrompt", "function promptForRequest");
  const sanitizeStructuredVideoPrompt = Function(`${videoPromptSanitizerSource}; return sanitizeStructuredVideoPrompt;`)();
  assert.equal(
    sanitizeStructuredVideoPrompt("生成一个6秒的9:16竖屏视频，成年女性在花海中挥手。"),
    "生成一个视频，成年女性在花海中挥手。"
  );
  assert.equal(
    sanitizeStructuredVideoPrompt("A 6-second vertical video, aspect ratio 9:16, of a red ball rolling on a white floor."),
    "A video, of a red ball rolling on a white floor."
  );
  const actualGeminiFailurePrompt = "A vertical above-the-thigh photograph of a single woman at a sunny shore, opening two fingers horizontally. A 3:4 vertical, close-up portrait captured from head to above the thighs. Do not omit the horizontal peace sign.";
  const sanitizedGeminiFailurePrompt = sanitizeStructuredVideoPrompt(actualGeminiFailurePrompt);
  assert.doesNotMatch(sanitizedGeminiFailurePrompt, /3\s*:\s*4|\bvertical\b|\bhorizontal(?:ly)?\b|\bportrait\b|\bclose[\s-]?up\b/i);
  assert.match(sanitizedGeminiFailurePrompt, /above-the-thigh photograph/);
  assert.match(sanitizedGeminiFailurePrompt, /opening two fingers side by side/);
  assert.match(sanitizedGeminiFailurePrompt, /peace sign/);
  assert.doesNotMatch(sanitizedGeminiFailurePrompt, /\bA above-the-thigh\b|^A\s*,\s*captured\b/im);
  assert.equal(sanitizeStructuredVideoPrompt("时长：6秒\n比例：9:16"), "");
  const videoCreate = sectionBetween(html, "async function requestVideoCreate", "async function requestVideoStatus");
  assert.match(videoCreate, /const transport = getJbbVideoTransport\(config, Boolean\(referenceFile\)\)/);
  assert.match(videoCreate, /if \(transport === "multipart"\)/);
  assert.match(videoCreate, /form\.append\("input_reference", referenceFile/);
  assert.match(videoCreate, /const reference = referenceFile \? await readBlobAsDataUrl\(referenceFile\) : null/);
  assert.match(videoCreate, /headers\["Content-Type"\] = "application\/json"/);
  const videoDownload = sectionBetween(html, "async function downloadVideoContent", "async function waitForVideoTask");
  assert.ok(videoDownload.indexOf("profile.downloadPriority") < videoDownload.indexOf("getJbbVideoTaskUrl(config, taskId, true)"));
  const videoPolling = sectionBetween(html, "async function waitForVideoTask", "function getJbbVideoTaskUrl");
  assert.match(videoPolling, /!profile\.requireVideoUrlOnComplete \|\| extractVideoFallbackUrl\(payload\)/);
  assert.match(videoPolling, /Number\(profile\.pollIntervalMs \|\| 4000\)/);
  assert.match(videoPolling, /"failure"/);
  assert.match(videoPolling, /"expired"/);
  assert.match(videoPolling, /const maxWaitMinutes = Math\.max\(1, Math\.round\(maxWaitMs \/ 60000\)\)/);
  assert.match(html, /videoTransport: config\.mediaType === "video" \? getJbbVideoTransport\(config\) : ""/);

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
  assert.match(canvasRendering, /const settleRenderedImages = options\.settleRenderedImages === true/);
  assert.match(canvasRendering, /createCanvasEditableTitle\(item, "提示词", "canvas-prompt-floating-title"\)/);
  assert.match(canvasRendering, /createCanvasEditableTitle\(item, getCanvasWorkModeDefaultTitle\(workMode\), "canvas-generator-floating-title"\)/);
  assert.match(canvasRendering, /createCanvasGeneratorSummaryField\(node, item, "工作模式", getCanvasWorkModeLabel\(workMode\), "work-mode"\)/);
  assert.match(canvasRendering, /parameters\.append\(workModeField, modelField, referenceField, parameterField, groupField\)/);
  assert.match(html, /workMode: item\.workMode === "video" \? "video" : "image"/);
  assert.match(html, /\[\["image", "图片生成"\], \["video", "视频生成"\]\]/);
  assert.match(html, /addCanvasGenerateNode\(\{ workMode: normalizeCanvasWorkMode\(workMode\) \}\)/);
  assert.match(html, /function getCanvasModelsForWorkMode\(workMode = "image"\)/);
  assert.match(html, /return models\.sort\(compareVideoModels\)/);
  assert.match(html, /model: getDefaultCanvasModel\(workMode\)/);
  const generatorPopover = sectionBetween(html, "function openCanvasGeneratorPopover", "function createCanvasGeneratorSummaryField");
  assert.match(generatorPopover, /popover\.addEventListener\("wheel", \(event\) => \{/);
  assert.match(generatorPopover, /event\.preventDefault\(\)/);
  assert.match(generatorPopover, /event\.stopPropagation\(\)/);
  assert.match(generatorPopover, /popover\.scrollTop \+= event\.deltaY/);
  assert.match(html, /\.canvas-generator-popover\s*\{[^}]*scrollbar-width:\s*none;/s);
  assert.match(html, /\.canvas-generator-popover::\-webkit-scrollbar\s*\{[^}]*display:\s*none;/s);
  assert.match(generatorPopover, /const availableModels = getCanvasModelsForWorkMode\(value\)/);
  assert.match(generatorPopover, /if \(!availableModels\.includes\(item\.model\)\) item\.model = getDefaultCanvasModel\(value\)/);
  assert.match(generatorPopover, /const modelOptions = getCanvasModelsForWorkMode\(workMode\)/);
  assert.match(html, /function getCanvasWorkModeDefaultTitle\(value\) \{\s*return "控制节点";/);
  assert.match(html, /function normalizeCanvasGenerateTitle\(value\) \{\s*return String\(value \|\| ""\)\.trim\(\)\.slice\(0, 80\) \|\| "控制节点";/);
  assert.match(html, /data-canvas-work-mode="image"[\s\S]+?生图节点/);
  assert.match(html, /data-canvas-work-mode="video"[\s\S]+?视频节点/);
  const referenceModes = sectionBetween(html, "function getCanvasReferenceModeValue", "function getCanvasSizeOptionLabel");
  assert.match(referenceModes, /if \(count === 1\) return "single"/);
  assert.match(referenceModes, /if \(count > 1\) return "multi"/);
  assert.match(referenceModes, /return "text"/);
  assert.match(referenceModes, /isVideo \? "文生视频" : "文生图"/);
  assert.match(referenceModes, /"首尾帧参考"/);
  assert.match(html, /type: "range", min: 1, max: 15, step: 1/);
  assert.match(html, /type: "range", min: 5, max: 15, step: 1/);
  assert.match(html, /type: "fixed", value: 15/);
  assert.match(html, /type: "options", text: \[4, 6, 8, 10\], reference: \[4, 6, 8, 10\]/);
  assert.match(html, /videoDuration: Number\.isFinite\(Number\(item\.videoDuration\)\)/);
  assert.match(html, /\^\\d\+:\\d\+\$\/i\.test\(sizeValue\)/);
  assert.match(html, /if \(normalizeCanvasWorkMode\(item\.workMode\) === "video"\) return `\$\{sizeLabel\}｜\$\{item\.videoDuration \|\| 5\}秒`/);
  assert.match(html, /\["default:1:1", "1:1"\]/);
  assert.match(html, /\["default:3:4", "3:4"\]/);
  assert.match(html, /\["default:16:9", "16:9"\]/);
  assert.match(html, /\["default:9:16", "9:16"\]/);
  assert.doesNotMatch(sectionBetween(html, "const CANVAS_V2_SIZE_OPTIONS", "function createCanvasDocument"), /默认/);
  assert.doesNotMatch(sectionBetween(html, "const CANVAS_V2_SIZE_OPTIONS", "function createCanvasDocument"), /default:4:3|2k:|4k:/i);
  assert.match(generatorPopover, /videoProfile\?\.referenceModes \|\| \["text", "single", "multi"\]/);
  assert.match(generatorPopover, /\["single", "首帧参考"\]/);
  assert.doesNotMatch(generatorPopover, /const unsupported = isVideo && value === "multi"/);
  assert.match(generatorPopover, /item\.referenceModeManual = true/);
  assert.match(generatorPopover, /syncCanvasFrameRoles\(item\.id\)/);
  assert.match(generatorPopover, /String\(value\),\s*"count"/);
  assert.match(generatorPopover, /createCanvasGeneratorParameterSection\("时长", durationChoices\)/);
  assert.match(generatorPopover, /getCanvasVideoDurationOptions\(item\)\.map/);
  assert.match(generatorPopover, /createCanvasGeneratorDurationInput\(item, updateSummary\)/);
  assert.match(generatorPopover, /getCanvasVideoRatioOptions\(item\)\.map\(\(value\) => \[value, getCanvasVideoSizeOptionLabel\(item, value\)\]\)/);
  assert.match(generatorPopover, /VIDEO_MODEL_GROUPS\.map/);
  assert.doesNotMatch(generatorPopover, /不可用|渠道不稳定/);
  assert.match(canvasRendering, /const defaultTitle = item\.type === "result"/);
  assert.match(canvasRendering, /const isVideoResult = item\.type === "result" && Boolean\(item\.videoFile\)/);
  assert.match(canvasRendering, /video\.controls = false/);
  assert.match(canvasRendering, /video\.preload = "metadata"/);
  assert.match(html, /if \(config\.mediaType === "video"\)[\s\S]*?await updateTaskLog\(config,[\s\S]*?return;[\s\S]*?} else if \(config\.isEdit\)/);
  assert.match(html, /sizeValue: config\.videoRatio \|\| config\.size/);
  assert.match(canvasRendering, /video\.playsInline = true/);
  assert.match(canvasRendering, /video\.muted = true/);
  assert.match(canvasRendering, /video\.addEventListener\("pointerdown", \(event\) => startCanvasNodeDrag\(event, item\)\)/);
  assert.match(canvasRendering, /bindCanvasVideoPreviewInteractions\(node, video, item\)/);
  assert.match(canvasRendering, /createCanvasNodeInteractionHint\("悬停自动播放 · 双击放大 · 按住拖动"\)/);
  assert.match(canvasRendering, /appendCanvasReferenceResizeHandles\(node, item\)/);
  const canvasVideoInteractions = sectionBetween(html, "function bindCanvasVideoPreviewInteractions", "function renderCanvasNodes(options = {})");
  assert.match(canvasVideoInteractions, /const hoverDelayMs = 1500/);
  assert.match(canvasVideoInteractions, /video\.play\(\)\.catch/);
  assert.match(canvasVideoInteractions, /video\.addEventListener\("dblclick"/);
  assert.match(canvasVideoInteractions, /openCanvasVideoLightbox\(item, video\)/);
  assert.match(canvasVideoInteractions, /video\.addEventListener\("pointerdown", \(\) => stopHoverPreview\(false\)\)/);
  assert.match(html, /function setCanvasVideoLightbox\(open, restoreFocus = true\)/);
  assert.match(html, /function openCanvasVideoLightbox\(item, returnFocus = null\)/);
  assert.match(html, /id="canvas-video-lightbox-video"/);
  const canvasTaskDomUpdate = sectionBetween(html, "function updateCanvasTaskNodeDom", "function removeCanvasTaskNode");
  assert.match(canvasTaskDomUpdate, /\["waiting", "running"\]\.includes\(currentState\)/);
  assert.match(canvasTaskDomUpdate, /\["waiting", "running"\]\.includes\(nextState\)/);
  assert.match(canvasTaskDomUpdate, /node\.querySelector\("\.canvas-task-state"\)/);
  assert.match(canvasTaskDomUpdate, /node\.querySelector\("\.canvas-task-detail"\)/);
  assert.match(canvasTaskDomUpdate, /!updateCanvasTaskNodeDom\(taskNode\)\) renderCanvasNodes\(\)/);
  const videoTaskIdPersistence = sectionBetween(html, "function persistCanvasVideoRemoteTaskId", "function bindCanvasTaskNodeToTask");
  assert.match(videoTaskIdPersistence, /!updateCanvasTaskNodeDom\(target\.taskNode\)\) renderCanvasNodes\(\)/);
  const generationScheduler = sectionBetween(html, "function startQueuedGenerationTask", "function getAssistantTaskSetLabel");
  assert.doesNotMatch(html, /const GENERATION_CONCURRENCY_LIMIT\s*=/);
  assert.doesNotMatch(generationScheduler, /function pumpGenerationQueue/);
  assert.match(generationScheduler, /regularTasks\.forEach\(\(task\) => \{[\s\S]*?startQueuedGenerationTask\(task\)/);
  assert.doesNotMatch(generationScheduler, /regularTasks\.forEach[\s\S]*?generationQueue\.push\(task\)/);
  assert.match(generationScheduler, /const waveSize = Math\.max\(1, Number\(batchTasks\[0\]\?\.config\?\.batchWaveSize \|\| 3\)\)/);
  assert.match(generationScheduler, /const intervalMs = Math\.max\(1000, Number\(batchTasks\[0\]\?\.config\?\.batchWaveIntervalMs \|\| 5000\)\)/);
  assert.match(canvasRendering, /event\.target\.closest\("textarea, input, select, button, video"\)/);
  assert.match(canvasRendering, /textarea\.addEventListener\("wheel", \(event\) => \{\s*if \(!textarea\.readOnly\) event\.stopPropagation\(\);/);
  const canvasWheel = sectionBetween(html, 'elements.canvasStage.addEventListener("wheel"', "bindImageDropTarget(elements.canvasStage");
  assert.match(canvasWheel, /event\.target\.closest\("\.canvas-prompt-node textarea\.is-editing"\)/);
  assert.match(html, /\.canvas-prompt-node textarea\.is-editing\s*\{[^}]*overscroll-behavior:\s*contain;/s);
  assert.match(canvasRendering, /createCanvasEditableTitle\(item, defaultTitle, "canvas-reference-image-label"\)/);
  assert.match(canvasRendering, /image\.addEventListener\("load", \(\) => initializeCanvasReferenceSize\(item, image, node\), \{ once: true \}\)/);
  assert.match(canvasRendering, /if \(item\.type === "image"\) appendCanvasReferenceResizeHandles\(node, item\)/);
  const referenceResize = sectionBetween(html, "function getCanvasReferenceFittedSize", "function getCanvasItemRect");
  assert.match(referenceResize, /CANVAS_REFERENCE_DEFAULT_MAX_SIZE \/ width/);
  assert.match(referenceResize, /CANVAS_REFERENCE_DEFAULT_MAX_SIZE \/ height/);
  assert.match(referenceResize, /function beginCanvasReferenceResize/);
  assert.match(referenceResize, /item\.type === "result" && Boolean\(item\.videoFile\)/);
  assert.match(referenceResize, /type: "resize-reference"/);
  assert.match(referenceResize, /\["nw", "ne", "sw", "se"\]/);
  assert.match(html, /\.canvas-reference-resize-handle\[data-corner="nw"\][^{]*\{[^}]*cursor:\s*nwse-resize/s);
  assert.match(html, /\.canvas-reference-resize-handle\[data-corner="ne"\][^{]*\{[^}]*cursor:\s*nesw-resize/s);

  // Generator outputs expose explicit labels while preserving the existing prompt/reference labels.
  const edgeLabels = sectionBetween(html, "function getCanvasEdgeLabel(edge)", "function getCanvasMentionRange(textarea)");
  assert.match(edgeLabels, /source\.type === "generate" && target\.type === "task"\) return "生成任务"/);
  assert.match(edgeLabels, /source\.type === "generate" && target\.type === "result"\) return "生成结果"/);
  assert.match(edgeLabels, /source\.type === "prompt"\) return "提示词"/);

  // Video nodes keep two references in first/last-frame mode until the user explicitly selects multi-reference.
  assert.match(html, /referenceModeManual: Boolean\(item\.referenceModeManual\)/);
  assert.match(html, /frameRole: \["start", "end"\]\.includes\(edge\.frameRole\) \? edge\.frameRole : ""/);
  assert.match(referenceModes, /generateNode\?\.referenceModeManual/);
  assert.match(referenceModes, /isVideo && count > 0 && count <= 2\) return "single"/);
  const frameRoles = sectionBetween(html, "function getCanvasFrameRoleEdges", "function syncCanvasGeneratorReferenceMode");
  assert.match(frameRoles, /referenceEdges\.length !== 2/);
  assert.match(frameRoles, /firstTwo\[0\]\.frameRole = "start"/);
  assert.match(frameRoles, /firstTwo\[1\]\.frameRole = "end"/);
  assert.match(frameRoles, /const otherRole = role === "start" \? "end" : "start"/);
  assert.match(frameRoles, /candidate\.id === edge\.id\) candidate\.frameRole = role/);
  assert.match(frameRoles, /referenceEdges\.length === 2\) candidate\.frameRole = otherRole/);
  const referenceCollection = sectionBetween(html, "async function collectCanvasReferenceFiles", "function getConnectedPrompt");
  assert.match(referenceCollection, /syncCanvasFrameRoles\(generateNodeId\)/);
  assert.match(referenceCollection, /frameEdges\.slice\(\)\.sort/);
  assert.match(referenceCollection, /left\.frameRole === "start"/);
  const frameRoleUi = sectionBetween(html, "function isCanvasFrameRoleEdge", "function getCanvasMentionRange");
  assert.match(frameRoleUi, /appendCanvasContextAction\("设为首帧"/);
  assert.match(frameRoleUi, /appendCanvasContextAction\("设为尾帧"/);
  assert.match(frameRoleUi, /control\.className = "canvas-edge-role-button"/);
  assert.match(frameRoleUi, /aria-haspopup", "menu"/);
  assert.match(frameRoleUi, /function isCanvasSingleStartFrameEdge/);
  assert.match(frameRoleUi, /getCanvasReferenceEdges\(generateNode\.id\)\.length === 1/);
  assert.match(frameRoleUi, /document\.createElement\(isSwitchable \? "button" : "span"\)/);
  assert.match(frameRoleUi, /classList\.toggle\("is-static", isStaticStartFrame\)/);
  assert.match(frameRoleUi, /if \(isSwitchable\) control\.setAttribute\("aria-haspopup", "menu"\)/);
  assert.match(html, /id="canvas-edge-control-layer"/);
  assert.match(html, /\.canvas-edge-role-button:focus-visible/);
  assert.match(html, /\.canvas-edge-role-button\.is-static\s*\{[^}]*pointer-events:\s*none;[^}]*cursor:\s*default;/s);
  assert.match(html, /\.canvas-edge-role-button\s*\{[^}]*width:\s*84px;[^}]*min-width:\s*84px;[^}]*white-space:\s*nowrap;/s);
  assert.match(html, /\.canvas-edge-role-button span\s*\{[^}]*white-space:\s*nowrap;/s);

  // Context actions stay under the pointer, image replacement preserves the node, and connections never auto-arrange nodes.
  const canvasContextMenu = sectionBetween(html, "function openCanvasContextMenu", "function handleCanvasPointerMove");
  assert.match(canvasContextMenu, /appendCanvasContextAction\("替换图片", \(\) => replaceCanvasReference\(target\)\)/);
  assert.match(canvasContextMenu, /const localX = clientX - stageRect\.left/);
  assert.match(canvasContextMenu, /const localY = clientY - stageRect\.top/);
  const imageUpload = sectionBetween(html, "async function addUploadedImagesToCanvas", "function openCanvasAssetPicker");
  assert.match(imageUpload, /item\.sources = replaceReferenceNodeId === item\.id \? sources :/);
  assert.match(imageUpload, /if \(replaceReferenceNodeId === item\.id\) item\.recordIds = \[\]/);
  assert.match(imageUpload, /renderCanvasNodes\(\{ settleRenderedImages: false \}\)/);
  assert.doesNotMatch(imageUpload, /layoutCanvasGeneratorBranch|scheduleCanvasGeneratorBranchLayout/);
  const canvasUploadPicker = sectionBetween(html, "function clearCanvasUploadIntent", "function chooseCanvasReferenceAsset");
  assert.match(canvasUploadPicker, /function finishCanvasUploadPicker/);
  assert.match(canvasUploadPicker, /function armCanvasUploadPicker/);
  assert.match(canvasUploadPicker, /window\.addEventListener\("blur", markDialogBlur/);
  assert.match(canvasUploadPicker, /if \(!dialogBlurred\) return/);
  assert.match(canvasUploadPicker, /if \(elements\.canvasUpload\.files\?\.length\) return/);
  assert.match(canvasUploadPicker, /clearCanvasUploadIntent\(\)/);
  const canvasUploadEvents = sectionBetween(html, 'elements.canvasUploadTrigger.addEventListener("click"', 'elements.canvasOpenAssets.addEventListener');
  assert.match(canvasUploadEvents, /finishCanvasUploadPicker\(\)/);
  assert.match(canvasUploadEvents, /elements\.canvasUpload\.addEventListener\("change", \(\) => \{\s*finishCanvasUploadPicker\(\);/);
  assert.match(canvasUploadEvents, /elements\.canvasUpload\.addEventListener\("cancel", \(\) => \{/);
  const directConnection = sectionBetween(html, "function completeCanvasConnection", "function updateCanvasConnectionTargets");
  assert.match(directConnection, /syncCanvasGeneratorReferenceMode\(to\)/);
  assert.match(directConnection, /renderCanvasNodes\(\{ settleRenderedImages: false \}\)/);
  assert.doesNotMatch(directConnection, /layoutCanvasGeneratorBranch|scheduleCanvasGeneratorBranchLayout/);
  const addPromptInput = sectionBetween(html, "function addPromptForGenerator", "function addImageForGenerator");
  const addImageInput = sectionBetween(html, "function addImageForGenerator", "function uploadIntoCanvasReference");
  assert.doesNotMatch(addPromptInput, /layoutCanvasGeneratorBranch|scheduleCanvasGeneratorBranchLayout/);
  assert.doesNotMatch(addImageInput, /layoutCanvasGeneratorBranch|scheduleCanvasGeneratorBranchLayout/);
  assert.doesNotMatch(canvasAssistantAdapter, /connect:[\s\S]*?layoutCanvasGeneratorBranch/);

  // Reopening a project fits the viewport while preserving every restored node coordinate.
  const canvasScreen = sectionBetweenLast(html, "function setCanvasScreen(screen)", "function hydrateCanvasResultsForProject(projectId)");
  assert.match(canvasScreen, /window\.requestAnimationFrame\(\(\) => \{[\s\S]*?fitCanvasContent\(\)/);
  const canvasHydration = sectionBetween(html, "function hydrateCanvasResultsForProject(projectId)", "function openCanvasProject(projectId)");
  assert.doesNotMatch(canvasHydration, /layoutCanvasGeneratorBranch|scheduleCanvasGeneratorBranchLayout|settleCanvasItemWithoutOverlap|settleCanvasRenderedImageItem/);
  const canvasProjectOpening = sectionBetween(html, "function openCanvasProject(projectId)", "function createCanvasProject(name)");
  assert.match(canvasProjectOpening, /setCanvasScreen\("project"\)/);
  assert.match(canvasProjectOpening, /renderCanvasNodes\(\{ settleRenderedImages: false \}\)/);
  assert.doesNotMatch(canvasProjectOpening, /layoutCanvasGeneratorBranch|scheduleCanvasGeneratorBranchLayout|settleCanvasItemWithoutOverlap|settleCanvasRenderedImageItem/);
  assert.match(canvasProjectOpening, /cancelCanvasBranchLayouts\(\)/);

  // Reference edges use the image-side port nearest the connected control node without moving either node.
  const outputPortSide = sectionBetween(html, "function getCanvasOutputPortSide(item)", "function canConnectCanvasNodes(fromId, toId)");
  assert.match(outputPortSide, /return target\.x \+ targetBounds\.width \/ 2 < itemCenterX \? "left" : "right"/);
  assert.doesNotMatch(outputPortSide, /item\.x\s*=|item\.y\s*=/);
  const canvasPort = sectionBetween(html, "function createCanvasPort(item, direction)", "function createCanvasNodeHeader(item, fallbackTitle)");
  assert.match(canvasPort, /getCanvasOutputPortSide\(item\)/);
  assert.match(canvasPort, /dataset\.canvasSide = side/);
  const canvasEdges = sectionBetween(html, "function renderCanvasEdges()", "function applyCanvasViewport()");
  assert.match(canvasEdges, /fromNode\.querySelector\("\.canvas-port-out"\)/);
  assert.match(canvasEdges, /const nextSide = getCanvasOutputPortSide\(fromItem\)/);
  assert.match(canvasEdges, /fromPort\?\.dataset\.canvasSide === "left" \? -1 : 1/);
  assert.doesNotMatch(canvasEdges, /fromItem\.x\s*=|fromItem\.y\s*=|toItem\.x\s*=|toItem\.y\s*=/);
  assert.match(html, /\.canvas-port-side-left\s*\{[^}]*left:\s*-6px;[^}]*right:\s*auto;/s);
  assert.match(html, /\.canvas-port-side-right\s*\{[^}]*right:\s*-6px;[^}]*left:\s*auto;/s);

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
  assert.match(pointerMove, /interaction\.type === "resize-reference"/);
  assert.match(pointerMove, /const requestedScale/);
  assert.match(pointerMove, /Object\.assign\(item, \{ x, y, width, height \}\)/);
  assert.match(pointerMove, /renderCanvasEdges\(\)/);
  assert.match(pointerMove, /interaction\.type === "node" && !interaction\.activated/);
  assert.match(pointerMove, /if \(dragDistance < 4\) return/);
  assert.match(pointerMove, /interaction\.activated = true/);
  assert.match(pointerMove, /if \(!interaction\.duplicateOnDrag\) pushCanvasHistory\(\)/);

  // Canvas task nodes expose failed/timeout details and a retry action; successful result nodes expose status.
  assert.match(canvasRendering, /const isTaskError = \["failed", "timeout"\]\.includes\(item\.taskState\)/);
  assert.match(canvasRendering, /const isTaskActive = \["waiting", "running"\]\.includes\(item\.taskState\)/);
  assert.match(canvasRendering, /media\.className = `canvas-task-media\$\{isTaskActive \? " skeleton-media" : ""\}`/);
  assert.match(canvasRendering, /if \(isTaskActive && activeTask\?\.startedAt\)/);
  assert.match(html, /\.canvas-task-node\[data-task-state="failed"\] \.canvas-task-media::after,[\s\S]*?content:\s*none;/);
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
