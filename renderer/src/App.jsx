import React, { useEffect, useMemo, useState } from "react";
import {
  Activity, AlertTriangle, ArrowRight, Camera, Check, CheckCircle2, ChevronDown, CircleHelp,
  Download, FolderPlus, GitMerge, ImagePlus, ImageUp, Maximize2, Minus, MoreHorizontal,
  Paperclip, Pencil, RefreshCw, Settings2, Sparkles, Trash2, WandSparkles, X,
} from "lucide-react";

const seedTasks = [
  { id: "task_0003", status: "completed", model: "gpt-image-2", prompt: "银灰虎斑猫在瑞士网格工作室里整理一组灵感卡片，白底、红蓝批注", time: "刚刚", color: "linear-gradient(135deg,#dce9f3,#f4e1d3)" },
  { id: "task_0002", status: "completed", model: "banana-vision", prompt: "极简产品静物，金属材质与硬朗侧光，杂志封面构图", time: "12 分钟前", color: "linear-gradient(135deg,#e5ecdc,#f4edcf)" },
  { id: "task_0001", status: "failed", model: "grok-image", prompt: "建筑概念图，雨后街道与柔和霓虹反射", time: "昨天", color: "linear-gradient(135deg,#eadfe6,#dbe3ed)" },
];

const seedProjectId = "project_default";
const configStatusLabels = { configured: "已配置", unconfigured: "未配置", invalid: "异常配置" };
const defaultImageModels = ["gpt-image-2", "banana-vision", "grok-image"];
const defaultSettingsDraft = {
  apiBaseUrl: "金贝贝",
  apiMode: "compatible",
  apiKey: "",
  background: "auto",
  moderation: "auto",
  inputFidelity: "auto",
  responseWarning: "auto",
  requestTimeout: "auto",
  retryTransient: false,
};

function createSettingsDraft(settings = {}, connection = {}) {
  return {
    ...defaultSettingsDraft,
    apiBaseUrl: connection.baseUrl || settings.apiBaseUrl || "金贝贝",
    apiMode: settings.apiMode || "compatible",
    background: settings.background || "auto",
    moderation: settings.moderation || "auto",
    inputFidelity: settings.inputFidelity || "auto",
    responseWarning: settings.responseWarning || "auto",
    requestTimeout: settings.requestTimeout || "auto",
    retryTransient: Boolean(settings.retryTransient),
  };
}

function isLikelyImageModel(modelId) {
  return /(image|img|dall|flux|banana|grok|ideogram|recraft|midjourney)/i.test(String(modelId));
}

function createDefaultProject() {
  const now = new Date().toISOString();
  return { id: seedProjectId, name: "默认项目", color: "#8ab4f8", createdAt: now, updatedAt: now };
}

function evaluateConfigStatus(settings = {}) {
  if (settings.configStatus && Object.hasOwn(configStatusLabels, settings.configStatus)) return settings.configStatus;
  const endpoint = String(settings.apiBaseUrl || "").trim();
  const keyConfigured = Boolean(settings.apiKeyConfigured);
  if (!endpoint && !keyConfigured) return "unconfigured";
  if (endpoint && keyConfigured) return "configured";
  return "invalid";
}

function App() {
  const [theme, setTheme] = useState("light");
  const [activeView, setActiveView] = useState("workbench");
  const [projects, setProjects] = useState([]);
  const [activeProjectId, setActiveProjectId] = useState(seedProjectId);
  const [projectsReady, setProjectsReady] = useState(false);
  const [projectDialog, setProjectDialog] = useState(null);
  const [projectNameInput, setProjectNameInput] = useState("");
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeSelection, setMergeSelection] = useState([]);
  const [mergeTargetId, setMergeTargetId] = useState(seedProjectId);
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("gpt-image-2");
  const [availableModels, setAvailableModels] = useState(defaultImageModels);
  const [size, setSize] = useState("Auto");
  const [quality, setQuality] = useState("auto");
  const [format, setFormat] = useState("png");
  const [imageCount, setImageCount] = useState("3");
  const [customCount, setCustomCount] = useState(4);
  const [referenceCount, setReferenceCount] = useState(0);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [tasks, setTasks] = useState(seedTasks);
  const [tasksReady, setTasksReady] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [notice, setNotice] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsReady, setSettingsReady] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState(defaultSettingsDraft);
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [configStatus, setConfigStatus] = useState("unconfigured");
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.jbb?.window?.getState?.().then((state) => setMaximized(Boolean(state?.maximized))).catch(() => {});
  }, [theme]);

  useEffect(() => {
    const applyDensity = (metrics = {}) => {
      const logicalWidth = metrics.workAreaSize?.width || window.innerWidth;
      const logicalHeight = metrics.workAreaSize?.height || window.innerHeight;
      const scaleFactor = metrics.scaleFactor || window.devicePixelRatio || 1;
      const compact = logicalHeight < 900 || logicalWidth < 1440 || scaleFactor >= 1.25;
      document.documentElement.dataset.density = compact ? "compact" : "comfortable";
    };
    applyDensity();
    window.jbb?.window?.getMetrics?.().then(applyDensity).catch(() => {});
    window.jbb?.window?.onMetrics?.(applyDensity);
    window.addEventListener("resize", applyDensity, { passive: true });
    return () => window.removeEventListener("resize", applyDensity);
  }, []);

  useEffect(() => {
    const readJson = window.jbb?.storage?.readJson;
    if (!readJson) {
      const fallbackProject = createDefaultProject();
      setProjects([fallbackProject]);
      setActiveProjectId(fallbackProject.id);
      setProjectsReady(true);
      setTasksReady(true);
      setSettingsReady(true);
      return undefined;
    }
    const connectionPromise = window.jbb?.settings?.getConnection?.() || Promise.resolve({ baseUrl: "", apiKeyConfigured: false });
    Promise.all([
      readJson("projects.json", { schemaVersion: 1, projects: [] }),
      readJson("tasks.json", { schemaVersion: 1, tasks: [] }),
      readJson("settings.json", {}),
      connectionPromise,
    ]).then(([projectSnapshot, taskSnapshot, settingsSnapshot, connectionSnapshot]) => {
      const storedProjects = Array.isArray(projectSnapshot?.projects) ? projectSnapshot.projects.filter((project) => project?.id && project?.name) : [];
      const nextProjects = storedProjects.length ? storedProjects : [createDefaultProject()];
      const validProjectIds = new Set(nextProjects.map((project) => project.id));
      const fallbackProjectId = nextProjects[0].id;
      const nextTasks = Array.isArray(taskSnapshot?.tasks) ? taskSnapshot.tasks.map((task) => ({
        ...task,
        projectId: validProjectIds.has(task.projectId) ? task.projectId : fallbackProjectId,
        time: task.time || "历史记录",
        color: task.color || "linear-gradient(135deg,#dce9f3,#f4e1d3)",
      })) : [];
      setProjects(nextProjects);
      setActiveProjectId(fallbackProjectId);
      setTasks(nextTasks);
      const storedModel = settingsSnapshot?.model || settingsSnapshot?.defaultModel || "gpt-image-2";
      setModel(storedModel);
      setAvailableModels((current) => [...new Set([storedModel, ...current])]);
      setSize(settingsSnapshot?.size || settingsSnapshot?.defaultSize || "Auto");
      setQuality(settingsSnapshot?.quality || "auto");
      setFormat(settingsSnapshot?.outputFormat || "png");
      setTheme(settingsSnapshot?.themeMode === "dark" || settingsSnapshot?.themePreference === "dark" ? "dark" : "light");
      setSettingsDraft(createSettingsDraft(settingsSnapshot, connectionSnapshot));
      const nextKeyConfigured = Boolean(connectionSnapshot?.apiKeyConfigured || settingsSnapshot?.apiKeyConfigured);
      setApiKeyConfigured(nextKeyConfigured);
      setConfigStatus(evaluateConfigStatus({ apiBaseUrl: connectionSnapshot?.baseUrl || settingsSnapshot?.apiBaseUrl, apiKeyConfigured: nextKeyConfigured }));
    }).catch(() => {
      const fallbackProject = createDefaultProject();
      setProjects([fallbackProject]);
      setActiveProjectId(fallbackProject.id);
    }).finally(() => {
      setProjectsReady(true);
      setTasksReady(true);
      setSettingsReady(true);
    });
    return undefined;
  }, []);

  useEffect(() => {
    if (!projectsReady || !window.jbb?.storage?.writeJson) return;
    window.jbb.storage.writeJson("projects.json", { schemaVersion: 1, projects }).catch(() => {});
  }, [projects, projectsReady]);

  useEffect(() => {
    if (!tasksReady || !window.jbb?.storage?.writeJson) return;
    window.jbb.storage.writeJson("tasks.json", { schemaVersion: 1, tasks }).catch(() => {});
  }, [tasks, tasksReady]);

  const activeProject = useMemo(() => projects.find((project) => project.id === activeProjectId) || projects[0] || null, [projects, activeProjectId]);
  const projectTasks = useMemo(() => tasks.filter((task) => task.projectId === activeProject?.id), [tasks, activeProject]);
  const completedCount = useMemo(() => projectTasks.filter((task) => task.status === "completed").length, [projectTasks]);

  function showNotice(message) {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 2600);
  }

  function startGeneration() {
    if (!prompt.trim() || isGenerating) return;
    let projectId = activeProject?.id;
    if (!projectId) {
      const fallbackProject = createDefaultProject();
      projectId = fallbackProject.id;
      setProjects([fallbackProject]);
      setActiveProjectId(projectId);
    }
    const groupId = `group_${String(Date.now()).slice(-6)}`;
    const total = imageCount === "custom" ? Math.min(10, Math.max(1, Number(customCount) || 1)) : Number(imageCount);
    const ids = Array.from({ length: total }, (_, index) => `${groupId}_${index + 1}`);
    const palettes = ["linear-gradient(135deg,#dbeafe,#e0e7ff)", "linear-gradient(135deg,#e5ecdc,#f4edcf)", "linear-gradient(135deg,#eadfe6,#dbe3ed)"];
    setIsGenerating(true);
    setTasks((current) => [
      ...ids.map((id, index) => ({ id, projectId, groupId, groupIndex: index + 1, groupTotal: total, status: "running", model, prompt, size, quality, format, referenceCount, time: "正在生成", color: palettes[index % palettes.length] })),
      ...current,
    ]);
    window.setTimeout(() => {
      setTasks((current) => current.map((task) => ids.includes(task.id) ? { ...task, status: "completed", time: "刚刚" } : task));
      setIsGenerating(false);
      showNotice(`${total} 个任务已完成，结果已写入本地 output`);
    }, 1500);
  }

  function cycleSize() {
    const sizes = ["Auto", "1024 × 1024", "1536 × 1024", "1024 × 1536"];
    setSize((current) => sizes[(sizes.indexOf(current) + 1) % sizes.length]);
  }

  function handleReferenceFiles(event) {
    const count = Math.min(4, event.target.files?.length || 0);
    setReferenceCount(count);
    if (count) showNotice(`已添加 ${count} 张参考图`);
  }

  function retryTask(id) {
    setTasks((current) => current.map((task) => task.id === id ? { ...task, status: "running", time: "重试中" } : task));
    window.setTimeout(() => setTasks((current) => current.map((task) => task.id === id ? { ...task, status: "completed", time: "刚刚" } : task)), 900);
  }

  function deleteTask(id) {
    setTasks((current) => current.filter((task) => task.id !== id));
    showNotice("任务记录已移除");
  }

  function openNewProject() {
    setProjectNameInput("");
    setProjectDialog("create");
  }

  function openRenameProject() {
    if (!activeProject) return;
    setProjectNameInput(activeProject.name);
    setProjectDialog("rename");
  }

  function saveProjectName() {
    const name = projectNameInput.trim() || "未命名项目";
    if (projectDialog === "create") {
      const now = new Date().toISOString();
      const project = { id: `project_${Date.now()}`, name, color: "#f3a67a", createdAt: now, updatedAt: now };
      setProjects((current) => [...current, project]);
      setActiveProjectId(project.id);
      setActiveView("workbench");
      showNotice("项目已创建");
    } else if (projectDialog === "rename" && activeProject) {
      setProjects((current) => current.map((project) => project.id === activeProject.id ? { ...project, name, updatedAt: new Date().toISOString() } : project));
      showNotice("项目名称已更新");
    }
    setProjectDialog(null);
  }

  function openMergeProjects() {
    if (projects.length < 2) return;
    const initial = projects.filter((project) => project.id === activeProject?.id).map((project) => project.id);
    setMergeSelection(initial);
    setMergeTargetId(activeProject?.id || projects[0].id);
    setMergeOpen(true);
  }

  function confirmMergeProjects() {
    if (mergeSelection.length < 2) {
      showNotice("至少选择两个项目");
      return;
    }
    const targetId = mergeSelection.includes(mergeTargetId) ? mergeTargetId : mergeSelection[0];
    const selected = new Set(mergeSelection);
    setTasks((current) => current.map((task) => selected.has(task.projectId) ? { ...task, projectId: targetId } : task));
    setProjects((current) => current.filter((project) => project.id === targetId || !selected.has(project.id)));
    setActiveProjectId(targetId);
    setActiveView("workbench");
    setMergeOpen(false);
    showNotice("项目已合并");
  }

  async function saveSettings() {
    if (settingsSaving) return;
    setSettingsSaving(true);
    const endpoint = settingsDraft.apiBaseUrl.trim();
    const nextStatus = evaluateConfigStatus({ apiBaseUrl: endpoint, apiKeyConfigured: apiKeyConfigured || Boolean(settingsDraft.apiKey.trim()) });
    const nextKeyConfigured = apiKeyConfigured || Boolean(settingsDraft.apiKey.trim());
    const snapshot = {
      schemaVersion: 2,
      themeMode: theme,
      model,
      defaultModel: model,
      size,
      defaultSize: size,
      quality,
      outputFormat: format,
      apiMode: settingsDraft.apiMode,
      background: settingsDraft.background,
      moderation: settingsDraft.moderation,
      inputFidelity: settingsDraft.inputFidelity,
      responseWarning: settingsDraft.responseWarning,
      requestTimeout: settingsDraft.requestTimeout,
      retryTransient: settingsDraft.retryTransient,
      apiKeyConfigured: nextKeyConfigured,
      configStatus: nextStatus,
    };
    try {
      const writeSettings = window.jbb?.storage?.writeJson?.("settings.json", snapshot) || Promise.resolve();
      const writeConnection = window.jbb?.settings?.saveConnection?.({ baseUrl: endpoint, apiMode: settingsDraft.apiMode, apiKey: settingsDraft.apiKey }) || Promise.resolve({ baseUrl: endpoint, apiKeyConfigured: nextKeyConfigured });
      const [, savedConnection] = await Promise.all([writeSettings, writeConnection]);
      setApiKeyConfigured(Boolean(savedConnection?.apiKeyConfigured ?? nextKeyConfigured));
      setConfigStatus(nextStatus);
      setSettingsDraft((current) => ({ ...current, apiBaseUrl: savedConnection?.baseUrl || endpoint || "金贝贝", apiKey: "" }));
      setSettingsOpen(false);
      showNotice("连接与高级设置已保存");
    } catch (error) {
      showNotice(`设置保存失败：${error?.message || "未知错误"}`);
    } finally {
      setSettingsSaving(false);
    }
  }

  async function clearSettings() {
    try {
      await window.jbb?.settings?.clearLocal?.();
      setSettingsDraft(defaultSettingsDraft);
      setApiKeyConfigured(false);
      setConfigStatus("unconfigured");
      setModel("gpt-image-2");
      setAvailableModels(defaultImageModels);
      showNotice("本地连接与高级设置已清除");
    } catch (error) {
      showNotice(`清除失败：${error?.message || "未知错误"}`);
    }
  }

  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="brand drag-region">
          <img className="brand-mark" src="/jbb-icon.png" alt="金贝贝生图工具" />
          <div><strong>金贝贝生图工具</strong><span>JBBIMG · 0.2</span></div>
        </div>
        <div className="titlebar-context drag-region"><span className="status-dot" />{isGenerating ? "正在处理生成任务" : "本地工作台"}</div>
        <div className="window-actions no-drag">
          <button className="icon-btn" title="设置" onClick={() => setSettingsOpen(true)}><Settings2 size={16} /></button>
          <button className="icon-btn" title="最小化" onClick={() => window.jbb?.window?.minimize?.()}><Minus size={16} /></button>
          <button className="icon-btn" title={maximized ? "还原" : "最大化"} onClick={async () => { const state = await window.jbb?.window?.toggleMaximize?.(); setMaximized(Boolean(state?.maximized)); }}><Maximize2 size={15} /></button>
          <button className="icon-btn close" title="关闭" onClick={() => window.jbb?.window?.close?.()}><X size={16} /></button>
        </div>
      </header>

      <div className="content-shell">
        <aside className="sidebar">
          <div className="sidebar-label">创作工具</div>
          <button className={`tool-item ${activeView === "angle" ? "active" : ""}`} onClick={() => setActiveView("angle")}><Camera size={18} /><span>视角工具 <small>Beta</small></span></button>
          <button className={`tool-item ${activeView === "repair" ? "active" : ""}`} onClick={() => setActiveView("repair")}><ImageUp size={18} /><span>4K 高清修复工具</span></button>
          <div className="sidebar-divider" />
          <div className="sidebar-section-head"><div className="sidebar-label">工作列表</div><button className="sidebar-add-button" type="button" title="新建项目" aria-label="新建项目" onClick={openNewProject}><FolderPlus size={16} /></button></div>
          <div className="project-list">
            {projects.map((project) => <button key={project.id} className={`project-item ${activeProject?.id === project.id ? "active" : ""}`} type="button" onClick={() => { setActiveProjectId(project.id); setActiveView("workbench"); }}><span className="project-swatch" style={{ background: project.color || "#8ab4f8" }} /><span className="project-name">{project.name}</span><span className="project-count">{tasks.filter((task) => task.projectId === project.id).length}</span></button>)}
          </div>
          <div className="project-actions">
            <button className="project-action-button" type="button" title="重命名当前项目" onClick={openRenameProject} disabled={!activeProject}><Pencil size={14} />重命名</button>
            <button className="project-action-button" type="button" title="合并项目" onClick={openMergeProjects} disabled={projects.length < 2}><GitMerge size={14} />合并</button>
          </div>
          <div className="sidebar-bottom">
            <button className="nav-item" onClick={() => setSettingsOpen(true)}><Settings2 size={17} />配置与存储</button>
            <div className={`config-status-badge ${configStatus}`}><span className="status-dot" />{configStatusLabels[configStatus]}</div>
          </div>
        </aside>

        <main className="main-area">
          <div className="page-head">
            <div><div className="eyebrow">IMAGE GENERATION SYSTEM / JBBIMG 0.2</div><h1>{activeView === "workbench" ? (activeProject?.name || "默认项目") : activeView === "angle" ? "视角工具" : "4K 高清修复工具"}</h1><p>{activeView === "workbench" ? "当前项目的结果自动保存在本地。" : activeView === "angle" ? "在当前项目中组织多视角生成任务。" : "从当前项目选择图片，创建高清修复任务。"}</p></div>
            <div className="head-actions"><button className="quiet-btn" onClick={() => setTasks((current) => current.filter((task) => task.projectId !== activeProject?.id))} disabled={!projectTasks.length}><Trash2 size={15} />清空结果</button><button className="icon-btn bordered" title="功能说明"><CircleHelp size={16} /></button></div>
          </div>

          {activeView === "workbench" ? <>
            <section className="metric-strip"><div><span>已完成</span><strong>{completedCount}</strong></div><div><span>运行中</span><strong>{projectTasks.filter((task) => task.status === "running").length}</strong></div><div><span>当前项目</span><strong>{activeProject?.name || "默认项目"}</strong></div><div className="metric-note"><Activity size={15} />全部任务均由主进程管理</div></section>
            <section className="workspace-grid">
              <div className="results-column">
                <div className="section-head"><h2>任务记录</h2></div>
                <div className="task-list">{projectTasks.length ? projectTasks.map((task) => <TaskCard key={task.id} task={task} onRetry={retryTask} onDelete={deleteTask} />) : <div className="empty-state"><ImagePlus size={24} /><strong>还没有生成记录</strong><span>在底部输入提示词，开始第一张图。</span></div>}</div>
              </div>
              <aside className="assistant-panel"><div className="panel-head"><div><span className="eyebrow">ASSISTANT</span><h2>提示词助手</h2></div><button className="icon-btn"><MoreHorizontal size={17} /></button></div><div className="assistant-empty"><WandSparkles size={22} /><p>输入一个想法，助手会帮助你拆解主体、光线和构图。</p></div><button className="assistant-action" onClick={() => setPrompt("一张具有清晰主体、克制配色和明确光线方向的产品视觉图")}>生成提示词草稿 <ChevronDown size={15} /></button></aside>
            </section>
            <section className={`composer ${promptExpanded ? "is-expanded" : ""}`} aria-label="图片生成器">
              <div className="composer-prompt">
                <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="描述你想生成的图片..." maxLength={32000} aria-label="提示词" />
                <button className="prompt-expand-toggle" type="button" title={promptExpanded ? "收起提示词编辑框" : "展开全文编辑"} aria-label={promptExpanded ? "收起提示词编辑框" : "展开提示词编辑框"} onClick={() => setPromptExpanded((current) => !current)}><Maximize2 size={16} /></button>
              </div>
              <div className="composer-controls">
                <label className="composer-field"><span>生图模型</span><span className="field-control model-control"><Sparkles size={14} /><select value={model} onChange={(event) => setModel(event.target.value)}>{availableModels.map((modelId) => <option key={modelId} value={modelId}>{modelId}</option>)}</select><ChevronDown size={14} /></span></label>
                <label className="composer-field"><span>尺寸</span><button className="field-control" type="button" onClick={cycleSize}><span>{size}</span><ChevronDown size={14} /></button></label>
                <label className="composer-field"><span>质量</span><span className="field-control"><select value={quality} onChange={(event) => setQuality(event.target.value)}><option value="auto">自动 / 中转站决定</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select><ChevronDown size={14} /></span></label>
                <label className="composer-field"><span>格式</span><span className="field-control"><select value={format} onChange={(event) => setFormat(event.target.value)}><option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WebP</option></select><ChevronDown size={14} /></span></label>
                <label className="composer-field"><span>数量</span><span className="field-control"><select value={imageCount} onChange={(event) => setImageCount(event.target.value)}><option value="1">1 张</option><option value="2">2 张</option><option value="3">3 张</option><option value="custom">自定义</option></select><ChevronDown size={14} /></span>{imageCount === "custom" && <input className="custom-count" type="number" min="1" max="10" value={customCount} onChange={(event) => setCustomCount(event.target.value)} aria-label="自定义图片数量" />}</label>
                <div className="composer-actions"><input id="reference-files" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={handleReferenceFiles} /><button className={`attach-button ${referenceCount ? "has-files" : ""}`} type="button" title={referenceCount ? `已添加 ${referenceCount} 张参考图` : "上传参考图片"} aria-label="上传参考图片" onClick={() => document.getElementById("reference-files")?.click()}><Paperclip size={18} />{referenceCount > 0 && <span>{referenceCount}</span>}</button><button className="generate-button" type="button" title="生成图片" aria-label="生成图片" onClick={startGeneration} disabled={!prompt.trim() || isGenerating}>{isGenerating ? <RefreshCw className="spin" size={18} /> : <ArrowRight size={19} />}</button></div>
              </div>
            </section>
          </> : <section className="feature-placeholder tool-placeholder"><div className="placeholder-icon">{activeView === "angle" ? <Camera size={28} /> : <ImageUp size={28} />}</div><h2>{activeView === "angle" ? "视角工具 Beta" : "4K 高清修复工具"}</h2><p>当前项目：{activeProject?.name || "默认项目"}。工具产生的任务会继续归入当前项目。</p><button className="primary-btn" onClick={() => setActiveView("workbench")}>返回当前项目</button></section>}
        </main>
      </div>
      {settingsOpen && <SettingsDialog draft={settingsDraft} apiKeyConfigured={apiKeyConfigured} availableModels={availableModels} saving={settingsSaving} onChange={(patch) => setSettingsDraft((current) => ({ ...current, ...patch }))} onModelsLoaded={(models) => { const imageModels = models.filter(isLikelyImageModel); if (imageModels.length) { setAvailableModels(imageModels); if (!imageModels.includes(model)) setModel(imageModels[0]); } }} onClose={saveSettings} onClear={clearSettings} />}
      {projectDialog && <div className="modal-backdrop" onMouseDown={() => setProjectDialog(null)}><section className="settings-modal project-modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><span className="eyebrow">PROJECT</span><h2>{projectDialog === "create" ? "新建项目" : "修改项目名称"}</h2></div><button className="icon-btn" type="button" title="关闭" aria-label="关闭项目窗口" onClick={() => setProjectDialog(null)}><X size={17} /></button></div><label>项目名称<input autoFocus value={projectNameInput} maxLength={48} onChange={(event) => setProjectNameInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") saveProjectName(); }} placeholder="输入项目名称" /></label><button className="primary-btn full" type="button" onClick={saveProjectName}>{projectDialog === "create" ? "创建项目" : "保存名称"}</button></section></div>}
      {mergeOpen && <div className="modal-backdrop" onMouseDown={() => setMergeOpen(false)}><section className="settings-modal merge-modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><span className="eyebrow">PROJECT MERGE</span><h2>合并项目</h2></div><button className="icon-btn" type="button" title="关闭" aria-label="关闭合并窗口" onClick={() => setMergeOpen(false)}><X size={17} /></button></div><p className="modal-description">选择两个或多个项目，合并后任务会归入同一个项目。</p><div className="merge-project-list">{projects.map((project) => <label key={project.id} className="merge-project-option"><input type="checkbox" checked={mergeSelection.includes(project.id)} onChange={() => setMergeSelection((current) => current.includes(project.id) ? current.filter((id) => id !== project.id) : [...current, project.id])} /><span className="project-swatch" style={{ background: project.color || "#8ab4f8" }} /><span>{project.name}</span></label>)}</div><label>合并到<select value={mergeTargetId} onChange={(event) => setMergeTargetId(event.target.value)}>{projects.filter((project) => mergeSelection.includes(project.id)).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><button className="primary-btn full" type="button" disabled={mergeSelection.length < 2} onClick={confirmMergeProjects}>确认合并</button></section></div>}
      {notice && <div className="toast"><Check size={15} />{notice}</div>}
    </div>
  );
}

function SettingsDialog({ draft, apiKeyConfigured, availableModels, saving, onChange, onModelsLoaded, onClose, onClear }) {
  const [keyVisible, setKeyVisible] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [latency, setLatency] = useState(null);
  const [modelStatus, setModelStatus] = useState("读取全部模型后，生图模型会显示在生成框，对话模型会显示在提示词助手。");

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === "Escape" && !saving) {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, saving]);

  async function loadModels() {
    if (modelsLoading) return;
    setModelsLoading(true);
    setModelStatus("正在读取模型列表…");
    try {
      const result = await window.jbb?.settings?.listModels?.({ baseUrl: draft.apiBaseUrl, apiMode: draft.apiMode, apiKey: draft.apiKey });
      setLatency(Number.isFinite(result?.latencyMs) ? result.latencyMs : null);
      if (!result?.ok) {
        setModelStatus(result?.error || "模型列表读取失败，请检查连接配置。");
        return;
      }
      const models = Array.isArray(result.models) ? result.models : [];
      onModelsLoaded(models);
      const imageCount = models.filter(isLikelyImageModel).length;
      setModelStatus(models.length ? `已读取 ${models.length} 个模型，其中识别到 ${imageCount} 个生图模型。` : "接口返回成功，但没有识别到模型列表。");
    } catch (error) {
      setModelStatus(error?.message || "模型列表读取失败，请检查连接配置。");
    } finally {
      setModelsLoading(false);
    }
  }

  async function confirmClear() {
    if (!window.confirm("确定清除本地连接和高级参数吗？此操作不会删除生成图片和任务记录。")) return;
    await onClear();
    setLatency(null);
    setModelStatus("本地设置已清除，可重新填写连接信息。");
  }

  return <div className="modal-backdrop settings-backdrop" onMouseDown={() => { if (!saving) onClose(); }}>
    <section className="settings-modal connection-settings-modal" role="dialog" aria-modal="true" aria-labelledby="connection-settings-title" onMouseDown={(event) => event.stopPropagation()}>
      <header className="connection-settings-head">
        <h2 id="connection-settings-title">连接与高级设置</h2>
        <button className="settings-close-button" type="button" disabled={saving} onClick={onClose}>{saving ? "保存中" : "关闭"}</button>
      </header>
      <div className="connection-settings-body">
        <section className="settings-section" aria-labelledby="connection-section-title">
          <div className="settings-section-heading"><h3 id="connection-section-title">连接</h3><span>OpenAI Compatible</span></div>
          <div className="settings-field">
            <div className="settings-label-row"><label htmlFor="settings-base-url">中转站地址</label><span className="connection-latency" role="status">{latency == null ? "未检测" : `${latency} ms`}</span></div>
            <input id="settings-base-url" autoFocus value={draft.apiBaseUrl} onChange={(event) => onChange({ apiBaseUrl: event.target.value })} inputMode="url" autoComplete="url" spellCheck="false" placeholder="金贝贝或 https://example.com/v1" />
            <p>默认使用金贝贝国内站（https://cn.jbbt.cc/v1）；也可填写其他根地址或以 /v1 结尾的地址。</p>
          </div>
          <div className="settings-field">
            <label htmlFor="settings-api-mode">请求模式</label>
            <select id="settings-api-mode" value={draft.apiMode} onChange={(event) => { onChange({ apiMode: event.target.value }); setLatency(null); }}><option value="compatible">中转站兼容</option><option value="official">OpenAI 官方</option></select>
            <p>{draft.apiMode === "compatible" ? "兼容模式逐张请求；添加参考图后重复使用 image 字段上传。" : "官方模式按照 OpenAI 图像接口格式发送请求。"}</p>
          </div>
          <div className="settings-field">
            <label htmlFor="settings-api-key">生图 API Key（用户图像生成）</label>
            <div className="settings-key-wrap"><input id="settings-api-key" type={keyVisible ? "text" : "password"} value={draft.apiKey} onChange={(event) => onChange({ apiKey: event.target.value })} autoComplete="off" spellCheck="false" placeholder={apiKeyConfigured ? "已保存，输入新值可替换" : "sk-..."} /><button type="button" aria-controls="settings-api-key" aria-pressed={keyVisible} onClick={() => setKeyVisible((current) => !current)}>{keyVisible ? "隐藏" : "显示"}</button></div>
            <p>关闭窗口时以 .env 格式写入 data 目录，请妥善保护该文件。</p>
          </div>
          <div className="settings-field">
            <label>模型列表</label>
            <span className="settings-model-summary">默认生图 gpt-image-2 / 当前 {availableModels.length} 个生图模型</span>
            <button className="settings-secondary-button" type="button" disabled={modelsLoading} onClick={loadModels}>{modelsLoading ? "读取中…" : "读取模型"}</button>
            <p className="settings-model-status" role="status" aria-live="polite">{modelStatus}</p>
          </div>
        </section>

        <section className="settings-section advanced-settings-section" aria-labelledby="advanced-section-title">
          <div className="settings-section-heading"><h3 id="advanced-section-title">高级参数</h3><span>Optional</span></div>
          <div className="settings-parameter-grid">
            <div className="settings-field"><label htmlFor="settings-background">背景</label><select id="settings-background" value={draft.background} onChange={(event) => onChange({ background: event.target.value })}><option value="auto">自动</option><option value="opaque">不透明</option><option value="transparent">透明</option></select></div>
            <div className="settings-field"><label htmlFor="settings-moderation">内容审核</label><select id="settings-moderation" value={draft.moderation} onChange={(event) => onChange({ moderation: event.target.value })}><option value="auto">标准</option><option value="low">较低限制</option></select></div>
            <div className="settings-field"><label htmlFor="settings-fidelity">参考图保真度</label><select id="settings-fidelity" value={draft.inputFidelity} onChange={(event) => onChange({ inputFidelity: event.target.value })}><option value="auto">自动</option><option value="high">高</option><option value="low">低</option></select></div>
            <div className="settings-field"><label htmlFor="settings-warning">等待预警</label><select id="settings-warning" value={draft.responseWarning} onChange={(event) => onChange({ responseWarning: event.target.value })}><option value="auto">自动</option><option value="60000">1 分钟</option><option value="120000">2 分钟</option><option value="180000">3 分钟</option><option value="300000">5 分钟</option><option value="off">关闭</option></select></div>
            <div className="settings-field"><label htmlFor="settings-timeout">请求超时</label><select id="settings-timeout" value={draft.requestTimeout} onChange={(event) => onChange({ requestTimeout: event.target.value })}><option value="auto">自动</option><option value="300000">5 分钟</option><option value="480000">8 分钟</option><option value="600000">10 分钟</option><option value="900000">15 分钟</option></select></div>
          </div>
          <p className="settings-capability-note">Image2 的 size 是比例约束；宽 × 高只表示等价比例，不保证最终像素。</p>
          <label className="settings-checkbox"><input type="checkbox" checked={draft.retryTransient} onChange={(event) => onChange({ retryTransient: event.target.checked })} /><span>遇到 429 或 5xx 时延迟后重试一次</span></label>
          <p className="settings-helper">自动重试存在重复计费风险，默认关闭。</p>
          <p className="settings-helper">自动预警按默认分辨率、4K 分别在 3、5 分钟提醒检查中转站；自动超时分别在 8、10 分钟终止等待。</p>
        </section>
        <button className="clear-local-settings-button" type="button" onClick={confirmClear}>清除本地设置</button>
        <p className="settings-privacy-line">请求会发送到你填写的中转站。请只使用可信服务。</p>
      </div>
    </section>
  </div>;
}

function TaskCard({ task, onRetry, onDelete }) {
  const failed = task.status === "failed";
  const running = task.status === "running";
  return <article className={`task-card result-card ${failed ? "failed-task-card" : ""}`} aria-label={`${failed ? "生成失败" : "生成结果"}：${task.prompt}`}>
    <div className={`image-frame ${failed ? "failed-task-media" : ""}`} style={{ background: task.color }} role="button" tabIndex={0} aria-label="预览生成结果">
      <div className="preview-grid" />
      {failed ? <div className="failed-task-content"><span className="failed-task-icon">!</span><strong>生成失败</strong><span>{task.prompt}</span></div> : <div className="image-placeholder"><ImagePlus size={26} /><span>{running ? "正在生成" : "本地预览"}</span></div>}
      {running && <div className="preview-loader"><RefreshCw className="spin" size={18} /></div>}
      <span className="task-card-timer"><Activity size={11} />{task.time}</span>
      <button className="card-delete-button" type="button" title="删除任务" aria-label="删除任务" onClick={() => onDelete(task.id)}><X size={13} /></button>
    </div>
    <div className="task-card-info result-info">
      <div className="result-meta"><span className="result-model" title={task.model}>{task.model}</span><span className="result-size">1536 × 1024</span></div>
      <p className="revised-prompt" title={task.prompt}>提示词：{task.prompt}</p>
      <div className="result-card-actions">
        <button className="icon-btn" type="button" title="添加为参考图" aria-label="添加为参考图"><Paperclip size={15} /></button>
        {failed && <button className="icon-btn" type="button" title="立即重试" aria-label="立即重试" onClick={() => onRetry(task.id)}><RefreshCw size={15} /></button>}
        <button className="icon-btn" type="button" title="下载原图" aria-label="下载原图"><Download size={15} /></button>
        <button className="icon-btn" type="button" title="更多操作" aria-label="更多操作"><MoreHorizontal size={16} /></button>
      </div>
    </div>
  </article>;
}

export default App;
