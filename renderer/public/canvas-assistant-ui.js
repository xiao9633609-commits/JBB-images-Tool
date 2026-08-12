(function initJBBCanvasAssistantUI(global) {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const ICONS = Object.freeze({
    sparkles: [
      ["path", { d: "m12 3-1.35 3.65L7 8l3.65 1.35L12 13l1.35-3.65L17 8l-3.65-1.35Z" }],
      ["path", { d: "m5 14-.9 2.1L2 17l2.1.9L5 20l.9-2.1L8 17l-2.1-.9Z" }],
      ["path", { d: "m19 13-.9 2.1L16 16l2.1.9L19 19l.9-2.1L22 16l-2.1-.9Z" }]
    ],
    close: [["path", { d: "M6 6l12 12M18 6 6 18" }]],
    "chevron-left": [["path", { d: "m15 6-6 6 6 6" }]],
    "arrow-up": [["path", { d: "M12 19V5m0 0-5 5m5-5 5 5" }]],
    expand: [
      ["path", { d: "M15 3h6v6" }],
      ["path", { d: "M9 21H3v-6" }],
      ["path", { d: "m21 3-7 7" }],
      ["path", { d: "m3 21 7-7" }]
    ],
    collapse: [
      ["path", { d: "M4 14h6v6" }],
      ["path", { d: "M20 10h-6V4" }],
      ["path", { d: "m14 10 7-7" }],
      ["path", { d: "m3 21 7-7" }]
    ],
    send: [
      ["path", { d: "m21 3-7.6 18-3.7-7.7L2 9.6Z" }],
      ["path", { d: "M9.7 13.3 21 3" }]
    ],
    trash: [
      ["path", { d: "M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13" }]
    ],
    copy: [
      ["rect", { x: "8", y: "8", width: "11", height: "11", rx: "2" }],
      ["path", { d: "M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" }]
    ],
    check: [["path", { d: "m5 12 4 4L19 6" }]],
    cancel: [["path", { d: "M6 6l12 12M18 6 6 18" }]],
    nodes: [
      ["rect", { x: "3", y: "4", width: "7", height: "6", rx: "1" }],
      ["rect", { x: "14", y: "14", width: "7", height: "6", rx: "1" }],
      ["path", { d: "M10 7h4a3 3 0 0 1 3 3v4" }]
    ],
    folder: [
      ["path", { d: "M3 7.5V6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" }]
    ],
    alert: [
      ["path", { d: "M12 3 2.8 19h18.4Z" }],
      ["path", { d: "M12 9v4" }],
      ["path", { d: "M12 16h.01" }]
    ],
    retry: [
      ["path", { d: "M20 7v5h-5" }],
      ["path", { d: "M4 17v-5h5" }],
      ["path", { d: "M6.1 9a7 7 0 0 1 11.6-2L20 12M4 12l2.3 5a7 7 0 0 0 11.6-2" }]
    ]
  });

  let mounted = null;

  function createElement(tagName, className, text) {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function createIcon(name, className) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    if (className) svg.setAttribute("class", className);
    (ICONS[name] || ICONS.sparkles).forEach(([tagName, attributes]) => {
      const child = document.createElementNS(SVG_NS, tagName);
      Object.entries(attributes).forEach(([key, value]) => child.setAttribute(key, value));
      svg.appendChild(child);
    });
    return svg;
  }

  function createIconButton(iconName, label, className) {
    const button = createElement("button", className || "");
    button.type = "button";
    button.setAttribute("aria-label", label);
    button.title = label;
    button.appendChild(createIcon(iconName));
    return button;
  }

  function createBrandImage() {
    const image = createElement("img", "jbb-canvas-assistant__brand-image");
    image.src = "./jbb-assistant-icon.png";
    image.alt = "";
    image.draggable = false;
    image.setAttribute("aria-hidden", "true");
    return image;
  }

  function resolveHost(host) {
    if (host instanceof Element) return host;
    if (typeof host === "string") return document.querySelector(host);
    return null;
  }

  function normalizeSummary(value, fallback) {
    const text = String(value || "").trim();
    return text || fallback;
  }

  function invoke(callback, payload) {
    if (typeof callback !== "function") return;
    try {
      const result = callback(payload);
      if (result && typeof result.catch === "function") {
        result.catch(() => setError("操作没有完成，请重试。"));
      }
    } catch {
      setError("操作没有完成，请重试。");
    }
  }

  function buildContextRow(iconName, label, value) {
    const row = createElement("div", "jbb-canvas-assistant__context-row");
    row.appendChild(createIcon(iconName));
    const body = createElement("div", "jbb-canvas-assistant__context-copy");
    body.appendChild(createElement("span", "jbb-canvas-assistant__context-label", label));
    body.appendChild(createElement("strong", "jbb-canvas-assistant__context-value", value));
    row.appendChild(body);
    return row;
  }

  function renderEmptyMessages(container) {
    const empty = createElement("div", "jbb-canvas-assistant__empty");
    const icon = createElement("span", "jbb-canvas-assistant__empty-icon");
    icon.appendChild(createIcon("sparkles"));
    empty.appendChild(icon);
    empty.appendChild(createElement("strong", "", "告诉我你想怎样调整画布"));
    empty.appendChild(createElement("p", "", "我可以协助创建、连接、整理节点，并在提交任务前让你确认。"));
    container.appendChild(empty);
  }

  function formatMessageContent(message) {
    if (typeof message === "string") return message;
    if (!message || typeof message !== "object") return "";
    return String(message.content ?? message.text ?? message.message ?? "");
  }

  async function copyText(value) {
    const text = String(value || "");
    if (!text) return false;
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {}
    }
    const textarea = createElement("textarea");
    textarea.value = text;
    textarea.readOnly = true;
    textarea.style.position = "fixed";
    textarea.style.inset = "-9999px auto auto -9999px";
    document.body.appendChild(textarea);
    textarea.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {}
    textarea.remove();
    return copied;
  }

  function createMessageCopyButton(text) {
    const button = createIconButton("copy", "复制消息", "jbb-canvas-assistant__message-copy");
    let resetTimer = 0;
    ["pointerdown", "click", "copy"].forEach((eventName) => {
      button.addEventListener(eventName, (event) => event.stopPropagation());
    });
    button.addEventListener("click", async () => {
      const copied = await copyText(text);
      window.clearTimeout(resetTimer);
      button.replaceChildren(createIcon(copied ? "check" : "copy"));
      button.classList.toggle("is-copied", copied);
      button.setAttribute("aria-label", copied ? "已复制" : "复制失败");
      button.title = copied ? "已复制" : "复制失败";
      resetTimer = window.setTimeout(() => {
        button.replaceChildren(createIcon("copy"));
        button.classList.remove("is-copied");
        button.setAttribute("aria-label", "复制消息");
        button.title = "复制消息";
      }, 1400);
    });
    return button;
  }

  function setMessageExpanded(article, expanded) {
    const content = article?.querySelector(".jbb-canvas-assistant__message-content");
    const disclosure = article?.querySelector(".jbb-canvas-assistant__message-disclosure");
    if (!content || !disclosure) return;
    const nextExpanded = Boolean(expanded);
    article.classList.toggle("is-collapsed", !nextExpanded);
    article.dataset.messageExpanded = String(nextExpanded);
    disclosure.setAttribute("aria-expanded", String(nextExpanded));
    disclosure.setAttribute("aria-label", nextExpanded ? "收起这条消息" : "展开这条已折叠消息");
    disclosure.title = nextExpanded ? "收起消息" : "展开完整消息";
    disclosure.textContent = nextExpanded ? "收起" : "已折叠 · 展开";
  }

  function syncMessageDisclosures() {
    if (!mounted || !mounted.open) return;
    mounted.messageList.querySelectorAll("[data-message-collapse-candidate='true']").forEach((article) => {
      const content = article.querySelector(".jbb-canvas-assistant__message-content");
      const disclosure = article.querySelector(".jbb-canvas-assistant__message-disclosure");
      if (!content || !disclosure) return;
      const styles = global.getComputedStyle(content);
      const lineHeight = Number.parseFloat(styles.lineHeight);
      const paddingTop = Number.parseFloat(styles.paddingTop) || 0;
      const paddingBottom = Number.parseFloat(styles.paddingBottom) || 0;
      const fourLineHeight = (Number.isFinite(lineHeight) ? lineHeight * 4 : 0) + paddingTop + paddingBottom;
      const isLong = fourLineHeight > 0 && content.scrollHeight > fourLineHeight + 1;
      article.classList.toggle("is-collapsible", isLong);
      disclosure.hidden = !isLong;
      if (isLong) setMessageExpanded(article, article.dataset.messageExpanded === "true");
      else article.classList.remove("is-collapsed");
    });
  }

  function renderMessages(messages) {
    if (!mounted) return;
    const list = Array.isArray(messages) ? messages : [];
    mounted.messages = list.slice();
    mounted.messageList.replaceChildren();

    if (!list.length) {
      renderEmptyMessages(mounted.messageList);
      updateControls();
      return;
    }

    list.forEach((message, index) => {
      const item = typeof message === "object" && message ? message : { content: message };
      const role = ["user", "assistant", "system", "error"].includes(item.role) ? item.role : "assistant";
      const article = createElement("article", `jbb-canvas-assistant__message is-${role}`);
      const meta = createElement(
        "div",
        "jbb-canvas-assistant__message-meta",
        role === "user" ? "你" : role === "error" ? "执行失败" : role === "system" ? "画布状态" : "金贝贝 AI"
      );
      const messageText = formatMessageContent(item);
      const body = createElement("div", "jbb-canvas-assistant__message-body");
      const main = createElement("div", "jbb-canvas-assistant__message-main");
      const content = createElement("div", "jbb-canvas-assistant__message-content", messageText);
      const disclosure = createElement("button", "jbb-canvas-assistant__message-disclosure", "已折叠 · 展开");
      const collapseCandidate = index < list.length - 1;
      content.id = `jbb-canvas-assistant-message-${mounted.messageRenderToken}-${index}`;
      disclosure.type = "button";
      disclosure.hidden = true;
      disclosure.setAttribute("aria-controls", content.id);
      disclosure.setAttribute("aria-expanded", "false");
      disclosure.setAttribute("aria-label", "展开这条已折叠消息");
      disclosure.title = "展开完整消息";
      disclosure.addEventListener("click", () => {
        setMessageExpanded(article, disclosure.getAttribute("aria-expanded") !== "true");
      });
      main.append(content, disclosure);
      const copyButton = createMessageCopyButton(messageText);
      if (role === "user") body.append(copyButton, main);
      else body.append(main, copyButton);
      article.append(meta, body);
      article.dataset.messageCollapseCandidate = String(collapseCandidate);
      article.dataset.messageExpanded = "false";
      if (item.status) article.dataset.status = String(item.status);
      mounted.messageList.appendChild(article);
    });

    mounted.messageRenderToken += 1;
    mounted.messageList.scrollTop = mounted.messageList.scrollHeight;
    requestAnimationFrame(() => syncMessageDisclosures());
    updateControls();
  }

  function normalizeOperations(plan) {
    if (!plan || typeof plan !== "object") return [];
    if (!Array.isArray(plan.operations)) return [];
    return plan.operations
      .map((operation) => {
        if (typeof operation === "string") return operation.trim();
        if (!operation || typeof operation !== "object") return "";
        return String(operation.label ?? operation.description ?? operation.title ?? operation.type ?? "").trim();
      })
      .filter(Boolean);
  }

  function renderPlan(plan) {
    if (!mounted) return;
    mounted.plan = plan && typeof plan === "object" ? plan : null;
    mounted.planRegion.replaceChildren();
    mounted.planRegion.hidden = !mounted.plan;
    if (!mounted.plan) return;

    const card = createElement("section", "jbb-canvas-assistant__plan");
    const header = createElement("div", "jbb-canvas-assistant__plan-header");
    const heading = createElement("div", "jbb-canvas-assistant__plan-heading");
    heading.appendChild(createIcon("nodes"));
    heading.appendChild(createElement("strong", "", mounted.plan.title || "准备执行画布操作"));
    const status = createElement("span", "jbb-canvas-assistant__plan-status");
    const statusValue = mounted.plan.status || (mounted.plan.needsConfirmation === false ? "ready" : "confirm");
    status.dataset.status = statusValue;
    status.textContent = statusValue === "running"
      ? "执行中"
      : statusValue === "done"
        ? "已完成"
        : statusValue === "error"
          ? "失败"
          : mounted.plan.needsConfirmation === false
            ? "准备执行"
            : "待确认";
    header.append(heading, status);
    card.appendChild(header);

    if (mounted.plan.description) {
      card.appendChild(createElement("p", "jbb-canvas-assistant__plan-description", mounted.plan.description));
    }

    const operations = normalizeOperations(mounted.plan);
    if (operations.length) {
      const list = createElement("ol", "jbb-canvas-assistant__plan-list");
      operations.forEach((operation) => list.appendChild(createElement("li", "", operation)));
      card.appendChild(list);
    }

    if (mounted.plan.needsConfirmation !== false && !["running", "done"].includes(statusValue)) {
      const actions = createElement("div", "jbb-canvas-assistant__plan-actions");
      const cancel = createIconButton("cancel", "取消这次操作", "jbb-canvas-assistant__button is-secondary");
      cancel.appendChild(createElement("span", "", "取消"));
      const confirm = createIconButton("check", "确认执行画布操作", "jbb-canvas-assistant__button is-primary");
      confirm.appendChild(createElement("span", "", "确认执行"));
      cancel.disabled = mounted.busy || mounted.disabled;
      confirm.disabled = mounted.busy || mounted.disabled;
      cancel.addEventListener("click", () => invoke(mounted.options.onCancel, mounted.plan));
      confirm.addEventListener("click", () => invoke(mounted.options.onConfirm, mounted.plan));
      actions.append(cancel, confirm);
      card.appendChild(actions);
    }

    mounted.planRegion.appendChild(card);
  }

  function updateControls() {
    if (!mounted) return;
    const disabled = Boolean(mounted.disabled);
    const busy = Boolean(mounted.busy);
    mounted.input.disabled = disabled || busy;
    mounted.sendButton.disabled = disabled || busy || !mounted.input.value.trim();
    mounted.clearButton.disabled = disabled || busy || mounted.messages.length === 0;
    mounted.errorAction.disabled = disabled || busy;
    mounted.root.classList.toggle("is-disabled", disabled);
    mounted.root.classList.toggle("is-busy", busy);
    mounted.input.setAttribute("aria-busy", String(busy));
    mounted.busyBar.hidden = !busy;
    mounted.busyLabel.textContent = mounted.busyLabelText || "正在理解画布操作...";
    if (mounted.plan) renderPlan(mounted.plan);
  }

  function submitInput() {
    if (!mounted || mounted.disabled || mounted.busy) return;
    const value = mounted.input.value.trim();
    if (!value) return;
    invoke(mounted.options.onSend, value);
    if (mounted.options.clearInputOnSend !== false) {
      mounted.input.value = "";
      mounted.input.style.height = "";
    }
    updateControls();
  }

  function resizeInput() {
    if (!mounted) return;
    if (mounted.composerExpanded) {
      mounted.input.style.height = "";
      return;
    }
    mounted.input.style.height = "auto";
    mounted.input.style.height = `${Math.min(Math.max(mounted.input.scrollHeight, 104), 164)}px`;
  }

  function setComposerExpanded(expanded, focusInput = true) {
    if (!mounted) return;
    const nextExpanded = Boolean(expanded);
    mounted.composerExpanded = nextExpanded;
    mounted.composer.classList.toggle("is-expanded", nextExpanded);
    mounted.expandButton.setAttribute("aria-expanded", String(nextExpanded));
    mounted.expandButton.setAttribute("aria-label", nextExpanded ? "收起对话输入框" : "展开对话输入框");
    mounted.expandButton.title = nextExpanded ? "收起输入框（Esc）" : "展开输入框";
    mounted.expandButton.replaceChildren(createIcon(nextExpanded ? "collapse" : "expand"));
    resizeInput();
    if (focusInput && !mounted.input.disabled) mounted.input.focus({ preventScroll: true });
  }

  function setOpen(open, focusInput) {
    if (!mounted) return;
    const nextOpen = Boolean(open);
    if (mounted.open === nextOpen) return;
    mounted.open = nextOpen;
    mounted.root.classList.toggle("is-open", nextOpen);
    mounted.panel.hidden = !nextOpen;
    mounted.toggle.setAttribute("aria-expanded", String(nextOpen));
    mounted.toggle.setAttribute("aria-label", nextOpen ? "收起金贝贝 AI 画布助手" : "展开金贝贝 AI 画布助手");
    invoke(mounted.options.onOpenChange, nextOpen);
    requestAnimationFrame(() => {
      if (!mounted) return;
      if (nextOpen) syncMessageDisclosures();
      if (nextOpen && focusInput !== false && !mounted.input.disabled) mounted.input.focus();
      if (!nextOpen) mounted.toggle.focus();
    });
  }

  function setBusy(busy, label) {
    if (!mounted) return;
    mounted.busy = Boolean(busy);
    mounted.busyLabelText = String(label || "").trim();
    updateControls();
  }

  function setDisabled(disabled) {
    if (!mounted) return;
    mounted.disabled = Boolean(disabled);
    updateControls();
  }

  function setError(errorState) {
    if (!mounted) return;
    const state = errorState && typeof errorState === "object"
      ? errorState
      : { message: errorState };
    const value = String(state.message || "").trim();
    const actionLabel = String(state.actionLabel || "").trim();
    mounted.errorActionCallback = typeof state.onAction === "function" ? state.onAction : null;
    mounted.error.hidden = !value;
    mounted.errorText.textContent = value;
    mounted.errorAction.hidden = !value || !actionLabel || !mounted.errorActionCallback;
    mounted.errorActionLabel.textContent = actionLabel || "重试";
    mounted.errorAction.setAttribute("aria-label", actionLabel || "重试");
    mounted.errorAction.title = actionLabel || "重试";
    updateControls();
  }

  function setContext(context) {
    if (!mounted) return;
    const source = context && typeof context === "object" ? context : {};
    mounted.projectValue.textContent = normalizeSummary(source.project ?? source.projectName, "未选择项目");
    mounted.selectionValue.textContent = normalizeSummary(source.selection ?? source.selectionSummary, "未选择节点");
  }

  function mount(options) {
    const config = options && typeof options === "object" ? options : {};
    const host = resolveHost(config.host);
    if (!host) throw new Error("JBBCanvasAssistantUI.mount 需要有效的 host 元素");
    destroy();

    const root = createElement("div", "jbb-canvas-assistant");
    root.dataset.canvasAssistantUi = "true";

    const toggle = createElement("button", "jbb-canvas-assistant__toggle");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", "展开金贝贝 AI 画布助手");
    toggle.title = "金贝贝 AI 画布助手";
    const toggleIcon = createElement("span", "jbb-canvas-assistant__toggle-icon");
    toggleIcon.appendChild(createBrandImage());
    toggle.append(toggleIcon, createElement("span", "jbb-canvas-assistant__toggle-text", "金贝贝"));

    const panel = createElement("aside", "jbb-canvas-assistant__panel");
    panel.hidden = true;
    panel.setAttribute("aria-label", "金贝贝 AI 画布助手");

    const header = createElement("header", "jbb-canvas-assistant__header");
    const identity = createElement("div", "jbb-canvas-assistant__identity");
    const avatar = createElement("span", "jbb-canvas-assistant__avatar");
    avatar.appendChild(createBrandImage());
    const titleBlock = createElement("div", "jbb-canvas-assistant__title-block");
    titleBlock.appendChild(createElement("strong", "jbb-canvas-assistant__title", "金贝贝助手"));
    titleBlock.appendChild(createElement("span", "jbb-canvas-assistant__ai-label", "无限画布操作助手"));
    identity.append(avatar, titleBlock);
    const headerActions = createElement("div", "jbb-canvas-assistant__header-actions");
    const clearButton = createIconButton("trash", "清空对话", "jbb-canvas-assistant__icon-button");
    const closeButton = createIconButton("chevron-left", "收起助手", "jbb-canvas-assistant__icon-button");
    headerActions.append(clearButton, closeButton);
    header.append(identity, headerActions);

    const context = createElement("section", "jbb-canvas-assistant__context");
    context.setAttribute("aria-label", "当前画布上下文");
    const projectRow = buildContextRow("folder", "当前项目", normalizeSummary(config.projectSummary, "未选择项目"));
    const selectionRow = buildContextRow("nodes", "选中节点", normalizeSummary(config.selectionSummary, "未选择节点"));
    const projectValue = projectRow.querySelector(".jbb-canvas-assistant__context-value");
    const selectionValue = selectionRow.querySelector(".jbb-canvas-assistant__context-value");
    context.append(projectRow, selectionRow);

    const body = createElement("div", "jbb-canvas-assistant__body");
    const messageList = createElement("div", "jbb-canvas-assistant__messages");
    messageList.setAttribute("role", "log");
    messageList.setAttribute("aria-label", "对话记录");
    messageList.setAttribute("aria-live", "polite");
    messageList.setAttribute("aria-relevant", "additions text");
    messageList.tabIndex = 0;
    const planRegion = createElement("div", "jbb-canvas-assistant__plan-region");
    planRegion.hidden = true;
    body.append(messageList, planRegion);

    const busyBar = createElement("div", "jbb-canvas-assistant__busy");
    busyBar.hidden = true;
    busyBar.setAttribute("role", "status");
    const busyDots = createElement("span", "jbb-canvas-assistant__busy-dots");
    busyDots.append(createElement("i"), createElement("i"), createElement("i"));
    const busyLabel = createElement("span", "", "正在理解画布操作...");
    busyBar.append(busyDots, busyLabel);

    const error = createElement("div", "jbb-canvas-assistant__error");
    error.hidden = true;
    error.setAttribute("role", "alert");
    error.appendChild(createIcon("alert"));
    const errorText = createElement("span");
    const errorAction = createIconButton("retry", "重试", "jbb-canvas-assistant__error-action");
    const errorActionLabel = createElement("span", "", "重试");
    errorAction.appendChild(errorActionLabel);
    errorAction.hidden = true;
    error.append(errorText, errorAction);

    const composer = createElement("div", "jbb-canvas-assistant__composer");
    const input = createElement("textarea", "jbb-canvas-assistant__input");
    input.id = "jbb-canvas-assistant-input";
    input.rows = 2;
    input.placeholder = config.placeholder || "例如：创建一个 1:1 的生图节点，并连接选中的提示词";
    input.setAttribute("aria-label", "向金贝贝描述画布操作");
    const composerActions = createElement("div", "jbb-canvas-assistant__composer-actions");
    const modelPill = createElement("span", "jbb-canvas-assistant__model-pill");
    modelPill.append(createIcon("sparkles"), createElement("span", "", config.modelLabel || "沿用工作台对话模型"));
    const composerCommandActions = createElement("div", "jbb-canvas-assistant__composer-command-actions");
    const expandButton = createIconButton("expand", "展开对话输入框", "jbb-canvas-assistant__composer-expand");
    expandButton.setAttribute("aria-controls", input.id);
    expandButton.setAttribute("aria-expanded", "false");
    const sendButton = createIconButton("arrow-up", "发送给金贝贝", "jbb-canvas-assistant__send");
    composerCommandActions.append(expandButton, sendButton);
    composerActions.append(modelPill, composerCommandActions);
    composer.append(input, composerActions);
    const privacy = createElement("p", "jbb-canvas-assistant__privacy", "发送时会读取当前项目画布、选中节点和连接关系。");

    const footer = createElement("footer", "jbb-canvas-assistant__footer");
    footer.append(busyBar, error, composer, privacy);
    panel.append(header, context, body, footer);
    root.append(toggle, panel);
    host.appendChild(root);

    const handleDocumentKeydown = (event) => {
      if (!mounted || !mounted.open || event.key !== "Escape") return;
      if (event.defaultPrevented) return;
      if (mounted.composerExpanded) {
        event.preventDefault();
        setComposerExpanded(false);
        return;
      }
      setOpen(false);
    };

    mounted = {
      root,
      host,
      toggle,
      panel,
      closeButton,
      projectValue,
      selectionValue,
      messageList,
      planRegion,
      busyBar,
      busyLabel,
      error,
      errorText,
      errorAction,
      errorActionLabel,
      errorActionCallback: null,
      composer,
      input,
      expandButton,
      clearButton,
      sendButton,
      options: config,
      messages: [],
      messageRenderToken: 0,
      plan: null,
      open: false,
      busy: false,
      disabled: Boolean(config.disabled),
      composerExpanded: false,
      busyLabelText: "",
      handleDocumentKeydown
    };

    toggle.addEventListener("click", () => setOpen(!mounted.open));
    closeButton.addEventListener("click", () => setOpen(false));
    sendButton.addEventListener("click", submitInput);
    expandButton.addEventListener("pointerdown", (event) => event.preventDefault());
    expandButton.addEventListener("click", () => setComposerExpanded(!mounted.composerExpanded));
    clearButton.addEventListener("click", () => invoke(mounted.options.onClear));
    errorAction.addEventListener("click", () => invoke(mounted.errorActionCallback));
    root.addEventListener("pointerdown", (event) => event.stopPropagation());
    root.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
    root.addEventListener("contextmenu", (event) => event.stopPropagation());
    root.addEventListener("dragover", (event) => event.stopPropagation());
    root.addEventListener("drop", (event) => event.stopPropagation());
    input.addEventListener("input", () => {
      resizeInput();
      updateControls();
    });
    input.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && ["a", "c", "v", "x"].includes(event.key.toLowerCase())) {
        event.stopPropagation();
        return;
      }
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      submitInput();
    });
    ["copy", "cut", "paste"].forEach((eventName) => {
      input.addEventListener(eventName, (event) => event.stopPropagation());
    });
    document.addEventListener("keydown", handleDocumentKeydown);

    renderMessages(config.messages || []);
    if (config.plan) renderPlan(config.plan);
    setError(config.error || "");
    updateControls();
    resizeInput();
    if (config.open) setOpen(true, config.focusInputOnOpen !== false);
    return api;
  }

  function destroy() {
    if (!mounted) return;
    document.removeEventListener("keydown", mounted.handleDocumentKeydown);
    mounted.root.remove();
    mounted = null;
  }

  const api = Object.freeze({
    mount,
    setOpen,
    renderMessages,
    renderPlan,
    setBusy,
    setDisabled,
    setError,
    setContext,
    destroy
  });

  global.JBBCanvasAssistantUI = api;
})(window);
