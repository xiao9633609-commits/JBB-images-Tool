const fs = require("node:fs/promises");

const DAY_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_SOURCE_ITEMS = 240;
const MAX_PROMPTHERO_DETAILS = 100;
const PROMPTHERO_PAGE_SIZE = 24;
const PROMPTHERO_MAX_PAGES = 5;
const MAX_DETAIL_CONCURRENCY = 4;
const YOUMIND_PAGE_SIZE = 18;
const YOUMIND_MAX_PAGES = 40;
const YOUMIND_EXPLORE_URL = "https://youmind.com/zh-CN/gpt-image-2-prompts/explore";
const YOUMIND_API_URL = "https://youmind.com/youmarketing-api/prompts";
const PROMPTHERO_FILTERS = Object.freeze({
  prompthero_chatgpt: { model: "ChatGPT Image" },
  prompthero_nano_banana: { model: "Nano Banana" },
  prompthero_midjourney: { model: "Midjourney" },
  prompthero_veo: { query: "veo", searchType: "hybrid" },
  prompthero_stable_diffusion: { model: "Stable Diffusion " },
  prompthero_photography: { category: "photography" },
  prompthero_anime: { category: "anime" },
  prompthero_fashion: { category: "fashion" },
  prompthero_architecture: { category: "architecture" }
});
const ALLOWED_HOSTS = new Set([
  "image.prompt123.cn", "public.prompt123.cn", "www.aiwind.org", "image.aiwind.org",
  "api.opennana.com", "opennana.com", "prompthub.xin", "www.prompthub.xin",
  "static.prompthub.xin", "aiart.pics", "www.aiart.pics", "img1.aiart.pics",
  "youmind.com", "www.youmind.com", "cms-assets.youmind.com", "prompthero.com",
  "www.prompthero.com", "cdn.prompthero.com", "prompthero.s3.amazonaws.com",
  "2slides.com", "www.2slides.com"
]);

const SOURCES = Object.freeze([
  { id: "prompt123", name: "Prompt123", url: "https://image.prompt123.cn/data/collections/gpt-image2.json", kind: "prompt123" },
  { id: "aiwind", name: "AIWind", url: "https://www.aiwind.org/", kind: "aiwind" },
  { id: "opennana", name: "OpenNana", url: "https://api.opennana.com/api/prompts?page=1&limit=40&sort=reviewed_at&order=DESC&access_type=0", kind: "opennana" },
  { id: "prompthub_gpt_image", name: "PromptHub GPT Image", url: "https://prompthub.xin/columns/gpt-image", kind: "prompthub" },
  { id: "aiart", name: "AIArt", url: "https://aiart.pics/", kind: "aiart" },
  { id: "youmind_gpt_image", name: "YouMind GPT Image 2", url: "https://youmind.com/zh-CN/gpt-image-2-prompts", kind: "youmind" },
  { id: "prompthero_chatgpt", name: "PromptHero ChatGPT", url: "https://prompthero.com/chatgpt-image-prompts", kind: "prompthero" },
  { id: "prompthero_nano_banana", name: "PromptHero Nano Banana", url: "https://prompthero.com/nano-banana-prompts", kind: "prompthero" },
  { id: "prompthero_midjourney", name: "PromptHero Midjourney", url: "https://prompthero.com/midjourney-prompts", kind: "prompthero" },
  { id: "prompthero_veo", name: "PromptHero Veo", url: "https://prompthero.com/veo-prompts", kind: "prompthero" },
  { id: "prompthero_stable_diffusion", name: "PromptHero Stable Diffusion", url: "https://prompthero.com/stable-diffusion-prompts", kind: "prompthero" },
  { id: "prompthero_photography", name: "PromptHero Photography", url: "https://prompthero.com/photography-prompts", kind: "prompthero" },
  { id: "prompthero_anime", name: "PromptHero Anime", url: "https://prompthero.com/anime-prompts", kind: "prompthero" },
  { id: "prompthero_fashion", name: "PromptHero Fashion", url: "https://prompthero.com/fashion-prompts", kind: "prompthero" },
  { id: "prompthero_architecture", name: "PromptHero Architecture", url: "https://prompthero.com/architecture-prompts", kind: "prompthero" },
  { id: "twoslides_gpt_image", name: "2Slides GPT Image 2", url: "https://2slides.com/zh-CN/products/gpt-image-2-prompts", kind: "twoslides" }
]);

function decodeText(value) {
  return String(value ?? "")
    .replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi, (_, token) => {
      const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
      if (named[token.toLowerCase()]) return named[token.toLowerCase()];
      const number = token[0].toLowerCase() === "x" ? parseInt(token.slice(1), 16) : parseInt(token.slice(1), 10);
      return Number.isFinite(number) ? String.fromCodePoint(number) : _;
    })
    .replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .trim();
}

function cleanPrompt(value) {
  let prompt = decodeText(value).replace(/\\(["'\\])/g, "$1").trim();
  prompt = prompt.replace(/\{argument\s+name\s*=\s*["']([^"']+)["']\s+default\s*=\s*["']([^"']*)["']\s*\}/gi, (_, name, fallback) => fallback || name);
  prompt = prompt.replace(/\{argument\s+name\s*=\s*["']([^"']+)["']\s*\}/gi, "$1");
  prompt = prompt.replace(/\[\[USE_REFERENCE_FACE_SKIN_HAIR\]\]/gi, "使用参考图中的面部、肤色和发型");
  prompt = prompt.replace(/\{argument\s+name\s*=.*$/gim, "");
  return prompt.replace(/[ \t]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
}

function category(text) {
  const value = String(text || "").toLowerCase();
  if (/portrait|fashion|beauty|character|人像|肖像|女孩|女性|男性|人物/.test(value)) return "portrait";
  if (/product|brand|food|commercial|material|产品|商品|品牌|美食|材质/.test(value)) return "product";
  if (/illustration|anime|comic|cartoon|3d|concept|插画|动漫|漫画|概念/.test(value)) return "illustration";
  if (/graphic|poster|logo|typography|平面|海报|标志|字体/.test(value)) return "graphic";
  return "scene";
}

function normalizeUrl(value, { upgradeHttp = false } = {}) {
  try {
    const url = new URL(String(value || ""));
    if (upgradeHttp && url.protocol === "http:") url.protocol = "https:";
    return url.protocol === "https:" ? url.href : "";
  } catch { return ""; }
}

function normalizeTimestamp(value) {
  if (value === undefined || value === null || value === "") return "";
  let input = value;
  if (typeof value === "number" || /^\d{10,13}$/.test(String(value))) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) input = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }
  const date = new Date(input);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function twitterSnowflakeTimestamp(value) {
  const statusId = /\/status\/(\d+)/.exec(String(value || ""))?.[1];
  if (!statusId) return "";
  try {
    const timestamp = Number((BigInt(statusId) >> 22n) + 1288834974657n);
    return normalizeTimestamp(timestamp);
  } catch { return ""; }
}

function compareFreshness(left, right) {
  const leftTime = Date.parse(left?.publishedAt || "") || 0;
  const rightTime = Date.parse(right?.publishedAt || "") || 0;
  if (leftTime !== rightTime) return rightTime - leftTime;
  const leftRank = left?.sourceRank !== null && left?.sourceRank !== undefined && Number.isFinite(Number(left.sourceRank)) ? Number(left.sourceRank) : Number.MAX_SAFE_INTEGER;
  const rightRank = right?.sourceRank !== null && right?.sourceRank !== undefined && Number.isFinite(Number(right.sourceRank)) ? Number(right.sourceRank) : Number.MAX_SAFE_INTEGER;
  if (leftRank !== rightRank) return leftRank - rightRank;
  return `${left?.sourceId || ""}${left?.title || ""}`.localeCompare(`${right?.sourceId || ""}${right?.title || ""}`);
}

function item({ id, sourceId, sourceName, sourceUrl, author, model, title, tags, cover, prompt, promptKind = "full", publishedAt = "", sourceRank }) {
  const cleanTitle = decodeText(title) || "未命名灵感";
  const cleanTags = (Array.isArray(tags) ? tags : []).map(decodeText).filter(Boolean).slice(0, 6);
  const clean = cleanPrompt(prompt);
  const normalizedRank = Number(sourceRank);
  return {
    id: String(id), sourceId, sourceName, sourceUrl: normalizeUrl(sourceUrl, { upgradeHttp: true }),
    author: decodeText(author) || sourceName, model: decodeText(model) || "未标注",
    category: category(`${cleanTitle} ${cleanTags.join(" ")}`), title: cleanTitle, tone: "Prompt gallery",
    tags: cleanTags.slice(0, 3), cover: normalizeUrl(cover, { upgradeHttp: true }), prompt: clean,
    promptKind, promptAvailable: Boolean(clean), publishedAt: normalizeTimestamp(publishedAt),
    sourceRank: Number.isFinite(normalizedRank) ? normalizedRank : null
  };
}

function createInspirationService({ dataRoot, logsRoot, onEvent, sources = SOURCES }) {
  const sourceList = Array.isArray(sources) && sources.length ? sources : SOURCES;
  let running = false;
  let controller = null;
  let timer = null;
  let promptHeroRequestChain = Promise.resolve();
  let lastState = { status: "idle", updatedAt: "", lastSuccessfulSyncAt: "", nextSyncAt: "", sourceStatuses: [] };
  const feedPath = `${dataRoot}/inspiration-feed.json`;
  const statePath = `${dataRoot}/inspiration-sync-state.json`;
  const logPath = `${logsRoot}/inspiration-sync.log`;
  const emit = (payload) => { lastState = { ...lastState, ...payload, updatedAt: new Date().toISOString() }; onEvent?.(lastState); };
  const writeAtomic = async (file, value) => { const temp = `${file}.${process.pid}.tmp`; await fs.writeFile(temp, JSON.stringify(value, null, 2), "utf8"); await fs.rename(temp, file); };
  const readJson = async (file, fallback) => { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; } };
  const previousFeed = async () => readJson(feedPath, { version: 3, updatedAt: "", items: [], sourceStatuses: [] });
  const previousItems = async (id) => (await previousFeed()).items.filter((entry) => entry?.sourceId === id);
  function assertAllowed(url) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !ALLOWED_HOSTS.has(parsed.hostname)) throw new Error("来源不在允许列表");
    return parsed.href;
  }
  async function fetchText(url, signal, headers = {}) {
    const requestController = new AbortController();
    const timerId = setTimeout(() => requestController.abort(), REQUEST_TIMEOUT_MS);
    const abort = () => requestController.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetch(assertAllowed(url), { signal: requestController.signal, headers: { "User-Agent": "Mozilla/5.0 JBBimg/0.3 InspirationSync", Accept: "text/html,application/xhtml+xml,application/json", ...headers } });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        const retryAfter = Number(response.headers.get("retry-after"));
        if (Number.isFinite(retryAfter)) error.retryAfterMs = Math.max(0, retryAfter * 1000);
        throw error;
      }
      return await response.text();
    } catch (error) {
      if (error.name === "AbortError") throw new Error("请求已取消或超时");
      throw error;
    } finally { clearTimeout(timerId); signal?.removeEventListener("abort", abort); }
  }
  async function fetchPromptHeroText(url, signal, headers = {}) {
    const request = promptHeroRequestChain.then(async () => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, attempt ? 5000 : 2200));
        try {
          return await fetchText(url, signal, headers);
        } catch (error) {
          if (error?.status !== 429 || attempt >= 3) throw error;
          const backoff = Math.max(error.retryAfterMs || 0, 12000 * (attempt + 1));
          await new Promise((resolve) => setTimeout(resolve, backoff));
        }
      }
      throw new Error("PromptHero 请求重试失败");
    });
    promptHeroRequestChain = request.catch(() => {});
    return request;
  }
  function decodeFlight(html) {
    return [...String(html).matchAll(/self\.__next_f\.push\(\[1,(?<payload>"(?:\\.|[^"\\])*")\]\)/g)]
      .map((match) => { try { return JSON.parse(match.groups.payload); } catch { return ""; } }).filter(Boolean).join("\n");
  }
  function flightRefValue(flight, reference) {
    if (!reference) return "";
    const referenceId = String(reference).replace(/^\$/, "");
    const marker = new RegExp(`(?:^|\\n)${referenceId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:T(?<length>[0-9a-f]+),`, "m").exec(flight);
    if (!marker) return "";
    const length = parseInt(marker.groups.length, 16); const bytes = Buffer.from(flight.slice(marker.index + marker[0].length), "utf8");
    return length > 0 && bytes.length >= length ? bytes.subarray(0, length).toString("utf8").trim() : "";
  }
  function extractJsonValueAfter(text, key) {
    const startAt = String(text).indexOf(key); if (startAt < 0) return null;
    let start = startAt + key.length; while (/[\s:]/.test(text[start] || "")) start++;
    const opening = text[start]; if (opening !== "[" && opening !== "{") return null;
    const closing = opening === "[" ? "]" : "}"; let depth = 0; let quote = false; let escaped = false;
    for (let i = start; i < text.length; i++) {
      const char = text[i];
      if (quote) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quote = false; continue; }
      if (char === '"') { quote = true; continue; }
      if (char === opening) depth++;
      else if (char === closing && --depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; } }
    }
    return null;
  }
  function htmlText(fragment) { return cleanPrompt(String(fragment || "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ")); }
  async function syncPrompt123(signal) {
    const payload = JSON.parse(await fetchText(SOURCES[0].url, signal));
    const records = Array.isArray(payload?.items) ? payload.items : Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
    const orderedRecords = records.filter((record) => record?.id && record?.title).sort((left, right) => Number(right.id) - Number(left.id));
    const items = orderedRecords.map((record, sourceRank) => item({ id: `prompt123-${record.id}`, sourceId: "prompt123", sourceName: "Prompt123", sourceUrl: new URL(String(record.url || ""), "https://image.prompt123.cn/").href, author: record.authorName, model: record.model, title: record.title, tags: record.labels, cover: new URL(String(record.coverThumb || ""), "https://public.prompt123.cn/").href, prompt: record.excerpt, promptKind: "excerpt", sourceRank }));
    if (!items.length) throw new Error("未返回有效记录"); return items;
  }
  async function syncAIWind(signal) {
    const old = await previousItems("aiwind"); const items = []; const seen = new Set();
    const consumeHtml = async (html) => {
      const matches = [...html.matchAll(/\{\\"id\\":(?<id>\d+),\\"slug\\":\\"(?<slug>.*?)\\"[\s\S]*?\\"sourceDisplayName\\":\\"(?<display>.*?)\\"\}/g)];
      let added = 0;
      for (const match of matches) {
        const id = `aiwind-${match.groups.id}`; if (seen.has(id)) continue; seen.add(id); const body = match[0];
        const value = (pattern) => pattern.exec(body)?.groups?.value || "";
        const title = decodeText(value(/\\"title\\":\\"(?<value>.*?)\\"/)); const image = value(/\\"images\\":\[\\"(?<value>.*?)\\"/); if (!title || !image) continue;
        const tagsBlock = value(/\\"sourceCategory\\":\[(?<value>.*?)\]/); const tags = [...tagsBlock.matchAll(/\\"(?<tag>.*?)\\"/g)].map((m) => decodeText(m.groups.tag.replace(/\\(.)/g, "$1")));
        let promptRaw = value(/\\"prompts_i18n\\":\{.*?\\"zh\\":\[\\"(?<value>.*?)\\"/s) || value(/\\"prompts\\":\[\\"(?<value>.*?)\\"/s); let prompt = cleanPrompt(promptRaw.replace(/\\(.)/g, "$1"));
        if (!prompt || /^\$[0-9a-z]+$/.test(promptRaw)) {
          const detail = await fetchText(`https://www.aiwind.org/prompt/${match.groups.slug}`, signal).catch(() => ""); const flight = decodeFlight(detail);
          const ref = /"prompts_i18n":\{.*?"zh":\["(?<ref>\$[0-9a-z]+)"/s.exec(flight)?.groups?.ref || /"prompts":\["(?<ref>\$[0-9a-z]+)"/s.exec(flight)?.groups?.ref;
          prompt = cleanPrompt(flightRefValue(flight, ref));
        }
        if (!prompt) prompt = cleanPrompt(old.find((entry) => entry.id === id && !/\{argument\s+name\s*=|^\$/.test(entry.prompt || ""))?.prompt || "");
        const cover = /^https?:/i.test(image) ? image : `https://image.aiwind.org/${image}`;
        items.push(item({ id, sourceId: "aiwind", sourceName: "AIWind", sourceUrl: `https://www.aiwind.org/prompt/${match.groups.slug}`, author: value(/\\"source\\":\{.*?\\"name\\":\\"(?<value>.*?)\\"/s).replace(/\\(.)/g, "$1"), model: value(/\\"model\\":\\"(?<value>.*?)\\"/).replace(/\\(.)/g, "$1"), title, tags, cover, prompt, publishedAt: value(/\\"createdAt\\":\\"(?<value>.*?)\\"/) || value(/\\"updatedAt\\":\\"(?<value>.*?)\\"/), sourceRank: -Number(match.groups.id) })); added++;
      }
      return added;
    };
    await consumeHtml(await fetchText(SOURCES[1].url, signal));
    const sitemap = await fetchText("https://www.aiwind.org/sitemap.xml", signal);
    const detailUrls = [...sitemap.matchAll(/<loc>(https:\/\/www\.aiwind\.org\/prompt\/[^<]+)<\/loc>/g)].map((match) => decodeText(match[1])).filter((url) => !items.some((entry) => entry.sourceUrl === url)).slice(0, MAX_SOURCE_ITEMS - items.length);
    let cursor = 0; const worker = async () => { while (cursor < detailUrls.length && items.length < MAX_SOURCE_ITEMS) { const url = detailUrls[cursor++]; try { await consumeHtml(await fetchText(url, signal)); } catch (error) { if (error.message.includes("取消")) throw error; } } };
    await Promise.all(Array.from({ length: Math.min(MAX_DETAIL_CONCURRENCY, detailUrls.length || 1) }, worker));
    if (!items.length) throw new Error("未返回有效记录"); return items;
  }
  async function syncOpenNana(signal) {
    const old = await previousItems("opennana"); const items = []; const records = [];
    for (let page = 1; page <= 12 && records.length < MAX_SOURCE_ITEMS; page++) {
      const payload = JSON.parse(await fetchText(`https://api.opennana.com/api/prompts?page=${page}&limit=40&sort=reviewed_at&order=DESC&access_type=0`, signal));
      const batch = Array.isArray(payload?.data?.items) ? payload.data.items : []; if (!batch.length) break; records.push(...batch); if (batch.length < 40) break;
    }
    const queue = records.filter((record) => record?.slug).slice(0, MAX_SOURCE_ITEMS); let cursor = 0;
      const worker = async () => { while (cursor < queue.length) { const record = queue[cursor++]; try { const detail = (await JSON.parse(await fetchText(`https://api.opennana.com/api/prompts/${encodeURIComponent(record.slug)}`, signal)))?.data; if (!detail || Number(detail.access_type) !== 0) continue; const prompts = Array.isArray(detail.prompts) ? detail.prompts : []; const preferred = prompts.find((prompt) => prompt?.type === "zh" || /中文/.test(String(prompt?.label || ""))) || prompts[0]; const cover = detail.cover_image || record.cover_image || detail.images?.[0]; const title = detail.title || record.title; if (!title || !cover) continue; items.push(item({ id: `opennana-${detail.id}`, sourceId: "opennana", sourceName: "OpenNana", sourceUrl: `https://opennana.com/awesome-prompt-gallery/${record.slug}`, author: detail.source_name, model: detail.model, title, tags: detail.tags, cover, prompt: preferred?.text || old.find((entry) => entry.id === `opennana-${detail.id}`)?.prompt || "", publishedAt: detail.reviewed_at || detail.reviewedAt || detail.published_at || detail.publishedAt || detail.created_at || detail.createdAt || record.reviewed_at || record.created_at, sourceRank: records.indexOf(record) })); } catch (error) { if (error.message.includes("取消")) throw error; } } };
    await Promise.all(Array.from({ length: Math.min(MAX_DETAIL_CONCURRENCY, queue.length || 1) }, worker)); if (!items.length) throw new Error("未返回有效记录"); return items;
  }
  async function syncPromptHub(signal) {
    const source = sourceList.find((entry) => entry.kind === "prompthub") || SOURCES[3]; const records = []; const seen = new Set(); const baseTags = "gptimage2,gpt-image2,gpt-image-2,gptimage,gpt-image,openai-image,chatgpt";
    for (let page = 1; page <= 5 && records.length < 100; page++) {
      const query = new URLSearchParams({ baseTags, page: String(page), limit: "20", sortBy: "newest" });
      const payload = JSON.parse(await fetchText(`https://prompthub.xin/api/prompts/public?${query}`, signal, { Accept: "application/json" }));
      const batch = Array.isArray(payload?.data) ? payload.data : []; if (!batch.length) break;
      batch.forEach((record) => { const id = String(record?.id || ""); if (id && !seen.has(id)) { seen.add(id); records.push(record); } });
      if (!payload?.pagination?.hasNext) break;
    }
    if (!records.length) {
      const html = await fetchText(source.url, signal); const flight = decodeFlight(html);
      records.push(...(extractJsonValueAfter(flight, '"initialPrompts"') || []));
    }
      const items = records.slice(0, 100).map((record, sourceRank) => item({ id: `${source.id}-${record.id}`, sourceId: source.id, sourceName: source.name, sourceUrl: normalizeUrl(record.url || record.sourceUrl || source.url) || source.url, author: record.authorName || record.author?.name || record.author, model: record.model || "GPT Image 2", title: record.title, tags: record.tags || record.labels, cover: record.featured_image || record.images?.[0]?.url || record.images?.[0]?.thumb, prompt: record.content || record.prompt || record.description, publishedAt: record.createdAt || record.created_at || record.publishedAt || record.published_at, sourceRank }));
    if (!items.length) throw new Error("未返回有效记录"); return items;
  }
  async function syncAiArt(signal) {
    const source = SOURCES[4]; const items = []; const records = [];
    for (let offset = 0; offset < MAX_SOURCE_ITEMS; offset += 50) {
      const payload = JSON.parse(await fetchText(`https://aiart.pics/api/prompts?sort=newest&limit=50&offset=${offset}`, signal)); const batch = Array.isArray(payload?.prompts) ? payload.prompts : []; if (!batch.length) break;
      records.push(...batch); if (batch.length < 50 || records.length >= MAX_SOURCE_ITEMS) break;
    }
      let cursor = 0; const worker = async () => { while (cursor < records.length) { const record = records[cursor++]; const detail = (await JSON.parse(await fetchText(`https://aiart.pics/api/prompts/${encodeURIComponent(record.id)}`, signal).catch(() => "{}")))?.data || record; const title = typeof detail.title === "object" ? detail.title.zh || detail.title.en : detail.title; const prompt = Array.isArray(detail.prompts) ? detail.prompts.filter(Boolean).join("\n\n") : detail.prompt || detail.description; const imageRecord = detail.images?.[0] || record.images?.[0]; const videoRecord = detail.videos?.[0] || record.videos?.[0]; const imagePath = imageRecord?.path || imageRecord?.url || (typeof imageRecord === "string" ? imageRecord : "") || videoRecord?.cover; const image = /^https?:/i.test(String(imagePath || "")) ? imagePath : imagePath ? `https://img1.aiart.pics/${String(imagePath).replace(/^\/+/, "")}` : ""; items.push(item({ id: `aiart-${detail.id}`, sourceId: source.id, sourceName: source.name, sourceUrl: `https://aiart.pics/?prompt=${encodeURIComponent(detail.id)}`, author: detail.author?.name, model: detail.model, title, tags: detail.tags, cover: image, prompt, publishedAt: detail.publishedAt || detail.createdAt || record.publishedAt || record.createdAt, sourceRank: records.indexOf(record) })); } };
    await Promise.all(Array.from({ length: Math.min(MAX_DETAIL_CONCURRENCY, records.length || 1) }, worker));
    if (!items.length) throw new Error("未返回有效记录"); return items;
  }
  function parseImageSrc(tag, baseUrl = "") {
    const srcSet = /\ssrcset="([^"]+)"/i.exec(tag)?.[1] || "";
    const src = /\ssrc="([^"]+)"/i.exec(tag)?.[1] || "";
    const firstSrcSetUrl = /^\s*(.+?)\s+\d+(?:w|x)(?:,|$)/i.exec(srcSet)?.[1] || srcSet;
    const candidates = [firstSrcSetUrl, src].filter(Boolean);
    for (const candidate of candidates) {
      let decoded = candidate.replace(/&amp;/g, "&");
      try { decoded = decodeURIComponent(decoded); } catch {}
      const embeddedAbsolute = /https?:\/\/[^\s"']+/i.exec(decoded)?.[0];
      if (embeddedAbsolute) return embeddedAbsolute;
      if (baseUrl) { try { return new URL(decoded, baseUrl).href; } catch {} }
    }
    return "";
  }
  async function fetchYouMindText(url, signal, { method = "GET", body = "", cookie = "" } = {}) {
    const requestController = new AbortController();
    const timerId = setTimeout(() => requestController.abort(), REQUEST_TIMEOUT_MS);
    const abort = () => requestController.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetch(assertAllowed(url), {
        method,
        body: body || undefined,
        signal: requestController.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
          Accept: "application/json, text/plain, */*",
          Origin: "https://youmind.com",
          Referer: YOUMIND_EXPLORE_URL,
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
          ...(cookie ? { Cookie: cookie } : {})
        }
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return { text: await response.text(), headers: response.headers };
    } catch (error) {
      if (error.name === "AbortError") throw new Error("请求已取消或超时");
      throw error;
    } finally {
      clearTimeout(timerId);
      signal?.removeEventListener("abort", abort);
    }
  }
  function getResponseCookieHeader(headers) {
    const values = typeof headers?.getSetCookie === "function"
      ? headers.getSetCookie()
      : [headers?.get?.("set-cookie")].filter(Boolean);
    return values.map((value) => String(value).split(";", 1)[0]).filter(Boolean).join("; ");
  }
  function youMindRecordToItem(record, source, sourceRank) {
    const id = String(record?.id || "").trim();
    const slug = String(record?.slug || "").trim();
    if (!id || !slug) return null;
    const categoryTags = (Array.isArray(record?.promptCategories) ? record.promptCategories : [])
      .map((entry) => typeof entry === "string" ? entry : entry?.name || entry?.label || entry?.slug)
      .filter(Boolean);
    const author = typeof record?.author === "string" ? record.author : record?.author?.name;
    return item({
      id: `youmind_gpt_image-${id}`,
      sourceId: source.id,
      sourceName: source.name,
      sourceUrl: new URL(`/zh-CN/prompts/${slug}-${id}`, source.url).href,
      author,
      model: "GPT Image 2",
      title: record.title || record.description,
      tags: ["GPT Image 2", ...categoryTags],
      cover: record.media?.[0] || record.mediaThumbnails?.[0],
      prompt: record.translatedContent || record.content || record.description,
      publishedAt: record.sourcePublishedAt,
      sourceRank
    });
  }
  async function syncYouMindLandingFallback(source, signal) {
    const html = await fetchText(source.url, signal); const items = []; const cards = [...html.matchAll(/data-id="(?<id>\d+)"[\s\S]*?<img(?<img>[^>]+)>[\s\S]*?<a[^>]+href="(?<href>\/zh-CN\/prompts\/[^\"]+)"/g)];
    const publishedById = new Map([...html.matchAll(/\\"id\\":(?<id>\d+),[\s\S]{0,1600}?\\"sourcePublishedAt\\":\\"(?<publishedAt>[^"\\]+)\\"/g)].map((match) => [match.groups.id, match.groups.publishedAt]));
    let cursor = 0; const worker = async () => { while (cursor < Math.min(cards.length, MAX_SOURCE_ITEMS)) { const sourceRank = cursor; const card = cards[cursor++]; const detailUrl = new URL(card.groups.href, source.url).href; try { const detailHtml = await fetchText(detailUrl, signal); const promptBlock = /<div[^>]+class="[^"]*max-h-\[min\(58vh,620px\)[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(detailHtml)?.[1] || ""; const title = /<title>([\s\S]*?)<\/title>/i.exec(detailHtml)?.[1]?.split(" - GPT")[0] || "YouMind 提示词"; const image = parseImageSrc(card.groups.img, source.url); const author = /作者<\/span>\s*<a[^>]*>(?:<!-- -->)?([^<]+)/i.exec(detailHtml)?.[1] || source.name; items.push(item({ id: `youmind_gpt_image-${card.groups.id}`, sourceId: source.id, sourceName: source.name, sourceUrl: detailUrl, author, model: "GPT Image 2", title: htmlText(title), tags: ["GPT Image 2"], cover: image, prompt: htmlText(promptBlock), publishedAt: publishedById.get(card.groups.id), sourceRank })); } catch (error) { if (error.message.includes("取消")) throw error; } } };
    await Promise.all(Array.from({ length: Math.min(MAX_DETAIL_CONCURRENCY, cards.length || 1) }, worker)); if (!items.length) throw new Error("未返回有效记录"); return items;
  }
  async function syncYouMind(signal) {
    const source = SOURCES[5];
    try {
      const session = await fetchYouMindText(YOUMIND_EXPLORE_URL, signal);
      const cookie = getResponseCookieHeader(session.headers) || "NEXT_LOCALE=zh-CN";
      const records = [];
      const seen = new Set();
      for (let page = 1; page <= YOUMIND_MAX_PAGES && records.length < MAX_SOURCE_ITEMS; page += 1) {
        const payload = JSON.parse((await fetchYouMindText(YOUMIND_API_URL, signal, {
          method: "POST",
          cookie,
          body: JSON.stringify({
            model: "gpt-image-2",
            page,
            limit: YOUMIND_PAGE_SIZE,
            locale: "zh-CN",
            campaign: "gpt-image-2-prompts",
            filterMode: "imageCategories"
          })
        })).text);
        const batch = Array.isArray(payload?.prompts) ? payload.prompts : [];
        if (!batch.length) break;
        const previousCount = records.length;
        batch.forEach((record) => {
          const id = String(record?.id || "");
          if (id && !seen.has(id) && records.length < MAX_SOURCE_ITEMS) {
            seen.add(id);
            records.push(record);
          }
        });
        if (!payload?.hasMore || records.length === previousCount) break;
      }
      const items = records
        .map((record, sourceRank) => youMindRecordToItem(record, source, sourceRank))
        .filter((entry) => entry?.prompt && entry?.cover);
      if (!items.length) throw new Error("未返回有效记录");
      return items;
    } catch (error) {
      if (error.message.includes("取消")) throw error;
      return syncYouMindLandingFallback(source, signal);
    }
  }
  async function syncPromptHeroLegacy(source, signal) {
    const html = await fetchPromptHeroText(source.url, signal); const records = []; const seen = new Set();
    for (const match of html.matchAll(/<a href="(?<href>\/prompt\/[^"]+)"[^>]*aria-label="(?<label>[^"]*)"[\s\S]*?<img(?<img>[^>]+)>/g)) { const href = match.groups.href; if (seen.has(href)) continue; seen.add(href); const image = parseImageSrc(match.groups.img, source.url); const label = decodeText(match.groups.label).replace(/^AI generated:\s*/i, "").replace(/\.\.\.$/, ""); records.push({ href, image, label }); if (records.length >= MAX_PROMPTHERO_DETAILS) break; }
    const items = []; let cursor = 0; const worker = async () => { while (cursor < records.length) { const record = records[cursor++]; try { const detailUrl = new URL(record.href, source.url).href; const detailHtml = await fetchText(detailUrl, signal); const flight = decodeFlight(detailHtml); const promptToken = /"promptText":(?<value>"(?:\\.|[^"\\])*")/.exec(flight)?.groups?.value; let promptValue = ""; try { promptValue = promptToken ? JSON.parse(promptToken) : ""; } catch {} const prompt = cleanPrompt(/^\$[0-9a-z]+$/i.test(promptValue) ? flightRefValue(flight, promptValue) : promptValue || record.label); const title = /<title>([\s\S]*?)<\/title>/i.exec(detailHtml)?.[1]?.split(" – AI Prompt")[0] || record.label || "PromptHero 灵感"; const cover = /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i.exec(detailHtml)?.[1] || record.image; const author = /name="article:author"\s+content="([^"]+)"/i.exec(detailHtml)?.[1] || source.name; items.push(item({ id: `${source.id}-${record.href.split("/").pop()}`, sourceId: source.id, sourceName: source.name, sourceUrl: detailUrl, author, model: source.name.replace("PromptHero ", ""), title: htmlText(title), tags: [source.name.replace("PromptHero ", "")], cover, prompt, promptKind: promptValue ? "full" : "excerpt" })); } catch (error) { if (error.message.includes("取消")) throw error; } } };
    await Promise.all(Array.from({ length: Math.min(MAX_DETAIL_CONCURRENCY, records.length || 1) }, worker)); if (!items.length) throw new Error("未返回有效记录"); return items;
  }
  async function syncPromptHero(source, signal) {
    const filter = PROMPTHERO_FILTERS[source.id] || {};
    const endpoint = new URL("https://prompthero.com/api/trpc/prompt.search");
    const records = []; const seen = new Set();
    for (let page = 1; page <= PROMPTHERO_MAX_PAGES && records.length < MAX_PROMPTHERO_DETAILS; page++) {
      const input = { json: { ...filter, page, pageSize: PROMPTHERO_PAGE_SIZE, sort: "newest", sortOverride: "newest", nsfw: false } };
      endpoint.search = new URLSearchParams({ input: JSON.stringify(input) }).toString();
      let payload;
      try {
        payload = JSON.parse(await fetchPromptHeroText(endpoint.href, signal, { Accept: "application/json" }));
      } catch (error) {
        if (!records.length) throw error;
        break;
      }
      const json = payload?.result?.data?.json;
      const batch = Array.isArray(json?.items) ? json.items : [];
      if (!batch.length) break;
      batch.forEach((record) => {
        const prompt = record?.prompt || {};
        const id = String(prompt.id || prompt.canonicalSlug || prompt.slug || record?.asset?.recordId || "");
        if (id && !seen.has(id)) { seen.add(id); records.push(record); }
      });
      if (!json?.pagination?.hasNextPage || batch.length < PROMPTHERO_PAGE_SIZE) break;
    }
    const items = records.slice(0, MAX_PROMPTHERO_DETAILS).map((record, sourceRank) => {
      const promptRecord = record?.prompt || {};
      const asset = record?.asset || {};
      const slug = promptRecord.canonicalSlug || promptRecord.slug || promptRecord.id || asset.recordId;
      const fullPrompt = cleanPrompt(promptRecord.prompt);
      const excerpt = cleanPrompt(promptRecord.description);
      const model = [promptRecord.modelUsed, promptRecord.modelUsedVersion].filter(Boolean).join(" ") || source.name.replace("PromptHero ", "");
      const tags = [...(Array.isArray(promptRecord.tags) ? promptRecord.tags : []), promptRecord.category].filter(Boolean);
      return item({
        id: `${source.id}-${slug}`,
        sourceId: source.id,
        sourceName: source.name,
        sourceUrl: slug ? new URL(`/prompt/${slug}`, source.url).href : source.url,
        author: promptRecord.author || promptRecord.authorName || source.name,
        model,
        title: promptRecord.title || excerpt.slice(0, 80) || `${source.name} 灵感`,
        tags,
        cover: asset.canonicalUrl || asset.thumbnailUrl || asset.url,
        prompt: fullPrompt || excerpt,
        promptKind: fullPrompt ? "full" : "excerpt",
        publishedAt: promptRecord.createdAt || promptRecord.updatedAt,
        sourceRank
      });
    }).filter((entry) => entry.prompt && entry.cover);
    if (!items.length) return syncPromptHeroLegacy(source, signal);
    return items;
  }
  async function syncTwoSlides(source, signal) {
    const payload = JSON.parse(await fetchText("https://2slides.com/api/gpt-image-2-prompts?includeCategories=true", signal, { Accept: "application/json" }));
    const records = Array.isArray(payload?.data) ? payload.data : [];
    const items = records.slice(0, MAX_SOURCE_ITEMS).map((record, sourceRank) => item({
      id: `twoslides_gpt_image-${record.id}`, sourceId: source.id, sourceName: source.name,
      sourceUrl: source.url, author: record.authorHandle || "2Slides", model: "GPT Image 2",
      title: record.title, tags: [record.category, record.source].filter(Boolean), cover: record.imageUrl,
      prompt: record.prompt, publishedAt: record.addedAt || twitterSnowflakeTimestamp(record.tweetUrl), sourceRank
    }));
    if (!items.length) throw new Error("未返回有效记录"); return items;
  }
  async function syncSource(source, signal) {
    if (source.kind === "prompt123") return syncPrompt123(signal);
    if (source.kind === "aiwind") return syncAIWind(signal);
    if (source.kind === "opennana") return syncOpenNana(signal);
    if (source.kind === "prompthub") return syncPromptHub(signal);
    if (source.kind === "aiart") return syncAiArt(signal);
    if (source.kind === "youmind") return syncYouMind(signal);
    if (source.kind === "twoslides") return syncTwoSlides(source, signal);
    return syncPromptHero(source, signal);
  }
  async function sync(force = false) {
    if (running) return { status: "running" }; running = true; controller = new AbortController(); emit({ status: "running", message: `正在同步 ${sourceList.length} 个灵感来源…` });
    const previous = await previousFeed(); const sourceResults = new Array(sourceList.length); let sourceCursor = 0;
    const sourceWorker = async () => { while (sourceCursor < sourceList.length) { const index = sourceCursor++; const source = sourceList[index]; try { const items = await syncSource(source, controller.signal); sourceResults[index] = { sourceId: source.id, success: true, count: items.length, items, message: "OK", checkedAt: new Date().toISOString() }; } catch (error) { sourceResults[index] = { sourceId: source.id, success: false, count: 0, items: previous.items.filter((entry) => entry?.sourceId === source.id), message: String(error.message || "同步失败").replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 240), checkedAt: new Date().toISOString() }; } } };
    await Promise.all(Array.from({ length: Math.min(3, sourceList.length || 1) }, sourceWorker));
    const refreshedSourceIds = new Set(sourceResults.filter((result) => result.success).map((result) => result.sourceId));
    const cumulativeSourceIds = new Set(sourceList.filter((source) => source.kind === "prompthero" || source.kind === "youmind").map((source) => source.id));
    const merged = new Map();
    previous.items
      .filter((entry) => !refreshedSourceIds.has(entry?.sourceId) || cumulativeSourceIds.has(entry?.sourceId))
      .forEach((entry) => merged.set(entry.id, entry));
    sourceResults.flatMap((result) => result.items).forEach((entry) => merged.set(entry.id, entry));
    const statusMap = new Map((previous.sourceStatuses || []).map((status) => [status.sourceId, status]));
    sourceResults.forEach(({ items, ...status }) => statusMap.set(status.sourceId, status));
    const sourceOrder = new Map(SOURCES.map((source, index) => [source.id, index]));
    const sourceStatuses = [...statusMap.values()].sort((a, b) => (sourceOrder.get(a.sourceId) ?? 999) - (sourceOrder.get(b.sourceId) ?? 999));
    const updatedAt = new Date().toISOString();
    const feed = { version: 3, updatedAt, items: [...merged.values()].sort(compareFreshness), sourceStatuses };
    await writeAtomic(feedPath, feed);
    const successful = sourceResults.some((entry) => entry.success); const nextSyncAt = new Date(Date.now() + DAY_MS).toISOString(); const newState = { status: successful ? "completed" : "failed", message: successful ? "素材缓存已更新" : "所有来源同步失败，已保留上次缓存", updatedAt, lastSuccessfulSyncAt: successful ? updatedAt : (lastState.lastSuccessfulSyncAt || previous.updatedAt || ""), nextSyncAt: successful ? nextSyncAt : lastState.nextSyncAt, sourceStatuses: feed.sourceStatuses }; await writeAtomic(statePath, newState); await fs.appendFile(logPath, `${updatedAt} ${successful ? "completed" : "failed"} items=${feed.items.length} sources=${sourceResults.map((s) => `${s.sourceId}:${s.success ? "ok" : "cached"}`).join(",")}\n`); emit(newState); running = false; controller = null; schedule(); return newState;
  }
  async function cancel() { if (!running) return { status: "idle" }; controller?.abort(); running = false; controller = null; const state = { ...lastState, status: "cancelled", message: "同步已取消，继续保留上一次缓存", updatedAt: new Date().toISOString() }; await writeAtomic(statePath, state).catch(() => {}); emit(state); schedule(); return state; }
  function schedule() { if (timer) clearTimeout(timer); const due = Date.parse(lastState.nextSyncAt || ""); const wait = Number.isFinite(due) ? Math.max(1000, due - Date.now()) : 1000; timer = setTimeout(() => { sync(false).catch(() => {}); }, wait); }
  async function start() { const state = await readJson(statePath, null); if (state && typeof state === "object") lastState = { ...lastState, ...state }; const feed = await previousFeed(); if (!lastState.lastSuccessfulSyncAt && feed.updatedAt) lastState.lastSuccessfulSyncAt = feed.updatedAt; const due = !lastState.lastSuccessfulSyncAt || Date.now() - Date.parse(lastState.lastSuccessfulSyncAt) >= DAY_MS; if (due) setTimeout(() => sync(false).catch(() => {}), 1200); else schedule(); }
  return { start, sync, cancel, reload: previousFeed, getStatus: () => ({ ...lastState, running }), getSources: () => sourceList.map(({ id, name, url }) => ({ id, name, url })) };
}

module.exports = { SOURCES, createInspirationService };
