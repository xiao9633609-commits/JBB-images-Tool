export const TASK_STATES = Object.freeze({
  DRAFT: "draft",
  QUEUED: "queued",
  RUNNING: "running",
  SAVING: "saving",
  COMPLETED: "completed",
  FAILED: "failed",
  RETRYING: "retrying",
  CANCELLED: "cancelled",
  INTERRUPTED: "interrupted",
});

const transitions = {
  draft: ["queued", "cancelled"],
  queued: ["running", "cancelled"],
  running: ["saving", "failed", "cancelled", "interrupted"],
  saving: ["completed", "failed", "interrupted"],
  failed: ["retrying", "cancelled"],
  retrying: ["running", "failed", "cancelled"],
  interrupted: ["retrying", "cancelled"],
  completed: [],
  cancelled: [],
};

export function canTransition(from, to) {
  return transitions[from]?.includes(to) ?? false;
}

export function transitionTask(task, nextStatus, patch = {}) {
  if (!canTransition(task.status, nextStatus)) {
    throw new Error(`非法任务状态转换：${task.status} -> ${nextStatus}`);
  }
  return { ...task, ...patch, status: nextStatus, updatedAt: new Date().toISOString() };
}

export function createTask(input = {}) {
  const now = new Date().toISOString();
  const id = input.id || `task_${Date.now()}`;
  return {
    schemaVersion: 1,
    id,
    groupId: input.groupId || id,
    kind: input.kind || "image-generation",
    status: "draft",
    model: input.model || "gpt-image-2",
    requestId: input.requestId || null,
    input: { prompt: "", references: [], size: "1536x1024", aspectRatio: "3:2", count: 1, ...input.input },
    outputs: [],
    failure: null,
    timing: {},
    createdAt: now,
    updatedAt: now,
  };
}
