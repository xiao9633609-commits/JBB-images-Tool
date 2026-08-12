(function initializeCanvasAssistantBridge(global) {
  "use strict";

  const OPERATION_LABELS = Object.freeze({
    create_prompt: "新建提示词节点",
    create_image: "新建参考图节点",
    create_generate: "新建生图节点",
    update_prompt: "修改提示词",
    update_generate: "修改生图参数",
    connect: "连接节点",
    disconnect: "断开连接",
    arrange: "整理画布",
    select: "选择节点",
    delete: "删除节点或连接",
    submit_generation: "提交生图任务"
  });

  const DISPLAY_MESSAGE_ROLES = new Set(["user", "assistant", "system", "error"]);
  const MODEL_MESSAGE_ROLES = new Set(["user", "assistant"]);
  const PLAN_PROTOCOL_ERROR_CODES = new Set([
    "EMPTY_MODEL_RESPONSE",
    "INVALID_MODEL_JSON",
    "INVALID_PLAN",
    "PLAN_FIELD_NOT_ALLOWED",
    "TOO_MANY_OPERATIONS",
    "INVALID_OPERATION",
    "OPERATION_FIELD_NOT_ALLOWED",
    "OPERATION_NOT_ALLOWED",
    "MISSING_OPERATION_ARGUMENT",
    "OPERATION_ARGUMENT_NOT_ALLOWED",
    "PROJECT_MISMATCH"
  ]);

  function cleanText(value, limit = 4000) {
    return String(value ?? "").trim().slice(0, limit);
  }

  function describeExecution(plan, result) {
    const operations = Array.isArray(plan?.operations) ? plan.operations : [];
    const createdPromptCount = operations.filter((operation) => operation.type === "create_prompt").length;
    const createdGenerateRefs = new Set(
      operations
        .filter((operation) => operation.type === "create_generate")
        .map((operation) => cleanText(operation.args?.clientRef, 100))
        .filter(Boolean)
    );
    const createdGenerateCount = operations.filter((operation) => operation.type === "create_generate").length;
    const submittedOperations = operations.filter((operation) => operation.type === "submit_generation");
    const reusedSubmissionCount = submittedOperations.filter((operation) => {
      const nodeRef = cleanText(operation.args?.nodeId, 240);
      const clientRef = nodeRef.startsWith("$") ? nodeRef.slice(1) : nodeRef;
      return !createdGenerateRefs.has(clientRef);
    }).length;
    const lines = [];
    if (createdPromptCount || createdGenerateCount) {
      lines.push(`本次新建 ${createdPromptCount} 个提示词节点、${createdGenerateCount} 个生图节点。`);
    }
    if (result.remoteSubmissions) {
      lines.push(`已提交 ${result.remoteSubmissions} 个生图任务。远程任务不能通过普通撤销取消。`);
      if (reusedSubmissionCount) {
        lines.push(`其中 ${reusedSubmissionCount} 个任务使用已有生图节点，节点中的历史结果会继续保留。`);
      }
    } else {
      lines.push("可使用撤销恢复本次本地修改。");
    }
    return lines;
  }

  function cloneMessages(messages) {
    return (Array.isArray(messages) ? messages : []).slice(-40).map((message) => ({
      role: DISPLAY_MESSAGE_ROLES.has(message?.role) ? message.role : "system",
      content: cleanText(message?.content ?? message?.text, 4000)
    })).filter((message) => message.content);
  }

  function getModelHistory(messages) {
    return (Array.isArray(messages) ? messages : [])
      .filter((message) => MODEL_MESSAGE_ROLES.has(message?.role))
      .slice(-8)
      .map((message) => ({ role: message.role, content: cleanText(message.content ?? message.text, 3000) }))
      .filter((message) => message.content);
  }

  function sanitizeDiagnosticText(value, limit = 1000) {
    return cleanText(value, limit)
      .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
      .replace(/((?:api[-_ ]?key|authorization|access[-_ ]?token|token|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
      .replace(/([?&](?:key|api_key|token|access_token)=)[^&#\s]+/gi, "$1[REDACTED]");
  }

  function createDiagnostic(error, phase) {
    return Object.freeze({
      source: "canvas-assistant",
      phase,
      code: sanitizeDiagnosticText(error?.code || "UNEXPECTED_ERROR", 120),
      name: sanitizeDiagnosticText(error?.name || "Error", 120),
      message: sanitizeDiagnosticText(error?.message || "Unknown error")
    });
  }

  function getUserError(error, phase) {
    const code = cleanText(error?.code, 120);
    if (phase === "planning") {
      if (code === "TEXT_MODEL_CONFIG_REQUIRED") {
        return "文本模型配置不完整，暂时无法生成操作计划。画布未修改，请检查工作台模型配置后重试。";
      }
      if (code === "TEXT_MODEL_REQUEST_FAILED" || error?.name === "TypeError") {
        return "连接文本模型失败，暂时无法生成操作计划。画布未修改，请检查网络或模型配置后重试。";
      }
      if (PLAN_PROTOCOL_ERROR_CODES.has(code) || /^(INVALID_|MISSING_|OPERATION_|PLAN_|NODE_|DUPLICATE_|REFERENCE_)/.test(code)) {
        return "助手生成的操作计划暂时无法执行。画布未修改，请重试。";
      }
      return "暂时无法生成画布操作计划。画布未修改，请重试。";
    }
    if (phase === "submission") {
      return "生图任务的提交状态暂时无法确认。请先检查任务列表，避免立即重复提交。";
    }
    if (code === "PROJECT_CHANGED") {
      return "画布状态已变化，本次计划没有执行。请重试生成新计划。";
    }
    return "画布操作未完整完成。系统已尝试恢复本地修改，请检查画布后重试。";
  }

  function createSession(options = {}) {
    const actions = options.actions || global.CanvasAssistantActions;
    const ui = options.ui || global.JBBCanvasAssistantUI;
    const adapter = options.adapter;
    if (!actions?.requestAssistantPlan || !actions?.executePlan) throw new Error("画布助手操作引擎未加载");
    if (!ui?.mount) throw new Error("画布助手界面模块未加载");
    if (!adapter) throw new Error("画布助手 adapter 未配置");

    let pendingPlan = null;
    let activeProjectId = "";
    let messages = [];
    let controller = null;
    let retryRequest = null;

    function getProjectId() {
      return cleanText(adapter.getCurrentProjectId?.(), 240);
    }

    function persistMessages() {
      if (activeProjectId) options.setMessages?.(activeProjectId, cloneMessages(messages));
    }

    function renderMessages() {
      ui.renderMessages(messages);
      persistMessages();
    }

    function appendMessage(role, content) {
      const text = cleanText(content);
      if (!text) return;
      messages.push({ role, content: text });
      if (messages.length > 40) messages = messages.slice(-40);
      renderMessages();
    }

    function reportError(error, phase, reportOptions = {}) {
      const diagnostic = createDiagnostic(error, phase);
      try {
        options.onDiagnostic?.(diagnostic);
      } catch {}
      global.console?.warn?.("[CanvasAssistant]", diagnostic);
      const canRetry = reportOptions.canRetry !== false && Boolean(retryRequest);
      ui.setError({
        message: getUserError(error, phase),
        actionLabel: canRetry ? "重试" : "",
        onAction: canRetry ? retryLastRequest : null
      });
    }

    function retryLastRequest() {
      if (!retryRequest || controller) return null;
      const request = {
        text: retryRequest.text,
        history: getModelHistory(retryRequest.history)
      };
      return send(request.text, { appendUser: false, history: request.history });
    }

    function renderPendingPlan(status = "confirm") {
      if (!pendingPlan) {
        ui.renderPlan(null);
        return;
      }
      const description = actions.summarizePlan(pendingPlan);
      ui.renderPlan({
        title: "准备执行画布操作",
        description,
        status,
        needsConfirmation: pendingPlan.requiresConfirmation,
        operations: pendingPlan.operations.map((operation) => ({
          type: operation.type,
          label: OPERATION_LABELS[operation.type] || operation.type
        }))
      });
    }

    async function execute(plan, confirmed) {
      ui.setBusy(true, plan.operations.some((operation) => operation.type === "submit_generation")
        ? "正在创建画布任务..."
        : "正在执行画布操作...");
      ui.setError("");
      renderPendingPlan("running");
      try {
        const result = await actions.executePlan(plan, adapter, { confirmed });
        if (result.status === "confirmation_required") {
          pendingPlan = plan;
          renderPendingPlan("confirm");
          return result;
        }
        pendingPlan = null;
        ui.renderPlan(null);
        const operationLines = plan.operations.map((operation, index) => (
          `${index + 1}. ${OPERATION_LABELS[operation.type] || operation.type}`
        ));
        appendMessage("system", [
          "画布操作已完成",
          actions.summarizePlan(plan),
          ...describeExecution(plan, result),
          ...operationLines
        ].filter(Boolean).join("\n"));
        retryRequest = null;
        options.onExecuted?.(result, plan);
        return result;
      } catch (error) {
        pendingPlan = null;
        ui.renderPlan(null);
        const submissionMayBeUncertain = plan.operations.some((operation) => operation.type === "submit_generation");
        reportError(error, submissionMayBeUncertain ? "submission" : "execution", { canRetry: !submissionMayBeUncertain });
        return null;
      } finally {
        ui.setBusy(false);
      }
    }

    async function send(userText, sendOptions = {}) {
      const text = cleanText(userText);
      if (!text || controller) return null;
      refresh();
      if (!activeProjectId) {
        ui.setError("请先进入一个画布项目");
        return null;
      }
      const requestHistory = Array.isArray(sendOptions.history)
        ? getModelHistory(sendOptions.history)
        : getModelHistory(messages);
      if (sendOptions.appendUser !== false) appendMessage("user", text);
      retryRequest = { text, history: requestHistory };
      pendingPlan = null;
      ui.renderPlan(null);
      ui.setBusy(true, "正在理解画布操作...");
      ui.setError("");
      controller = new AbortController();
      try {
        const result = await actions.requestAssistantPlan(adapter, {
          userText: text,
          history: requestHistory,
          signal: controller.signal
        });
        appendMessage("assistant", result.plan.reply || result.summary);
        if (!result.plan.operations.length) {
          retryRequest = null;
          return result;
        }
        pendingPlan = result.plan;
        if (pendingPlan.requiresConfirmation) {
          renderPendingPlan("confirm");
          return result;
        }
        return await execute(pendingPlan, true);
      } catch (error) {
        if (error?.name !== "AbortError") {
          reportError(error, "planning");
        }
        return null;
      } finally {
        controller = null;
        ui.setBusy(false);
      }
    }

    function refresh() {
      const nextProjectId = getProjectId();
      if (nextProjectId !== activeProjectId) {
        persistMessages();
        activeProjectId = nextProjectId;
        messages = cloneMessages(options.getMessages?.(activeProjectId));
        pendingPlan = null;
        retryRequest = null;
        ui.renderPlan(null);
        ui.setError("");
        renderMessages();
      }
      const context = adapter.getContext?.() || {};
      ui.setContext(context);
      ui.setDisabled(!activeProjectId);
    }

    ui.mount({
      host: options.host,
      messages,
      projectSummary: "当前画布",
      selectionSummary: "未选择节点",
      onSend: send,
      onClear: () => {
        messages = [];
        pendingPlan = null;
        retryRequest = null;
        ui.renderPlan(null);
        ui.setError("");
        renderMessages();
      },
      onConfirm: () => pendingPlan && execute(pendingPlan, true),
      onCancel: () => {
        pendingPlan = null;
        retryRequest = null;
        ui.renderPlan(null);
        ui.setError("");
        appendMessage("system", "已取消这次画布操作。");
      },
      onOpenChange: (open) => {
        if (open) refresh();
        options.onOpenChange?.(open);
      }
    });

    refresh();

    return Object.freeze({
      send,
      refresh,
      setOpen: ui.setOpen,
      getPendingPlan: () => pendingPlan,
      abort() {
        controller?.abort();
        controller = null;
        ui.setBusy(false);
      },
      destroy() {
        persistMessages();
        controller?.abort();
        controller = null;
        ui.destroy();
      }
    });
  }

  global.JBBCanvasAssistantBridge = Object.freeze({ createSession });
})(window);
