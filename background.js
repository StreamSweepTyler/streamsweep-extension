// background.js — StreamSweep MV3 Service Worker

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
let state = {
  isRecording: false,
  startTime: null,
  tabId: null,
  sellerName: null,
  quality: "720p",
  savedFile: null,  // { filename, size }
  error: null,
};

// ─────────────────────────────────────────────
// ICON GENERATION (OffscreenCanvas — works in SW)
// ─────────────────────────────────────────────
function drawLightningIcon(size, color) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");
  const s = size;

  ctx.clearRect(0, 0, s, s);

  // Subtle rounded background
  ctx.fillStyle = color === "#ef4444" ? "rgba(239,68,68,0.15)" : "rgba(16,185,129,0.15)";
  ctx.beginPath();
  ctx.roundRect(0, 0, s, s, s * 0.22);
  ctx.fill();

  // Lightning bolt path (normalized coords)
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(s * 0.60, s * 0.04);   // top-right
  ctx.lineTo(s * 0.20, s * 0.54);   // mid-left
  ctx.lineTo(s * 0.44, s * 0.54);   // mid-notch
  ctx.lineTo(s * 0.36, s * 0.96);   // bottom
  ctx.lineTo(s * 0.80, s * 0.44);   // mid-right
  ctx.lineTo(s * 0.56, s * 0.44);   // mid-notch
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

// Init icon on startup
setIcon(false);

// ─────────────────────────────────────────────
// OFFSCREEN DOCUMENT HELPERS
// ─────────────────────────────────────────────
async function offscreenExists() {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    return contexts.length > 0;
  } catch {
    return false;
  }
}

async function closeOffscreen() {
  try {
    if (await offscreenExists()) {
      await chrome.offscreen.closeDocument();
    }
  } catch { /* ignore */ }
}

async function createOffscreen(streamId, quality, sellerName) {
  await closeOffscreen();

  const params = new URLSearchParams({
    sid: streamId,
    quality,
    seller: sellerName || "",
  });

  await chrome.offscreen.createDocument({
    url: `offscreen.html?${params}`,
    reasons: ["USER_MEDIA"],
    justification: "Capture tab audio and video for stream recording",
  });
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
// MESSAGE HANDLER
// ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  dispatch(msg)
    .then(sendResponse)
    .catch((err) => sendResponse({ success: false, error: err.message }));
  return true; // keep channel open for async
});

async function dispatch(msg) {
  // ── Offscreen → background: save completed recording ──────────────────────
  // offscreen.js sends type:'SAVE_RECORDING' (not action) to keep concerns separate.
  // chrome.downloads.download() accepts a data URI directly — no createObjectURL needed.
  if (msg.type === "SAVE_RECORDING") {
    const dataUri = `data:${msg.mimeType};base64,${msg.base64}`;
    try {
      await chrome.downloads.download({ url: dataUri, filename: msg.filename, saveAs: false });
      state.isRecording = false;
      state.savedFile   = { filename: msg.filename, size: msg.size };
      await setIcon(false);
    } catch (err) {
      state.isRecording = false;
      state.error = `Download failed: ${err.message}`;
      await setIcon(false);
    } finally {
      await closeOffscreen();
    }
    return { success: true };
  }

  switch (msg.action) {
    // ── Popup: start recording ──────────────────
    case "startRecording": {
      if (state.isRecording) {
        return { success: false, error: "Recording already in progress." };
      }

      const { tabId, quality, sellerName } = msg;

      // Get stream ID — must happen within user-gesture propagation window
      let streamId;
      try {
        streamId = await getMediaStreamId(tabId);
      } catch (err) {
        // Provide human-readable errors for common cases
        const msg = err.message || "";
        if (msg.includes("Cannot access") || msg.includes("chrome://")) {
          throw new Error("This tab cannot be captured (browser internal pages are not allowed).");
        }
        if (msg.includes("incognito")) {
          throw new Error("Enable extension access in Incognito mode to record this tab.");
        }
        throw new Error(`Capture failed: ${msg}`);
      }

      // Commit state
      state = {
        isRecording: true,
        startTime: Date.now(),
        tabId,
        sellerName,
        quality,
        savedFile: null,
        error: null,
      };

      await setIcon(true);

      // Launch offscreen document (stream ID valid ~5s — creation is ~100ms)
      await createOffscreen(streamId, quality, sellerName);

      return { success: true };
    }

    // ── Popup: stop recording ───────────────────
    case "stopRecording": {
      if (!state.isRecording) {
        return { success: false, error: "Not currently recording." };
      }
      // Tell offscreen to finalise
      chrome.runtime.sendMessage({ action: "stopCapture" }).catch(() => {});
      return { success: true };
    }

    // ── Popup: poll status ──────────────────────
    case "getStatus": {
      const elapsed =
        state.isRecording && state.startTime
          ? Math.floor((Date.now() - state.startTime) / 1000)
          : 0;
      return { ...state, elapsed };
    }

    // ── Offscreen: error ────────────────────────
    case "recordingError": {
      state.isRecording = false;
      state.error = msg.error || "Recording failed.";
      await setIcon(false);
      await closeOffscreen();
      return { success: true };
    }

    default:
      return { success: false, error: `Unknown action: ${msg.action}` };
  }
}
