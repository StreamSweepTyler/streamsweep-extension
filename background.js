// background.js — StreamSweep MV3 Service Worker

// ─────────────────────────────────────────────
// STATE — per-tab Map
// Persisted to chrome.storage.session so state survives SW suspension.
// ─────────────────────────────────────────────
const recordings = new Map();
// tabId → { isRecording, startTime, sellerName, quality, savedFile, error }

function getTabState(tabId) {
  return recordings.get(tabId) ?? {
    isRecording: false,
    startTime:   null,
    sellerName:  null,
    quality:     "720p",
    savedFile:   null,
    error:       null,
  };
}

async function persistState() {
  try {
    const obj = {};
    for (const [tabId, state] of recordings) obj[String(tabId)] = state;
    await chrome.storage.session.set({ ssRecordings: obj });
  } catch { /* not critical */ }
}

async function restoreState() {
  try {
    const { ssRecordings } = await chrome.storage.session.get("ssRecordings");
    if (!ssRecordings) return;
    for (const [key, state] of Object.entries(ssRecordings)) {
      recordings.set(Number(key), state);
    }
  } catch {}
}

// ─────────────────────────────────────────────
// DOWNLOAD LISTENER — must be registered at the TOP LEVEL so Chrome MV3
// service workers pick it up on every wake cycle.
// offscreen.js sends DOWNLOAD_RECORDING with base64; we call chrome.downloads
// here because chrome.downloads is only available in the service worker.
// ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "DOWNLOAD_RECORDING") return; // let other listeners handle it

  const dataUrl = `data:${message.mimeType};base64,${message.base64}`;

  chrome.downloads.download(
    {
      url:      dataUrl,
      filename: `Stream Sweep Streams/${message.filename}`,
      saveAs:   false,
    },
    (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error("[StreamSweep] Download failed:", chrome.runtime.lastError.message);
        // Update state to reflect the error
        const tabId = message.tabId;
        if (tabId != null) {
          recordings.set(tabId, {
            ...getTabState(tabId),
            isRecording: false,
            error: `Download failed: ${chrome.runtime.lastError.message}`,
          });
          persistState();
          updateIcon();
        }
      } else {
        // Download queued successfully — update UI state
        const tabId = message.tabId;
        if (tabId != null) {
          recordings.set(tabId, {
            ...getTabState(tabId),
            isRecording: false,
            savedFile: {
              filename:  message.filename,
              size:      message.size,
              isPartial: message.isPartial ?? false,
            },
            error: null,
          });
          persistState();
          updateIcon();
        }
        // Close the offscreen doc once no recordings remain
        const anyRecording = [...recordings.values()].some((r) => r.isRecording);
        if (!anyRecording) closeOffscreen();
      }
    },
  );

  sendResponse({ success: true });
  return true;
});

// ─────────────────────────────────────────────
// ICON GENERATION (OffscreenCanvas — works in SW)
// ─────────────────────────────────────────────
function drawLightningIcon(size, color) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx    = canvas.getContext("2d");
  const s      = size;

  ctx.clearRect(0, 0, s, s);
  ctx.fillStyle = color === "#ef4444" ? "rgba(239,68,68,0.15)" : "rgba(16,185,129,0.15)";
  ctx.beginPath();
  ctx.roundRect(0, 0, s, s, s * 0.22);
  ctx.fill();

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(s * 0.60, s * 0.04);
  ctx.lineTo(s * 0.20, s * 0.54);
  ctx.lineTo(s * 0.44, s * 0.54);
  ctx.lineTo(s * 0.36, s * 0.96);
  ctx.lineTo(s * 0.80, s * 0.44);
  ctx.lineTo(s * 0.56, s * 0.44);
  ctx.closePath();
  ctx.fill();

  return ctx.getImageData(0, 0, s, s);
}

async function setIcon(recording) {
  const color = recording ? "#ef4444" : "#10b981";
  try {
    await chrome.action.setIcon({
      imageData: {
        16: drawLightningIcon(16, color),
        32: drawLightningIcon(32, color),
        48: drawLightningIcon(48, color),
      },
    });
    if (recording) {
      await chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
      await chrome.action.setBadgeText({ text: "REC" });
    } else {
      await chrome.action.setBadgeText({ text: "" });
    }
  } catch (e) {
    console.warn("[StreamSweep] Icon update failed:", e);
  }
}

async function updateIcon() {
  const anyRecording = [...recordings.values()].some((r) => r.isRecording);
  await setIcon(anyRecording);
}

// ─────────────────────────────────────────────
// STARTUP — clean up stale captures
// ─────────────────────────────────────────────
async function handleStartup() {
  await closeOffscreen();
  await restoreState();

  // Mark any in-progress recordings as interrupted (the offscreen doc is gone)
  let changed = false;
  for (const [tabId, state] of recordings) {
    if (state.isRecording) {
      recordings.set(tabId, { ...state, isRecording: false, error: "Recording interrupted by extension restart." });
      changed = true;
    }
  }
  if (changed) await persistState();

  await updateIcon();
}

chrome.runtime.onStartup.addListener(handleStartup);
chrome.runtime.onInstalled.addListener(handleStartup);

// ─────────────────────────────────────────────
// OFFSCREEN DOCUMENT HELPERS
// ─────────────────────────────────────────────
async function offscreenExists() {
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    return contexts.length > 0;
  } catch {
    return false;
  }
}

async function closeOffscreen() {
  try {
    if (await offscreenExists()) await chrome.offscreen.closeDocument();
  } catch { /* ignore */ }
}

async function ensureOffscreen() {
  if (!(await offscreenExists())) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
      justification: "Capture tab audio/video and play it back through speakers while recording",
    });
    // Allow the document to load and register its message listener.
    await new Promise((r) => setTimeout(r, 150));
  }
}

// ─────────────────────────────────────────────
// tabCapture helper (callback → Promise)
// ─────────────────────────────────────────────
function getMediaStreamId(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(streamId);
      }
    });
  });
}

// ─────────────────────────────────────────────
// GENERAL MESSAGE HANDLER (popup ↔ background, offscreen errors)
// ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // DOWNLOAD_RECORDING is handled by the dedicated top-level listener above.
  if (msg.type === "DOWNLOAD_RECORDING") return;

  dispatch(msg)
    .then(sendResponse)
    .catch((err) => sendResponse({ success: false, error: err.message }));
  return true;
});

async function dispatch(msg) {
  switch (msg.action) {
    // ── Popup: start recording ──────────────────────────────────────────────
    case "startRecording": {
      const { tabId, quality, sellerName } = msg;

      if (recordings.get(tabId)?.isRecording) {
        return { success: false, error: "This tab is already being recorded." };
      }

      let streamId;
      try {
        streamId = await getMediaStreamId(tabId);
      } catch (err) {
        const errMsg = err.message || "";
        if (errMsg.includes("active stream") || errMsg.includes("already being captured")) {
          throw new Error("This tab already has an active capture stream. Use Force Stop to clear it, then try again.");
        }
        if (errMsg.includes("Cannot access") || errMsg.includes("chrome://")) {
          throw new Error("This tab cannot be captured (browser internal pages are not allowed).");
        }
        if (errMsg.includes("incognito")) {
          throw new Error("Enable extension access in Incognito mode to record this tab.");
        }
        throw new Error(`Capture failed: ${errMsg}`);
      }

      recordings.set(tabId, {
        isRecording: true,
        startTime:   Date.now(),
        sellerName,
        quality,
        savedFile:   null,
        error:       null,
      });
      await persistState();
      await updateIcon();
      await ensureOffscreen();

      const result = await chrome.runtime.sendMessage({
        action: "startCapture",
        tabId,
        streamId,
        quality,
        seller: sellerName || "",
      }).catch((err) => ({ success: false, error: err.message }));

      if (!result?.success) {
        recordings.delete(tabId);
        await persistState();
        await updateIcon();
        throw new Error(result?.error || "Offscreen capture failed to start.");
      }

      return { success: true };
    }

    // ── Popup: stop recording ───────────────────────────────────────────────
    case "stopRecording": {
      const { tabId } = msg;
      if (!recordings.get(tabId)?.isRecording) {
        return { success: false, error: "Not currently recording this tab." };
      }
      chrome.runtime.sendMessage({ action: "stopCapture", tabId }).catch(() => {});
      return { success: true };
    }

    // ── Popup: poll status ──────────────────────────────────────────────────
    case "getStatus": {
      const { tabId }    = msg;
      const entry        = getTabState(tabId);
      const elapsed      = entry.isRecording && entry.startTime
        ? Math.floor((Date.now() - entry.startTime) / 1000)
        : 0;
      const offscreenUp  = await offscreenExists();
      const anyRecording = [...recordings.values()].some((r) => r.isRecording);
      const stuckCapture = offscreenUp && !anyRecording;
      return { ...entry, elapsed, stuckCapture };
    }

    // ── Popup: force-stop all captures ──────────────────────────────────────
    case "forceStop": {
      await closeOffscreen();
      for (const [tabId, state] of recordings) {
        if (state.isRecording) recordings.set(tabId, { ...state, isRecording: false, error: null });
      }
      await persistState();
      await updateIcon();
      return { success: true };
    }

    // ── Offscreen: recording error ──────────────────────────────────────────
    case "recordingError": {
      const { tabId, error } = msg;
      recordings.set(tabId, { ...getTabState(tabId), isRecording: false, error: error || "Recording failed." });
      await persistState();
      if (![...recordings.values()].some((r) => r.isRecording)) await closeOffscreen();
      await updateIcon();
      return { success: true };
    }

    default:
      return { success: false, error: `Unknown action: ${msg.action}` };
  }
}
