// Injected via chrome.scripting.executeScript({ files: ['scanner.js'], world: 'MAIN' }).
// Runs in the page's own JS context (not the isolated content-script world) so it can
// read the live window.ytInitialData object — the shelf we care about is loaded lazily
// by YouTube's own JS as the user scrolls, and only exists in that live object, not in
// the static ytInitialData script tag baked into the initial HTML response.
//
// Everything is wrapped in this IIFE so no top-level `const`/`let` leaks into the page's
// shared global lexical scope. MAIN-world injection runs in the page's real global
// environment, and a second injection into the same document (e.g. clicking "掃描" again
// without a full page reload) would otherwise throw "Identifier has already been
// declared" on re-evaluation of a top-level const/let, which silently turned into an
// empty result because chrome.scripting.executeScript reports that as a per-frame error
// rather than throwing — see popup.js's handling of injection.error for the other half
// of this fix.
//
// The final expression's value becomes the executeScript() result for this tab.
(function () {
  const SHELF_TITLE = "本週發燒特惠";

  function ytExtractText(node) {
    if (!node || typeof node !== "object") return null;
    if (typeof node.simpleText === "string") return node.simpleText;
    if (Array.isArray(node.runs)) {
      return node.runs.map((r) => r.text || "").join("");
    }
    return null;
  }

  // Locates the shelfRenderer whose title matches SHELF_TITLE and returns its list of
  // item nodes. Verified against a real logged-in storefront page: a shelf is shaped like
  // { title, endpoint, content: { horizontalMovieListRenderer: { items: [...] } }, ... }.
  // The exact wrapper name under `content` isn't hard-coded since YouTube uses different
  // renderer names for different shelves; we just take whichever child of `content` has
  // an `items` array.
  function findShelfItems(root, titleQuery) {
    let found = null;

    function contentToItems(node) {
      if (node.content && typeof node.content === "object") {
        for (const value of Object.values(node.content)) {
          if (value && Array.isArray(value.items)) return value.items;
        }
      }
      if (Array.isArray(node.contents)) return node.contents;
      if (Array.isArray(node.items)) return node.items;
      return null;
    }

    function walk(node) {
      if (found || !node || typeof node !== "object") return;

      if (!Array.isArray(node)) {
        for (const [key, value] of Object.entries(node)) {
          if (/title/i.test(key)) {
            const text = ytExtractText(value);
            if (text && text.includes(titleQuery)) {
              const items = contentToItems(node);
              // Ignore an empty match and keep searching — an unrelated node
              // (e.g. page metadata) could coincidentally repeat the shelf
              // title text without being the shelf's actual item list.
              if (items && items.length > 0) {
                found = items;
                return;
              }
            }
          }
        }
      }

      for (const value of Array.isArray(node) ? node : Object.values(node)) {
        if (found) return;
        if (value && typeof value === "object") walk(value);
      }
    }

    walk(root);
    return found;
  }

  function extractMovieFromJsonItem(item) {
    if (!item || typeof item !== "object") return null;
    const renderer = Object.values(item)[0];
    if (!renderer || typeof renderer !== "object") return null;

    const title = ytExtractText(renderer.title);
    const videoId = renderer.videoId;
    if (!title || !videoId) return null;

    const thumbs = renderer.thumbnail?.thumbnails;
    const thumbnailUrl = thumbs && thumbs.length ? thumbs[thumbs.length - 1].url : null;

    return {
      title,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      thumbnailUrl,
      meta: ytExtractText(renderer.metadata),
    };
  }

  function findShelfHeading(titleQuery) {
    return Array.from(document.querySelectorAll("*")).find(
      (el) => el.children.length === 0 && el.textContent.trim() === titleQuery
    );
  }

  // The dedicated "查看全部" (view all) page for a category renders the FULL list as a
  // <ytd-grid-renderer> of <ytd-grid-movie-renderer> items — verified against a real
  // logged-in page to hold hundreds of movies, far more than the ~16-item preview that
  // ytInitialData's shelfRenderer carries (that JSON teaser matches the homepage
  // carousel and doesn't grow on the view-all page). When this grid is present it's the
  // most complete source, so scanStorefront() tries this before the JSON teaser.
  function scanGridPage(titleQuery) {
    const heading = findShelfHeading(titleQuery);
    const section = heading?.closest("ytd-item-section-renderer, ytd-browse");
    const grid = section?.querySelector("ytd-grid-renderer");
    if (!grid) return null;

    const seenUrls = new Set();
    const movies = [];
    for (const item of grid.querySelectorAll("ytd-grid-movie-renderer")) {
      const link = item.querySelector("a#thumbnail, a[href*='/watch']");
      if (!link) continue;
      const url = new URL(link.getAttribute("href"), location.origin).toString();
      if (seenUrls.has(url)) continue;

      const title = item.querySelector("#video-title")?.textContent?.trim();
      if (!title) continue;

      seenUrls.add(url);
      movies.push({
        title,
        url,
        thumbnailUrl: item.querySelector("img")?.getAttribute("src") || null,
        meta: item.querySelector(".grid-movie-renderer-metadata")?.textContent?.trim() || null,
      });
    }
    return movies;
  }

  function scanDomShelf(titleQuery) {
    const heading = findShelfHeading(titleQuery);
    const container = heading?.closest("ytd-shelf-renderer, ytd-rich-shelf-renderer");
    if (!container) return null;

    const seenUrls = new Set();
    const movies = [];
    for (const link of container.querySelectorAll("a[href*='/watch']")) {
      const url = new URL(link.getAttribute("href"), location.origin).toString();
      if (seenUrls.has(url)) continue;

      const title =
        link.getAttribute("aria-label") ||
        link.closest("[class*='item']")?.querySelector("img[alt]")?.getAttribute("alt");
      if (!title) continue;

      seenUrls.add(url);
      movies.push({
        title,
        url,
        thumbnailUrl: link.querySelector("img")?.getAttribute("src") || null,
        meta: null,
      });
    }
    return movies;
  }

  function scanStorefront() {
    const gridMovies = scanGridPage(SHELF_TITLE);
    if (gridMovies) {
      return { movies: gridMovies, source: "grid", shelfFound: true, warning: null };
    }

    const data = typeof ytInitialData !== "undefined" ? ytInitialData : null;

    if (data) {
      const items = findShelfItems(data, SHELF_TITLE);
      if (items) {
        const movies = items.map(extractMovieFromJsonItem).filter(Boolean);
        return { movies, source: "ytInitialData", shelfFound: true, warning: null };
      }
    }

    const domMovies = scanDomShelf(SHELF_TITLE);
    if (domMovies) {
      return { movies: domMovies, source: "dom", shelfFound: true, warning: null };
    }

    return {
      movies: [],
      source: null,
      shelfFound: false,
      warning: `在目前頁面找不到「${SHELF_TITLE}」這個分類，請確認目前頁面是否為已登入的 storefront 頁面、且畫面上有捲動到該分類。`,
    };
  }

  return scanStorefront();
})();
