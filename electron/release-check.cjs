const RELEASE_METADATA_URL = "https://raw.githubusercontent.com/xiao9633609-commits/JBB-images-Tool/main/latest-version.json";
const RELEASES_URL = "https://github.com/xiao9633609-commits/JBB-images-Tool/releases/latest";
const RELEASE_TAG_PREFIX = "https://github.com/xiao9633609-commits/JBB-images-Tool/releases/tag/";
const ALLOWED_DOWNLOAD_PREFIX = "https://github.com/xiao9633609-commits/JBB-images-Tool/releases/download/";

function normalizeVersion(value) {
  const match = String(value || "").trim().match(/(?:^|[^0-9])(\d+(?:\.\d+){1,3})(?:[^0-9]|$)/);
  return match ? match[1] : "0.0.0";
}

function compareVersions(left, right) {
  const leftParts = normalizeVersion(left).split(".").map(Number);
  const rightParts = normalizeVersion(right).split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

function isAllowedReleaseUrl(value) {
  const source = String(value || "");
  return source === RELEASES_URL
    || source.startsWith(RELEASE_TAG_PREFIX)
    || source.startsWith(ALLOWED_DOWNLOAD_PREFIX);
}

function isAllowedInstallerUrl(value, platform = process.platform) {
  const source = String(value || "");
  if (!source.startsWith(ALLOWED_DOWNLOAD_PREFIX)) return false;
  try {
    const filename = decodeURIComponent(new URL(source).pathname.split("/").pop() || "");
    if (platform === "darwin") return /\.dmg$/i.test(filename);
    return /\.exe$/i.test(filename) && /setup|installer/i.test(filename);
  } catch {
    return false;
  }
}

function installerFromUrl(url, size = 0, name = "", platform = process.platform) {
  if (!isAllowedInstallerUrl(url, platform)) return null;
  const filename = name || decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
  return {
    name: String(filename),
    url: String(url),
    size: Number(size || 0)
  };
}

function selectInstallerAsset(assets = []) {
  return (Array.isArray(assets) ? assets : [])
    .map((asset) => installerFromUrl(asset?.browser_download_url || asset?.url, asset?.size, asset?.name))
    .filter(Boolean)
    .sort((left, right) => Number(right.size || 0) - Number(left.size || 0))[0] || null;
}

function buildReleaseResult({ currentVersion, latestVersion, releaseName, publishedAt, releaseUrl, installer, source }) {
  const normalizedLatestVersion = normalizeVersion(latestVersion);
  const normalizedCurrentVersion = normalizeVersion(currentVersion);
  if (normalizedLatestVersion === "0.0.0") throw new Error("版本文件缺少有效的版本号");
  return {
    ok: true,
    currentVersion: normalizedCurrentVersion,
    latestVersion: normalizedLatestVersion,
    updateAvailable: compareVersions(normalizedLatestVersion, normalizedCurrentVersion) > 0,
    releaseName: String(releaseName || `JBBimg ${normalizedLatestVersion}`),
    publishedAt: String(publishedAt || ""),
    releaseUrl: isAllowedReleaseUrl(releaseUrl) ? String(releaseUrl) : RELEASES_URL,
    installer: installer || null,
    source
  };
}

function parseReleaseMetadata(metadata, currentVersion, platform = process.platform, arch = process.arch) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("版本文件格式无效");
  }
  return buildReleaseResult({
    currentVersion,
    latestVersion: metadata.version || metadata.latestVersion,
    releaseName: metadata.releaseName || metadata.name,
    publishedAt: metadata.publishedAt,
    releaseUrl: metadata.releaseUrl,
    installer: installerFromUrl(
      platform === "darwin" ? (arch === "arm64" ? metadata.macArm64InstallerUrl : metadata.macX64InstallerUrl) : (metadata.installerUrl || metadata.installer?.url),
      platform === "darwin" ? (arch === "arm64" ? metadata.macArm64InstallerSize : metadata.macX64InstallerSize) : (metadata.installerSize || metadata.installer?.size),
      platform === "darwin" ? (arch === "arm64" ? metadata.macArm64InstallerName : metadata.macX64InstallerName) : (metadata.installerName || metadata.installer?.name),
      platform
    ),
    source: "metadata"
  });
}

function parseReleasePage({ url, html = "" }, currentVersion) {
  const pageSource = String(html);
  const tagMatch = pageSource.match(/\/xiao9633609-commits\/JBB-images-Tool\/releases\/tag\/v?(\d+(?:\.\d+){1,3})/i);
  const latestVersion = normalizeVersion(tagMatch?.[1] || url);
  if (latestVersion === "0.0.0") throw new Error("GitHub Release 页面未提供有效版本号");
  const releaseUrl = tagMatch
    ? `${RELEASE_TAG_PREFIX}v${latestVersion}`
    : (isAllowedReleaseUrl(url) ? String(url) : RELEASES_URL);

  const escapedVersion = latestVersion.replace(/\./g, "\\.");
  const installerMatch = pageSource.match(new RegExp(`JBBimg-(?:Setup|Installer)-${escapedVersion}-x64\\.exe`, "i"));
  const installerName = installerMatch?.[0] || "";
  const installerUrl = installerName ? `${ALLOWED_DOWNLOAD_PREFIX}v${latestVersion}/${installerName}` : "";

  return buildReleaseResult({
    currentVersion,
    latestVersion,
    releaseUrl,
    installer: installerFromUrl(installerUrl, 0, installerName),
    source: "release-page"
  });
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchStaticMetadata({ fetchImpl, currentVersion, timeoutMs, platform, arch }) {
  const response = await fetchWithTimeout(fetchImpl, RELEASE_METADATA_URL, {
    headers: {
      Accept: "application/json",
      "User-Agent": `JBBimg/${normalizeVersion(currentVersion)}`
    },
    cache: "no-store"
  }, timeoutMs);
  if (!response.ok) {
    const error = new Error(`静态版本文件 HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return parseReleaseMetadata(await response.json(), currentVersion, platform, arch);
}

async function fetchReleasePage({ fetchImpl, currentVersion, timeoutMs }) {
  const response = await fetchWithTimeout(fetchImpl, RELEASES_URL, {
    headers: {
      Accept: "text/html",
      "User-Agent": `JBBimg/${normalizeVersion(currentVersion)}`
    },
    cache: "no-store",
    redirect: "follow"
  }, timeoutMs);
  if (!response.ok) {
    const error = new Error(`GitHub Release 页面 HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return parseReleasePage({ url: response.url, html: await response.text() }, currentVersion);
}

async function fetchLatestRelease({ fetchImpl = fetch, currentVersion, timeoutMs = 20000, attempts = 2, platform = process.platform, arch = process.arch } = {}) {
  let lastError;
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    try {
      return await fetchStaticMetadata({ fetchImpl, currentVersion, timeoutMs, platform, arch });
    } catch (metadataError) {
      try {
        return await fetchReleasePage({ fetchImpl, currentVersion, timeoutMs });
      } catch (releasePageError) {
        lastError = releasePageError;
        const retryable = releasePageError?.name === "AbortError"
          || !Number(releasePageError?.status)
          || releasePageError.status === 429
          || releasePageError.status >= 500;
        if (!retryable || attempt >= attempts - 1) {
          releasePageError.cause = metadataError;
          throw releasePageError;
        }
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    }
  }
  throw lastError || new Error("版本检测失败");
}

module.exports = {
  ALLOWED_DOWNLOAD_PREFIX,
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
};
