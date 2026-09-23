const STOREFRONT_URL_PREFIX = "https://www.youtube.com/feed/storefront";
const PRICE_CACHE_KEY = "priceCache";
const PRICE_JOB_KEY = "priceJob";
const LAST_SCAN_KEY = "lastScanMovies";

// Only keep/auto-check movies in this year range — the full "本週發燒特惠" list can be
// 300+ movies, and checking each one costs a real background tab + a few seconds, so this
// keeps a full run to a few minutes instead of tens of minutes. Also drives what's shown
// in the list at all: movies outside this range are filtered out entirely, not just
// skipped for price-checking. Chosen with the user as a scope tradeoff, not a technical
// constraint — recent releases rarely discount deeply and pre-2015 titles aren't of
// interest here.
const PRICE_CHECK_MIN_YEAR = 2015;
const PRICE_CHECK_MAX_YEAR_EXCLUSIVE = 2023;

// Only keep movies whose HD purchase sale price is at or under this (in the currency
// symbol YouTube itself shows, e.g. "$150.00" — same figure the user asked for, "NT150").
const PRICE_CHECK_MAX_SALE_PRICE = 150;

// How long a cached price result is trusted before it's treated as stale and re-checked.
// "本週發燒特惠" (this week's deals) implies prices rotate roughly weekly, so caching
// forever would go stale; checking every popup open would be wasteful. 24 hours is a
// middle ground — adjust this constant if that tradeoff should shift either way.
const PRICE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const scanBtn = document.getElementById("scan-btn");
const statusEl = document.getElementById("status");
const progressEl = document.getElementById("price-progress");
const resultsEl = document.getElementById("results");

let currentJob = null;
let tickTimer = null;
let isOnStorefront = false;

function setStatus(text) {
  statusEl.textContent = text;
}

function renderGoToStorefrontPrompt(tab) {
  statusEl.textContent = "請先前往 ";

  const link = document.createElement("a");
  link.href = STOREFRONT_URL_PREFIX;
  link.textContent = STOREFRONT_URL_PREFIX;
  link.addEventListener("click", (event) => {
    event.preventDefault();
    if (tab && tab.id) {
      chrome.tabs.update(tab.id, { url: STOREFRONT_URL_PREFIX });
    } else {
      chrome.tabs.create({ url: STOREFRONT_URL_PREFIX });
    }
    window.close();
  });

  statusEl.append(link, document.createTextNode(" 頁面"));
}

function clearResults() {
  resultsEl.innerHTML = "";
}

function extractYear(meta) {
  const match = meta?.match(/\d{4}/);
  return match ? parseInt(match[0], 10) : null;
}

// The DOM-scraped "查看全部" grid page appends tracking query params to each movie's
// href, which can differ between scans of the same movie — using the raw URL as a cache
// key would make an already-checked movie look "new" again after a re-scan. The video ID
// is the stable part.
function movieKey(url) {
  const match = url.match(/[?&]v=([\w-]{11})/);
  return match ? match[1] : url;
}

function isPriceCheckCandidate(movie) {
  const year = extractYear(movie.meta);
  return (
    year !== null && year >= PRICE_CHECK_MIN_YEAR && year < PRICE_CHECK_MAX_YEAR_EXCLUSIVE
  );
}

// A stale cached entry is treated the same as "not checked yet" everywhere — both for
// the keep-in-list decision and for what gets rendered (renderPriceBlock shows "查價中…"
// for it, not the possibly-outdated old price), so it doesn't matter whether it used to
// be a good deal or not; it just needs a fresh check.
function isFreshEntry(entry) {
  return !!entry && !!entry.checkedAt && Date.now() - entry.checkedAt <= PRICE_CACHE_TTL_MS;
}

function parsePriceNumber(priceStr) {
  const match = priceStr?.match(/[\d.]+/);
  return match ? parseFloat(match[0]) : null;
}

// Whether a movie should still be visible in the list:
// - not yet checked, or its cached result is stale — keep showing it as pending so it
//   gets (re)checked
// - checked (fresh), discounted, AND at/under PRICE_CHECK_MAX_SALE_PRICE
// Anything else (not discounted, discounted but too expensive, or "not found") drops out
// of the list as soon as its result arrives, per the "沒特價就移除出清單" requirement.
function shouldKeepInList(entry) {
  if (!isFreshEntry(entry)) return true;
  if (!entry.found || !entry.discounted) return false;
  const saleNum = parsePriceNumber(entry.salePrice);
  return saleNum !== null && saleNum <= PRICE_CHECK_MAX_SALE_PRICE;
}

// Fills the right-hand price block for one row. Callers pass `undefined` for anything
// not fresh-and-good (never checked, stale, not discounted, or over the price cap —
// shouldKeepInList() already filtered those out of the DOM or is about to), and a fresh
// found+discounted+cheap-enough result otherwise.
function renderPriceBlock(container, entry) {
  container.innerHTML = "";

  if (!entry) {
    container.className = "movie-price-block price-pending";
    container.textContent = "查價中…";
    return;
  }

  container.className = "movie-price-block price-discounted";

  const saleEl = document.createElement("div");
  saleEl.className = "price-sale";
  saleEl.textContent = entry.salePrice;
  container.append(saleEl);

  const origEl = document.createElement("div");
  origEl.className = "price-original";
  origEl.textContent = entry.originalPrice;
  container.append(origEl);

  if (entry.percent !== null) {
    const badge = document.createElement("div");
    badge.className = "price-percent";
    badge.textContent = `-${entry.percent}%`;
    container.append(badge);
  }
}

function buildCandidateList(movies) {
  const sorted = [...movies].sort((a, b) => {
    const yearA = extractYear(a.meta);
    const yearB = extractYear(b.meta);
    if (yearA === null && yearB === null) return 0;
    if (yearA === null) return 1;
    if (yearB === null) return -1;
    return yearB - yearA;
  });

  return sorted.filter(isPriceCheckCandidate).map((movie) => ({
    url: movie.url,
    key: movieKey(movie.url),
    title: movie.title,
    thumbnailUrl: movie.thumbnailUrl || null,
    meta: movie.meta || null,
  }));
}

function renderCandidateList(candidates, priceCache) {
  clearResults();

  for (const movie of candidates) {
    const entry = priceCache[movie.key];
    if (!shouldKeepInList(entry)) continue;

    const li = document.createElement("li");
    li.className = "movie-item";
    li.title = movie.url;
    li.dataset.priceKey = movie.key;

    // Many "查看全部" grid-page thumbnails are lazy-loaded by YouTube inside a
    // closed shadow root and never get a real src until scrolled into view, so
    // movie.thumbnailUrl is often empty there. An <img src=""> renders as a
    // broken-image icon, so only create the <img> when we actually have a URL —
    // otherwise leave a plain placeholder box (the CSS background fills it in).
    let thumb;
    if (movie.thumbnailUrl) {
      thumb = document.createElement("img");
      thumb.className = "movie-thumb";
      thumb.src = movie.thumbnailUrl;
      thumb.alt = "";
    } else {
      thumb = document.createElement("div");
      thumb.className = "movie-thumb";
    }

    const info = document.createElement("div");
    info.className = "movie-info";

    const titleEl = document.createElement("div");
    titleEl.className = "movie-title";
    titleEl.textContent = movie.title;
    info.append(titleEl);

    if (movie.meta) {
      const metaEl = document.createElement("div");
      metaEl.className = "movie-meta";
      metaEl.textContent = movie.meta;
      info.append(metaEl);
    }

    const priceBlock = document.createElement("div");
    renderPriceBlock(priceBlock, isFreshEntry(entry) ? entry : undefined);

    li.append(thumb, info, priceBlock);

    li.addEventListener("click", () => {
      // The popup closes as soon as the new tab steals focus, so the tab-load
      // wait + price-checker injection happens in the background service
      // worker (background.js) instead of here — popup.js's own execution
      // would be torn down before chrome.tabs.onUpdated ever fired.
      chrome.runtime.sendMessage({ type: "openAndCheckPrice", url: movie.url });
    });

    resultsEl.append(li);
  }

  maybeShowEmptyMessage();
}

function maybeShowEmptyMessage() {
  // Don't clobber the "請先前往 storefront 頁面" prompt when the user isn't on the
  // storefront tab — this can fire from a storage change while the popup happens to be
  // open on some unrelated page.
  if (!isOnStorefront) return;
  if (resultsEl.children.length > 0) return;
  if (currentJob && currentJob.running) return;
  setStatus(
    `目前沒有符合條件（${PRICE_CHECK_MIN_YEAR}～${PRICE_CHECK_MAX_YEAR_EXCLUSIVE - 1} 年）的特價電影。`
  );
}

function formatElapsed(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function renderProgressText() {
  const job = currentJob;
  if (!job || !job.total) {
    progressEl.hidden = true;
    return;
  }
  const done = job.total - job.remaining;
  progressEl.hidden = false;
  if (job.running) {
    const elapsed = job.startedAt ? formatElapsed(Date.now() - job.startedAt) : "0:00";
    progressEl.textContent = `正在查詢價格… ${done}/${job.total}（已耗時 ${elapsed}）`;
  } else {
    progressEl.textContent = `價格查詢完成（${done}/${job.total}）`;
  }
}

function updateProgress(job) {
  currentJob = job || null;
  renderProgressText();

  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  if (currentJob && currentJob.running) {
    tickTimer = setInterval(renderProgressText, 1000);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  if (changes[PRICE_CACHE_KEY]) {
    const newCache = changes[PRICE_CACHE_KEY].newValue || {};
    for (const li of Array.from(resultsEl.querySelectorAll("[data-price-key]"))) {
      const entry = newCache[li.dataset.priceKey];
      if (!entry) continue;
      if (!shouldKeepInList(entry)) {
        li.remove();
        continue;
      }
      renderPriceBlock(li.querySelector(".movie-price-block"), isFreshEntry(entry) ? entry : undefined);
    }
    maybeShowEmptyMessage();
  }

  if (changes[PRICE_JOB_KEY]) {
    updateProgress(changes[PRICE_JOB_KEY].newValue);
    maybeShowEmptyMessage();
  }
});

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function checkCurrentTab() {
  const tab = await getActiveTab();
  if (!tab || !tab.url || !tab.url.startsWith(STOREFRONT_URL_PREFIX)) {
    isOnStorefront = false;
    scanBtn.disabled = true;
    renderGoToStorefrontPrompt(tab);
    return null;
  }
  isOnStorefront = true;
  scanBtn.disabled = false;
  setStatus("已就緒，可以掃描");
  return tab;
}

// Restores whatever was scanned last time, so reopening the popup shows results that
// accumulated while it was closed (a background price-check run can take several
// minutes, far longer than a popup realistically stays open/focused). Also re-sends the
// candidate list to background.js — enqueueMovies() is idempotent (skips anything already
// cached), so this is a cheap no-op once a run has finished, but it self-heals a run that
// silently died because the MV3 service worker got recycled mid-job.
async function restoreLastScan() {
  const stored = await chrome.storage.local.get([
    LAST_SCAN_KEY,
    PRICE_CACHE_KEY,
    PRICE_JOB_KEY,
  ]);
  const candidates = stored[LAST_SCAN_KEY];
  if (!candidates || candidates.length === 0) return;

  // Only overwrite the status line when it's actually showing the storefront-ready
  // message — leave the "請先前往 storefront 頁面" prompt alone when the current tab
  // isn't storefront. The list itself still restores either way, since clicking an item
  // works regardless of which tab the popup happened to be opened from.
  if (isOnStorefront) {
    setStatus(`上次掃描的清單（共 ${candidates.length} 部符合條件的電影）`);
  }
  renderCandidateList(candidates, stored[PRICE_CACHE_KEY] || {});
  updateProgress(stored[PRICE_JOB_KEY]);
  chrome.runtime.sendMessage({ type: "checkPricesForMovies", movies: candidates });
}

async function handleScan() {
  const tab = await getActiveTab();
  if (!tab || !tab.id) return;

  scanBtn.disabled = true;
  setStatus("掃描中…");
  progressEl.hidden = true;
  clearResults();

  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["scanner.js"],
      world: "MAIN",
    });

    if (injection.error) {
      throw new Error(
        typeof injection.error === "string" ? injection.error : "注入的掃描程式執行失敗"
      );
    }

    const { movies, warning } = injection.result || {};

    if (warning) {
      setStatus(warning);
    } else if (!movies || movies.length === 0) {
      setStatus("目前「本週發燒特惠」是空的。");
    } else {
      const candidates = buildCandidateList(movies);

      if (candidates.length === 0) {
        setStatus(
          `掃描到 ${movies.length} 部電影，但沒有符合 ${PRICE_CHECK_MIN_YEAR}～${PRICE_CHECK_MAX_YEAR_EXCLUSIVE - 1} 年條件的。`
        );
        await chrome.storage.local.remove(LAST_SCAN_KEY);
        return;
      }

      setStatus(`符合條件的電影共 ${candidates.length} 部，正在查價…`);

      const { [PRICE_CACHE_KEY]: priceCache } = await chrome.storage.local.get(
        PRICE_CACHE_KEY
      );
      renderCandidateList(candidates, priceCache || {});

      await chrome.storage.local.set({ [LAST_SCAN_KEY]: candidates });

      const { [PRICE_JOB_KEY]: job } = await chrome.storage.local.get(PRICE_JOB_KEY);
      updateProgress(job);

      chrome.runtime.sendMessage({ type: "checkPricesForMovies", movies: candidates });
    }
  } catch (err) {
    setStatus(`掃描失敗：${err.message}`);
  } finally {
    scanBtn.disabled = false;
  }
}

scanBtn.addEventListener("click", handleScan);
// Sequenced (not fired in parallel): restoreLastScan()'s status message ("上次掃描的清單
// …") is more useful than checkCurrentTab()'s generic "已就緒" one when there's a saved
// list, so it should be the one left on screen if both run.
checkCurrentTab().then(() => restoreLastScan());
