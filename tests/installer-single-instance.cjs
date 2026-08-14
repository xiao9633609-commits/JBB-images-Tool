const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const mainSource = fs.readFileSync(path.join(root, "electron", "main.cjs"), "utf8");
const preloadSource = fs.readFileSync(path.join(root, "electron", "preload.cjs"), "utf8");
const rendererSource = fs.readFileSync(path.join(root, "renderer", "index.html"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

const lockIndex = mainSource.indexOf("app.requestSingleInstanceLock()");
const readyIndex = mainSource.indexOf("app.whenReady()");
assert.ok(lockIndex >= 0, "main process must request a single-instance lock");
assert.ok(lockIndex < readyIndex, "single-instance lock must be acquired before app startup");
assert.match(mainSource, /if \(!hasSingleInstanceLock\)\s*\{\s*app\.quit\(\)/);
assert.match(mainSource, /app\.on\("second-instance", \(\) => \{\s*focusExistingMainWindow\(\)/);
assert.match(mainSource, /if \(mainWindow\.isMinimized\(\)\) mainWindow\.restore\(\)/);
assert.match(mainSource, /if \(!mainWindow\.isVisible\(\)\) mainWindow\.show\(\)/);
assert.match(mainSource, /mainWindow\.focus\(\)/);
assert.match(mainSource, /mainWindow\.moveTop\(\)/);
assert.doesNotMatch(mainSource, /second-instance[\s\S]{0,300}(?:dialog|MessageBox|showMessageBox)/);

assert.equal(packageJson.version, "0.3.109");
assert.equal(packageJson.build.appId, "cn.jbbimg.desktop");
assert.equal(packageJson.build.win.executableName, "JBBimg");
assert.equal(packageJson.build.nsis.guid, "7b141cc7-d57c-5908-af89-47db935b5de0");
assert.equal(packageJson.build.nsis.oneClick, false);
assert.equal(packageJson.build.nsis.allowToChangeInstallationDirectory, true);
assert.equal(packageJson.build.nsis.runAfterFinish, true);
assert.equal(packageJson.build.nsis.deleteAppDataOnUninstall, false);
assert.equal(packageJson.build.nsis.shortcutName, "金贝贝生图工具");
assert.equal(packageJson.build.nsis.uninstallDisplayName, "金贝贝生图工具");
assert.equal(packageJson.build.directories.output, "output/installer");
assert.equal(packageJson.scripts["dist:mac"], "npm run build && electron-builder --mac dmg zip --arm64 --x64");
assert.equal(packageJson.build.mac.category, "public.app-category.graphics-design");
assert.equal(packageJson.build.mac.icon, "renderer/public/jbb-icon.png");
assert.equal(packageJson.build.mac.artifactName, "JBBimg-${version}-mac-${arch}.${ext}");
assert.deepEqual(packageJson.build.mac.target, [
  { target: "dmg", arch: ["arm64", "x64"] },
  { target: "zip", arch: ["arm64", "x64"] }
]);
assert.deepEqual(packageJson.build.extraResources, [{
  from: "resources/inspiration-seed",
  to: "inspiration-seed",
  filter: ["inspiration-feed.json", "inspiration-sync-state.json"]
}]);
assert.match(mainSource, /prepareReleaseProfileReset/);
assert.match(mainSource, /release:get-profile-reset/);
assert.match(mainSource, /release:complete-profile-reset/);
assert.match(mainSource, /session\.defaultSession\.clearCache\(\)/);
assert.doesNotMatch(mainSource, /fs\.rm\([^\n]+outputsRoot/);
assert.match(preloadSource, /getProfileReset: \(\) => ipcRenderer\.invoke\("release:get-profile-reset"\)/);
assert.match(preloadSource, /completeProfileReset: \(\) => ipcRenderer\.invoke\("release:complete-profile-reset"\)/);
assert.match(mainSource, /mainWindow\.webContents\.send\("window:prepare-close"\)/);
assert.match(mainSource, /ipcMain\.handle\("window:confirm-close"/);
assert.match(preloadSource, /confirmClose: \(\) => ipcRenderer\.invoke\("window:confirm-close"\)/);
assert.match(preloadSource, /ipcRenderer\.on\("window:prepare-close", listener\)/);
const resetFunctionStart = rendererSource.indexOf("async function applyPendingReleaseProfileReset");
const initializeStart = rendererSource.indexOf("async function initializeApplication");
const directoryInitialization = rendererSource.indexOf("await initializeDirectoryHandles()", initializeStart);
const resetInvocation = rendererSource.indexOf("await applyPendingReleaseProfileReset()", initializeStart);
assert.ok(resetFunctionStart >= 0, "renderer profile reset function must exist");
assert.ok(resetInvocation >= initializeStart && resetInvocation < directoryInitialization, "profile reset must run before directory restoration");
assert.match(rendererSource.slice(resetFunctionStart, initializeStart), /localStorage\.getItem\(INSPIRATION_FAVORITES_KEY\)/);
assert.match(rendererSource.slice(resetFunctionStart, initializeStart), /localStorage\.clear\(\)/);
assert.match(rendererSource.slice(resetFunctionStart, initializeStart), /localStorage\.setItem\(INSPIRATION_FAVORITES_KEY/);
assert.match(rendererSource.slice(resetFunctionStart, initializeStart), /deleteReleaseStorageDatabase\(STORAGE_DATABASE_NAME\)/);

process.stdout.write("installer and single-instance tests passed\n");
