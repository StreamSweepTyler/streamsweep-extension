// offscreen.js — Multi-session media capture with OPFS-backed chunk storage.
//
// Key design decisions:
//   • OPFS (Origin Private File System) is used to write chunks to disk as
//     they arrive, so heap memory stays constant regardless of duration.
//   • MediaRecorder timeslice is 10 s — large enough to be efficient, small
//     enough to keep the in-flight write queue minimal.
//   • Downloads are triggered directly from this context via createObjectURL
//     so we never have to base64-encode gigabyte recordings.
//   • If stream tracks end unexpectedly (tab navigated away, stream cut), the
//     recording is auto-saved with a "-partial" filename suffix.
//   • Each session is keyed by tabId, so multiple tabs can record in parallel.

// sessions: tabId → { mediaRecorder, writable, fileHandle, writeQueue,
//                     stream, audioCtx, seller, isPartial, stopping }
const sessions = new Map();

// ─────────────────────────────────────────────
// STARTUP — clean up any leftover OPFS files from a previous crash
// ─────────────────────────────────────────────
(async () => {
  try {
    const root = await navigator.storage.getDirectory();
    const toDelete = [];
    for await (const [name] of root.entries()) {
      if (name.startsWith("ss-rec-")) toDelete.push(name);
    }
    await Promise.all(toDelete.map((n) => root.removeEntry(n).catch(() => {})));
  } catch { /* OPFS not available — will fall back to in-memory */ }
})();

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
    stopCapture(msg.tabId, false);
    sendResponse({ success: true });
  }
});

// ─────────────────────────────────────────────
// START CAPTURE
// ─────────────────────────────────────────────
async function startCapture({ tabId, streamId, quality, seller }) {
  // Clean up any pre-existing session for this tab
  if (sessions.has(tabId)) stopCapture(tabId, false);

  // ── 1. Acquire tab stream ────────────────────────────────────────────────
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(buildConstraints(streamId, quality));
  } catch (err) {
    let msg = err.message || String(err);
    if (err.name === "NotAllowedError") msg = "Tab capture permission denied. Try reopening the extension.";
    if (err.name === "NotFoundError")   msg = "Stream not found — the stream ID may have expired. Try again.";
    notifyError(tabId, msg);
    throw new Error(msg);
  }

  // ── 2. Audio split: playback + recording (fix: audio muted while recording)
  // tabCapture takes exclusive audio ownership and silences the tab.
  // We route the captured audio through an AudioContext:
  //   source → audioCtx.destination  (plays back through speakers)
  //   source → audioDest.stream      (fed into the MediaRecorder)
  const audioCtx = new AudioContext();
  const source   = audioCtx.createMediaStreamSource(stream);
  source.connect(audioCtx.destination);                    // path 1: speakers
  const audioDest = audioCtx.createMediaStreamDestination();
  source.connect(audioDest);                               // path 2: record

  const recordingStream = new MediaStream([
    ...stream.getVideoTracks(),
    ...audioDest.stream.getAudioTracks(),
  ]);

  // ── 3. OPFS file handle for chunk storage (fix: long-duration stability) ──
  // Chunks are written to disk as they arrive rather than accumulated in RAM.
  // For a 3-hour stream this keeps heap usage constant at a few MB.
  let writable = null;
  let fileHandle = null;
  try {
    const root = await navigator.storage.getDirectory();
    fileHandle = await root.getFileHandle(`ss-rec-${tabId}.webm`, { create: true });
    writable = await fileHandle.createWritable({ keepExistingData: false });
  } catch {
    // OPFS unavailable — fall back to in-memory chunks array
  }

  const inMemoryChunks = writable ? null : [];

  // ── 4. MediaRecorder ─────────────────────────────────────────────────────
  const mimeType = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ].find((t) => MediaRecorder.isTypeSupported(t)) || "";

  const mediaRecorder = new MediaRecorder(
    recordingStream,
    mimeType ? { mimeType } : {},
  );

  // Sequential write queue — ensures OPFS writes never race each other
  let writeQueue = Promise.resolve();

  mediaRecorder.ondataavailable = (e) => {
    if (!e.data?.size) return;
    if (writable) {
      writeQueue = writeQueue
        .then(() => writable.write(e.data))
        .catch((err) => notifyError(tabId, `Chunk write failed: ${err.message}`));
    } else {
      inMemoryChunks.push(e.data);
    }
  };

  mediaRecorder.onstop = async () => {
    const session = sessions.get(tabId);
    sessions.delete(tabId);

    // Stop all source tracks and close audio context
    stream.getTracks().forEach((t) => t.stop());
    audioCtx.close();

    const isPartial = session?.isPartial ?? false;

    if (writable) {
      // Drain the write queue, then close and download
      await writeQueue;
      try {
        await writable.close();
        const file = await fileHandle.getFile();
        await downloadAndNotify(tabId, file, seller, isPartial);
      } catch (err) {
        notifyError(tabId, `Save failed: ${err.message}`);
      } finally {
        // Remove OPFS file regardless of outcome
        try {
          const root = await navigator.storage.getDirectory();
          await root.removeEntry(`ss-rec-${tabId}.webm`);
        } catch {}
      }
    } else {
      // In-memory fallback
      if (!inMemoryChunks?.length) {
        notifyError(tabId, "Recording contained no data.");
        return;
      }
      const blob = new Blob(inMemoryChunks, { type: "video/webm" });
      await downloadAndNotify(tabId, blob, seller, isPartial);
    }
  };

  // ── Fix: auto-save on unexpected stop (track ended by tab navigation etc.)
  mediaRecorder.onerror = (e) => {
    const session = sessions.get(tabId);
    if (session) {
      session.isPartial = true;
      session.stopping  = true;
    }
    notifyError(tabId, `MediaRecorder error: ${e.error?.message || "unknown"}`);
  };

  const session = { mediaRecorder, writable, fileHandle, writeQueue: null, stream, audioCtx, seller, isPartial: false, stopping: false };
  sessions.set(tabId, session);

  // ── Fix: recording continues when user switches tabs (fix #1) ─────────────
  // The MediaRecorder lives here in the offscreen document, which has no
  // connection to tab focus or visibility. It runs until stopCapture() is called.
  //
  // If the *source* tab navigates away (stream ends), we auto-save what we have.
  stream.getTracks().forEach((track) => {
    track.addEventListener("ended", () => {
      const s = sessions.get(tabId);
      if (s && !s.stopping && s.mediaRecorder.state === "recording") {
        s.isPartial = true;   // mark as partial so filename reflects it
        s.stopping  = true;
        s.mediaRecorder.stop();
      }
    });
  });

  // 10 s timeslice: large chunks → fewer OPFS writes → efficient for long recordings
  mediaRecorder.start(10_000);
}

// ─────────────────────────────────────────────
// STOP CAPTURE
// ─────────────────────────────────────────────
function stopCapture(tabId, isPartial = false) {
  const session = sessions.get(tabId);
  if (!session) return;
  if (session.stopping) return;
  session.isPartial = isPartial;
  session.stopping  = true;
  if (session.mediaRecorder.state === "recording") {
    session.mediaRecorder.stop(); // triggers onstop → save
  } else {
    sessions.delete(tabId);
  }
}

// ─────────────────────────────────────────────
// DOWNLOAD & NOTIFY
// Offscreen document initiates the download directly via createObjectURL so
// we never have to base64-encode potentially gigabyte recordings (fix #4).
// ─────────────────────────────────────────────
async function downloadAndNotify(tabId, blobOrFile, seller, isPartial) {
  const filename = generateFilename(seller, isPartial);
  const size     = blobOrFile.size;

  if (size === 0) {
    notifyError(tabId, "Recording contained no data.");
    return;
  }

  const blobUrl = URL.createObjectURL(blobOrFile);
  try {
    await new Promise((resolve, reject) => {
      chrome.downloads.download(
        { url: blobUrl, filename: `Stream Sweep Streams/${filename}`, saveAs: false },
        (downloadId) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(downloadId);
          }
        },
      );
    });
    chrome.runtime.sendMessage({
      type: "RECORDING_SAVED",
      tabId,
      filename,
      size,
      isPartial,
    }).catch(() => {});
  } catch (err) {
    notifyError(tabId, `Download failed: ${err.message}`);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
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
  const date    = new Date().toISOString().slice(0, 10);
  const slug    = sellerName
    ? sellerName.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40)
    : "stream";
  const suffix  = isPartial ? "-partial" : "";
  return `streamsweep-${slug}-${date}${suffix}.webm`;
}

function notifyError(tabId, error) {
  console.error("[StreamSweep offscreen]", error);
  chrome.runtime.sendMessage({ action: "recordingError", tabId, error }).catch(() => {});
}
