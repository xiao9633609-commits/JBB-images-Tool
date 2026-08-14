const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");

assert.match(source, /async function fetchWithSystemProxy\(url, options = \{\}\) \{\s*return net\.fetch\(String\(url\), options\);/);
assert.match(source, /session\.defaultSession\.resolveProxy\(String\(url\)\)/);
assert.match(source, /const response = await net\.fetch\(`\$\{baseUrl\}\/models`/);
assert.match(source, /const response = await fetchWithSystemProxy\(input\.url/);
assert.match(source, /const response = await fetchWithSystemProxy\(src/);
assert.match(source, /const response = await fetchWithSystemProxy\(input\.src\)/);
assert.doesNotMatch(source, /const response = await fetch\(`\$\{baseUrl\}\/models`/);
assert.doesNotMatch(source, /const response = await fetch\(String\(input\.url\)/);
assert.match(source, /SAFE_CONNECT_RETRY_CODES/);
assert.match(source, /SAFE_POST_RETRY_CODES/);
assert.match(source, /message\.match\(\/\(\?:net::\)\?\(ERR_/);
assert.match(source, /normalizedMethod === "POST"\) return SAFE_POST_RETRY_CODES\.has\(details\.code\)/);
assert.match(source, /retryIndex === 0 && !controller\.signal\.aborted && shouldRetryConnectionError/);
assert.match(source, /proxyRoute/);
assert.match(source, /await requestLogs\.interruptRunning\(\)/);

process.stdout.write("network transport tests passed\n");
