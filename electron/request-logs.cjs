const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const DEFAULT_MAX_ITEMS = 50;
const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_TEXT_LENGTH = 200000;
const SENSITIVE_KEY = /(authorization|api[-_]?key|cookie|token|secret|signature|credential|password)/i;

function truncateText(value) {
  const text = String(value ?? "");
  if (text.length <= MAX_TEXT_LENGTH) return text;
  return `${text.slice(0, MAX_TEXT_LENGTH)}\n[TRUNCATED ${text.length - MAX_TEXT_LENGTH} CHARACTERS]`;
}

function sanitizeUrl(value) {
  const source = String(value || "");
  if (/^data:/i.test(source)) return "data:[embedded-image-omitted]";
  if (/^blob:/i.test(source)) return "blob:[local-object-url]";
  try {
    const parsed = new URL(source);
    parsed.username = "";
    parsed.password = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_KEY.test(key) || /^(x-amz-|x-oss-|sig$)/i.test(key)) {
        parsed.searchParams.set(key, "[REDACTED]");
      }
    }
    return parsed.toString();
  } catch {
    return source;
  }
}

function sanitizeValue(value, key = "", seen = new WeakSet()) {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    const text = truncateText(value)
      .replace(/Bearer\s+[A-Za-z0-9._~+\-/=]+/gi, "Bearer [REDACTED]")
      .replace(/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, "$1[REDACTED]");
    if (/^(https?:|data:|blob:)/i.test(text)) return sanitizeUrl(text);
    return text;
  }
  if (Buffer.isBuffer(value) || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return `[BINARY ${value.byteLength ?? value.length ?? 0} BYTES OMITTED]`;
  }
  if (typeof value !== "object") return truncateText(value);
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, "", seen));
  return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
    childKey,
    sanitizeValue(childValue, childKey, seen)
  ]));
}

function sanitizeBody(body) {
  if (body === undefined || body === null || body === "") return "";
  if (typeof body !== "string") return sanitizeValue(body);
  try {
    return sanitizeValue(JSON.parse(body));
  } catch {
    return sanitizeValue(body);
  }
}

function sanitizeRequest(input = {}) {
  const formDataEntries = Array.isArray(input.formDataEntries)
    ? input.formDataEntries.map((entry) => entry?.kind === "file" ? {
        name: entry.name,
        kind: "file",
        filename: entry.filename || "upload.bin",
        mimeType: entry.mimeType || "application/octet-stream",
        bytes: entry.data?.byteLength ?? entry.data?.length ?? 0
      } : {
        name: entry?.name,
        kind: "text",
        value: sanitizeValue(entry?.value, entry?.name)
      })
    : undefined;
  return sanitizeValue({
    url: sanitizeUrl(input.url),
    method: String(input.method || "GET").toUpperCase(),
    headers: input.headers || {},
    timeoutMs: Number(input.timeoutMs || 0),
    proxyRoute: String(input.proxyRoute || ""),
    retryIndex: Math.max(0, Number(input.retryIndex || 0)),
    body: sanitizeBody(input.body),
    ...(formDataEntries ? { formDataEntries } : {})
  });
}

function sanitizeResponse(input = {}) {
  return sanitizeValue({
    status: Number(input.status || 0),
    statusText: String(input.statusText || ""),
    headers: input.headers || {},
    body: sanitizeBody(input.body),
    durationMs: Number(input.durationMs || 0)
  });
}

function createRequestLogService({ dataRoot, now = () => Date.now(), maxItems = DEFAULT_MAX_ITEMS, maxAgeMs = DEFAULT_MAX_AGE_MS }) {
  const filePath = path.join(dataRoot, "request-logs.json");
  let operation = Promise.resolve();

  function runExclusive(callback) {
    const next = operation.then(callback, callback);
    operation = next.catch(() => {});
    return next;
  }

  async function readStore() {
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
      return { version: 1, updatedAt: parsed.updatedAt || "", items: Array.isArray(parsed.items) ? parsed.items : [] };
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return { version: 1, updatedAt: "", items: [] };
      throw error;
    }
  }

  function prune(store) {
    const cutoff = now() - maxAgeMs;
    store.items = store.items
      .filter((item) => {
        const timestamp = Date.parse(item.updatedAt || item.createdAt || 0);
        return Number.isFinite(timestamp) && timestamp >= cutoff;
      })
      .sort((left, right) => Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0))
      .slice(0, maxItems);
    return store;
  }

  async function writeStore(store) {
    await fs.mkdir(dataRoot, { recursive: true });
    const sanitized = prune(sanitizeValue(store));
    sanitized.version = 1;
    sanitized.updatedAt = new Date(now()).toISOString();
    const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(sanitized, null, 2)}\n`, "utf8");
    try {
      await fs.rename(tempPath, filePath);
    } catch (error) {
      if (!["EEXIST", "EPERM"].includes(error.code)) throw error;
      await fs.rm(filePath, { force: true });
      await fs.rename(tempPath, filePath);
    }
    return sanitized;
  }

  async function mutate(callback) {
    return runExclusive(async () => {
      const store = prune(await readStore());
      const result = await callback(store);
      await writeStore(store);
      return sanitizeValue(result);
    });
  }

  function ensureItem(store, id, seed = {}) {
    let item = store.items.find((candidate) => candidate.id === id);
    if (!item) {
      const timestamp = new Date(now()).toISOString();
      item = {
        id,
        taskId: Number(seed.taskId || 0),
        createdAt: seed.createdAt || timestamp,
        updatedAt: timestamp,
        status: seed.status || "running",
        config: sanitizeValue(seed.config || {}),
        attempts: [],
        downloads: [],
        result: null,
        error: null
      };
      store.items.unshift(item);
    }
    return item;
  }

  return {
    filePath,
    sanitizeValue,
    sanitizeRequest,
    sanitizeResponse,
    list: () => runExclusive(async () => {
      const before = await readStore();
      const originalCount = before.items.length;
      const store = prune(before);
      if (store.items.length !== originalCount) await writeStore(store);
      return sanitizeValue(store.items);
    }),
    clear: () => runExclusive(async () => {
      await writeStore({ version: 1, updatedAt: "", items: [] });
      return true;
    }),
    interruptRunning: () => mutate((store) => {
      const timestamp = new Date(now()).toISOString();
      let interrupted = 0;
      store.items.forEach((item) => {
        if (item.status !== "running") return;
        item.status = "interrupted";
        item.error = sanitizeValue({
          name: "InterruptedError",
          code: "app_restarted",
          status: 0,
          message: "程序已关闭或重新启动，任务请求被中断。",
          raw: ""
        });
        item.updatedAt = timestamp;
        interrupted += 1;
      });
      return interrupted;
    }),
    create: (input = {}) => mutate((store) => {
      const id = String(input.id || crypto.randomUUID());
      const item = ensureItem(store, id, input);
      item.taskId = Number(input.taskId || item.taskId || 0);
      item.status = String(input.status || item.status || "running");
      item.config = sanitizeValue(input.config || item.config || {});
      item.updatedAt = new Date(now()).toISOString();
      return item;
    }),
    update: (id, patch = {}) => mutate((store) => {
      const item = ensureItem(store, String(id), patch);
      const cleanPatch = sanitizeValue(patch);
      for (const key of ["status", "config", "result", "error"]) {
        if (Object.prototype.hasOwnProperty.call(cleanPatch, key)) item[key] = cleanPatch[key];
      }
      item.updatedAt = new Date(now()).toISOString();
      return item;
    }),
    startAttempt: (id, input = {}, seed = {}) => mutate((store) => {
      const item = ensureItem(store, String(id), seed);
      const requestId = String(input.requestId || crypto.randomUUID());
      item.attempts.push({
        requestId,
        startedAt: new Date(now()).toISOString(),
        completedAt: "",
        request: sanitizeRequest(input),
        response: null,
        error: null
      });
      item.updatedAt = new Date(now()).toISOString();
      return requestId;
    }),
    finishAttempt: (id, requestId, patch = {}) => mutate((store) => {
      const item = ensureItem(store, String(id));
      let attempt = item.attempts.find((candidate) => candidate.requestId === String(requestId));
      if (!attempt) {
        attempt = { requestId: String(requestId), startedAt: "", request: null, response: null, error: null };
        item.attempts.push(attempt);
      }
      attempt.completedAt = new Date(now()).toISOString();
      if (patch.response) attempt.response = sanitizeResponse(patch.response);
      if (patch.error) attempt.error = sanitizeValue(patch.error);
      item.updatedAt = new Date(now()).toISOString();
      return attempt;
    }),
    addDownload: (id, input = {}, seed = {}) => mutate((store) => {
      const item = ensureItem(store, String(id), seed);
      item.downloads.push(sanitizeValue({ ...input, url: sanitizeUrl(input.url) }));
      item.updatedAt = new Date(now()).toISOString();
      return item.downloads.at(-1);
    })
  };
}

module.exports = {
  DEFAULT_MAX_ITEMS,
  DEFAULT_MAX_AGE_MS,
  createRequestLogService,
  sanitizeBody,
  sanitizeUrl,
  sanitizeValue
};
