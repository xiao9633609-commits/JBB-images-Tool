(function (global) {
  "use strict";

  const PROMPT_TERM_PATTERN = /(?:提示词|提示語|提示语|prompt)/i;
  const PROMPT_AUTHORING_PATTERN = /(?:写|撰写|编写|创作|创建|生成|制作|设计|给|提供|整理|优化|润色|改写|重写|修改|调整|完善|扩写|精简|翻译)[^，。；！？\n]{0,28}(?:提示词|提示語|提示语|prompt)|(?:提示词|提示語|提示语|prompt)[^，。；！？\n]{0,20}(?:怎么写|如何写|写法|优化|润色|改写|重写|修改|调整|完善|扩写|精简|翻译)/i;
  const DIRECT_EXECUTION_PATTERN = /(?:^|[，。；！？\n])\s*(?:(?:请|请你|麻烦|劳驾|给我|替我|为我|帮我|可以帮我|能帮我|能不能帮我|我要|我需要)\s*)?(?:批量\s*)?(?:(?:现在|立即|马上|立刻|直接|开始|正式|执行)\s*)?(?:生成|生图|出图|出|做图|做|绘制|制作|创建|提交)[^，。；！？\n]{0,40}(?:图|图片|图像|画面|照片|海报|插画|头像|封面|效果图|任务)/i;
  const SHORT_EXECUTION_PATTERN = /(?:^|[，。；！？\n])\s*(?:现在|立即|马上|立刻|直接|开始|执行|提交)\s*(?:生成|生图|出图|做图|任务)(?:\s|$|[，。；！？])/i;
  const SEPARATE_IMAGE_EXECUTION_PATTERN = /(?:提示词|提示語|提示语|prompt)[^。；！？\n]{0,32}(?:(?:，|,)?\s*(?:然后|并且|并|再|之后|完成后|后)\s*)(?:(?:请|帮我|给我)\s*)?(?:(?:现在|立即|马上|立刻|直接|开始|正式|执行)\s*)?(?:生成|生图|出图|出|做图|做|绘制|制作|创建|提交)[^，。；！？\n]{0,32}(?:图|图片|图像|画面|照片|海报|插画|头像|封面|效果图|任务)|(?:生成|生图|出图|出|做图|做|绘制|制作|创建|提交)[^，。；！？\n]{0,32}(?:图|图片|图像|画面|照片|海报|插画|头像|封面|效果图|任务)[^。；！？\n]{0,24}(?:(?:，|,)?\s*(?:然后|并且|并|再|同时)\s*)[^。；！？\n]{0,24}(?:提示词|提示語|提示语|prompt)/i;
  const MULTI_SCOPE_PATTERN = /(?:批量|多张|多个(?:生图)?任务|多个镜头|组图|套图|系列图|九宫格|一组|一套|全套|全角度|几张|若干张|两张|俩张|[二三四五六七八九十百]\s*(?:张|幅|个(?:(?:生图)?任务|镜头|版本)?)|(?:[2-9]|[1-9]\d+)\s*(?:张|幅|个(?:(?:生图)?任务|镜头|版本)?))/i;

  function normalizeUserText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function hasPromptAuthoringIntent(userText) {
    const text = normalizeUserText(userText);
    return PROMPT_TERM_PATTERN.test(text) && PROMPT_AUTHORING_PATTERN.test(text);
  }

  function hasExplicitExecutionIntent(userText) {
    const text = normalizeUserText(userText);
    return DIRECT_EXECUTION_PATTERN.test(text) || SHORT_EXECUTION_PATTERN.test(text);
  }

  function hasExplicitMultiScope(userText) {
    return MULTI_SCOPE_PATTERN.test(normalizeUserText(userText));
  }

  function resolveAssistantRequestIntent(userText) {
    const text = normalizeUserText(userText);
    const promptAuthoring = hasPromptAuthoringIntent(text);
    const separateImageExecution = SEPARATE_IMAGE_EXECUTION_PATTERN.test(text);
    const explicitExecution = hasExplicitExecutionIntent(userText);
    const explicitMultiScope = hasExplicitMultiScope(userText);
    const promptOnly = promptAuthoring && !separateImageExecution;
    const explicitImageExecution = separateImageExecution || (!promptAuthoring && explicitExecution);
    return {
      promptOnly,
      explicitImageExecution,
      explicitBatchExecution: explicitImageExecution && explicitMultiScope
    };
  }

  function guardResult(userText, result) {
    const normalizedResult = result && typeof result === "object" ? result : {};
    const action = String(normalizedResult.action || "none");
    const tasks = Array.isArray(normalizedResult.tasks) ? normalizedResult.tasks : [];
    const revisedPrompt = String(normalizedResult.revisedPrompt || "").trim();
    const firstTaskPrompt = String(tasks[0]?.prompt || "").trim();
    const requestIntent = resolveAssistantRequestIntent(userText);

    let guardedAction = action;
    let guardedPrompt = revisedPrompt;
    let guardedTasks = tasks;
    let blockedReason = "";
    let guardedReply = String(normalizedResult.reply || "").trim();

    if (requestIntent.promptOnly && ["generate_image", "create_task_set"].includes(action)) {
      guardedPrompt = revisedPrompt || firstTaskPrompt;
      guardedAction = guardedPrompt ? "revise_prompt" : "none";
      guardedTasks = [];
      blockedReason = "prompt_authoring";
      guardedReply = guardedPrompt
        ? "已整理为单条提示词，不会自动创建生图任务。"
        : "这是提示词创作请求，但助手没有返回可应用的提示词，因此未创建任务。";
    } else if (action === "generate_image" && !requestIntent.explicitImageExecution) {
      guardedAction = revisedPrompt ? "revise_prompt" : "none";
      guardedTasks = [];
      blockedReason = "generation_not_explicit";
      guardedReply = revisedPrompt
        ? "已整理为单条提示词，但未检测到明确生图指令，因此未创建任务。"
        : "未检测到明确生图指令，因此没有创建任务。需要执行时请明确说“立即生成图片”。";
    } else if (action === "create_task_set" && !requestIntent.explicitBatchExecution) {
      guardedPrompt = revisedPrompt || firstTaskPrompt;
      guardedAction = requestIntent.explicitImageExecution && guardedPrompt
        ? "generate_image"
        : "none";
      guardedTasks = [];
      blockedReason = !requestIntent.explicitImageExecution ? "generation_not_explicit" : "multi_scope_not_explicit";
      guardedReply = requestIntent.explicitImageExecution
        ? guardedPrompt
          ? "已按明确的单图要求整理提示词，将只创建 1 个生图任务。"
          : "检测到明确的单图要求，但助手没有返回可用提示词，因此未创建任务。"
        : "这是组图讨论或意图仍不明确，因此未创建任务。需要执行时请明确说明立即生成，并给出数量或批量要求。";
      if (!requestIntent.explicitImageExecution) guardedPrompt = "";
    }

    return {
      ...normalizedResult,
      reply: guardedReply,
      action: guardedAction,
      revisedPrompt: guardedAction === "create_task_set" ? "" : guardedPrompt,
      tasks: guardedAction === "create_task_set" ? guardedTasks : [],
      intentGuard: {
        blocked: Boolean(blockedReason),
        reason: blockedReason,
        promptAuthoring: requestIntent.promptOnly,
        explicitExecution: requestIntent.explicitImageExecution,
        explicitMultiScope: requestIntent.explicitBatchExecution
      }
    };
  }

  const api = Object.freeze({
    resolveAssistantRequestIntent,
    hasPromptAuthoringIntent,
    hasExplicitExecutionIntent,
    hasExplicitMultiScope,
    guardResult
  });

  global.JBBPromptAssistantIntent = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
