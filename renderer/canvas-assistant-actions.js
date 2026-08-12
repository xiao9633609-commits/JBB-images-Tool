(function attachCanvasAssistantActions(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CanvasAssistantActions = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createCanvasAssistantActions() {
  "use strict";

  const VERSION = 1;
  const MAX_OPERATIONS = 32;
  const MAX_REFERENCE_IMAGES = 16;
  const MAX_PROMPT_LENGTH = 12000;
  const MAX_NODE_TITLE_LENGTH = 80;
  const NODE_TYPES = Object.freeze(["prompt", "image", "generate", "task", "result", "group"]);
  const OPERATION_TYPES = Object.freeze([
    "create_prompt",
    "create_image",
    "create_generate",
    "update_prompt",
    "update_generate",
    "connect",
    "disconnect",
    "arrange",
    "select",
    "delete",
    "submit_generation"
  ]);
  const LOCAL_OPERATION_TYPES = new Set(OPERATION_TYPES.filter((type) => type !== "submit_generation"));
  const VALID_REFERENCE_MODES = new Set(["text", "single", "multi"]);
  const VALID_QUALITIES = new Set(["auto", "medium", "high"]);
  const VALID_ARRANGE_SCOPES = new Set(["all", "selected", "branch"]);
  const VALID_PROMPT_UPDATE_MODES = new Set(["replace", "append"]);
  const VALID_CONNECT_SOURCES = new Set(["prompt", "image", "result"]);
  const REPAIRABLE_PLAN_ERROR_CODES = new Set([
    "CONNECTION_CYCLE", "DELETE_TARGET_REQUIRED", "DISCONNECT_TARGET_REQUIRED", "DUPLICATE_CLIENT_REF",
    "DUPLICATE_CONNECTION", "EDGE_NOT_FOUND", "EMPTY_GENERATE_PATCH", "EMPTY_MODEL_RESPONSE",
    "GENERATE_FIELD_NOT_ALLOWED", "INVALID_CONNECTION", "INVALID_GENERATE_PATCH", "INVALID_MODEL_JSON",
    "INVALID_OPERATION", "INVALID_PLAN", "INVALID_QUALITY", "INVALID_REFERENCE_MODE", "MISSING_OPERATION_ARGUMENT",
    "NODE_NOT_FOUND", "NODE_TYPE_MISMATCH", "OPERATION_ARGUMENT_NOT_ALLOWED", "OPERATION_FIELD_NOT_ALLOWED",
    "OPERATION_NOT_ALLOWED", "PLAN_FIELD_NOT_ALLOWED", "PROJECT_MISMATCH", "PROJECT_REQUIRED", "PROMPT_REQUIRED",
    "PROMPT_CONNECTION_CONFLICT", "REFERENCE_LIMIT", "TOO_MANY_OPERATIONS", "UNRESOLVED_PROMPT_PLACEHOLDER",
    "INCOMPLETE_INDEPENDENT_GENERATION_PLAN"
  ]);

  const ACTION_PROTOCOL = deepFreeze({
    version: VERSION,
    maxOperations: MAX_OPERATIONS,
    maxReferenceImages: MAX_REFERENCE_IMAGES,
    response: {
      required: ["version", "projectId", "reply", "operations"],
      optional: ["requiresConfirmation"]
    },
    operations: {
      create_prompt: { required: [], optional: ["clientRef", "prompt", "title", "x", "y"] },
      create_image: { required: [], optional: ["clientRef", "recordIds", "sourceNodeIds", "title", "x", "y"] },
      create_generate: { required: [], optional: ["clientRef", "title", "model", "referenceMode", "sizeValue", "count", "quality", "groupMode", "x", "y"] },
      update_prompt: { required: ["nodeId", "prompt"], optional: ["mode"] },
      update_generate: { required: ["nodeId", "patch"], optional: [] },
      connect: { required: ["fromId", "toId"], optional: [] },
      disconnect: { required: [], optional: ["edgeId", "fromId", "toId"] },
      arrange: { required: [], optional: ["scope", "nodeIds", "anchorNodeId"] },
      select: { required: [], optional: ["nodeIds"] },
      delete: { required: [], optional: ["nodeIds", "edgeIds"] },
      submit_generation: { required: ["nodeId"], optional: ["countOverride", "groupModeOverride"] }
    }
  });

  const CANVAS_ASSISTANT_SYSTEM_PROMPT = [
    "你是金贝贝无限画布助手。你的权限只限于当前无限画布项目，不是工作区助手。",
    "你只能根据用户要求和提供的当前项目快照生成白名单 JSON 操作计划，不能输出代码、脚本、API Key、文件路径操作或全局设置修改。",
    "只能操作快照 projectId 对应的当前项目，禁止读取、引用或操作其他项目。",
    "创建的节点使用 clientRef（例如 new_prompt_1），同一计划后续操作优先用 $new_prompt_1 引用；遗漏 $ 时仅在精确匹配本计划已创建的 clientRef 时兼容。已有节点必须使用快照中的真实 id。",
    "$clientRef 只能出现在 nodeId、fromId、toId、nodeIds、sourceNodeIds、anchorNodeId 等节点引用参数中，绝不能写进 prompt、title 或回复正文。",
    "create_prompt 和 update_prompt 的 prompt 必须直接写入完整、可独立执行的字面提示词。禁止使用 $prompt_front、$prompt_1、{{base_prompt}}，或仅用“同上”“沿用前文”等文字代替实际提示词。正常编辑指令中的“其余不变”和普通标点不属于变量。",
    "prompt 节点是提示词；image 或 result 节点是参考图；它们只能连接到 generate 节点。每个 generate 最多接收 16 张参考图。",
    "每个 generate 只能连接一个 prompt。正向描述、负面要求和角度要求必须合并到同一个完整提示词节点中；不要为同一个 generate 连接第二个 prompt。已有提示词需要补充时使用 update_prompt 的 append 模式。",
    "当用户说“根据参考图”“参考这张图”或同类要求时，必须优先使用 selectedNodeIds 中的 image/result 节点；若未选中但快照中只有一个明确可用的 image/result 节点，则将它连接到本次创建的每个 generate 节点。不得只创建提示词和生图节点而遗漏参考图连接。",
    "没有参考图时为 text，1 张为 single，2 张及以上自动为 multi。不得绕过此规则。",
    "普通且可撤销的本地操作可以规划执行；提交生图、删除、覆盖已有提示词、批量操作必须明确标记 requiresConfirmation=true。",
    "用户指代模糊时优先使用 selectedNodeIds；仍无法确定时 operations 返回空数组，并在 reply 中只问一个关键问题。",
    "submit_generation 前必须保证 generate 节点已有非空提示词来源。远程生图提交不可承诺通过普通撤销取消。",
    "当用户明确列出多个拍摄角度并要求分别生成多张独立图片或任务时，每个角度默认必须新建一套独立 prompt + generate 分支，并各自 submit_generation；不得把多个角度压进同一个 prompt/generate。仅当用户明确要求复用已有某个角度节点时，才可复用该角度分支，但仍必须保证任务数量、节点唯一性、提示词完整性和角度覆盖。",
    "只能使用下列逐动作字段协议；required 是必填字段，optional 是唯一允许的可选字段，任何未列出的字段都会被拒绝：",
    JSON.stringify(ACTION_PROTOCOL),
    "返回单个 JSON 对象，不要 Markdown 代码块，不要额外文字。完整外层格式示例：",
    JSON.stringify({
      version: VERSION,
      projectId: "当前项目ID",
      reply: "给用户的简短说明",
      requiresConfirmation: false,
      operations: [
        { id: "op_1", type: "create_prompt", args: { clientRef: "new_prompt_1", prompt: "提示词" } }
      ]
    })
  ].join("\n");

  class CanvasAssistantError extends Error {
    constructor(code, message, details) {
      super(message);
      this.name = "CanvasAssistantError";
      this.code = code;
      if (details !== undefined) this.details = details;
    }
  }

  function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
    return value;
  }

  function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function cleanString(value, maxLength = 500) {
    return String(value == null ? "" : value).trim().slice(0, maxLength);
  }

  function cleanTitle(value, fallback) {
    const title = cleanString(value || fallback, MAX_NODE_TITLE_LENGTH)
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return title || fallback;
  }

  const PROMPT_PLACEHOLDER_PATTERNS = Object.freeze([
    /\$[A-Za-z_][A-Za-z0-9_-]*/,
    /\{\{\s*[^{}]+\s*\}\}/,
    /(?:^|[\n。；;])\s*(?:同上|同前|如上|见上文|沿用(?:上文|上述|前述)(?:提示词|内容)?|使用(?:上文|上述|前述)(?:提示词|内容)?)(?=\s*[,，。；;:：]|$)/u,
    /^(?:\bTODO\b|\bTBD\b|待补充|待完善|占位(?:符)?|placeholder)[\s。.!！]*$/iu
  ]);

  const INDEPENDENT_ANGLE_DEFINITIONS = Object.freeze([
    { key: "front", label: "正视", pattern: /正视(?:视角|机位|拍摄角度)?|正面(?:视角|机位|镜头|拍摄角度)|平视(?:视角|机位|镜头|拍摄角度)?|眼平(?:视角|机位|镜头)/u },
    { key: "top", label: "俯视", pattern: /俯视|俯拍|高机位|鸟瞰|顶视/u },
    { key: "low", label: "仰视", pattern: /仰视|仰拍|低机位/u },
    { key: "side", label: "侧视", pattern: /侧视(?:视角|机位|拍摄角度)?|侧面(?:视角|机位|镜头|拍摄角度)|侧拍/u },
    { key: "back", label: "背视", pattern: /背视(?:视角|机位|拍摄角度)?|背面(?:视角|机位|镜头|拍摄角度)|后视(?:视角|机位|拍摄角度)?|背拍/u },
    { key: "three-quarter", label: "三分之四视角", pattern: /三分之四|四分之三|3\s*\/\s*4/u }
  ]);

  function assertResolvedPromptLiteral(value, options = {}) {
    const prompt = cleanString(value, MAX_PROMPT_LENGTH);
    if (!prompt && options.allowEmpty) return prompt;
    if (!prompt) throw new CanvasAssistantError("PROMPT_REQUIRED", options.emptyMessage || "提示词不能为空");
    const placeholder = PROMPT_PLACEHOLDER_PATTERNS.map((pattern) => prompt.match(pattern)?.[0] || "").find(Boolean);
    if (placeholder) {
      throw new CanvasAssistantError(
        "UNRESOLVED_PROMPT_PLACEHOLDER",
        `${options.label || "提示词"}包含未解析的占位或省略写法：${placeholder}。请直接写入完整提示词正文。`,
        { placeholder }
      );
    }
    return prompt;
  }

  function requestedIndependentImageCount(text) {
    const match = String(text || "").match(/(?:生成|创建|新建|制作|生图|出图|提交)?\s*(10|[2-9]|十|九|八|七|六|五|四|三|二|两)\s*(?:张|幅|个(?:独立)?(?:(?:生图|生成)?任务|图片|图像|照片|(?:拍摄)?角度|视角|机位))/u);
    if (!match) return 0;
    const chineseCounts = { 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    return Number(match[1]) || chineseCounts[match[1]] || 0;
  }

  function detectIndependentAngleGenerationIntent(userText) {
    const text = cleanString(userText, 4000);
    if (!text) return null;
    const angles = INDEPENDENT_ANGLE_DEFINITIONS.filter((definition) => definition.pattern.test(text));
    if (angles.length < 2) return null;
    const asksForGeneration = /(?:生成|创建|新建|制作|生图|出图|提交).{0,28}(?:图片|图像|照片|任务|张|角度)|(?:图片|图像|照片|任务|张|角度).{0,20}(?:生成|创建|新建|制作|生图|出图|提交)/u.test(text);
    if (!asksForGeneration) return null;
    const requestedCount = requestedIndependentImageCount(text);
    const asksForIndependentBranches = /分别|各自|各(?:自)?一张|每个(?:角度|视角|机位)|每个角度一张|独立|不同(?:拍摄)?角度/u.test(text) || requestedCount >= 2;
    if (!asksForIndependentBranches) return null;
    const existingReusePattern = /(?:复用|使用|重试|重新提交|再次提交).{0,16}(?:已有|现有|当前|选中).{0,12}(?:节点|分支)|(?:已有|现有|当前|选中).{0,16}(?:节点|分支).{0,12}(?:复用|重试|重新提交|再次提交)/u;
    const explicitlyRejectsExistingReuse = /(?:不要|请勿|禁止|不得|不能|不可|不允许|无需|别|不再|避免)\s*(?:再)?(?:复用|使用|重试|重新提交|再次提交).{0,16}(?:已有|现有|当前|选中).{0,12}(?:节点|分支)|(?:已有|现有|当前|选中).{0,16}(?:节点|分支).{0,8}(?:不要|请勿|禁止|不得|不能|不可|不允许|无需|别|不再|避免)\s*(?:再)?(?:复用|使用|重试|重新提交|再次提交)/u.test(text);
    const reuseMatch = explicitlyRejectsExistingReuse ? null : text.match(existingReusePattern);
    if (requestedCount && requestedCount !== angles.length) return null;
    return {
      expectedCount: angles.length,
      angles,
      allowExistingReuse: Boolean(reuseMatch),
      allowedExistingAngleKeys: reuseMatch
        ? angles.filter((angle) => angle.pattern.test(reuseMatch[0])).map((angle) => angle.key)
        : []
    };
  }

  function finiteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function uniqueStrings(value, max = 100) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map((item) => cleanString(item, 240)).filter(Boolean))].slice(0, max);
  }

  function cloneJson(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function nodeImageCount(node) {
    if (!node || !["image", "result"].includes(node.type)) return 0;
    const sources = Array.isArray(node.sources) ? node.sources.length : 0;
    const recordIds = Array.isArray(node.recordIds) ? node.recordIds.length : 0;
    return Math.max(1, sources, recordIds);
  }

  function compactNode(node) {
    const compact = {
      id: cleanString(node.id, 240),
      type: NODE_TYPES.includes(node.type) ? node.type : "",
      title: cleanString(node.title, 100),
      x: Math.round(finiteNumber(node.x, 0)),
      y: Math.round(finiteNumber(node.y, 0))
    };
    if (node.type === "prompt") compact.prompt = cleanString(node.prompt || node.text, 1600);
    if (node.type === "image" || node.type === "result") {
      compact.imageCount = nodeImageCount(node);
      compact.recordIds = uniqueStrings(node.recordIds, MAX_REFERENCE_IMAGES);
      compact.sources = (Array.isArray(node.sources) ? node.sources : []).slice(0, MAX_REFERENCE_IMAGES).map((source) => ({
        recordId: cleanString(source && source.recordId, 240),
        name: cleanString(source && source.name, 120),
        storageFile: cleanString(source && source.storageFile, 300)
      })).filter((source) => source.recordId || source.name || source.storageFile);
    }
    if (node.type === "generate") {
      compact.model = cleanString(node.model, 200);
      compact.referenceMode = VALID_REFERENCE_MODES.has(node.referenceMode) ? node.referenceMode : "text";
      compact.sizeValue = cleanString(node.sizeValue || "auto", 80);
      compact.count = Math.min(4, Math.max(1, Math.round(finiteNumber(node.count, 1))));
      compact.quality = VALID_QUALITIES.has(node.quality) ? node.quality : "auto";
      compact.groupMode = Boolean(node.groupMode);
      compact.status = cleanString(node.status, 120);
    }
    if (node.type === "task") {
      compact.taskState = cleanString(node.taskState, 60);
      compact.status = cleanString(node.status, 120);
      compact.taskSourceNodeId = cleanString(node.taskSourceNodeId, 240);
    }
    return compact;
  }

  function compressCanvasSnapshot(snapshot, options = {}) {
    if (!isObject(snapshot)) throw new CanvasAssistantError("INVALID_SNAPSHOT", "画布快照无效");
    const projectId = cleanString(snapshot.projectId, 240);
    if (!projectId) throw new CanvasAssistantError("PROJECT_REQUIRED", "画布助手必须绑定当前项目");
    const maxNodes = Math.min(300, Math.max(1, Math.round(finiteNumber(options.maxNodes, 120))));
    const maxEdges = Math.min(600, Math.max(1, Math.round(finiteNumber(options.maxEdges, 240))));
    const allNodes = (Array.isArray(snapshot.nodes) ? snapshot.nodes : Array.isArray(snapshot.items) ? snapshot.items : [])
      .filter((node) => node && NODE_TYPES.includes(node.type) && node.id);
    const nodes = allNodes.slice(0, maxNodes).map(compactNode);
    const visibleIds = new Set(nodes.map((node) => node.id));
    const allEdges = Array.isArray(snapshot.edges) ? snapshot.edges : [];
    const edges = allEdges
      .filter((edge) => edge && visibleIds.has(String(edge.from)) && visibleIds.has(String(edge.to)))
      .slice(0, maxEdges)
      .map((edge) => ({ id: cleanString(edge.id, 240), from: cleanString(edge.from, 240), to: cleanString(edge.to, 240) }));
    return {
      version: VERSION,
      projectId,
      projectName: cleanString(snapshot.projectName, 120),
      selectedNodeIds: uniqueStrings(snapshot.selectedNodeIds, maxNodes).filter((id) => visibleIds.has(id)),
      selectedEdgeId: cleanString(snapshot.selectedEdgeId, 240),
      nodes,
      edges,
      totals: { nodes: allNodes.length, edges: allEdges.length },
      truncated: allNodes.length > nodes.length || allEdges.length > edges.length
    };
  }

  function extractModelContent(payload) {
    if (typeof payload === "string") return payload;
    if (!payload || typeof payload !== "object") return "";
    if (typeof payload.output_text === "string") return payload.output_text;
    if (typeof payload.content === "string") return payload.content;
    const choiceContent = payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.content;
    if (typeof choiceContent === "string") return choiceContent;
    if (Array.isArray(choiceContent)) return choiceContent.map((part) => part && (part.text || part.content || "")).join("");
    if (Array.isArray(payload.output)) {
      return payload.output.flatMap((item) => Array.isArray(item && item.content) ? item.content : []).map((part) => part && (part.text || part.content || "")).join("");
    }
    return "";
  }

  function extractJsonObject(payload) {
    if (isObject(payload) && Array.isArray(payload.operations)) return cloneJson(payload);
    const content = extractModelContent(payload).trim();
    if (!content) throw new CanvasAssistantError("EMPTY_MODEL_RESPONSE", "模型没有返回画布操作计划");
    const withoutFence = content.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    try {
      return JSON.parse(withoutFence);
    } catch {}
    const start = withoutFence.indexOf("{");
    const end = withoutFence.lastIndexOf("}");
    if (start < 0 || end <= start) throw new CanvasAssistantError("INVALID_MODEL_JSON", "模型返回的操作计划不是有效 JSON");
    try {
      return JSON.parse(withoutFence.slice(start, end + 1));
    } catch (error) {
      throw new CanvasAssistantError("INVALID_MODEL_JSON", "模型返回的操作计划不是有效 JSON", { cause: error.message });
    }
  }

  function normalizeRef(value) {
    const ref = cleanString(value, 240);
    return ref.startsWith("$") ? ref : ref;
  }

  function normalizeOperationArgs(type, rawArgs) {
    const args = cloneJson(isObject(rawArgs) ? rawArgs : {});
    if (["connect", "disconnect"].includes(type)) {
      if (args.fromId === undefined) args.fromId = args.from ?? args.sourceId ?? args.source;
      if (args.toId === undefined) args.toId = args.to ?? args.targetId ?? args.target;
      ["from", "sourceId", "source", "to", "targetId", "target"].forEach((field) => delete args[field]);
    }
    return args;
  }

  function normalizeOperation(raw, index) {
    if (!isObject(raw)) throw new CanvasAssistantError("INVALID_OPERATION", `第 ${index + 1} 个操作无效`);
    Object.keys(raw).forEach((field) => {
      if (!["id", "type", "args"].includes(field)) throw new CanvasAssistantError("OPERATION_FIELD_NOT_ALLOWED", `操作不允许字段 ${field}`);
    });
    const type = cleanString(raw.type, 80);
    if (!OPERATION_TYPES.includes(type)) throw new CanvasAssistantError("OPERATION_NOT_ALLOWED", `不允许的画布操作：${type || "空"}`);
    const definition = ACTION_PROTOCOL.operations[type];
    const args = normalizeOperationArgs(type, raw.args);
    definition.required.forEach((field) => {
      if (args[field] === undefined || args[field] === null || args[field] === "") {
        throw new CanvasAssistantError("MISSING_OPERATION_ARGUMENT", `${type} 缺少参数 ${field}`);
      }
    });
    const allowed = new Set([...definition.required, ...definition.optional]);
    Object.keys(args).forEach((field) => {
      if (!allowed.has(field)) throw new CanvasAssistantError("OPERATION_ARGUMENT_NOT_ALLOWED", `${type} 不允许参数 ${field}`);
    });
    return { id: cleanString(raw.id || `op_${index + 1}`, 120), type, args: cloneJson(args) };
  }

  function normalizePlan(rawPlan) {
    if (!isObject(rawPlan)) throw new CanvasAssistantError("INVALID_PLAN", "画布操作计划无效");
    Object.keys(rawPlan).forEach((field) => {
      if (!["version", "projectId", "reply", "requiresConfirmation", "operations"].includes(field)) {
        throw new CanvasAssistantError("PLAN_FIELD_NOT_ALLOWED", `操作计划不允许字段 ${field}`);
      }
    });
    const operations = Array.isArray(rawPlan.operations) ? rawPlan.operations : [];
    if (operations.length > MAX_OPERATIONS) throw new CanvasAssistantError("TOO_MANY_OPERATIONS", `单次最多执行 ${MAX_OPERATIONS} 个操作`);
    return {
      version: VERSION,
      projectId: cleanString(rawPlan.projectId, 240),
      reply: cleanString(rawPlan.reply, 1200),
      requestedConfirmation: Boolean(rawPlan.requiresConfirmation),
      operations: operations.map(normalizeOperation)
    };
  }

  function makeSimulation(snapshot) {
    const nodes = new Map(snapshot.nodes.map((node) => [node.id, cloneJson(node)]));
    const edges = snapshot.edges.map((edge) => cloneJson(edge));
    return { nodes, edges, refs: new Map(), existingNodeIds: new Set(nodes.keys()) };
  }

  function resolveNodeId(value, simulation) {
    const ref = normalizeRef(value);
    if (!ref) return "";
    if (ref.startsWith("$")) return simulation.refs.get(ref.slice(1)) || "";
    if (simulation.existingNodeIds.has(ref)) return ref;
    return simulation.refs.get(ref) || ref;
  }

  function canonicalNodeRef(value, simulation) {
    const ref = normalizeRef(value);
    if (!ref || ref.startsWith("$") || simulation.existingNodeIds.has(ref)) return ref;
    return simulation.refs.has(ref) ? `$${ref}` : ref;
  }

  function publicNodeRef(nodeId, simulation) {
    if (simulation.existingNodeIds.has(nodeId)) return nodeId;
    for (const [clientRef, simulatedId] of simulation.refs) {
      if (simulatedId === nodeId) return `$${clientRef}`;
    }
    return nodeId;
  }

  function graphReaches(startId, targetId, simulation, visited = new Set()) {
    if (startId === targetId) return true;
    if (visited.has(startId)) return false;
    visited.add(startId);
    return simulation.edges
      .filter((edge) => edge.from === startId)
      .some((edge) => graphReaches(edge.to, targetId, simulation, visited));
  }

  function assertNode(nodeId, simulation, expectedTypes, label) {
    const node = simulation.nodes.get(nodeId);
    if (!node) throw new CanvasAssistantError("NODE_NOT_FOUND", `${label || "节点"}不存在：${nodeId}`);
    if (expectedTypes && !expectedTypes.includes(node.type)) {
      throw new CanvasAssistantError("NODE_TYPE_MISMATCH", `${label || "节点"}类型必须是 ${expectedTypes.join("/")}`);
    }
    return node;
  }

  function connectedImageCount(generateId, simulation) {
    return simulation.edges
      .filter((edge) => edge.to === generateId)
      .reduce((total, edge) => total + nodeImageCount(simulation.nodes.get(edge.from)), 0);
  }

  function connectedPrompt(generateId, simulation) {
    const edge = simulation.edges.find((candidate) => candidate.to === generateId && simulation.nodes.get(candidate.from)?.type === "prompt");
    return edge ? simulation.nodes.get(edge.from) : null;
  }

  function nextReferenceMode(imageCount) {
    if (imageCount <= 0) return "text";
    if (imageCount === 1) return "single";
    return "multi";
  }

  function sanitizePosition(args) {
    const result = {};
    if (args.x !== undefined) result.x = finiteNumber(args.x, 0);
    if (args.y !== undefined) result.y = finiteNumber(args.y, 0);
    return result;
  }

  function registerCreatedNode(op, simulation, node) {
    const clientRef = cleanString(op.args.clientRef, 100);
    if (clientRef) {
      if (simulation.refs.has(clientRef)) throw new CanvasAssistantError("DUPLICATE_CLIENT_REF", `重复的 clientRef：${clientRef}`);
      simulation.refs.set(clientRef, node.id);
    }
    node.createdInPlan = true;
    node.clientRef = clientRef;
    simulation.nodes.set(node.id, node);
    op.args.clientRef = clientRef;
  }

  function validateCreateOperation(op, simulation, index) {
    const tempId = `__new_${index + 1}`;
    if (op.type === "create_prompt") {
      const prompt = assertResolvedPromptLiteral(op.args.prompt, { allowEmpty: true, label: "新建提示词" });
      op.args = { clientRef: cleanString(op.args.clientRef, 100), prompt, title: cleanTitle(op.args.title, "提示词"), ...sanitizePosition(op.args) };
      registerCreatedNode(op, simulation, { id: tempId, type: "prompt", prompt });
      return;
    }
    if (op.type === "create_image") {
      const recordIds = uniqueStrings(op.args.recordIds, MAX_REFERENCE_IMAGES);
      const sourceNodeIds = uniqueStrings(op.args.sourceNodeIds, MAX_REFERENCE_IMAGES);
      sourceNodeIds.forEach((id) => assertNode(resolveNodeId(id, simulation), simulation, ["image", "result"], "图片来源节点"));
      if (recordIds.length + sourceNodeIds.length > MAX_REFERENCE_IMAGES) {
        throw new CanvasAssistantError("REFERENCE_LIMIT", `单个图片节点最多包含 ${MAX_REFERENCE_IMAGES} 张图片`);
      }
      op.args = { clientRef: cleanString(op.args.clientRef, 100), recordIds, sourceNodeIds: sourceNodeIds.map((id) => canonicalNodeRef(id, simulation)), title: cleanTitle(op.args.title, "参考图"), ...sanitizePosition(op.args) };
      registerCreatedNode(op, simulation, { id: tempId, type: "image", recordIds, sources: Array(recordIds.length + sourceNodeIds.length).fill({ recordId: "planned" }) });
      return;
    }
    const referenceMode = VALID_REFERENCE_MODES.has(op.args.referenceMode) ? op.args.referenceMode : "text";
    const quality = VALID_QUALITIES.has(op.args.quality) ? op.args.quality : "auto";
    op.args = {
      clientRef: cleanString(op.args.clientRef, 100),
      title: cleanTitle(op.args.title, "统一生图"),
      model: cleanString(op.args.model, 200),
      referenceMode,
      sizeValue: cleanString(op.args.sizeValue || "auto", 80),
      count: Math.min(4, Math.max(1, Math.round(finiteNumber(op.args.count, 1)))),
      quality,
      groupMode: Boolean(op.args.groupMode),
      ...sanitizePosition(op.args)
    };
    registerCreatedNode(op, simulation, { id: tempId, type: "generate", ...op.args });
  }

  function validateUpdatePrompt(op, simulation) {
    const nodeId = resolveNodeId(op.args.nodeId, simulation);
    const node = assertNode(nodeId, simulation, ["prompt"], "提示词节点");
    const mode = VALID_PROMPT_UPDATE_MODES.has(op.args.mode) ? op.args.mode : "replace";
    const prompt = assertResolvedPromptLiteral(op.args.prompt, { label: "更新提示词", emptyMessage: "更新后的提示词不能为空" });
    op.args = { nodeId: canonicalNodeRef(op.args.nodeId, simulation), prompt, mode };
    op.derived = { overwritesPrompt: mode === "replace" && Boolean(cleanString(node.prompt, MAX_PROMPT_LENGTH)) && node.prompt !== prompt };
    node.prompt = mode === "append" && node.prompt ? `${node.prompt}\n${prompt}`.slice(0, MAX_PROMPT_LENGTH) : prompt;
  }

  function sanitizeGeneratePatch(patch) {
    if (!isObject(patch)) throw new CanvasAssistantError("INVALID_GENERATE_PATCH", "生图节点参数无效");
    const allowed = new Set(["model", "referenceMode", "sizeValue", "count", "quality", "groupMode"]);
    const result = {};
    Object.keys(patch).forEach((key) => {
      if (!allowed.has(key)) throw new CanvasAssistantError("GENERATE_FIELD_NOT_ALLOWED", `不允许修改生图参数 ${key}`);
      if (key === "model") result.model = cleanString(patch.model, 200);
      if (key === "referenceMode") {
        if (!VALID_REFERENCE_MODES.has(patch.referenceMode)) throw new CanvasAssistantError("INVALID_REFERENCE_MODE", "参考类型必须是 text、single 或 multi");
        result.referenceMode = patch.referenceMode;
      }
      if (key === "sizeValue") result.sizeValue = cleanString(patch.sizeValue || "auto", 80);
      if (key === "count") result.count = Math.min(4, Math.max(1, Math.round(finiteNumber(patch.count, 1))));
      if (key === "quality") {
        if (!VALID_QUALITIES.has(patch.quality)) throw new CanvasAssistantError("INVALID_QUALITY", "质量参数无效");
        result.quality = patch.quality;
      }
      if (key === "groupMode") result.groupMode = Boolean(patch.groupMode);
    });
    if (!Object.keys(result).length) throw new CanvasAssistantError("EMPTY_GENERATE_PATCH", "没有可更新的生图参数");
    return result;
  }

  function validateConnect(op, simulation) {
    const fromId = resolveNodeId(op.args.fromId, simulation);
    const toId = resolveNodeId(op.args.toId, simulation);
    if (!fromId || !toId || fromId === toId) throw new CanvasAssistantError("INVALID_CONNECTION", "节点连接无效");
    const source = assertNode(fromId, simulation, [...VALID_CONNECT_SOURCES], "连接来源");
    const target = assertNode(toId, simulation, ["generate"], "连接目标");
    if (simulation.edges.some((edge) => edge.from === fromId && edge.to === toId)) throw new CanvasAssistantError("DUPLICATE_CONNECTION", "节点已经连接");
    if (graphReaches(toId, fromId, simulation)) throw new CanvasAssistantError("CONNECTION_CYCLE", "该连接会形成循环，已拒绝执行");
    if (source.type === "prompt") {
      const connectedPromptEdge = simulation.edges.find((edge) => edge.to === toId && simulation.nodes.get(edge.from)?.type === "prompt");
      if (connectedPromptEdge && connectedPromptEdge.from !== fromId) {
        throw new CanvasAssistantError(
          "PROMPT_CONNECTION_CONFLICT",
          "一个生图节点只能连接一个提示词，请把正向描述、负面要求和角度要求合并到同一个提示词节点"
        );
      }
    }
    simulation.edges.push({ id: `__edge_${simulation.edges.length + 1}`, from: fromId, to: toId });
    const imageCount = connectedImageCount(toId, simulation);
    if (imageCount > MAX_REFERENCE_IMAGES) throw new CanvasAssistantError("REFERENCE_LIMIT", `一个生图节点最多连接 ${MAX_REFERENCE_IMAGES} 张参考图片`);
    const mode = nextReferenceMode(imageCount);
    target.referenceMode = mode;
    op.args = { fromId: canonicalNodeRef(op.args.fromId, simulation), toId: canonicalNodeRef(op.args.toId, simulation) };
    op.derived = { referenceMode: mode };
  }

  function validateDisconnect(op, simulation) {
    const edgeId = cleanString(op.args.edgeId, 240);
    const fromId = resolveNodeId(op.args.fromId, simulation);
    const toId = resolveNodeId(op.args.toId, simulation);
    if (!edgeId && !(fromId && toId)) throw new CanvasAssistantError("DISCONNECT_TARGET_REQUIRED", "断开连接需要 edgeId 或 fromId/toId");
    const matched = simulation.edges.filter((edge) => edgeId ? edge.id === edgeId : edge.from === fromId && edge.to === toId);
    if (!matched.length) throw new CanvasAssistantError("EDGE_NOT_FOUND", "要断开的连接不存在");
    simulation.edges = simulation.edges.filter((edge) => !matched.includes(edge));
    const affectedGenerateIds = [...new Set(matched.map((edge) => edge.to).filter((id) => simulation.nodes.get(id)?.type === "generate"))];
    op.args = edgeId ? { edgeId } : { fromId: canonicalNodeRef(op.args.fromId, simulation), toId: canonicalNodeRef(op.args.toId, simulation) };
    op.derived = { referenceModes: affectedGenerateIds.map((id) => ({ nodeId: publicNodeRef(id, simulation), referenceMode: nextReferenceMode(connectedImageCount(id, simulation)) })) };
  }

  function validateOperation(op, simulation, index) {
    if (["create_prompt", "create_image", "create_generate"].includes(op.type)) return validateCreateOperation(op, simulation, index);
    if (op.type === "update_prompt") return validateUpdatePrompt(op, simulation);
    if (op.type === "update_generate") {
      const nodeId = resolveNodeId(op.args.nodeId, simulation);
      const node = assertNode(nodeId, simulation, ["generate"], "生图节点");
      const patch = sanitizeGeneratePatch(op.args.patch);
      const actualMode = nextReferenceMode(connectedImageCount(nodeId, simulation));
      if (patch.referenceMode && patch.referenceMode !== actualMode) patch.referenceMode = actualMode;
      Object.assign(node, patch);
      op.args = { nodeId: canonicalNodeRef(op.args.nodeId, simulation), patch };
      return;
    }
    if (op.type === "connect") return validateConnect(op, simulation);
    if (op.type === "disconnect") return validateDisconnect(op, simulation);
    if (op.type === "arrange") {
      const scope = VALID_ARRANGE_SCOPES.has(op.args.scope) ? op.args.scope : "all";
      const nodeRefs = uniqueStrings(op.args.nodeIds, 200);
      nodeRefs.map((id) => resolveNodeId(id, simulation)).forEach((id) => assertNode(id, simulation, null, "整理节点"));
      const anchorNodeRef = canonicalNodeRef(op.args.anchorNodeId, simulation);
      const anchorNodeId = resolveNodeId(anchorNodeRef, simulation);
      if (anchorNodeId) assertNode(anchorNodeId, simulation, null, "整理锚点");
      op.args = { scope, nodeIds: nodeRefs.map((id) => canonicalNodeRef(id, simulation)), anchorNodeId: anchorNodeRef };
      return;
    }
    if (op.type === "select") {
      const nodeRefs = uniqueStrings(op.args.nodeIds, 200);
      nodeRefs.map((id) => resolveNodeId(id, simulation)).forEach((id) => assertNode(id, simulation, null, "选择节点"));
      op.args = { nodeIds: nodeRefs.map((id) => canonicalNodeRef(id, simulation)) };
      return;
    }
    if (op.type === "delete") {
      const nodeRefs = uniqueStrings(op.args.nodeIds, 200);
      const nodeIds = nodeRefs.map((id) => resolveNodeId(id, simulation));
      const edgeIds = uniqueStrings(op.args.edgeIds, 200);
      nodeIds.forEach((id) => assertNode(id, simulation, null, "删除节点"));
      edgeIds.forEach((id) => {
        if (!simulation.edges.some((edge) => edge.id === id)) throw new CanvasAssistantError("EDGE_NOT_FOUND", `删除连接不存在：${id}`);
      });
      if (!nodeIds.length && !edgeIds.length) throw new CanvasAssistantError("DELETE_TARGET_REQUIRED", "删除操作没有目标");
      nodeIds.forEach((id) => simulation.nodes.delete(id));
      simulation.edges = simulation.edges.filter((edge) => !nodeIds.includes(edge.from) && !nodeIds.includes(edge.to) && !edgeIds.includes(edge.id));
      op.args = { nodeIds: nodeRefs.map((id) => canonicalNodeRef(id, simulation)), edgeIds };
      return;
    }
    if (op.type === "submit_generation") {
      const nodeId = resolveNodeId(op.args.nodeId, simulation);
      const node = assertNode(nodeId, simulation, ["generate"], "提交节点");
      const promptNode = connectedPrompt(nodeId, simulation);
      const prompt = assertResolvedPromptLiteral(promptNode?.prompt || node.prompt, {
        label: "提交任务的提示词",
        emptyMessage: "提交生图前必须填写或连接提示词"
      });
      const imageCount = connectedImageCount(nodeId, simulation);
      if (imageCount > MAX_REFERENCE_IMAGES) throw new CanvasAssistantError("REFERENCE_LIMIT", `一个生图节点最多连接 ${MAX_REFERENCE_IMAGES} 张参考图片`);
      op.args = {
        nodeId: canonicalNodeRef(op.args.nodeId, simulation),
        countOverride: op.args.countOverride === undefined ? undefined : Math.min(4, Math.max(1, Math.round(finiteNumber(op.args.countOverride, 1)))),
        groupModeOverride: op.args.groupModeOverride === undefined ? undefined : Boolean(op.args.groupModeOverride)
      };
      op.derived = { generationMode: nextReferenceMode(imageCount), referenceCount: imageCount };
    }
  }

  function getConfirmationRequirement(plan) {
    const reasons = [];
    if (plan.operations.length > 1) reasons.push("批量操作");
    plan.operations.forEach((op) => {
      if (op.type === "submit_generation") reasons.push("提交生图任务");
      if (op.type === "delete") reasons.push("删除节点或连接");
      if (op.type === "update_prompt" && op.derived?.overwritesPrompt) reasons.push("覆盖已有提示词");
      const targets = op.args.nodeIds || op.args.edgeIds;
      if (Array.isArray(targets) && targets.length > 1) reasons.push("批量操作");
    });
    return { required: reasons.length > 0, reasons: [...new Set(reasons)] };
  }

  function throwIncompleteIndependentPlan(message, intent, details = {}) {
    throw new CanvasAssistantError(
      "INCOMPLETE_INDEPENDENT_GENERATION_PLAN",
      message,
      { expectedCount: intent.expectedCount, angles: intent.angles.map((angle) => angle.label), ...details }
    );
  }

  function validateIndependentAngleGenerationPlan(plan, simulation, intent) {
    if (!intent) return;
    const createdNodes = [...simulation.nodes.values()].filter((node) => node.createdInPlan);
    const createdPrompts = createdNodes.filter((node) => node.type === "prompt");
    const createdGenerates = createdNodes.filter((node) => node.type === "generate");
    const submitOperations = plan.operations.filter((op) => op.type === "submit_generation");
    const expected = intent.expectedCount;

    if (submitOperations.length !== expected) {
      throwIncompleteIndependentPlan(
        `用户明确要求 ${expected} 个角度分别生成，计划必须提交 ${expected} 个独立任务。`,
        intent,
        { createdPrompts: createdPrompts.length, createdGenerates: createdGenerates.length, submissions: submitOperations.length }
      );
    }

    const submittedGenerateIds = submitOperations.map((op) => resolveNodeId(op.args.nodeId, simulation));
    if (new Set(submittedGenerateIds).size !== expected) {
      throwIncompleteIndependentPlan("每个拍摄角度必须提交不同的生图节点，不能重复提交同一分支。", intent);
    }
    const createdGenerateIds = new Set(createdGenerates.map((node) => node.id));
    const reusedSubmittedGenerateIds = submittedGenerateIds.filter((nodeId) => !createdGenerateIds.has(nodeId));
    if (reusedSubmittedGenerateIds.length && !intent.allowExistingReuse) {
      throwIncompleteIndependentPlan("多角度独立生成必须提交本计划新建的生图节点，不能复用已有或带历史结果的生图节点。", intent);
    }
    const expectedCreatedCount = expected - reusedSubmittedGenerateIds.length;
    if (createdPrompts.length !== expectedCreatedCount || createdGenerates.length !== expectedCreatedCount) {
      throwIncompleteIndependentPlan(
        `计划必须为未授权复用的角度新建独立提示词和生图节点；当前应新建 ${expectedCreatedCount} 套分支。`,
        intent,
        { createdPrompts: createdPrompts.length, createdGenerates: createdGenerates.length, reusedSubmissions: reusedSubmittedGenerateIds.length }
      );
    }

    const connectedPromptNodes = submittedGenerateIds.map((generateId) => connectedPrompt(generateId, simulation));
    if (connectedPromptNodes.some((node, index) => createdGenerateIds.has(submittedGenerateIds[index]) && !node?.createdInPlan)) {
      throwIncompleteIndependentPlan("每个新生图节点都必须连接本计划新建的完整提示词节点。", intent);
    }
    if (new Set(connectedPromptNodes.map((node) => node.id)).size !== expected) {
      throwIncompleteIndependentPlan("每个拍摄角度必须使用独立提示词节点，不能让多个生图分支共用同一提示词。", intent);
    }
    const normalizedPrompts = connectedPromptNodes.map((node) => cleanString(node.prompt, MAX_PROMPT_LENGTH));
    if (new Set(normalizedPrompts).size !== expected) {
      throwIncompleteIndependentPlan("各拍摄角度的提示词必须分别完整写明，不能复制同一段提示词充当多个分支。", intent);
    }
    const missingAngles = intent.angles.filter((angle) => !normalizedPrompts.some((prompt) => angle.pattern.test(prompt)));
    if (missingAngles.length) {
      throwIncompleteIndependentPlan(
        `独立提示词没有覆盖用户列出的角度：${missingAngles.map((angle) => angle.label).join("、")}。`,
        intent,
        { missingAngles: missingAngles.map((angle) => angle.label) }
      );
    }
    const branchAngleKeys = normalizedPrompts.map((prompt) => {
      const positivePrompt = prompt.split(/\n\s*负向提示词\s*[:：]?/u)[0];
      return intent.angles.filter((angle) => angle.pattern.test(positivePrompt)).map((angle) => angle.key);
    });
    if (branchAngleKeys.some((keys) => keys.length !== 1) || new Set(branchAngleKeys.flat()).size !== expected) {
      throwIncompleteIndependentPlan("每个独立提示词的正向描述必须只对应一个用户指定角度，不能同时保留冲突机位。", intent);
    }
    if (intent.allowExistingReuse) {
      const reusedGenerateIds = new Set(reusedSubmittedGenerateIds);
      const reusedAngleKeys = branchAngleKeys
        .filter((_keys, index) => reusedGenerateIds.has(submittedGenerateIds[index]))
        .map((keys) => keys[0]);
      const allowedAngleKeys = new Set(intent.allowedExistingAngleKeys || []);
      if (!reusedAngleKeys.length) {
        throwIncompleteIndependentPlan("用户明确要求复用已有角度节点，但计划没有提交任何已有生图节点。", intent);
      }
      if (allowedAngleKeys.size && (
        reusedAngleKeys.some((key) => !allowedAngleKeys.has(key))
        || [...allowedAngleKeys].some((key) => !reusedAngleKeys.includes(key))
      )) {
        throwIncompleteIndependentPlan("计划复用的已有节点角度与用户明确授权复用的角度不一致。", intent, {
          allowedExistingAngles: intent.angles.filter((angle) => allowedAngleKeys.has(angle.key)).map((angle) => angle.label)
        });
      }
    }
  }

  function validatePlan(rawPlan, rawSnapshot, options = {}) {
    const snapshot = compressCanvasSnapshot(rawSnapshot, { maxNodes: 300, maxEdges: 600 });
    const plan = normalizePlan(rawPlan);
    if (!plan.projectId) throw new CanvasAssistantError("PROJECT_REQUIRED", "操作计划缺少 projectId");
    if (plan.projectId !== snapshot.projectId) throw new CanvasAssistantError("PROJECT_MISMATCH", "画布助手只能操作当前项目");
    const simulation = makeSimulation(snapshot);
    plan.operations.forEach((op, index) => validateOperation(op, simulation, index));
    validateIndependentAngleGenerationPlan(plan, simulation, detectIndependentAngleGenerationIntent(options.userText));
    const confirmation = getConfirmationRequirement(plan);
    const validatedPlan = {
      ...plan,
      requiresConfirmation: confirmation.required,
      confirmationReasons: confirmation.reasons
    };
    Object.defineProperty(validatedPlan, "_existingNodeIds", { value: new Set(snapshot.nodes.map((node) => node.id)), enumerable: false });
    return validatedPlan;
  }

  function operationLabel(op) {
    const labels = {
      create_prompt: "新建提示词节点",
      create_image: "新建参考图节点",
      create_generate: "新建生图节点",
      update_prompt: op.args.mode === "append" ? "追加提示词" : "修改提示词",
      update_generate: "修改生图参数",
      connect: "连接节点",
      disconnect: "断开连接",
      arrange: "整理画布",
      select: "选择节点",
      delete: "删除节点或连接",
      submit_generation: "提交生图任务"
    };
    return labels[op.type] || op.type;
  }

  function summarizePlan(plan) {
    const counts = new Map();
    plan.operations.forEach((op) => counts.set(operationLabel(op), (counts.get(operationLabel(op)) || 0) + 1));
    const summary = [...counts].map(([label, count]) => count > 1 ? `${label} ${count} 次` : label).join("、") || "不执行画布操作";
    const confirmation = plan.requiresConfirmation ? `；需要确认：${(plan.confirmationReasons || []).join("、")}` : "；可直接执行";
    return `${summary}${confirmation}`;
  }

  function classifyGenerationMode(snapshot, generateNodeId) {
    const compact = compressCanvasSnapshot(snapshot, { maxNodes: 300, maxEdges: 600 });
    const simulation = makeSimulation(compact);
    assertNode(generateNodeId, simulation, ["generate"], "生图节点");
    const referenceCount = connectedImageCount(generateNodeId, simulation);
    return { mode: nextReferenceMode(referenceCount), referenceCount };
  }

  function createGenerationPlan(options) {
    const projectId = cleanString(options && options.projectId, 240);
    const generateNodeId = cleanString(options && options.generateNodeId, 240);
    if (!projectId || !generateNodeId) throw new CanvasAssistantError("GENERATION_PLAN_REQUIRED", "生成计划缺少项目或生图节点");
    const mode = options.mode || "text";
    if (!VALID_REFERENCE_MODES.has(mode)) throw new CanvasAssistantError("INVALID_REFERENCE_MODE", "生成模式无效");
    return {
      version: VERSION,
      projectId,
      reply: mode === "text" ? "准备提交文生图任务" : mode === "single" ? "准备提交单图生图任务" : "准备提交多图生图任务",
      requiresConfirmation: true,
      operations: [{
        id: "submit_generation_1",
        type: "submit_generation",
        args: {
          nodeId: generateNodeId,
          countOverride: options.countOverride,
          groupModeOverride: options.groupModeOverride
        }
      }]
    };
  }

  function resolveRuntimeRef(value, refs, existingNodeIds) {
    const ref = cleanString(value, 240);
    if (!ref) return "";
    if (!ref.startsWith("$")) {
      if (existingNodeIds?.has(ref)) return ref;
      return refs.get(ref) || ref;
    }
    const resolved = refs.get(ref.slice(1));
    if (!resolved) throw new CanvasAssistantError("UNRESOLVED_CLIENT_REF", `无法解析节点引用 ${ref}`);
    return resolved;
  }

  function requireAdapterMethod(adapter, name) {
    if (!adapter || typeof adapter[name] !== "function") throw new CanvasAssistantError("ADAPTER_METHOD_REQUIRED", `画布 adapter 缺少 ${name}()`);
    return adapter[name].bind(adapter);
  }

  async function executeLocalOperation(op, adapter, refs, existingNodeIds) {
    const args = cloneJson(op.args);
    ["nodeId", "fromId", "toId", "anchorNodeId"].forEach((field) => {
      if (args[field]) args[field] = resolveRuntimeRef(args[field], refs, existingNodeIds);
    });
    if (Array.isArray(args.nodeIds)) args.nodeIds = args.nodeIds.map((id) => resolveRuntimeRef(id, refs, existingNodeIds));
    if (Array.isArray(args.sourceNodeIds)) args.sourceNodeIds = args.sourceNodeIds.map((id) => resolveRuntimeRef(id, refs, existingNodeIds));

    const methodNames = {
      create_prompt: "createPrompt",
      create_image: "createImage",
      create_generate: "createGenerate",
      update_prompt: "updatePrompt",
      update_generate: "updateGenerate",
      connect: "connect",
      disconnect: "disconnect",
      arrange: "arrange",
      select: "select",
      delete: "delete"
    };
    const result = await requireAdapterMethod(adapter, methodNames[op.type])(args, { operation: op });
    if (op.type.startsWith("create_")) {
      const id = cleanString(result && (result.id || result.nodeId) || result, 240);
      if (!id) throw new CanvasAssistantError("CREATE_NODE_FAILED", `${operationLabel(op)}没有返回节点 id`);
      if (args.clientRef) refs.set(args.clientRef, id);
    }
    if (op.type === "connect" && op.derived?.referenceMode) {
      await requireAdapterMethod(adapter, "updateGenerate")({ nodeId: args.toId, patch: { referenceMode: op.derived.referenceMode } }, { derived: true, operation: op });
    }
    if (op.type === "disconnect" && Array.isArray(op.derived?.referenceModes)) {
      for (const effect of op.derived.referenceModes) {
        const nodeId = resolveRuntimeRef(effect.nodeId, refs, existingNodeIds);
        await requireAdapterMethod(adapter, "updateGenerate")({ nodeId, patch: { referenceMode: effect.referenceMode } }, { derived: true, operation: op });
      }
    }
    return result;
  }

  async function executePlan(validatedPlan, adapter, options = {}) {
    if (!validatedPlan || !Array.isArray(validatedPlan.operations)) throw new CanvasAssistantError("INVALID_PLAN", "没有可执行的画布计划");
    const currentProjectId = cleanString(await requireAdapterMethod(adapter, "getCurrentProjectId")(), 240);
    if (!currentProjectId || currentProjectId !== validatedPlan.projectId) throw new CanvasAssistantError("PROJECT_CHANGED", "当前项目已变化，请重新生成操作计划");
    if (validatedPlan.requiresConfirmation && options.confirmed !== true) {
      return { status: "confirmation_required", plan: validatedPlan, summary: summarizePlan(validatedPlan) };
    }

    const localOperations = validatedPlan.operations.filter((op) => LOCAL_OPERATION_TYPES.has(op.type));
    const remoteOperations = validatedPlan.operations.filter((op) => op.type === "submit_generation");
    const refs = new Map();
    const existingNodeIds = validatedPlan._existingNodeIds instanceof Set ? validatedPlan._existingNodeIds : new Set();
    const results = [];
    let transaction;
    if (localOperations.length) {
      transaction = await requireAdapterMethod(adapter, "beginTransaction")({
        projectId: validatedPlan.projectId,
        label: "金贝贝画布助手",
        operationCount: localOperations.length
      });
      try {
        for (const op of localOperations) results.push({ id: op.id, type: op.type, result: await executeLocalOperation(op, adapter, refs, existingNodeIds) });
        await requireAdapterMethod(adapter, "commitTransaction")(transaction);
      } catch (error) {
        try {
          await requireAdapterMethod(adapter, "rollbackTransaction")(transaction, error);
        } catch {}
        throw error;
      }
    }

    for (const op of remoteOperations) {
      const args = cloneJson(op.args);
      args.nodeId = resolveRuntimeRef(args.nodeId, refs, existingNodeIds);
      const result = await requireAdapterMethod(adapter, "submitGeneration")(args, { operation: op, nonUndoable: true });
      results.push({ id: op.id, type: op.type, result });
    }
    return { status: "executed", projectId: validatedPlan.projectId, results, localUndoSteps: localOperations.length ? 1 : 0, remoteSubmissions: remoteOperations.length };
  }

  async function requestTextModelPayload(adapter, messages, options = {}) {
    if (typeof adapter.requestTextModel === "function") {
      return adapter.requestTextModel({
        messages,
        signal: options.signal,
        responseFormat: "json_object",
        attempt: options.attempt || "initial"
      });
    }
    const config = await requireAdapterMethod(adapter, "getTextModelConfig")();
    const endpoint = cleanString(config && config.endpoint, 1000);
    const model = cleanString(config && config.model, 240);
    const apiKey = String(config && config.apiKey || "");
    if (!endpoint || !model || !apiKey) throw new CanvasAssistantError("TEXT_MODEL_CONFIG_REQUIRED", "文本模型配置不完整");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ model, messages, temperature: 0.2, response_format: { type: "json_object" } }),
      signal: options.signal
    });
    if (!response.ok) throw new CanvasAssistantError("TEXT_MODEL_REQUEST_FAILED", `文本模型请求失败（${response.status}）`);
    return response.json();
  }

  function repairPayloadText(payload) {
    if (isObject(payload) && Array.isArray(payload.operations)) return JSON.stringify(payload);
    return cleanString(extractModelContent(payload), 16000) || "{}";
  }

  function createRepairInstruction(error) {
    return [
      "上一个画布操作计划未通过本地校验。请只修正 JSON 计划，不要解释原因，不要输出 Markdown。",
      `校验错误码：${cleanString(error && error.code, 120) || "INVALID_PLAN"}`,
      `校验错误：${cleanString(error && error.message, 500)}`,
      `精确动作协议：${JSON.stringify(ACTION_PROTOCOL)}`,
      "保留用户原始意图和当前 projectId；删除未知字段；同一计划创建的节点后续优先使用 $clientRef。",
      "$clientRef 只能用于节点引用参数；prompt 必须改成完整字面文本，不能包含 $prompt_front、{{base_prompt}}，也不能只写同上、沿用前文等占位文本。",
      "若用户明确列出多个角度并要求分别生成，默认必须为每个角度新建独立 prompt 和 generate，逐一连接并提交；仅当用户明确要求复用已有某个角度节点时，才可复用该角度分支，其余角度仍须新建，且任务数量、节点唯一性、提示词完整性和角度覆盖必须正确。"
    ].join("\n");
  }

  function isRepairablePlanError(error) {
    return error instanceof CanvasAssistantError && REPAIRABLE_PLAN_ERROR_CODES.has(error.code);
  }

  async function requestAssistantPlan(adapter, options) {
    const userText = cleanString(options && options.userText, 4000);
    if (!userText) throw new CanvasAssistantError("USER_TEXT_REQUIRED", "请输入对画布助手的要求");
    const rawSnapshot = options.snapshot || await requireAdapterMethod(adapter, "getSnapshot")();
    const snapshot = compressCanvasSnapshot(rawSnapshot);
    const history = (Array.isArray(options.history) ? options.history : [])
      .filter((message) => message && ["user", "assistant"].includes(message.role))
      .slice(-8)
      .map((message) => ({ role: message.role, content: cleanString(message.content || message.text, 3000) }))
      .filter((message) => message.content);
    const messages = [
      { role: "system", content: CANVAS_ASSISTANT_SYSTEM_PROMPT },
      ...history,
      { role: "user", content: `用户要求：${userText}\n\n当前画布快照：${JSON.stringify(snapshot)}` }
    ];

    let payload = await requestTextModelPayload(adapter, messages, { signal: options.signal, attempt: "initial" });
    try {
      const plan = validatePlan(extractJsonObject(payload), snapshot, { userText });
      return { plan, snapshot, summary: summarizePlan(plan), repaired: false };
    } catch (error) {
      if (options.repair === false || !isRepairablePlanError(error)) throw error;
      const repairMessages = [
        ...messages,
        { role: "assistant", content: repairPayloadText(payload) },
        { role: "user", content: createRepairInstruction(error) }
      ];
      payload = await requestTextModelPayload(adapter, repairMessages, { signal: options.signal, attempt: "repair" });
      const plan = validatePlan(extractJsonObject(payload), snapshot, { userText });
      return { plan, snapshot, summary: summarizePlan(plan), repaired: true, repairedFrom: error.code };
    }
  }

  return Object.freeze({
    VERSION,
    MAX_OPERATIONS,
    MAX_REFERENCE_IMAGES,
    NODE_TYPES,
    OPERATION_TYPES,
    ACTION_PROTOCOL,
    CANVAS_ASSISTANT_SYSTEM_PROMPT,
    CanvasAssistantError,
    compressCanvasSnapshot,
    extractJsonObject,
    normalizePlan,
    validatePlan,
    getConfirmationRequirement,
    summarizePlan,
    classifyGenerationMode,
    createGenerationPlan,
    executePlan,
    requestAssistantPlan
  });
});
