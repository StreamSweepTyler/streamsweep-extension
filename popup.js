// popup.js — StreamSweep popup controller
"use strict";

// ─────────────────────────────────────────────
// DOM
// ─────────────────────────────────────────────
const sellerDot     = document.getElementById("sellerDot");
const sellerDisplay = document.getElementById("sellerDisplay");
const qualitySection= document.getElementById("qualitySection");
const recPanel      = document.getElementById("recPanel");
const recTimer      = document.getElementById("recTimer");
const statChunks    = document.getElementById("statChunks");
const statLastSave  = document.getElementById("statLastSave");
const statParts     = document.getElementById("statParts");
const forceStopBtn  = document.getElementById("forceStopBtn");
const actionBtn     = document.getElementById("actionBtn");
const clearStuckBtn = document.getElementById("clearStuckBtn");
const savedBox      = document.getElementById("savedBox");
const savedFilesList= document.getElementById("savedFilesList");
const errorBox      = document.getElementById("errorBox");

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
let selectedQuality = "720p";
let detectedSeller  = "";
let activeTabId     = null;
let pollInterval    = null;

// ─────────────────────────────────────────────
// QUALITY SELECTOR
// ─────────────────────────────────────────────
document.querySelectorAll(".q-option").forEach((el) => {
  el.addEventListener("click", () => {
    document.querySelectorAll(".q-option").forEach((o) => o.classList.remove("selected"));
    el.classList.add("selected");
    selectedQuality = el.dataset.quality;
  });
});

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function bg(action, extra = {}) {
  const tabId = activeTabId != null ? { tabId: activeTabId } : {};
  return chrome.runtime.sendMessage({ action, ...tabId, ...extra });
}

function fmtTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
}

function fmtBytes(b) {
  if (b >= 1073741824) return `${(b / 1073741824).toFixed(2)} GB`;
  if (b >= 1048576)    return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1024).toFixed(0)} KB`;
}

function fmtRelTime(ts) {
  if (!ts) return "no saves yet";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5)  return "just now";
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

function showError(msg) {
  errorBox.textContent = `⚠ ${msg}`;
  errorBox.classList.remove("hidden");
}
function hideError() { errorBox.classList.add("hidden"); }

// ─────────────────────────────────────────────
// APPLY STATUS → UI
// ─────────────────────────────────────────────
function applyStatus(status) {
  hideError();
  if (status.error && !status.isRecording) showError(status.error);

  // ── Stuck state: offscreen alive but nothing recording ───────────────────
  if (status.stuckCapture) {
    clearStuckBtn.classList.remove("hidden");
  } else {
    clearStuckBtn.classList.add("hidden");
  }

  if (status.isRecording) {
    // ── Recording UI ─────────────────────────────────────────────────────
    qualitySection.classList.add("hidden");
    actionBtn.classList.add("hidden");
    recPanel.classList.remove("hidden");
    savedBox.classList.add("hidden");

    recTimer.textContent   = fmtTime(status.elapsed || 0);
    statChunks.textContent = `${status.chunkCount || 0} chunks`;
    statLastSave.textContent = fmtRelTime(status.lastSaveTime);

    const parts = (status.savedFiles || []).filter((f) => f.isPartial).length;
    statParts.textContent = parts > 0 ? `${parts} auto-save${parts > 1 ? "s" : ""}` : "—";

    startPoll();
  } else {
    // ── Idle UI ───────────────────────────────────────────────────────────
    qualitySection.classList.remove("hidden");
    actionBtn.classList.remove("hidden");
    recPanel.classList.add("hidden");
    stopPoll();

    // Render saved files
    const files = (status.savedFiles || []).filter((f) => !f.isPartial); // show final files
    const partials = (status.savedFiles || []).filter((f) => f.isPartial);
    const allFiles = [...files, ...partials]; // finals first

    if (allFiles.length > 0) {
      savedBox.classList.remove("hidden");
      savedFilesList.innerHTML = "";
      allFiles.forEach((f) => {
        const div = document.createElement("div");
        div.className = "saved-file";
        div.innerHTML = `
          <div class="saved-filename">${f.filename}</div>
          <div class="saved-meta">
            <span>${fmtBytes(f.size)}</span>
            ${f.isPartial ? '<span style="color:#fbbf24;font-size:10px">auto-save</span>' : ""}
            ${f.downloadId != null
              ? `<button class="open-folder-btn" data-id="${f.downloadId}">Show in folder</button>`
              : ""}
          </div>`;
        savedFilesList.appendChild(div);
      });
    }
  }
}

// ─────────────────────────────────────────────
// POLLING
// ─────────────────────────────────────────────
function startPoll() {
  if (pollInterval) return;
  pollInterval = setInterval(async () => {
    const s = await bg("getStatus").catch(() => null);
    if (!s) return;
    applyStatus(s);
    if (!s.isRecording) stopPoll();
  }, 1000);
}

function stopPoll() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

// ─────────────────────────────────────────────
// ACTION BUTTON — Start Recording
// ─────────────────────────────────────────────
actionBtn.addEventListener("click", async () => {
  hideError();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { showError("No active tab found."); return; }
  if (!tab.url?.startsWith("http")) {
    showError("This tab can't be captured. Open a Whatnot or TikTok live stream first.");
    return;
  }

  actionBtn.disabled    = true;
  actionBtn.textContent = "Starting…";

  const result = await bg("startRecording", {
    tabId:      tab.id,
    quality:    selectedQuality,
    sellerName: detectedSeller,
  }).catch((e) => ({ ok: false, error: e.message }));

  actionBtn.disabled = false;

  if (!result?.ok) {
    showError(result?.error || "Could not start recording. Try reloading the tab.");
    actionBtn.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
        <circle cx="12" cy="12" r="10"/>
      </svg>
      Start Recording`;
    return;
  }

  const status = await bg("getStatus").catch(() => null);
  if (status) applyStatus(status);
});

// ─────────────────────────────────────────────
// FORCE STOP BUTTON (inside recording panel)
// ─────────────────────────────────────────────
forceStopBtn.addEventListener("click", async () => {
  forceStopBtn.disabled    = true;
  forceStopBtn.textContent = "Stopping…";

  await bg("stopRecording").catch(() => bg("forceStop"));

  // Wait briefly for download to initiate, then refresh
  await new Promise((r) => setTimeout(r, 1500));
  forceStopBtn.disabled    = false;
  forceStopBtn.textContent = "Force Stop";

  const status = await bg("getStatus").catch(() => ({ isRecording: false }));
  applyStatus(status);
});

// ─────────────────────────────────────────────
// CLEAR STUCK BUTTON
// ─────────────────────────────────────────────
clearStuckBtn.addEventListener("click", async () => {
  clearStuckBtn.disabled    = true;
  clearStuckBtn.textContent = "Clearing…";
  await bg("forceStop").catch(() => {});
  clearStuckBtn.disabled = false;
  clearStuckBtn.classList.add("hidden");
  const status = await bg("getStatus").catch(() => ({ isRecording: false }));
  applyStatus(status);
});

// ─────────────────────────────────────────────
// OPEN FOLDER (delegated click on saved-files list)
// ─────────────────────────────────────────────
savedFilesList.addEventListener("click", async (e) => {
  const btn = e.target.closest(".open-folder-btn");
  if (!btn) return;
  const downloadId = Number(btn.dataset.id);
  await bg("showDownload", { downloadId }).catch(() => {});
});

// ─────────────────────────────────────────────
// SELLER DETECTION
// ─────────────────────────────────────────────
async function detectSeller() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    const url       = tab.url || "";
    const isWhatnot = url.includes("whatnot.com");
    const isTikTok  = url.includes("tiktok.com");

    if (!isWhatnot && !isTikTok) {
      sellerDisplay.textContent = "Visit Whatnot or TikTok to detect";
      sellerDisplay.className   = "seller-value dim";
      sellerDot.className       = "seller-dot off";
      return;
    }

    let response = null;
    try {
      response = await chrome.tabs.sendMessage(tab.id, { action: "getSellerName" });
    } catch { /* content script not yet injected */ }

    const name = response?.sellerName;
    if (name) {
      detectedSeller            = name;
      sellerDisplay.textContent = `@${name}`;
      sellerDisplay.className   = "seller-value";
      sellerDot.className       = "seller-dot on";
    } else {
      detectedSeller            = isWhatnot ? "whatnot" : "tiktok";
      sellerDisplay.textContent = "Not detected — reload page";
      sellerDisplay.className   = "seller-value dim";
      sellerDot.className       = "seller-dot off";
    }
  } catch {
    sellerDisplay.textContent = "Detection error";
    sellerDisplay.className   = "seller-value dim";
  }
}

// ─────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) activeTabId = tab.id;

  await detectSeller();

  const status = await bg("getStatus").catch(() => ({ isRecording: false, savedFiles: [] }));
  applyStatus(status);
})();
