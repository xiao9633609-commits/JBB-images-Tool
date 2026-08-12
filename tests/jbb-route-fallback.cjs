const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "renderer", "index.html"), "utf8");
const mainSource = fs.readFileSync(path.join(root, "electron", "main.cjs"), "utf8");
const inlineScript = html.match(/<script>\s*"use strict";([\s\S]*?)<\/script>/);
assert.ok(inlineScript, "main inline renderer script must exist");
assert.doesNotThrow(() => new Function(`"use strict";${inlineScript[1]}`));

assert.match(html, /const DEFAULT_BASE_URL = "https:\/\/downstream\.jbbtoken\.cn\/v1"/);
assert.match(html, /const DEFAULT_FALLBACK_BASE_URL = "https:\/\/cn\.jbbt\.cc\/v1"/);
assert.match(html, /let pinnedDefaultBaseUrl = DEFAULT_BASE_URL/);
assert.match(html, /displayedValue === DEFAULT_BASE_URL_LABEL \? pinnedDefaultBaseUrl : displayedValue/);
assert.match(html, /async function selectAndPinInitialJbbRoute\(apiKey\)/);
assert.match(html, /await probeJbbConnectionRoute\(DEFAULT_BASE_URL, apiKey\)/);
assert.match(html, /if \(!canTryFallbackRoute\(primary\)\)/);
assert.match(html, /await probeJbbConnectionRoute\(DEFAULT_FALLBACK_BASE_URL, apiKey\)/);
assert.match(html, /state\.connectionRouteLocked && state\.storedApiKey === apiKey/);
assert.match(html, /async function networkRequest\(url, options = \{\}\) \{\s*return networkRequestOnce\(url, options\);\s*\}/);
assert.match(html, /return `\$\{normalizeBaseUrl\(configuredBaseUrl\)\}\/v1\/\$\{path\.replace/);
assert.doesNotMatch(html, /activeDefaultBaseUrl|defaultBaseUrlRouteResolved|resolveDefaultJbbRoute|replaceDefaultJbbRequestBase|useFallbackJbbRoute/);

assert.match(html, /async function saveSettingsAndClose\(\)/);
assert.match(html, /await ensureConnectionRouteLocked\(\)/);
assert.match(html, /await persistCredentialsToDirectory\(\)/);
assert.match(html, /elements\.settingsClose\.addEventListener\("click", requestConfigDrawerClose\)/);
assert.match(html, /elements\.configBackdrop\.addEventListener\("click", requestConfigDrawerClose\)/);
assert.doesNotMatch(html, /control\.addEventListener\("change", \(\) => \{\s*if \(getCredentialMode\(\) === "persistent"\) persistCredentialsToDirectory\(\)/);
assert.match(html, /\.preview-details::\-webkit-scrollbar\s*\{\s*display: none/);
assert.match(html, /\.preview-details\s*\{[^}]*scrollbar-width: none/s);

assert.match(mainSource, /const JBB_PRIMARY_BASE_URL = "https:\/\/downstream\.jbbtoken\.cn\/v1"/);
assert.match(mainSource, /const JBB_FALLBACK_BASE_URL = "https:\/\/cn\.jbbt\.cc\/v1"/);
assert.doesNotMatch(mainSource, /const candidates = isDefaultJbbUrl|JBB_ROUTE_FAILURE_STATUSES/);
assert.match(mainSource, /fetch\(`\$\{baseUrl\}\/models`/);

process.stdout.write("JBB pinned route and settings auto-save tests passed\n");
