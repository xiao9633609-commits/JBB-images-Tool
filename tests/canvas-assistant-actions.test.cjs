const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function snapshot(overrides = {}) {
  return {
    projectId: "project-a",
    projectName: "测试项目",
    selectedNodeIds: ["gen-1"],
    nodes: [
      { id: "prompt-1", type: "prompt", prompt: "一只橙色杯子", x: 0, y: 0 },
      { id: "image-1", type: "image", recordIds: ["record-1"], x: 0, y: 200 },
      { id: "gen-1", type: "generate", referenceMode: "text", sizeValue: "default:1:1", count: 1, x: 400, y: 0 }
    ],
    edges: [{ id: "edge-prompt", from: "prompt-1", to: "gen-1" }],
    ...overrides
  };
}

async function main() {
  const root = path.resolve(__dirname, "..");
  assert.equal(
    fs.readFileSync(path.join(root, "renderer", "canvas-assistant-actions.js"), "utf8"),
    fs.readFileSync(path.join(root, "renderer", "public", "canvas-assistant-actions.js"), "utf8")
  );
  await import("../renderer/canvas-assistant-actions.js");
  const actions = globalThis.CanvasAssistantActions;
  assert.ok(actions);
  assert.notEqual(actions.CANVAS_ASSISTANT_SYSTEM_PROMPT.includes("ASSISTANT_SYSTEM_PROMPT"), true);
  assert.deepEqual(actions.classifyGenerationMode(snapshot(), "gen-1"), { mode: "text", referenceCount: 0 });

  const connectedPlan = actions.validatePlan({
    version: 1,
    projectId: "project-a",
    reply: "连接参考图",
    operations: [{ type: "connect", args: { fromId: "image-1", toId: "gen-1" } }]
  }, snapshot());
  assert.equal(connectedPlan.operations[0].derived.referenceMode, "single");
  assert.equal(connectedPlan.requiresConfirmation, false);

  const aliasedConnectPlan = actions.validatePlan({
    projectId: "project-a",
    reply: "使用模型常见字段别名连接参考图",
    operations: [{ type: "connect", args: { from: "image-1", to: "gen-1" } }]
  }, snapshot());
  assert.equal(aliasedConnectPlan.operations[0].args.fromId, "image-1");
  assert.equal(aliasedConnectPlan.operations[0].args.toId, "gen-1");
  assert.equal(aliasedConnectPlan.operations[0].derived.referenceMode, "single");

  assert.throws(() => actions.validatePlan({
    projectId: "project-a",
    reply: "不要让负面提示词覆盖正向提示词",
    operations: [{ type: "connect", args: { fromId: "prompt-negative", toId: "gen-1" } }]
  }, snapshot({
    nodes: [...snapshot().nodes, { id: "prompt-negative", type: "prompt", prompt: "不要模糊" }]
  })), (error) => error.code === "PROMPT_CONNECTION_CONFLICT");

  const titledGeneratePlan = actions.validatePlan({
    projectId: "project-a",
    operations: [{ type: "create_generate", args: { title: `  马上班图\n${"A".repeat(100)}  ` } }]
  }, snapshot());
  assert.equal(titledGeneratePlan.operations[0].args.title.startsWith("马上班图 "), true);
  assert.equal(titledGeneratePlan.operations[0].args.title.length, 80);

  assert.throws(() => actions.validatePlan({
    projectId: "project-a",
    operations: [{ type: "create_generate", args: { apiKey: "never-allowed" } }]
  }, snapshot()), (error) => error.code === "OPERATION_ARGUMENT_NOT_ALLOWED");

  const multiPlan = actions.validatePlan({
    projectId: "project-a",
    reply: "新增第二张参考图并连接",
    operations: [
      { type: "create_image", args: { clientRef: "image_2", recordIds: ["record-2"] } },
      { type: "connect", args: { fromId: "$image_2", toId: "gen-1" } }
    ]
  }, snapshot({ edges: [
    { id: "edge-prompt", from: "prompt-1", to: "gen-1" },
    { id: "edge-image", from: "image-1", to: "gen-1" }
  ] }));
  assert.equal(multiPlan.operations[1].derived.referenceMode, "multi");
  assert.equal(multiPlan.requiresConfirmation, true);
  assert.ok(multiPlan.confirmationReasons.includes("批量操作"));

  assert.throws(() => actions.validatePlan({
    projectId: "project-b",
    operations: []
  }, snapshot()), (error) => error.code === "PROJECT_MISMATCH");

  assert.throws(() => actions.validatePlan({
    projectId: "project-a",
    unexpected: true,
    operations: []
  }, snapshot()), (error) => error.code === "PLAN_FIELD_NOT_ALLOWED");

  assert.throws(() => actions.validatePlan({
    projectId: "project-a",
    operations: [{ type: "connect", args: { fromId: "result-1", toId: "gen-1" } }]
  }, snapshot({
    nodes: [...snapshot().nodes, { id: "result-1", type: "result" }],
    edges: [...snapshot().edges, { id: "result-edge", from: "gen-1", to: "result-1" }]
  })), (error) => error.code === "CONNECTION_CYCLE");

  const sixteenImages = Array.from({ length: 16 }, (_, index) => ({ id: `image-${index}`, type: "image", recordIds: [`record-${index}`] }));
  const sixteenEdges = sixteenImages.map((node, index) => ({ id: `edge-${index}`, from: node.id, to: "gen-1" }));
  assert.throws(() => actions.validatePlan({
    projectId: "project-a",
    operations: [{ type: "connect", args: { fromId: "image-extra", toId: "gen-1" } }]
  }, snapshot({
    nodes: [{ id: "prompt-1", type: "prompt", prompt: "test" }, { id: "gen-1", type: "generate" }, ...sixteenImages, { id: "image-extra", type: "image", recordIds: ["extra"] }],
    edges: [{ id: "prompt-edge", from: "prompt-1", to: "gen-1" }, ...sixteenEdges]
  })), (error) => error.code === "REFERENCE_LIMIT");

  const overwritePlan = actions.validatePlan({
    projectId: "project-a",
    operations: [{ type: "update_prompt", args: { nodeId: "prompt-1", prompt: "新的提示词", mode: "replace" } }]
  }, snapshot());
  assert.equal(overwritePlan.requiresConfirmation, true);
  assert.ok(overwritePlan.confirmationReasons.includes("覆盖已有提示词"));

  const submitPlan = actions.validatePlan(actions.createGenerationPlan({
    projectId: "project-a",
    generateNodeId: "gen-1",
    mode: "text"
  }), snapshot());
  assert.equal(submitPlan.operations[0].derived.generationMode, "text");
  assert.ok(submitPlan.confirmationReasons.includes("提交生图任务"));

  const calls = [];
  const adapter = {
    getCurrentProjectId: () => "project-a",
    beginTransaction: (meta) => { calls.push(["begin", meta.operationCount]); return { id: 1 }; },
    commitTransaction: () => calls.push(["commit"]),
    rollbackTransaction: () => calls.push(["rollback"]),
    createPrompt: (args) => { calls.push(["createPrompt", args.prompt]); return { id: "created-prompt" }; },
    createGenerate: (args) => { calls.push(["createGenerate", args.title]); return { id: "created-generate" }; },
    createImage: () => ({ id: "created-image" }),
    updatePrompt: () => true,
    updateGenerate: (args) => { calls.push(["updateGenerate", args.nodeId, args.patch.referenceMode]); return true; },
    connect: (args) => { calls.push(["connect", args.fromId, args.toId]); return true; },
    disconnect: () => true,
    arrange: () => true,
    select: () => true,
    delete: () => true,
    submitGeneration: (args) => { calls.push(["submit", args.nodeId]); return true; }
  };
  const transactionPlan = actions.validatePlan({
    projectId: "project-a",
    operations: [
      { type: "create_prompt", args: { clientRef: "new_prompt", prompt: "测试提示词" } },
      { type: "create_generate", args: { clientRef: "new_generate", title: "马上班图" } },
      { type: "connect", args: { fromId: "new_prompt", toId: "new_generate" } },
      { type: "select", args: { nodeIds: ["new_prompt", "new_generate"] } },
      { type: "submit_generation", args: { nodeId: "new_generate" } }
    ]
  }, snapshot());
  assert.equal(transactionPlan.operations[2].args.fromId, "$new_prompt");
  assert.equal(transactionPlan.operations[2].args.toId, "$new_generate");
  const waiting = await actions.executePlan(transactionPlan, adapter);
  assert.equal(waiting.status, "confirmation_required");
  const executed = await actions.executePlan(transactionPlan, adapter, { confirmed: true });
  assert.equal(executed.localUndoSteps, 1);
  assert.equal(executed.remoteSubmissions, 1);
  assert.deepEqual(calls.map((call) => call[0]), ["begin", "createPrompt", "createGenerate", "connect", "updateGenerate", "commit", "submit"]);
  assert.deepEqual(calls[2], ["createGenerate", "马上班图"]);
  assert.deepEqual(calls.at(-1), ["submit", "created-generate"]);

  const compact = actions.compressCanvasSnapshot(snapshot({ nodes: [
    ...snapshot().nodes,
    { id: "image-secret", type: "image", sources: [{ src: "data:image/png;base64,SECRET", recordId: "safe-record", name: "图片" }] }
  ] }));
  assert.equal(JSON.stringify(compact).includes("SECRET"), false);
  assert.equal(JSON.stringify(compact).includes("safe-record"), true);

  const parsed = actions.extractJsonObject({ choices: [{ message: { content: "```json\n{\"projectId\":\"project-a\",\"operations\":[]}\n```" } }] });
  assert.equal(parsed.projectId, "project-a");

  const repairCalls = [];
  const repaired = await actions.requestAssistantPlan({
    getSnapshot: () => snapshot(),
    requestTextModel: ({ messages, attempt }) => {
      repairCalls.push({ messages, attempt });
      if (attempt === "initial") {
        return { projectId: "project-a", reply: "创建节点", operations: [{ type: "create_generate", args: { caption: "马上班图" } }] };
      }
      return { projectId: "project-a", reply: "创建节点", operations: [{ type: "create_generate", args: { title: "马上班图" } }] };
    }
  }, {
    userText: "帮我生成一张马上班图",
    history: [
      { role: "system", content: "内部状态" },
      { role: "error", content: "旧错误" },
      { role: "user", content: "上一条用户要求" },
      { role: "assistant", content: "上一条助手回复" }
    ]
  });
  assert.equal(repaired.repaired, true);
  assert.equal(repaired.repairedFrom, "OPERATION_ARGUMENT_NOT_ALLOWED");
  assert.equal(repairCalls.length, 2);
  assert.deepEqual(repairCalls.map((call) => call.attempt), ["initial", "repair"]);
  assert.equal(repairCalls[0].messages.some((message) => message.content === "内部状态" || message.content === "旧错误"), false);
  assert.match(repairCalls[1].messages.at(-1).content, /OPERATION_ARGUMENT_NOT_ALLOWED/);
  assert.equal(repaired.plan.operations[0].args.title, "马上班图");

  let failedRepairCalls = 0;
  await assert.rejects(() => actions.requestAssistantPlan({
    getSnapshot: () => snapshot(),
    requestTextModel: () => {
      failedRepairCalls += 1;
      return { projectId: "project-a", operations: [{ type: "create_generate", args: { unknown: true } }] };
    }
  }, { userText: "创建生图节点" }), (error) => error.code === "OPERATION_ARGUMENT_NOT_ALLOWED");
  assert.equal(failedRepairCalls, 2);

  let transportCalls = 0;
  await assert.rejects(() => actions.requestAssistantPlan({
    getSnapshot: () => snapshot(),
    requestTextModel: () => {
      transportCalls += 1;
      throw new Error("offline");
    }
  }, { userText: "创建生图节点" }), /offline/);
  assert.equal(transportCalls, 1);

  process.stdout.write("canvas assistant actions tests passed\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
