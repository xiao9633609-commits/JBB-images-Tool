const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "renderer", "index.html"), "utf8");
const main = fs.readFileSync(path.join(root, "electron", "main.cjs"), "utf8");

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

const restoreSource = sourceBetween(html, "async function restoreTaskHistory", "async function imageSourceToBlob");
assert.match(restoreSource, /createStoredImageUrl\(outputFile, "original"\)/);
assert.match(restoreSource, /createStoredImageUrl\(upscaleSourceFile, "original"\)/);
assert.doesNotMatch(restoreSource, /readBinary|getFile\(|URL\.createObjectURL/);

const resultCardSource = sourceBetween(html, "function createResultCard", "function getTimelineItemMetadata");
assert.match(resultCardSource, /getEntryThumbnailSource\(image, metadata\)/);
assert.match(resultCardSource, /card-image-retry/);
assert.match(resultCardSource, /is-image-loading/);
assert.match(resultCardSource, /takeReusableResultImage\(metadata\.recordId\) \|\| document\.createElement\("img"\)/);
assert.match(resultCardSource, /const reusedLoadedImage = img\.complete && img\.naturalWidth > 0/);
assert.match(resultCardSource, /if \(reusedLoadedImage\)/);
assert.match(resultCardSource, /img\.onload = revealImage/);
assert.match(resultCardSource, /img\.onerror = showImageError/);
assert.match(resultCardSource, /prepareGalleryCardForReveal\(article\.closest\("\.task-set-stack"\) \|\| article\)/);
assert.doesNotMatch(resultCardSource, /img\.addEventListener\("load"/);
assert.match(html, /img-src 'self' data: blob: jbb-image:/);
assert.match(html, /connect-src jbb-image:/);

const reusableImageSource = sourceBetween(html, "let galleryReusableResultImages", "function createResultCard");
assert.match(reusableImageSource, /function collectReusableResultImages\(\)/);
assert.match(reusableImageSource, /image\?\.complete/);
assert.match(reusableImageSource, /image\.naturalWidth <= 0/);
assert.match(reusableImageSource, /reusableImages\.get\(recordId\)\.push\(image\)/);
assert.match(reusableImageSource, /function takeReusableResultImage\(recordId\)/);

const galleryRenderSource = sourceBetween(html, "function renderImages", "function findTaskCard");
assert.match(galleryRenderSource, /galleryReusableResultImages = collectReusableResultImages\(\)/);
assert.ok(
  galleryRenderSource.indexOf("galleryReusableResultImages = collectReusableResultImages()")
    < galleryRenderSource.indexOf("elements.gallery.replaceChildren()"),
  "loaded images must be collected before gallery replacement"
);
assert.match(galleryRenderSource, /galleryReusableResultImages = null/);

const extractionSource = sourceBetween(html, "function extractImages", "function probeImageDimensions");
assert.doesNotMatch(extractionSource, /payload\?\.size|item\?\.size|item\?\.width|item\?\.height|actualSize/);

const dimensionSource = sourceBetween(html, "async function resolveImageDimensions", "\/\/ ===== 生成状态");
assert.match(dimensionSource, /probeImageDimensions\(image\.src\)/);
assert.doesNotMatch(dimensionSource, /image\.actualSize|reportedSize/);
assert.match(html, /syncEntryActualDimensionsFromImage/);
assert.match(html, /naturalWidth/);
assert.match(html, /naturalHeight/);
assert.match(html, /\/\^blob:\/i\.test\(src\) \|\| getStoredImageFilename\(src\)/);

const measurementSource = sourceBetween(html, "function parsePixelSize", "function appendReferenceMentionGuide");
const measurementContext = {
  ASPECT_RATIO_TOLERANCE: 0.03,
  COMMON_ASPECT_RATIOS: [
    ["1:1", 1],
    ["3:4", 3 / 4],
    ["3:2", 3 / 2],
    ["16:9", 16 / 9],
    ["2:3", 2 / 3],
    ["9:16", 9 / 16],
    ["4:3", 4 / 3]
  ]
};
vm.runInNewContext(`${measurementSource}\nthis.compareMeasurements = getImageMeasurementComparison;`, measurementContext);
const compareMeasurements = measurementContext.compareMeasurements;

assert.deepEqual(
  JSON.parse(JSON.stringify(compareMeasurements({
    actualSize: "1024x1376",
    expectedSize: "1024x1376",
    resolvedResolutionRatio: "3:4"
  }))),
  {
    actualSize: "1024x1376",
    requestedSize: "1024x1376",
    actualRatio: "3:4",
    requestedRatio: "3:4",
    sizeDiffers: false,
    ratioDiffers: false,
    hasMismatch: false
  }
);

const pixelMismatch = compareMeasurements({
  actualSize: "929x1693",
  expectedSize: "1080x1920",
  resolvedResolutionRatio: "9:16",
  sizeSemantics: "aspect-ratio"
});
assert.equal(pixelMismatch.sizeDiffers, true);
assert.equal(pixelMismatch.ratioDiffers, false);
assert.equal(pixelMismatch.hasMismatch, true);

const explicitRatioMismatch = compareMeasurements({
  actualSize: "929x1693",
  expectedSize: "1080x1920",
  resolvedResolutionRatio: "custom",
  resolutionRatio: "3:4"
});
assert.equal(explicitRatioMismatch.requestedRatio, "3:4");
assert.equal(explicitRatioMismatch.ratioDiffers, true);

assert.equal(compareMeasurements({ expectedSize: "1000x700", resolutionRatio: "custom" }).requestedRatio, "1000:700");
assert.equal(compareMeasurements({ expectedSize: "2048x1152", resolutionRatio: "3:4", sizeMode: "fixed" }).requestedRatio, "16:9");
assert.equal(compareMeasurements({ actualSize: "1030x1000", expectedSize: "1000x1000" }).ratioDiffers, false);
assert.equal(compareMeasurements({ actualSize: "1031x1000", expectedSize: "1000x1000" }).ratioDiffers, true);

const previewMeasurementSource = sourceBetween(html, "function updatePreviewMeasurementFields", "function syncEntryActualDimensionsFromImage");
assert.match(previewMeasurementSource, /getImageMeasurementComparison\(metadata\)/);
assert.match(previewMeasurementSource, /const showRequestedComparison = !isImage \|\| !measurements\.actualSize \|\| hasMismatch/);
assert.match(previewMeasurementSource, /`实际：\$\{actualSize\}；\\n请求：\$\{requestedSize\}。`/);
assert.match(previewMeasurementSource, /: `实际：\$\{actualSize\}。`/);
assert.match(previewMeasurementSource, /: `实际：\$\{actualRatio\}。`/);
assert.match(previewMeasurementSource, /dataset\.mismatch = String\(hasMismatch\)/);

const previewContext = {
  elements: {
    previewSize: { dataset: {}, textContent: "", title: "" },
    previewRatio: { dataset: {}, textContent: "", title: "" }
  },
  displayResolution: (value) => String(value).replace("x", " × "),
  getImageMeasurementComparison: (metadata) => metadata.measurements
};
vm.runInNewContext(`${previewMeasurementSource}\nthis.updatePreviewMeasurements = updatePreviewMeasurementFields;`, previewContext);
previewContext.updatePreviewMeasurements({
  measurements: {
    actualSize: "1024x1824",
    requestedSize: "1024x1824",
    actualRatio: "9:16",
    requestedRatio: "9:16",
    hasMismatch: false
  }
}, false, true);
assert.equal(previewContext.elements.previewSize.textContent, "实际：1024 × 1824。");
assert.equal(previewContext.elements.previewRatio.textContent, "实际：9:16。");
assert.equal(previewContext.elements.previewSize.dataset.mismatch, "false");

previewContext.updatePreviewMeasurements({
  measurements: {
    actualSize: "929x1693",
    requestedSize: "1080x1920",
    actualRatio: "9:16",
    requestedRatio: "3:4",
    hasMismatch: true
  }
}, false, true);
assert.equal(previewContext.elements.previewSize.textContent, "实际：929 × 1693；\n请求：1080 × 1920。");
assert.equal(previewContext.elements.previewRatio.textContent, "实际：9:16；\n请求：3:4。");
assert.equal(previewContext.elements.previewRatio.dataset.mismatch, "true");

const syncMeasurementSource = sourceBetween(html, "function syncEntryActualDimensionsFromImage", "function renderPreview");
assert.match(syncMeasurementSource, /getImageMeasurementComparison\(\{ \.\.\.entry\.metadata, actualSize \}\)/);
assert.doesNotMatch(syncMeasurementSource, /sizeSemantics === "pixels"/);

assert.match(resultCardSource, /getImageMeasurementComparison\(metadata\)/);
assert.match(resultCardSource, /sizeMismatch: measurements\.hasMismatch/);
assert.match(html, /className = "result-size-alert"/);

assert.match(main, /protocol\.registerSchemesAsPrivileged/);
assert.match(main, /protocol\.handle\("jbb-image"/);
assert.match(main, /assertPathInsideImageRoot\(sourcePath\)/);
assert.match(main, /nativeImage\.createThumbnailFromPath/);
assert.match(main, /THUMBNAIL_EDGE = 448/);
assert.match(main, /THUMBNAIL_CONCURRENCY = 2/);
assert.match(main, /getThumbnailCachePath/);

process.stdout.write("image loading regression tests passed\n");
