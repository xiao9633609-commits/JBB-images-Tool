const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

function snapshot(overrides = {}) {
  return {
    projectId: "project-a",
    projectName: "测试项目",
    selectedNodeIds: ["generate-existing-front"],
    nodes: [
      {
        id: "prompt-existing-front",
        type: "prompt",
        title: "已有正视提示词",
        prompt: "主体正视镜头，保持身份与服装一致"
      },
      {
        id: "generate-existing-front",
        type: "generate",
        title: "已有正视生图",
        referenceMode: "text",
        count: 1
      }
    ],
    edges: [
      { id: "edge-existing-front", from: "prompt-existing-front", to: "generate-existing-front" }
    ],
    ...overrides
  };
}

function createBranch(angle, index) {
  const promptRef = `prompt_${angle}`;
  const generateRef = `generate_${angle}`;
  return [
    {
      id: `create-prompt-${index}`,
      type: "create_prompt",
      args: {
        clientRef: promptRef,
        title: `${angle}提示词`,
        prompt: `同一主体，${angle}拍摄角度，完整独立提示词，保持身份、服装和场景一致`
      }
    },
    {
      id: `create-generate-${index}`,
      type: "create_generate",
      args: { clientRef: generateRef, title: `${angle}生图`, referenceMode: "text", count: 1 }
    },
    {
      id: `connect-${index}`,
      type: "connect",
      args: { fromId: `$${promptRef}`, toId: `$${generateRef}` }
    },
    {
      id: `submit-${index}`,
      type: "submit_generation",
      args: { nodeId: `$${generateRef}` }
    }
  ];
}

function plan(operations, reply = "已按要求创建独立任务") {
  return {
    version: 1,
    projectId: "project-a",
    reply,
    requiresConfirmation: true,
    operations
  };
}

async function main() {
  const root = path.resolve(__dirname, "..");
  const actionsPath = path.join(root, "renderer", "canvas-assistant-actions.js");
  const publicActionsPath = path.join(root, "renderer", "public", "canvas-assistant-actions.js");
  assert.equal(fs.readFileSync(actionsPath, "utf8"), fs.readFileSync(publicActionsPath, "utf8"));

  await import(pathToFileURL(actionsPath).href);
  const actions = globalThis.CanvasAssistantActions;
  assert.ok(actions);

  // A clientRef is only valid in node-reference fields. It must never leak into prompt text as a fake macro.
  assert.throws(() => actions.validatePlan(plan([
    {
      type: "create_prompt",
      args: {
        clientRef: "prompt_front",
        prompt: "主体正视镜头，保持身份和服装一致"
      }
    },
    {
      type: "create_prompt",
      args: {
        clientRef: "prompt_top",
        prompt: "$prompt_front\n改为俯视镜头"
      }
    }
  ]), snapshot(), {
    userText: "请创建正视、俯视、仰视三张独立图片"
  }), (error) => error.code === "UNRESOLVED_PROMPT_PLACEHOLDER");

  assert.throws(() => actions.validatePlan(plan([
    {
      type: "update_prompt",
      args: {
        nodeId: "prompt-existing-front",
        mode: "replace",
        prompt: "$prompt_front 改成仰视角度"
      }
    }
  ]), snapshot(), {
    userText: "把已有提示词改成仰视角度"
  }), (error) => error.code === "UNRESOLVED_PROMPT_PLACEHOLDER");

  const normalEditInstruction = actions.validatePlan(plan([
    {
      type: "update_prompt",
      args: {
        nodeId: "prompt-existing-front",
        mode: "replace",
        prompt: "把衣服修改为红色，其余不变……保持自然光和真实材质。"
      }
    }
  ]), snapshot(), {
    userText: "把衣服修改为红色，其余不变"
  });
  assert.equal(normalEditInstruction.operations[0].args.prompt, "把衣服修改为红色，其余不变……保持自然光和真实材质。");
  ["同上，改为俯视镜头", "沿用上述内容，改为仰视"].forEach((prompt) => {
    assert.throws(() => actions.validatePlan(plan([
      { type: "update_prompt", args: { nodeId: "prompt-existing-front", mode: "replace", prompt } }
    ]), snapshot(), {
      userText: "修改拍摄角度"
    }), (error) => error.code === "UNRESOLVED_PROMPT_PLACEHOLDER");
  });

  const snapshotWithStoredPlaceholder = snapshot({
    selectedNodeIds: ["generate-stored-placeholder"],
    nodes: [
      {
        id: "prompt-stored-placeholder",
        type: "prompt",
        title: "历史错误提示词",
        prompt: "$prompt_front\n改为俯视镜头"
      },
      {
        id: "generate-stored-placeholder",
        type: "generate",
        title: "历史错误生图",
        referenceMode: "text",
        count: 1
      }
    ],
    edges: [
      { id: "edge-stored-placeholder", from: "prompt-stored-placeholder", to: "generate-stored-placeholder" }
    ]
  });
  assert.throws(() => actions.validatePlan(plan([
    {
      type: "submit_generation",
      args: { nodeId: "generate-stored-placeholder" }
    }
  ]), snapshotWithStoredPlaceholder, {
    userText: "重新提交这个已有节点"
  }), (error) => error.code === "UNRESOLVED_PROMPT_PLACEHOLDER");

  // Explicitly requested independent angles cannot reuse the existing front generator for one branch.
  const reuseExistingFront = plan([
    {
      id: "submit-existing-front",
      type: "submit_generation",
      args: { nodeId: "generate-existing-front" }
    },
    ...createBranch("俯视", 2),
    ...createBranch("仰视", 3)
  ], "已创建正视、俯视、仰视三个任务");
  assert.throws(() => actions.validatePlan(reuseExistingFront, snapshot(), {
    userText: "请新建正视、俯视、仰视三张独立图片"
  }), (error) => error.code === "INCOMPLETE_INDEPENDENT_GENERATION_PLAN");
  assert.throws(() => actions.validatePlan(reuseExistingFront, snapshot(), {
    userText: "请重新生成正视、俯视、仰视三张不同拍摄角度的图片"
  }), (error) => error.code === "INCOMPLETE_INDEPENDENT_GENERATION_PLAN");
  assert.throws(() => actions.validatePlan(reuseExistingFront, snapshot(), {
    userText: "基于同一提示词创建正视/俯视/仰视三个生图任务"
  }), (error) => error.code === "INCOMPLETE_INDEPENDENT_GENERATION_PLAN");
  assert.throws(() => actions.validatePlan(reuseExistingFront, snapshot(), {
    userText: "生成正视/俯视/仰视三个角度，各一张"
  }), (error) => error.code === "INCOMPLETE_INDEPENDENT_GENERATION_PLAN");
  [
    "不要复用已有节点，请创建正视、俯视、仰视三个生图任务",
    "请不要使用当前分支，重新创建正视、俯视、仰视三个角度"
  ].forEach((userText) => {
    assert.throws(() => actions.validatePlan(reuseExistingFront, snapshot(), {
      userText
    }), (error) => error.code === "INCOMPLETE_INDEPENDENT_GENERATION_PLAN");
  });
  const explicitReuse = actions.validatePlan(reuseExistingFront, snapshot(), {
    userText: "请复用已有正视节点，并为俯视、仰视创建分支后分别提交三个任务"
  });
  assert.equal(explicitReuse.operations.filter((operation) => operation.type === "submit_generation").length, 3);
  const repeatedExistingSubmission = plan([
    { type: "submit_generation", args: { nodeId: "generate-existing-front" } },
    { type: "submit_generation", args: { nodeId: "generate-existing-front" } },
    { type: "submit_generation", args: { nodeId: "generate-existing-front" } }
  ]);
  assert.throws(() => actions.validatePlan(repeatedExistingSubmission, snapshot(), {
    userText: "请复用已有正视节点，并为俯视、仰视创建分支后分别提交三个任务"
  }), (error) => error.code === "INCOMPLETE_INDEPENDENT_GENERATION_PLAN");
  assert.throws(() => actions.validatePlan(plan([
    ...createBranch("正视", 1),
    ...createBranch("俯视", 2),
    ...createBranch("仰视", 3)
  ]), snapshot(), {
    userText: "请复用已有正视节点，并为俯视、仰视创建分支后分别提交三个任务"
  }), (error) => error.code === "INCOMPLETE_INDEPENDENT_GENERATION_PLAN");
  assert.throws(() => actions.validatePlan(reuseExistingFront, snapshot(), {
    userText: "请复用已有俯视节点，并为正视、仰视创建分支后分别提交三个任务"
  }), (error) => error.code === "INCOMPLETE_INDEPENDENT_GENERATION_PLAN");

  // Creating only two new branches must not be reported as three independent images.
  const onlyTwoBranches = plan([
    ...createBranch("俯视", 1),
    ...createBranch("仰视", 2)
  ], "已创建正视、俯视、仰视三个任务");
  assert.throws(() => actions.validatePlan(onlyTwoBranches, snapshot(), {
    userText: "为我创建正视、俯视、仰视三张独立图片"
  }), (error) => error.code === "INCOMPLETE_INDEPENDENT_GENERATION_PLAN");

  // Three complete prompt + generator + connection + submission branches are valid.
  const completeThreeBranches = plan([
    ...createBranch("正视", 1),
    ...createBranch("俯视", 2),
    ...createBranch("仰视", 3)
  ]);
  const validated = actions.validatePlan(completeThreeBranches, snapshot(), {
    userText: "请新建正视、俯视、仰视三张独立图片"
  });
  assert.equal(validated.operations.filter((operation) => operation.type === "create_prompt").length, 3);
  assert.equal(validated.operations.filter((operation) => operation.type === "create_generate").length, 3);
  assert.equal(validated.operations.filter((operation) => operation.type === "connect").length, 3);
  assert.equal(validated.operations.filter((operation) => operation.type === "submit_generation").length, 3);
  assert.equal(validated.requiresConfirmation, true);

  const realisticBranches = plan([
    ...createBranch("正视", 1),
    ...createBranch("俯视", 2),
    ...createBranch("仰视", 3)
  ]);
  const realisticPrompts = [
    "9:16 写实人像，人物身体正面朝向镜头，头部转向画面右侧，采用正面机位拍摄，保持身份、服装和场景一致。",
    "9:16 写实人像，人物身体正面朝向镜头，头部转向画面右侧，采用俯视拍摄角度，保持身份、服装和场景一致。",
    "9:16 写实人像，人物身体正面朝向镜头，头部转向画面右侧，采用仰视拍摄角度，保持身份、服装和场景一致。"
  ];
  realisticBranches.operations
    .filter((operation) => operation.type === "create_prompt")
    .forEach((operation, index) => { operation.args.prompt = realisticPrompts[index]; });
  const realisticValidated = actions.validatePlan(realisticBranches, snapshot(), {
    userText: "基于同一提示词创建正视/俯视/仰视三个生图任务"
  });
  assert.equal(realisticValidated.operations.filter((operation) => operation.type === "submit_generation").length, 3);

  const conflictingAngles = plan([
    ...createBranch("正视", 1),
    ...createBranch("俯视", 2),
    ...createBranch("仰视", 3)
  ]);
  conflictingAngles.operations.find((operation) => operation.id === "create-prompt-2").args.prompt =
    "同一主体，保留平视机位，同时改为俯视拍摄角度，保持身份、服装和场景一致";
  assert.throws(() => actions.validatePlan(conflictingAngles, snapshot(), {
    userText: "请新建正视、俯视、仰视三张独立图片"
  }), (error) => error.code === "INCOMPLETE_INDEPENDENT_GENERATION_PLAN");

  const planningAttempts = [];
  const repairedResult = await actions.requestAssistantPlan({
    getSnapshot: () => snapshot(),
    requestTextModel: ({ attempt }) => {
      planningAttempts.push(attempt);
      return attempt === "initial"
        ? plan([
          { type: "submit_generation", args: { nodeId: "generate-existing-front" } },
          ...createBranch("俯视", 2),
          ...createBranch("仰视", 3)
        ])
        : plan([
          ...createBranch("正视", 1),
          ...createBranch("俯视", 2),
          ...createBranch("仰视", 3)
        ]);
    }
  }, {
    userText: "请新建正视、俯视、仰视三张独立图片"
  });
  assert.deepEqual(planningAttempts, ["initial", "repair"]);
  assert.equal(repairedResult.repaired, true);
  assert.equal(repairedResult.repairedFrom, "INCOMPLETE_INDEPENDENT_GENERATION_PLAN");
  assert.equal(repairedResult.plan.operations.filter((operation) => operation.type === "submit_generation").length, 3);

  // Ordinary single-node retry/resubmission remains valid and is not treated as an incomplete batch.
  const retryExisting = actions.validatePlan(plan([
    {
      id: "retry-existing-front",
      type: "submit_generation",
      args: { nodeId: "generate-existing-front" }
    }
  ], "重新提交正视节点"), snapshot(), {
    userText: "请重试当前正视节点，再生成一张"
  });
  assert.equal(retryExisting.operations.length, 1);
  assert.equal(retryExisting.operations[0].args.nodeId, "generate-existing-front");
  assert.equal(retryExisting.operations[0].derived.generationMode, "text");

  const ordinarySingleBranch = actions.validatePlan(plan([
    ...createBranch("侧视", 1)
  ], "创建一个侧视任务"), snapshot(), {
    userText: "请新建一张侧视图片"
  });
  assert.equal(ordinarySingleBranch.operations.filter((operation) => operation.type === "submit_generation").length, 1);

  process.stdout.write("canvas assistant plan integrity tests passed\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
