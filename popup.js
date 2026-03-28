// popup.js — StreamSweep popup controller

"use strict";

// ─────────────────────────────────────────────
// DOM REFS
// ─────────────────────────────────────────────
const sellerDot     = document.getElementById("sellerDot");
const sellerDisplay = document.getElementById("sellerDisplay");
const qualitySection = document.getElementById("qualitySection");
const timerRow      = document.getElementById("timerRow");
const timerDisplay  = document.getElementById("timerDisplay");
const actionBtn     = document.getElementById("actionBtn");
const savedBox      = document.getElementById("savedBox");
const savedFilename = document.getElementById("savedFilename");
const savedMeta     = document.getElementById("savedMeta");
const errorBox      = document.getElementById("errorBox");

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
let selectedQuality = "720p";
let detectedSeller  = "";   // raw name for passing to background
let timerInterval   = null;

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
  return chrome.runtime.sendMessage({ action, ...extra });
}

function fmtTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
}

function fmtBytes(b) {
  if (b >= 1024 * 1024 * 1024) return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (b >= 1024 * 1024)        return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024).toFixed(0)} KB`;
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

  if (status.error && !status.isRecording) {
    showError(status.error);
  }

  if (status.isRecording) {
    // ── Recording state ──
    qualitySection.classList.add("hidden");
    timerRow.classList.remove("hidden");
    savedBox.classList.add("hidden");
    timerDisplay.textContent = fmtTime(status.elapsed || 0);

    actionBtn.className = "action-btn stop";
    actionBtn.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
        <rect x="4" y="4" width="16" height="16" rx="2"/>
      </svg>
      Stop Recording`;

    startTimerPoll();
  } else {
    // ── Idle / saved state ──
    qualitySection.classList.remove("hidden");
    timerRow.classList.add("hidden");
    stopTimerPoll();

    actionBtn.className = "action-btn start";
    actionBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <circle cx="12" cy="12" r="10"/>
      </svg>
      Start Recording`;

    if (status.savedFile) {
      savedBox.classList.remove("hidden");
      savedFilename.textContent = status.savedFile.filename;
      savedMeta.textContent = fmtBytes(status.savedFile.size) + " · saved to Downloads";
    }
  }
}

// ─────────────────────────────────────────────
// TIMER POLLING (1s interval while recording)
// ─────────────────────────────────────────────
function startTimerPoll() {
  if (timerInterval) return;
  timerInterval = setInterval(async () => {
    const s = await bg("getStatus").catch(() => null);
    if (!s) { stopTimerPoll(); return; }
    if (s.isRecording) {
      timerDisplay.textContent = fmtTime(s.elapsed || 0);
    } else {
      stopTimerPoll();
      applyStatus(s);
    }
  }, 1000);
}

function stopTimerPoll() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

// ─────────────────────────────────────────────
// ACTION BUTTON
// ─────────────────────────────────────────────
actionBtn.addEventListener("click", async () => {
  hideError();
  const currentStatus = await bg("getStatus");

  if (currentStatus.isRecording) {
    // ── STOP ──
    actionBtn.disabled = true;
    actionBtn.textContent = "Stopping…";
    await bg("stopRecording");
    // State will update via timer poll; re-enable button
    setTimeout(() => { actionBtn.disabled = false; }, 800);

  } else {
    // ── START ──
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
      showError("No active tab found.");
      return;
    }

    // Block chrome:// and other non-http pages early
    if (!tab.url?.startsWith("http")) {
      showError("This tab cannot be captured. Open a Whatnot or TikTok live stream.");
      return;
    }

    actionBtn.disabled = true;
    actionBtn.textContent = "Starting…";

    const result = await bg("startRecording", {
      tabId:      tab.id,
      quality:    selectedQuality,
      sellerName: detectedSeller,
    }).catch((e) => ({ success: false, error: e.message }));

    actionBtn.disabled = false;

    if (!result || !result.success) {
      showError(result?.error || "Could not start recording. Try reloading the tab.");
      actionBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="12" r="10"/>
        </svg>
        Start Recording`;
      return;
    }

    // Refresh UI to recording state
    const newStatus = await bg("getStatus");
    applyStatus(newStatus);
  }
});

// ─────────────────────────────────────────────
// SELLER DETECTION
// ─────────────────────────────────────────────
async function detectSeller() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    const url = tab.url || "";
    const isWhatnot = url.includes("whatnot.com");
    const isTikTok  = url.includes("tiktok.com");

    if (!isWhatnot && !isTikTok) {
      sellerDisplay.textContent = "Visit Whatnot or TikTok to detect";
      sellerDisplay.className   = "seller-value dim";
      sellerDot.className       = "seller-indicator off";
      return;
    }

    // Ask content script
    let response = null;
    try {
      response = await chrome.tabs.sendMessage(tab.id, { action: "getSellerName" });
    } catch {
      // Content script not yet injected — happens on a fresh page load
    }

    const name = response?.sellerName;

    if (name) {
      detectedSeller = name;
      sellerDisplay.textContent = `@${name}`;
      sellerDisplay.className   = "seller-value";
      sellerDot.className       = "seller-indicator on";
    } else {
      const platform = isWhatnot ? "whatnot" : "tiktok";
      detectedSeller = platform;
      sellerDisplay.textContent = "Not detected — reload page";
      sellerDisplay.className   = "seller-value dim";
      sellerDot.className       = "seller-indicator off";
    }
  } catch (e) {
    sellerDisplay.textContent = "Detection error";
    sellerDisplay.className   = "seller-value dim";
  }
}

// ─────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────
(async () => {
  await detectSeller();
  const status = await bg("getStatus").catch(() => ({ isRecording: false }));
  applyStatus(status);
})();
