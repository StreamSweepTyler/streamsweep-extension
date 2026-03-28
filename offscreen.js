// offscreen.js — Multi-session media capture.
// Chunks are collected in memory; on stop the Blob is base64-encoded and sent
// to background.js which owns the chrome.downloads API.

// sessions: tabId → { mediaRecorder, chunks, stream, audioCtx, isPartial, stopping }
const sessions = new Map();

// ─────────────────────────────────────────────
// MESSAGE HANDLER
// ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "startCapture") {
    startCapture(msg)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // async
  }

  if (msg.action === "stopCapture") {
    stopCapture(msg.tabId);
    sendResponse({ success: true });
  }
});

// ─────────────────────────────────────────────
// START CAPTURE
// ─────────────────────────────────────────────
async function startCapture({ tabId, streamId, quality, seller }) {
  if (sessions.has(tabId)) stopCapture(tabId);

  // ── 1. Acquire tab stream ────────────────────────────────────────────────
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(buildConstraints(streamId, quality));
  } catch (err) {
    let errMsg = err.message || String(err);
    if (err.name === "NotAllowedError") errMsg = "Tab capture permission denied. Try reopening the extension.";
    if (err.name === "NotFoundError")   errMsg = "Stream not found — the stream ID may have expired. Try again.";
    notifyError(tabId, errMsg);
    throw new Error(errMsg);
  }

  // ── 2. Audio split: playback + recording ────────────────────────────────
  // tabCapture takes exclusive audio ownership and silences the tab.
  // AudioContext routes the audio to both speakers and the recorder.
  const audioCtx = new AudioContext();
  const source   = audioCtx.createMediaStreamSource(stream);
  source.connect(audioCtx.destination);                     // path 1: speakers
  const audioDest = audioCtx.createMediaStreamDestination();
  source.connect(audioDest);                                // path 2: record

  const recordingStream = new MediaStream([
    ...stream.getVideoTracks(),
    ...audioDest.stream.getAudioTracks(),
  ]);

  // ── 3. MediaRecorder ─────────────────────────────────────────────────────
  const mimeType = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ].find((t) => MediaRecorder.isTypeSupported(t)) || "";

  const chunks = [];
  const mediaRecorder = new MediaRecorder(
    recordingStream,
    mimeType ? { mimeType } : {},
  );

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  mediaRecorder.onstop = () => {
    const session = sessions.get(tabId);
    sessions.delete(tabId);

    stream.getTracks().forEach((t) => t.stop());
    audioCtx.close();

    const isPartial = session?.isPartial ?? false;
    saveRecording(tabId, chunks, seller, isPartial);
  };

  mediaRecorder.onerror = (e) => {
    const session = sessions.get(tabId);
    if (session) { session.isPartial = true; session.stopping = true; }
    notifyError(tabId, `MediaRecorder error: ${e.error?.message || "unknown"}`);
  };

  const session = { mediaRecorder, chunks, stream, audioCtx, isPartial: false, stopping: false };
  sessions.set(tabId, session);

  // Auto-save as partial if the source tab navigates away and the stream ends
  stream.getTracks().forEach((track) => {
    track.addEventListener("ended", () => {
      const s = sessions.get(tabId);
      if (s && !s.stopping && s.mediaRecorder.state === "recording") {
        s.isPartial = true;
        s.stopping  = true;
        s.mediaRecorder.stop();
      }
    });
  });

  // 10 s timeslice keeps chunk count manageable for long recordings
  mediaRecorder.start(10000);
}

// ─────────────────────────────────────────────
// STOP CAPTURE
// ─────────────────────────────────────────────
function stopCapture(tabId) {
  const session = sessions.get(tabId);
  if (!session || session.stopping) return;
  session.stopping = true;
  if (session.mediaRecorder.state === "recording") {
    session.mediaRecorder.stop();
  } else {
    sessions.delete(tabId);
  }
}

// ─────────────────────────────────────────────
// SAVE — base64-encode and hand off to background.js for download
// chrome.downloads is not available in offscreen documents; background owns it.
// ─────────────────────────────────────────────
function saveRecording(tabId, chunks, seller, isPartial) {
  if (chunks.length === 0) {
    notifyError(tabId, "Recording contained no data.");
    return;
  }

  const blob     = new Blob(chunks, { type: "video/webm" });
  const filename = generateFilename(seller, isPartial);
  const reader   = new FileReader();

  reader.onloadend = () => {
    const base64 = reader.result.split(",")[1];
    chrome.runtime.sendMessage({
      type:     "DOWNLOAD_RECORDING",
      tabId,
      base64,
      filename,
      mimeType: "video/webm",
      size:     blob.size,
      isPartial,
    });
  };

  reader.onerror = () => notifyError(tabId, "FileReader failed while encoding recording.");
  reader.readAsDataURL(blob);
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function buildConstraints(sid, q) {
  const videoMandatory = {
    chromeMediaSource: "tab",
    chromeMediaSourceId: sid,
    ...(q === "1080p"
      ? { maxWidth: 1920, maxHeight: 1080 }
      : { maxWidth: 1280, maxHeight: 720 }),
  };
  return {
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: sid } },
    video: { mandatory: videoMandatory },
  };
}

function generateFilename(sellerName, isPartial = false) {
  const date   = new Date().toISOString().slice(0, 10);
  const slug   = sellerName
    ? sellerName.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40)
    : "stream";
  const suffix = isPartial ? "-partial" : "";
  return `streamsweep-${slug}-${date}${suffix}.webm`;
}

function notifyError(tabId, error) {
  console.error("[StreamSweep offscreen]", error);
  chrome.runtime.sendMessage({ action: "recordingError", tabId, error }).catch(() => {});
}
