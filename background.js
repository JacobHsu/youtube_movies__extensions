const PRICE_CACHE_KEY = "priceCache";
const PRICE_JOB_KEY = "priceJob";

// Matches popup.js's PRICE_CACHE_TTL_MS — kept in sync manually since these are separate
// plain scripts with no shared module. A cached result older than this is treated as if
// it were never checked, so enqueueMovies() re-queues it instead of skipping it forever.
const PRICE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function isFreshCacheEntry(entry) {
  return !!entry && !!entry.checkedAt && Date.now() - entry.checkedAt <= PRICE_CACHE_TTL_MS;
}

// Popup.js sends openAndCheckPrice here instead of handling it directly because the
// popup closes the instant the new tab steals focus, killing any in-flight
// chrome.tabs.onUpdated listener it might have registered. The service worker outlives
// the popup, so it owns the "wait for the tab to finish loading, then inject
// price-checker.js" sequence — for both the single-movie click-through flow and the
// batch "check every movie in the list" job below.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "openAndCheckPrice" && message.url) {
    openAndCheckPrice(message.url);
  }
  if (message?.type === "checkPricesForMovies" && Array.isArray(message.movies)) {
    enqueueMovies(message.movies);
  }
});

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    function onUpdated(id, info) {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

function openAndCheckPrice(url) {
  chrome.tabs.create({ url }, (tab) => {
    waitForTabComplete(tab.id).then(() => {
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["price-checker.js"],
      });
    });
  });
}

// Batch job used by the "查價格" list feature: opens each movie in a background
// (non-focus-stealing) tab so the popup and the user's current tab are undisturbed,
// runs price-checker.js in it, caches the parsed result, then closes the tab and moves
// to the next one. Runs sequentially (not in parallel) to keep resource/request load
// modest. Progress and results are written to chrome.storage.local as they happen so
// the popup can render them even if it's closed and reopened mid-job, and so the job
// naturally resumes (skips already-cached movies) if the service worker gets recycled
// partway through — MV3 service workers aren't guaranteed to survive a multi-minute job.
//
// The queue is a module-level array rather than a snapshot passed to one run: if the
// user re-scans while a batch is still in flight, checkPricesForMovies() merges the new
// candidates into the same queue instead of being silently dropped by a "job already
// running" guard.
let queue = [];
let queuedKeys = new Set();
let queueTotal = 0;
let jobRunning = false;
let jobStartedAt = null;

async function getPriceCache() {
  const { [PRICE_CACHE_KEY]: cache } = await chrome.storage.local.get(PRICE_CACHE_KEY);
  return cache || {};
}

async function publishJobState() {
  await chrome.storage.local.set({
    [PRICE_JOB_KEY]: {
      total: queueTotal,
      remaining: queue.length,
      running: jobRunning,
      startedAt: jobStartedAt,
    },
  });
}

async function checkOneMoviePrice(movie) {
  const tab = await chrome.tabs.create({ url: movie.url, active: false });
  await waitForTabComplete(tab.id);

  let result = null;
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["price-checker.js"],
    });
    result = injection?.result || null;
  } catch (e) {
    result = { found: false, reason: "injection-error" };
  }

  await chrome.tabs.remove(tab.id).catch(() => {});
  return result || { found: false, reason: "no-result" };
}

async function enqueueMovies(movies) {
  const cache = await getPriceCache();
  for (const movie of movies) {
    const key = movie.key || movie.url;
    if (isFreshCacheEntry(cache[key]) || queuedKeys.has(key)) continue;
    queuedKeys.add(key);
    queue.push(movie);
    queueTotal += 1;
  }
  await publishJobState();
  // Guard on queue.length too, not just jobRunning: popup.js resends the full candidate
  // list every time it opens (to self-heal a job the service worker may have dropped),
  // and most of the time everything in it is already cached — starting runQueue() with
  // nothing to do would flip jobRunning true→false almost instantly and briefly stomp the
  // "已耗時" timer's startedAt for no reason.
  if (!jobRunning && queue.length > 0) runQueue();
}

async function runQueue() {
  jobRunning = true;
  jobStartedAt = Date.now();
  await publishJobState();

  while (queue.length > 0) {
    const movie = queue.shift();
    const key = movie.key || movie.url;
    const result = await checkOneMoviePrice(movie);

    const latestCache = await getPriceCache();
    latestCache[key] = { ...result, checkedAt: Date.now() };
    await chrome.storage.local.set({ [PRICE_CACHE_KEY]: latestCache });

    // Remove from queuedKeys now that it's actually been checked (as opposed to merely
    // dequeued) — otherwise, once its cache entry goes stale, enqueueMovies() would keep
    // skipping it forever via the queuedKeys check even though isFreshCacheEntry() would
    // say it's due for a recheck.
    queuedKeys.delete(key);

    await publishJobState();
  }

  // Deliberately not resetting queueTotal here: popup.js hides the progress line when
  // job.total is falsy, so keeping the final total lets it show a "查詢完成 (X/X)" state
  // instead of the line just vanishing.
  jobRunning = false;
  await publishJobState();
}
