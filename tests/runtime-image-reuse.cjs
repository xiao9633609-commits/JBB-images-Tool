const assert = require("node:assert/strict");

const debugPort = Number(process.argv[2] || 9224);

async function getPageTarget() {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json`);
  assert.equal(response.ok, true, `Cannot read Electron CDP targets on port ${debugPort}`);
  const targets = await response.json();
  const target = targets.find((candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl);
  assert.ok(target, "No Electron page target is available");
  return target;
}

function createCdpClient(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });

  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  async function call(method, params = {}) {
    await opened;
    const id = ++nextId;
    const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    socket.send(JSON.stringify({ id, method, params }));
    return response;
  }

  return {
    call,
    async evaluate(expression) {
      const result = await call("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      }
      return result.result.value;
    },
    close() {
      socket.close();
    }
  };
}

async function main() {
  const target = await getPageTarget();
  const client = createCdpClient(target.webSocketDebuggerUrl);
  await client.call("Page.bringToFront");

  const result = await client.evaluate(`(async () => {
    const waitForFrame = () => Promise.race([
      new Promise((resolve) => requestAnimationFrame(resolve)),
      new Promise((resolve) => setTimeout(resolve, 100))
    ]);
    const originalScrollY = window.scrollY;
    const originalExpandedKeys = [...state.expandedTaskSetIds];
    if (!document.querySelector(".task-set-expansion")) {
      const expandableStack = [...document.querySelectorAll(".task-set-stack")]
        .find((stack) => Number(stack.dataset.memberCount || 0) > 1);
      if (expandableStack) {
        openTaskSetExpansion(expandableStack.dataset.taskSetKey);
        await waitForFrame();
        await waitForFrame();
      }
    }

    let cards = [];
    for (let attempt = 0; attempt < 50; attempt += 1) {
      cards = [...document.querySelectorAll(".result-card[data-record-id]")]
        .filter((card) => {
          const image = card.querySelector(".result-image.is-loaded");
          return image?.complete && image.naturalWidth > 0;
        });
      if (cards.length) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!cards.length) {
      return {
        skipped: true,
        reason: "No loaded result image is available in the active project",
        title: document.title
      };
    }

    const candidates = cards.map((card, index) => ({
      index,
      recordId: card.dataset.recordId,
      image: card.querySelector(".result-image"),
      inStack: Boolean(card.closest(".task-set-stack"))
    }));
    const expandedCandidates = candidates.filter((candidate) =>
      Boolean(candidate.image.closest(".task-set-expansion"))
    );
    window.__runtimeImageReuseCandidates = candidates;
    renderImages();
    await waitForFrame();
    await waitForFrame();

    window.scrollTo(0, document.documentElement.scrollHeight);
    await waitForFrame();
    const bottomFrameHiddenCards = getVirtualizableGalleryCards()
      .filter((card) => {
        const rect = card.getBoundingClientRect();
        if (rect.bottom <= 0 || rect.top >= window.innerHeight) return false;
        const styles = window.getComputedStyle(card);
        return styles.visibility === "hidden"
          || Number.parseFloat(styles.opacity || "1") === 0
          || styles.contentVisibility === "hidden"
          || (typeof card.checkVisibility === "function" && !card.checkVisibility({
            contentVisibilityAuto: true,
            opacityProperty: true,
            visibilityProperty: true
          }));
      })
      .map((card) => {
        const styles = window.getComputedStyle(card);
        const rect = card.getBoundingClientRect();
        return {
          className: card.className,
          recordId: card.dataset.recordId || "",
          visibility: styles.visibility,
          opacity: styles.opacity,
          contentVisibility: styles.contentVisibility,
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom)
        };
      });
    window.scrollTo(0, originalScrollY);
    await waitForFrame();
    const restoredFrameHiddenCards = getVirtualizableGalleryCards()
      .filter((card) => {
        const rect = card.getBoundingClientRect();
        if (rect.bottom <= 0 || rect.top >= window.innerHeight) return false;
        const styles = window.getComputedStyle(card);
        return styles.visibility === "hidden"
          || Number.parseFloat(styles.opacity || "1") === 0
          || styles.contentVisibility === "hidden"
          || (typeof card.checkVisibility === "function" && !card.checkVisibility({
            contentVisibilityAuto: true,
            opacityProperty: true,
            visibilityProperty: true
          }));
      })
      .map((card) => {
        const styles = window.getComputedStyle(card);
        const rect = card.getBoundingClientRect();
        return {
          className: card.className,
          recordId: card.dataset.recordId || "",
          visibility: styles.visibility,
          opacity: styles.opacity,
          contentVisibility: styles.contentVisibility,
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom)
        };
      });

    const checks = candidates.map((candidate) => {
      const matchingCards = [...document.querySelectorAll(
        ".result-card[data-record-id=\\\"" + CSS.escape(candidate.recordId) + "\\\"]"
      )];
      const reused = matchingCards.some((card) => card.querySelector(".result-image") === candidate.image);
      return {
        recordId: candidate.recordId,
        inStack: candidate.inStack,
        reused,
        complete: candidate.image.complete,
        naturalWidth: candidate.image.naturalWidth,
        loadedClass: candidate.image.classList.contains("is-loaded")
      };
    });

    delete window.__runtimeImageReuseCandidates;
    state.expandedTaskSetIds.clear();
    originalExpandedKeys.forEach((key) => state.expandedTaskSetIds.add(key));
    renderImages();
    window.scrollTo(0, originalScrollY);
    return {
      skipped: false,
      title: document.title,
      loadedCandidates: candidates.length,
      stackCandidates: candidates.filter((candidate) => candidate.inStack).length,
      expandedCandidates: expandedCandidates.length,
      bottomFrameHiddenCards,
      restoredFrameHiddenCards,
      checks
    };
  })()`);

  client.close();
  console.log(JSON.stringify(result, null, 2));

  if (result.skipped) return;
  assert.ok(result.loadedCandidates > 0, "Expected at least one loaded result image");
  assert.deepEqual(result.bottomFrameHiddenCards, [], "Visible cards were hidden on the first bottom scroll frame");
  assert.deepEqual(result.restoredFrameHiddenCards, [], "Visible cards were hidden on the first restored scroll frame");
  result.checks.forEach((check) => {
    assert.equal(check.reused, true, `Image node was replaced for record ${check.recordId}`);
    assert.equal(check.complete, true, `Image became incomplete for record ${check.recordId}`);
    assert.ok(check.naturalWidth > 0, `Image lost decoded dimensions for record ${check.recordId}`);
    assert.equal(check.loadedClass, true, `Image lost its loaded state for record ${check.recordId}`);
  });
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  }
);
