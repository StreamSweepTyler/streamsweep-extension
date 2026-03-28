// offscreen.js — MediaRecorder only. No state management. No downloads.
// Receives startCapture/stopCapture from background.js.
// Sends DOWNLOAD_RECORDING (base64) to background.js for all saves.

// sessions: tabId → {
//   mediaRecorder, stream, audioCtx,
//   seller, initChunk, mediaChunks,
//   totalChunkCount, lastSaveTime, partNumber,
//   autoSaveTimer, healthCheckTimer,
//   recoveryAttempts, stopping
// }
const sessions = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE WORKER KEEP-ALIVE
// An open port prevents Chrome from suspending the background service worker.
// We connect when the first session starts, disconnect when the last ends.
// We also send periodic pings as a belt-and-suspenders measure.
// ─────────────────────────────────────────────────────────────────────────────
let swPort       = null;
let pingInterval = null;

function connectToSW() {
  try {
    swPort = chrome.runtime.connect({ name: "ss-keepalive" });
    swPort.onDisconnect.addListener(() => {
      swPort = null;
      if (sessions.size > 0) setTimeout(connectToSW, 1000); // reconnect if still recording
    });
  } catch { /* SW not running yet */ }
}

function startSWKeepAlive() {
  if (!swPort) connectToSW();
  if (pingInterval) return;
  pingInterval = setInterval(() => {
    // Wake the service worker if asleep by sending a no-op message
    chrome.runtime.sendMessage({ type: "stateUpdate", tabId: -1, chunkCount: 0, lastSaveTime: null }).catch(() => {});
  }, 10_000);
}

function stopSWKeepAlive() {
  if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
  if (swPort) { try { swPort.disconnect(); } catch {} swPort = null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE HANDLER
// ─────────────────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "startCapture") {
    startCapture(msg)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.action === "stopCapture") {
    stopCapture(msg.tabId, false);
    sendResponse({ ok: true });
    return;
  }

  if (msg.action === "stopAll") {
    for (const tabId of sessions.keys()) stopCapture(tabId, true);
    sendResponse({ ok: true });
    return;
  }

  if (msg.action === "healthCheck") {
    const s = sessions.get(msg.tabId);
    sendResponse({ recorderState: s?.mediaRecorder?.state ?? "inactive" });
    return;
  }

  if (msg.action === "forcePartialSave") {
    const s = sessions.get(msg.tabId);
    if (s && !s.stopping) saveChunks(msg.tabId, true);
    sendResponse({ ok: true });
    return;
  }

  if (msg.action === "ping") {
    sendResponse({ alive: true });
    return;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// START CAPTURE
// ─────────────────────────────────────────────────────────────────────────────
async function startCapture({ tabId, streamId, quality, seller }) {
  if (sessions.has(tabId)) stopCapture(tabId, true); // clean up any stale session

  // ── 1. Acquire stream ──────────────────────────────────────────────────────
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(buildConstraints(streamId, quality));
  } catch (err) {
    let msg = err.message || String(err);
    if (err.name === "NotAllowedError") msg = "Tab capture permission denied — reopen the extension.";
    if (err.name === "NotFoundError")   msg = "Stream ID expired — please try again.";
    sendError(tabId, msg);
    throw new Error(msg);
  }

  // ── 2. Audio: split to speakers AND recorder ───────────────────────────────
  // tabCapture takes exclusive audio control and silences the tab.
  // AudioContext restores speaker output while the MediaRecorder also gets audio.
  const audioCtx = new AudioContext();
  const source   = audioCtx.createMediaStreamSource(stream);
  source.connect(audioCtx.destination);                     // → speakers
  const audioDest = audioCtx.createMediaStreamDestination();
  source.connect(audioDest);                                // → recorder

  const recStream = new MediaStream([...stream.getVideoTracks(), ...audioDest.stream.getAudioTracks()]);

  // ── 3. MediaRecorder ──────────────────────────────────────────────────────
  const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
    .find((t) => MediaRecorder.isTypeSupported(t)) ?? "";

  const mediaRecorder = new MediaRecorder(recStream, mimeType ? { mimeType } : {});

  const session = {
    mediaRecorder,
    stream,
    audioCtx,
    seller,
    initChunk:        null,   // first chunk — contains WebM header
    mediaChunks:      [],     // subsequent chunks since last partial save
    totalChunkCount:  0,
    lastSaveTime:     null,
    partNumber:       1,
    autoSaveTimer:    null,
    healthCheckTimer: null,
    recoveryAttempts: 0,
    stopping:         false,
  };
  sessions.set(tabId, session);

  // ── 4. Wire up MediaRecorder events ───────────────────────────────────────
  mediaRecorder.ondataavailable = (e) => {
    if (!e.data || e.data.size === 0) return;
    const s = sessions.get(tabId);
    if (!s) return;

    if (!s.initChunk) {
      s.initChunk = e.data; // First chunk holds the WebM initialization segment
    } else {
      s.mediaChunks.push(e.data);
    }
    s.totalChunkCount++;

    // Push lightweight state update to background every 5 s (matches timeslice)
    chrome.runtime.sendMessage({
      type:         "stateUpdate",
      tabId,
      chunkCount:   s.totalChunkCount,
      lastSaveTime: s.lastSaveTime,
      partNumber:   s.partNumber,
    }).catch(() => {});
  };

  mediaRecorder.onstop = () => {
    const s = sessions.get(tabId);
    sessions.delete(tabId);
    if (s) {
      clearInterval(s.autoSaveTimer);
      clearInterval(s.healthCheckTimer);
      s.stream.getTracks().forEach((t) => t.stop());
      s.audioCtx.close();
      // Always save — s.isPartial was stamped by whoever triggered the stop.
      // (The old guard `if (!s.stopping)` made saveChunks unreachable because
      //  stopCapture always sets s.stopping = true before calling stop().)
      saveChunks(tabId, s.isPartial ?? false, s);
    }
    if (sessions.size === 0) stopSWKeepAlive();
  };

  mediaRecorder.onerror = (e) => {
    console.error("[StreamSweep offscreen] MediaRecorder error:", e.error?.message);
    const s = sessions.get(tabId);
    if (s && !s.stopping) {
      s.stopping  = true;
      s.isPartial = true; // onstop will fire after onerror and handle the save
      sendError(tabId, `MediaRecorder error: ${e.error?.message ?? "unknown"}`);
    }
  };

  // Auto-save if stream track ends (tab navigated away, stream closed, etc.)
  stream.getTracks().forEach((track) => {
    track.addEventListener("ended", () => {
      const s = sessions.get(tabId);
      if (s && !s.stopping && s.mediaRecorder.state === "recording") {
        s.isPartial = true; // stream ended unexpectedly → save as partial
        s.stopping  = true;
        s.mediaRecorder.stop(); // triggers onstop → saveChunks with isPartial=true
      }
    });
  });

  // ── 5. Auto-save every 5 minutes (crash insurance) ────────────────────────
  session.autoSaveTimer = setInterval(() => {
    const s = sessions.get(tabId);
    if (!s || s.stopping) return;
    if (s.mediaChunks.length === 0) return; // nothing new since last save
    saveChunks(tabId, true, s);
  }, 5 * 60 * 1000);

  // ── 6. Self-health-check every 20 seconds ────────────────────────────────
  // Background also health-checks us, but this catches local failures faster.
  session.healthCheckTimer = setInterval(() => {
    const s = sessions.get(tabId);
    if (!s || s.stopping) return;

    if (s.mediaRecorder.state !== "recording") {
      s.recoveryAttempts++;
      console.warn(`[StreamSweep] Recorder not in recording state (tab ${tabId}), attempt ${s.recoveryAttempts}`);

      if (s.recoveryAttempts >= 3) {
        clearInterval(s.healthCheckTimer);
        s.stopping = true;
        saveChunks(tabId, true, s);
        sendError(tabId, "Recording stopped unexpectedly. Partial data saved.");
      } else {
        try { s.mediaRecorder.start(5000); } catch { /* will be caught next cycle */ }
      }
    } else {
      s.recoveryAttempts = 0; // reset on success
    }
  }, 20_000);

  // ── 7. Start recording (5 s timeslice for stable chunk sizes) ─────────────
  mediaRecorder.start(5000);

  // ── 8. Keep service worker alive ──────────────────────────────────────────
  startSWKeepAlive();
}

// ─────────────────────────────────────────────────────────────────────────────
// STOP CAPTURE
// ─────────────────────────────────────────────────────────────────────────────
function stopCapture(tabId, isForced = false) {
  const s = sessions.get(tabId);
  if (!s || s.stopping) return;
  s.stopping  = true;
  s.isPartial = isForced; // false = normal stop (final file), true = force stop (partial)
  if (s.mediaRecorder.state === "recording") {
    s.mediaRecorder.stop(); // triggers onstop → saveChunks with s.isPartial
  } else {
    // Already stopped — save manually and clean up
    saveChunks(tabId, isForced, s);
    sessions.delete(tabId);
    s.stream.getTracks().forEach((t) => t.stop());
    s.audioCtx.close();
    clearInterval(s.autoSaveTimer);
    clearInterval(s.healthCheckTimer);
    if (sessions.size === 0) stopSWKeepAlive();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SAVE CHUNKS — base64-encode and send to background for download
// ─────────────────────────────────────────────────────────────────────────────
function saveChunks(tabId, isPartial, session) {
  // session may be passed directly (after sessions.delete) or looked up
  const s = session ?? sessions.get(tabId);
  if (!s) return;

  const { initChunk, mediaChunks, seller, partNumber } = s;

  if (!initChunk && mediaChunks.length === 0) {
    if (!isPartial) sendError(tabId, "No data was recorded.");
    return;
  }

  // Each saved file is self-contained: WebM header + media chunks for that period
  const blobParts = initChunk ? [initChunk, ...mediaChunks] : [...mediaChunks];

  if (isPartial) {
    // Reset media chunks for next segment; keep initChunk for subsequent partials
    s.mediaChunks    = [];
    s.lastSaveTime   = Date.now();
    s.partNumber++;
  }

  const blob     = new Blob(blobParts, { type: "video/webm" });
  const filename = generateFilename(seller, isPartial ? partNumber : null);

  const reader = new FileReader();
  reader.onloadend = () => {
    const base64 = reader.result.split(",")[1];
    chrome.runtime.sendMessage({
      type:       "DOWNLOAD_RECORDING",
      tabId,
      base64,
      filename,
      mimeType:   "video/webm",
      size:       blob.size,
      isPartial,
      partNumber: isPartial ? partNumber : null,
    }).catch(() => {});
  };
  reader.onerror = () => sendError(tabId, "FileReader failed while encoding recording.");
  reader.readAsDataURL(blob);
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function buildConstraints(sid, q) {
  const video = {
    chromeMediaSource:   "tab",
    chromeMediaSourceId: sid,
    ...(q === "1080p" ? { maxWidth: 1920, maxHeight: 1080 } : { maxWidth: 1280, maxHeight: 720 }),
  };
  return {
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: sid } },
    video: { mandatory: video },
  };
}

function generateFilename(seller, partNum) {
  const date = new Date().toISOString().slice(0, 10);
  const slug = seller
    ? seller.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40)
    : "stream";
  return partNum != null
    ? `streamsweep-${slug}-${date}-part${partNum}.webm`
    : `streamsweep-${slug}-${date}.webm`;
}

function sendError(tabId, error) {
  console.error("[StreamSweep offscreen]", error);
  chrome.runtime.sendMessage({ type: "recordingError", tabId, error }).catch(() => {});
}
