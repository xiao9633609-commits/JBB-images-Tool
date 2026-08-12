const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

global.window = global;
require("../renderer/canvas-assistant-bridge.js");

function createUiHarness() {
  const state = { messages: [], error: null, mountOptions: null, plan: null };
  return {
    state,
    ui: {
      mount(options) { state.mountOptions = options; },
      renderMessages(messages) { state.messages = messages.map((message) => ({ ...message })); },
      renderPlan(plan) { state.plan = plan || null; },
      setBusy() {},
      setError(value) { state.error = value; },
      setContext() {},
      setDisabled() {},
      setOpen() {},
      destroy() {}
    }
  };
}

async function main() {
  const root = path.resolve(__dirname, "..");
  assert.equal(
    fs.readFileSync(path.join(root, "renderer", "canvas-assistant-bridge.js"), "utf8"),
    fs.readFileSync(path.join(root, "renderer", "public", "canvas-assistant-bridge.js"), "utf8")
  );

  const planningHarness = createUiHarness();
  const planningCalls = [];
  const diagnostics = [];
  let planningAttempt = 0;
  const planningActions = {
    summarizePlan: () => "无操作",
    executePlan: async () => ({ status: "executed", remoteSubmissions: 0 }),
    requestAssistantPlan: async (_adapter, options) => {
      planningCalls.push(options);
      planningAttempt += 1;
      if (planningAttempt === 1) {
        const error = new Error("create_generate 不允许参数 caption");
        error.code = "OPERATION_ARGUMENT_NOT_ALLOWED";
        throw error;
      }
      return { plan: { reply: "计划已修复", operations: [], requiresConfirmation: false }, summary: "无操作" };
    }
  };
  const planningSession = global.JBBCanvasAssistantBridge.createSession({
    actions: planningActions,
    ui: planningHarness.ui,
    adapter: {
      getCurrentProjectId: () => "project-a",
      getContext: () => ({ project: "测试项目", selection: "未选择节点" })
    },
    getMessages: () => [
      { role: "system", content: "画布状态" },
      { role: "error", content: "旧错误" },
      { role: "user", content: "旧用户消息" },
      { role: "assistant", content: "旧助手消息" }
    ],
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
  });

  await planningSession.send("创建马上班图节点");
  assert.equal(planningHarness.state.messages.filter((message) => message.role === "error").length, 1);
  assert.equal(planningHarness.state.messages.at(-1).role, "user");
  assert.equal(typeof planningHarness.state.error, "object");
  assert.match(planningHarness.state.error.message, /画布未修改/);
  assert.equal(planningHarness.state.error.actionLabel, "重试");
  assert.equal(diagnostics[0].phase, "planning");
  assert.equal(diagnostics[0].code, "OPERATION_ARGUMENT_NOT_ALLOWED");
  assert.equal(planningCalls[0].history.some((message) => ["system", "error"].includes(message.role)), false);

  await planningHarness.state.error.onAction();
  assert.equal(planningAttempt, 2);
  assert.equal(planningHarness.state.messages.filter((message) => message.content === "创建马上班图节点").length, 1);
  assert.equal(planningHarness.state.messages.at(-1).content, "计划已修复");
  planningSession.destroy();

  const completedHarness = createUiHarness();
  const completedPlan = {
    projectId: "project-a",
    reply: "开始创建",
    requiresConfirmation: false,
    operations: [
      { type: "create_prompt", args: { prompt: "测试" } },
      { type: "create_generate", args: {} }
    ]
  };
  const completedSession = global.JBBCanvasAssistantBridge.createSession({
    actions: {
      summarizePlan: () => "新建提示词节点、新建生图节点",
      requestAssistantPlan: async () => ({ plan: completedPlan, summary: "创建节点" }),
      executePlan: async () => ({ status: "executed", remoteSubmissions: 0 })
    },
    ui: completedHarness.ui,
    adapter: {
      getCurrentProjectId: () => "project-a",
      getContext: () => ({ project: "测试项目", selection: "未选择节点" })
    }
  });
  await completedSession.send("创建两个节点");
  assert.equal(completedHarness.state.plan, null);
  assert.equal(completedHarness.state.messages.at(-1).role, "system");
  assert.match(completedHarness.state.messages.at(-1).content, /画布操作已完成/);
  assert.match(completedHarness.state.messages.at(-1).content, /本次新建 1 个提示词节点、1 个生图节点/);
  assert.match(completedHarness.state.messages.at(-1).content, /1\. 新建提示词节点/);
  assert.match(completedHarness.state.messages.at(-1).content, /2\. 新建生图节点/);
  completedSession.destroy();

  const newSubmissionHarness = createUiHarness();
  const newSubmissionPlan = {
    projectId: "project-a",
    reply: "创建并提交新节点",
    requiresConfirmation: false,
    operations: [
      { type: "create_generate", args: { clientRef: "new-gen" } },
      { type: "submit_generation", args: { nodeId: "$new-gen" } }
    ]
  };
  const newSubmissionSession = global.JBBCanvasAssistantBridge.createSession({
    actions: {
      summarizePlan: () => "创建并提交新生图节点",
      requestAssistantPlan: async () => ({ plan: newSubmissionPlan, summary: "创建并提交新生图节点" }),
      executePlan: async () => ({ status: "executed", remoteSubmissions: 1 })
    },
    ui: newSubmissionHarness.ui,
    adapter: {
      getCurrentProjectId: () => "project-a",
      getContext: () => ({ project: "测试项目", selection: "未选择节点" })
    }
  });
  await newSubmissionSession.send("创建并立即提交新节点");
  assert.match(newSubmissionHarness.state.messages.at(-1).content, /本次新建 0 个提示词节点、1 个生图节点/);
  assert.doesNotMatch(newSubmissionHarness.state.messages.at(-1).content, /使用已有生图节点/);
  newSubmissionSession.destroy();

  const mixedSubmissionHarness = createUiHarness();
  const mixedSubmissionPlan = {
    projectId: "project-a",
    reply: "提交新旧节点",
    requiresConfirmation: false,
    operations: [
      { type: "create_generate", args: { clientRef: "new-gen" } },
      { type: "submit_generation", args: { nodeId: "$new-gen" } },
      { type: "submit_generation", args: { nodeId: "existing-gen" } }
    ]
  };
  const mixedSubmissionSession = global.JBBCanvasAssistantBridge.createSession({
    actions: {
      summarizePlan: () => "提交新旧生图节点",
      requestAssistantPlan: async () => ({ plan: mixedSubmissionPlan, summary: "提交新旧生图节点" }),
      executePlan: async () => ({ status: "executed", remoteSubmissions: 2 })
    },
    ui: mixedSubmissionHarness.ui,
    adapter: {
      getCurrentProjectId: () => "project-a",
      getContext: () => ({ project: "测试项目", selection: "已有生图节点" })
    }
  });
  await mixedSubmissionSession.send("创建一个新节点并同时提交已有节点");
  assert.match(mixedSubmissionHarness.state.messages.at(-1).content, /已提交 2 个生图任务/);
  assert.match(mixedSubmissionHarness.state.messages.at(-1).content, /其中 1 个任务使用已有生图节点/);
  mixedSubmissionSession.destroy();

  const reusedHarness = createUiHarness();
  const reusedPlan = {
    projectId: "project-a",
    reply: "提交已有节点",
    requiresConfirmation: false,
    operations: [{ type: "submit_generation", args: { nodeId: "existing-gen" } }]
  };
  const reusedSession = global.JBBCanvasAssistantBridge.createSession({
    actions: {
      summarizePlan: () => "提交生图任务",
      requestAssistantPlan: async () => ({ plan: reusedPlan, summary: "提交生图任务" }),
      executePlan: async () => ({ status: "executed", remoteSubmissions: 1 })
    },
    ui: reusedHarness.ui,
    adapter: {
      getCurrentProjectId: () => "project-a",
      getContext: () => ({ project: "测试项目", selection: "已有生图节点" })
    }
  });
  await reusedSession.send("提交已有节点");
  assert.match(reusedHarness.state.messages.at(-1).content, /其中 1 个任务使用已有生图节点/);
  assert.match(reusedHarness.state.messages.at(-1).content, /历史结果会继续保留/);
  reusedSession.destroy();

  const submissionHarness = createUiHarness();
  const submissionPlan = {
    projectId: "project-a",
    reply: "提交任务",
    requiresConfirmation: false,
    operations: [{ type: "submit_generation", args: { nodeId: "gen-1" } }]
  };
  const submissionSession = global.JBBCanvasAssistantBridge.createSession({
    actions: {
      summarizePlan: () => "提交生图任务",
      requestAssistantPlan: async () => ({ plan: submissionPlan, summary: "提交生图任务" }),
      executePlan: async () => { throw Object.assign(new Error("timeout"), { code: "TEXT_MODEL_REQUEST_FAILED" }); }
    },
    ui: submissionHarness.ui,
    adapter: {
      getCurrentProjectId: () => "project-a",
      getContext: () => ({ project: "测试项目", selection: "生图节点" })
    }
  });
  await submissionSession.send("立即生成");
  assert.match(submissionHarness.state.error.message, /避免立即重复提交/);
  assert.equal(submissionHarness.state.error.actionLabel, "");
  assert.equal(submissionHarness.state.error.onAction, null);
  submissionSession.destroy();

  process.stdout.write("canvas assistant bridge tests passed\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
