// background.js — StreamSweep MV3 Service Worker
// All state lives here. offscreen.js only operates MediaRecorder.
// Downloads only happen here. No shared mutable state between files.

// ─────────────────────────────────────────────────────────────────────────────
// STATE
// tabId → { isRecording, startTime, sellerName, quality, savedFiles,
//            error, chunkCount, lastSaveTime, partNumber }
// ─────────────────────────────────────────────────────────────────────────────
const recordings = new Map();

function getTabState(tabId) {
  return recordings.get(tabId) ?? {
    isRecording:  false,
    startTime:    null,
    sellerName:   null,
    quality:      "720p",
    savedFiles:   [],
    error:        null,
    chunkCount:   0,
    lastSaveTime: null,
    partNumber:   1,
  };
}

async function persistState() {
  try {
    const obj = {};
    for (const [id, s] of recordings) obj[id] = s;
    await chrome.storage.session.set({ ssRec: obj });
  } catch { /* non-critical */ }
}

async function restoreState() {
  try {
    const { ssRec } = await chrome.storage.session.get("ssRec");
    if (!ssRec) return;
    for (const [k, v] of Object.entries(ssRec)) recordings.set(Number(k), v);
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// TOP-LEVEL LISTENERS
// These MUST be registered synchronously at module scope for Chrome MV3.
// Any message that arrives while the SW is sleeping will re-wake it and
// this listener will be re-registered before the handler runs.
// ─────────────────────────────────────────────────────────────────────────────

// ── offscreen → background: download a recording ──────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "DOWNLOAD_RECORDING") return; // not for us

  const { tabId, base64, mimeType, filename, size, isPartial, partNumber } = msg;
  const dataUrl = `data:${mimeType};base64,${base64}`;

  chrome.downloads.download(
    { url: dataUrl, filename: `Stream Sweep Streams/${filename}`, saveAs: false },
    (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error("[StreamSweep] Download failed:", chrome.runtime.lastError.message);
        const cur = getTabState(tabId);
        recordings.set(tabId, {
          ...cur,
          isRecording: isPartial ? cur.isRecording : false,
          error: `Download failed: ${chrome.runtime.lastError.message}`,
        });
      } else {
        const cur = getTabState(tabId);
        const savedFiles = [
          ...cur.savedFiles,
          { filename, size, isPartial: !!isPartial, partNumber: partNumber ?? null, downloadId },
        ];
        recordings.set(tabId, {
          ...cur,
          isRecording: isPartial ? cur.isRecording : false,
          savedFiles,
          error: null,
        });
        // Close offscreen once the final file for this tab is saved
        if (!isPartial) {
          const anyRecording = [...recordings.values()].some((r) => r.isRecording);
          if (!anyRecording) closeOffscreen();
        }
      }
      persistState();
      updateIcon();
    },
  );

  sendResponse({ ok: true });
  return true; // keep channel open for async
});

// ── offscreen → background: live state update (chunk count, save time) ────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "stateUpdate") return;
  const cur = getTabState(msg.tabId);
  recordings.set(msg.tabId, {
    ...cur,
    chunkCount:   msg.chunkCount ?? cur.chunkCount,
    lastSaveTime: msg.lastSaveTime ?? cur.lastSaveTime,
    partNumber:   msg.partNumber ?? cur.partNumber,
  });
  // No persistState() here — too frequent; popup reads directly from Map
});

// ── popup → background: force-stop all recordings ─────────────────────────
// Top-level so it works even when the service worker was just woken from sleep.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "FORCE_STOP") return;

  console.log("[StreamSweep] FORCE_STOP received — killing all recordings");

  // Tell offscreen to flush partial saves before we destroy it
  chrome.runtime.sendMessage({ action: "stopAll" }).catch(() => {});

  // Give FileReader + download initiation 1.5 s, then force-close regardless
  setTimeout(async () => {
    await closeOffscreen();

    for (const [id, s] of recordings) {
      if (s.isRecording) recordings.set(id, { ...s, isRecording: false, error: null });
    }
    stopIntervals();
    await persistState();
    await updateIcon();

    sendResponse({ success: true });
  }, 1500);

  return true; // keep channel open for async sendResponse
});

// ── offscreen → background: recording error ────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "recordingError") return;
  const cur = getTabState(msg.tabId);
  recordings.set(msg.tabId, {
    ...cur,
    isRecording: false,
    error: msg.error || "Recording failed.",
  });
  persistState();
  updateIcon();
  const anyRecording = [...recordings.values()].some((r) => r.isRecording);
  if (!anyRecording) closeOffscreen();
});

// ── SW keep-alive port from offscreen document ─────────────────────────────
// Keeping an open port prevents Chrome from suspending the service worker
// while recording is active.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "ss-keepalive") return;
  // Just holding the port open does the work; nothing else needed here.
  port.onDisconnect.addListener(() => { /* offscreen closed or reconnecting */ });
});

// ─────────────────────────────────────────────────────────────────────────────
// ICON
// ─────────────────────────────────────────────────────────────────────────────
function drawIcon(size, rec) {
  const c   = new OffscreenCanvas(size, size);
  const ctx = c.getContext("2d");
  const s   = size;
  ctx.clearRect(0, 0, s, s);
  ctx.fillStyle = rec ? "rgba(239,68,68,.15)" : "rgba(16,185,129,.15)";
  ctx.beginPath(); ctx.roundRect(0, 0, s, s, s * 0.22); ctx.fill();
  ctx.fillStyle = rec ? "#ef4444" : "#10b981";
  ctx.beginPath();
  ctx.moveTo(s*.60,s*.04); ctx.lineTo(s*.20,s*.54); ctx.lineTo(s*.44,s*.54);
  ctx.lineTo(s*.36,s*.96); ctx.lineTo(s*.80,s*.44); ctx.lineTo(s*.56,s*.44);
  ctx.closePath(); ctx.fill();
  return ctx.getImageData(0, 0, s, s);
}

async function setIcon(rec) {
  try {
    await chrome.action.setIcon({ imageData: { 16: drawIcon(16,rec), 32: drawIcon(32,rec), 48: drawIcon(48,rec) } });
    await chrome.action.setBadgeBackgroundColor({ color: rec ? "#ef4444" : "#10b981" });
    await chrome.action.setBadgeText({ text: rec ? "REC" : "" });
  } catch {}
}

async function updateIcon() {
  await setIcon([...recordings.values()].some((r) => r.isRecording));
}

setIcon(false);

// ─────────────────────────────────────────────────────────────────────────────
// INTERVALS — keep-alive ping (15 s) + health check (20 s)
// Only run while at least one recording is active.
// ─────────────────────────────────────────────────────────────────────────────
let keepAliveTimer   = null;
let healthCheckTimer = null;
const healthFailures = new Map(); // tabId → consecutive failure count

function startIntervals() {
  if (keepAliveTimer) return; // already running

  // Ping the offscreen document to confirm it's still alive
  keepAliveTimer = setInterval(() => {
    chrome.runtime.sendMessage({ action: "ping" }).catch(() => {});
  }, 15_000);

  // Check each active recording's MediaRecorder state
  healthCheckTimer = setInterval(async () => {
    const activeTabIds = [...recordings.entries()]
      .filter(([, s]) => s.isRecording)
      .map(([id]) => id);

    for (const tabId of activeTabIds) {
      try {
        const resp = await Promise.race([
          chrome.runtime.sendMessage({ action: "healthCheck", tabId }),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000)),
        ]);
        if (resp?.recorderState === "recording") {
          healthFailures.delete(tabId);
        } else {
          handleHealthFailure(tabId, resp?.recorderState ?? "unknown");
        }
      } catch (err) {
        handleHealthFailure(tabId, `no response: ${err.message}`);
      }
    }
  }, 20_000);
}

function stopIntervals() {
  if (keepAliveTimer)   { clearInterval(keepAliveTimer);   keepAliveTimer   = null; }
  if (healthCheckTimer) { clearInterval(healthCheckTimer); healthCheckTimer = null; }
}

function handleHealthFailure(tabId, reason) {
  const n = (healthFailures.get(tabId) ?? 0) + 1;
  healthFailures.set(tabId, n);
  console.warn(`[StreamSweep] Health check failed tab=${tabId} reason=${reason} attempt=${n}`);

  if (n >= 3) {
    healthFailures.delete(tabId);
    // Ask offscreen to flush whatever chunks it has and stop
    chrome.runtime.sendMessage({ action: "forcePartialSave", tabId }).catch(() => {});
    const cur = getTabState(tabId);
    recordings.set(tabId, {
      ...cur,
      error: "Recorder became unresponsive — partial data saved.",
    });
    persistState();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STARTUP — release orphaned captures, restore persisted state
// ─────────────────────────────────────────────────────────────────────────────
async function handleStartup() {
  await closeOffscreen(); // releases any captured streams → restores tab audio
  await restoreState();

  // Any recording that was "active" when the SW restarted is now lost
  let changed = false;
  for (const [id, s] of recordings) {
    if (s.isRecording) {
      recordings.set(id, { ...s, isRecording: false, error: "Interrupted by extension restart." });
      changed = true;
    }
  }
  if (changed) await persistState();

  stopIntervals();
  await updateIcon();
}

chrome.runtime.onStartup.addListener(handleStartup);
chrome.runtime.onInstalled.addListener(handleStartup);

// ─────────────────────────────────────────────────────────────────────────────
// OFFSCREEN DOCUMENT
// ─────────────────────────────────────────────────────────────────────────────
async function offscreenExists() {
  try {
    return (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length > 0;
  } catch { return false; }
}

async function closeOffscreen() {
  try { if (await offscreenExists()) await chrome.offscreen.closeDocument(); } catch {}
}

async function ensureOffscreen() {
  if (!(await offscreenExists())) {
    await chrome.offscreen.createDocument({
      url:           "offscreen.html",
      reasons:       ["USER_MEDIA", "AUDIO_PLAYBACK"],
      justification: "Capture tab audio/video; split audio so user still hears stream while recording",
    });
    await new Promise((r) => setTimeout(r, 200)); // let script load + listener register
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// tabCapture (callback → Promise)
// ─────────────────────────────────────────────────────────────────────────────
function getMediaStreamId(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(id);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POPUP MESSAGE HANDLER
// ─────────────────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // type-based messages are handled by the top-level listeners above
  if (msg.type) return;

  dispatch(msg)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true;
});

async function dispatch(msg) {
  switch (msg.action) {
    // ── Start ────────────────────────────────────────────────────────────────
    case "startRecording": {
      const { tabId, quality, sellerName } = msg;

      if (recordings.get(tabId)?.isRecording) {
        return { ok: false, error: "This tab is already being recorded." };
      }

      let streamId;
      try {
        streamId = await getMediaStreamId(tabId);
      } catch (err) {
        const m = err.message || "";
        if (m.includes("active stream") || m.includes("already being captured")) {
          throw new Error("Tab has an active capture stream. Use Force Stop to clear it first.");
        }
        if (m.includes("chrome://") || m.includes("Cannot access")) {
          throw new Error("This tab cannot be captured (browser-internal pages are off-limits).");
        }
        if (m.includes("incognito")) {
          throw new Error("Enable this extension in Incognito mode to record this tab.");
        }
        throw new Error(`Capture failed: ${m}`);
      }

      recordings.set(tabId, {
        isRecording:  true,
        startTime:    Date.now(),
        sellerName,
        quality,
        savedFiles:   [],
        error:        null,
        chunkCount:   0,
        lastSaveTime: null,
        partNumber:   1,
      });
      await persistState();
      await updateIcon();
      startIntervals();

      await ensureOffscreen();

      const result = await chrome.runtime.sendMessage({
        action: "startCapture", tabId, streamId, quality, seller: sellerName || "",
      }).catch((e) => ({ ok: false, error: e.message }));

      if (!result?.ok) {
        recordings.delete(tabId);
        await persistState();
        await updateIcon();
        const anyRec = [...recordings.values()].some((r) => r.isRecording);
        if (!anyRec) { stopIntervals(); await closeOffscreen(); }
        throw new Error(result?.error || "Offscreen failed to start capture.");
      }

      return { ok: true };
    }

    // ── Stop ─────────────────────────────────────────────────────────────────
    case "stopRecording": {
      const { tabId } = msg;
      if (!recordings.get(tabId)?.isRecording) {
        return { ok: false, error: "Not recording this tab." };
      }
      chrome.runtime.sendMessage({ action: "stopCapture", tabId }).catch(() => {});
      return { ok: true };
    }

    // ── Status (popup polls this every second) ────────────────────────────────
    case "getStatus": {
      const { tabId }    = msg;
      const s            = getTabState(tabId);
      const elapsed      = s.isRecording && s.startTime
        ? Math.floor((Date.now() - s.startTime) / 1000) : 0;
      const offUp        = await offscreenExists();
      const anyRecording = [...recordings.values()].some((r) => r.isRecording);
      const stuckCapture = offUp && !anyRecording;
      return { ...s, elapsed, stuckCapture };
    }

    // ── Force Stop ────────────────────────────────────────────────────────────
    case "forceStop": {
      chrome.runtime.sendMessage({ action: "stopAll" }).catch(() => {});
      await closeOffscreen();
      for (const [id, s] of recordings) {
        if (s.isRecording) recordings.set(id, { ...s, isRecording: false, error: null });
      }
      stopIntervals();
      await persistState();
      await updateIcon();
      return { ok: true };
    }

    // ── Show saved file in Finder/Explorer ───────────────────────────────────
    case "showDownload": {
      const { downloadId } = msg;
      if (downloadId != null) chrome.downloads.show(downloadId);
      return { ok: true };
    }

    default:
      return { ok: false, error: `Unknown action: ${msg.action}` };
  }
}
