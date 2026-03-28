// content.js — Seller/streamer name detection
// Injected on whatnot.com and tiktok.com

function detectSellerName() {
  const { hostname, pathname } = window.location;
  if (hostname.includes("whatnot.com")) return detectWhatnot(pathname);
  if (hostname.includes("tiktok.com"))  return detectTikTok(pathname);
  return null;
}

// ─────────────────────────────────────────────
// WHATNOT
// ─────────────────────────────────────────────
function detectWhatnot(pathname) {
  // 1. Page title — most reliable: set by the server to the streamer's name.
  //    Format: "@username is live" or "username is live on Whatnot"
  const titleMatch = document.title.match(/^@?([^\s@]+)\s+is\s+live/i);
  if (titleMatch) return titleMatch[1].replace(/^@/, "");

  // 2. URL path — reliable when the live URL is /user/USERNAME/...
  const urlMatch = pathname.match(/\/user\/([^/?#]+)/);
  if (urlMatch) return urlMatch[1];

  // 3. DOM — scope to the video-player area, explicitly skip the top nav.
  //    The streamer's profile link sits adjacent to the video, not in the nav bar.
  const streamerName = findNearVideoUsername();
  if (streamerName) return streamerName;

  return null;
}

function findNearVideoUsername() {
  // Find the video element and walk up to a reasonable container
  const video = document.querySelector("video");
  if (!video) return null;

  // Walk up at most 8 levels to find a container that has a /user/ link
  let node = video.parentElement;
  for (let i = 0; i < 8 && node; i++) {
    const link = node.querySelector('a[href*="/user/"]');
    if (link) {
      // Make sure this link is NOT inside the top navigation bar
      if (!isInsideNav(link)) {
        const m = link.href.match(/\/user\/([^/?#]+)/);
        if (m) return m[1];
      }
    }
    node = node.parentElement;
  }
  return null;
}

function isInsideNav(el) {
  let n = el;
  while (n) {
    const tag = n.tagName?.toLowerCase();
    if (tag === "nav" || tag === "header") return true;
    const cls = (n.className || "").toLowerCase();
    const role = (n.getAttribute?.("role") || "").toLowerCase();
    if (
      role === "navigation" ||
      cls.includes("topnav") ||
      cls.includes("top-nav") ||
      cls.includes("navbar") ||
      cls.includes("nav-bar") ||
      cls.includes("header") ||
      cls.includes("usermenu") ||
      cls.includes("user-menu") ||
      cls.includes("accountmenu") ||
      cls.includes("profile-menu")
    ) return true;
    n = n.parentElement;
  }
  return false;
}

// ─────────────────────────────────────────────
// TIKTOK
// ─────────────────────────────────────────────
function detectTikTok(pathname) {
  // 1. URL path — most reliable: /@username/live is always the host's handle.
  const urlMatch = pathname.match(/@([^/?#/]+)/);
  if (urlMatch) return urlMatch[1];

  // 2. Specific live-room host data attributes — these target the host badge
  //    overlaid on the top-left of the video, NOT the logged-in user.
  const hostSelectors = [
    '[data-e2e="live-room-host-name"]',
    '[data-e2e="live-room-username"]',
    '[data-e2e="video-author-uniqueid"]',
    '[data-e2e="browse-username"]',
  ];
  for (const sel of hostSelectors) {
    const el = document.querySelector(sel);
    const text = el?.textContent?.trim();
    if (text) return text.replace(/^@/, "");
  }

  // 3. Look for the @handle that appears specifically near the video overlay
  //    (top-left of the player). Scan only elements inside a live-room wrapper.
  const liveRoot = document.querySelector(
    '[data-e2e="live-room-content"], [class*="LiveRoom"], [class*="liveRoom"]'
  );
  if (liveRoot) {
    for (const el of liveRoot.querySelectorAll("p, span, h2, strong")) {
      if (isInsideNav(el)) continue;
      const text = el.textContent?.trim() || "";
      const m = text.match(/^@([a-zA-Z0-9_.]{2,30})$/);
      if (m) return m[1];
    }
  }

  return null;
}

// ─────────────────────────────────────────────
// MESSAGE LISTENER
// ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "getSellerName") {
    sendResponse({ sellerName: detectSellerName() });
    return true;
  }
});
