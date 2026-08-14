const assert = require("node:assert/strict");
const {
  RELEASE_METADATA_URL,
  RELEASES_URL,
  compareVersions,
  fetchLatestRelease,
  isAllowedInstallerUrl,
  isAllowedReleaseUrl,
  normalizeVersion,
  parseReleaseMetadata,
  parseReleasePage,
  selectInstallerAsset
} = require("../electron/release-check.cjs");

const installerUrl = "https://github.com/xiao9633609-commits/JBB-images-Tool/releases/download/v0.3.109/JBBimg-Setup-0.3.109-x64.exe";

assert.equal(normalizeVersion("v0.3.108"), "0.3.108");
assert.equal(normalizeVersion("金贝贝生图工具 JBBimg 0.4.0"), "0.4.0");
assert.equal(compareVersions("0.3.109", "0.3.108"), 1);
assert.equal(compareVersions("0.3.108", "0.3.108"), 0);
assert.equal(compareVersions("0.3.9", "0.3.108"), -1);
assert.equal(compareVersions("1.0", "0.9.999"), 1);
assert.equal(isAllowedReleaseUrl(RELEASES_URL), true);
assert.equal(isAllowedReleaseUrl("https://github.com/xiao9633609-commits/JBB-images-Tool/releases/tag/v0.3.109"), true);
assert.equal(isAllowedReleaseUrl("https://example.com/untrusted.exe"), false);
assert.equal(isAllowedInstallerUrl(installerUrl), true);
assert.equal(isAllowedInstallerUrl("https://github.com/xiao9633609-commits/JBB-images-Tool/releases/download/v0.3.109/source.zip"), false);

const assets = [
  {
    name: "JBBimg-0.3.109-portable.zip",
    browser_download_url: "https://github.com/xiao9633609-commits/JBB-images-Tool/releases/download/v0.3.109/JBBimg-0.3.109-portable.zip",
    size: 200
  },
  { name: "JBBimg-Setup-0.3.109-x64.exe", browser_download_url: installerUrl, size: 100 },
  { name: "JBBimg-Setup-0.3.109-x64.exe", browser_download_url: "https://example.com/untrusted.exe", size: 500 }
];
assert.equal(selectInstallerAsset(assets).size, 100);

const available = parseReleaseMetadata({
  version: "0.3.109",
  releaseName: "JBBimg 0.3.109",
  publishedAt: "2026-08-13T00:00:00Z",
  releaseUrl: "https://github.com/xiao9633609-commits/JBB-images-Tool/releases/tag/v0.3.109",
  installerUrl
}, "0.3.108");
assert.equal(available.updateAvailable, true);
assert.equal(available.installer.name, "JBBimg-Setup-0.3.109-x64.exe");
assert.equal(available.source, "metadata");

const latest = parseReleasePage({
  url: RELEASES_URL,
  html: '<a href="/xiao9633609-commits/JBB-images-Tool/releases/tag/v0.3.108">JBBimg-Setup-0.3.108-x64.exe</a>'
}, "0.3.108");
assert.equal(latest.updateAvailable, false);
assert.equal(latest.installer.name, "JBBimg-Setup-0.3.108-x64.exe");
assert.equal(latest.releaseUrl, "https://github.com/xiao9633609-commits/JBB-images-Tool/releases/tag/v0.3.108");
assert.equal(latest.source, "release-page");

let calls = [];
fetchLatestRelease({
  currentVersion: "0.3.108",
  timeoutMs: 1000,
  attempts: 1,
  fetchImpl: async (url) => {
    calls.push(url);
    if (url === RELEASE_METADATA_URL) return { ok: false, status: 404 };
    return {
      ok: true,
      status: 200,
      url: "https://github.com/xiao9633609-commits/JBB-images-Tool/releases/tag/v0.3.109",
      text: async () => "JBBimg-Setup-0.3.109-x64.exe"
    };
  }
}).then((result) => {
  assert.deepEqual(calls, [RELEASE_METADATA_URL, RELEASES_URL]);
  assert.equal(result.updateAvailable, true);
  assert.equal(result.source, "release-page");
  process.stdout.write("release check tests passed\n");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
