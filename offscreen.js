// offscreen.js — Media capture only. No download logic lives here.
// Stream ID is passed via URL search params: ?sid=...&quality=...&seller=...

const params   = new URLSearchParams(location.search);
const streamId = params.get("sid")     || "";
const quality  = params.get("quality") || "720p";
const seller   = params.get("seller")  || "";

let mediaRecorder = null;
let chunks        = [];

// ─────────────────────────────────────────────
// MAIN: start capture immediately on load
// ─────────────────────────────────────────────
(async function init() {
  if (!streamId) {
    notifyError("No stream ID — offscreen document created without a capture source.");
    return;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(buildConstraints(streamId, quality));
  } catch (err) {
    let msg = err.message || String(err);
    if (err.name === "NotAllowedError") msg = "Tab capture permission denied. Try reopening the extension.";
    if (err.name === "NotFoundError")   msg = "Stream not found. The stream ID may have expired — please try again.";
    notifyError(msg);
    return;
  }

  chunks = [];

  const mimeType = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ].find((t) => MediaRecorder.isTypeSupported(t)) || "";

  mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  mediaRecorder.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    saveRecording();
  };

  mediaRecorder.onerror = (e) => {
    notifyError(`MediaRecorder error: ${e.error?.message || "unknown"}`);
  };

  mediaRecorder.start(1000);
})();

// ─────────────────────────────────────────────
// SAVE — offscreen only builds the data, background does the download
// ─────────────────────────────────────────────
function saveRecording() {
  if (chunks.length === 0) {
    notifyError("Recording contained no data.");
    return;
  }

  const blob     = new Blob(chunks, { type: "video/webm" });
  const filename = generateFilename(seller);
  const reader   = new FileReader();

  reader.onloadend = () => {
    // reader.result is "data:video/webm;base64,XXXXX..."
    // Split off the prefix so background can reconstruct the data URI itself.
    const base64 = reader.result.split(",")[1];

    chrome.runtime.sendMessage({
      type:     "SAVE_RECORDING",
      base64,
      filename,
      mimeType: "video/webm",
      size:     blob.size,
    });
  };

  reader.onerror = () => notifyError("FileReader failed while encoding recording.");
  reader.readAsDataURL(blob);
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function buildConstraints(sid, q) {
  const videoMandatory = {
    chromeMediaSource: "tab",
    chromeMediaSourceId: sid,
    ...(q === "1080p" ? { maxWidth: 1920, maxHeight: 1080 }
                      : { maxWidth: 1280, maxHeight: 720 }),
  };
  return {
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: sid } },
    video: { mandatory: videoMandatory },
  };
}

function generateFilename(sellerName) {
  const date = new Date().toISOString().slice(0, 10);
  const slug = sellerName
    ? sellerName.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40)
    : "stream";
  return `streamsweep-${slug}-${date}.webm`;
}

function notifyError(error) {
  console.error("[StreamSweep offscreen]", error);
  chrome.runtime.sendMessage({ action: "recordingError", error }).catch(() => {});
}

// ─────────────────────────────────────────────
// LISTEN: stop command from background
// ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "stopCapture") {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
    }
  }
});
