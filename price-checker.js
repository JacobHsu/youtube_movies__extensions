// Injected via chrome.scripting.executeScript({ files: ['price-checker.js'] }) into a
// movie's watch page after it finishes loading. Clicks the generic "購買或租看" button
// (which triggers YouTube's own /youtubei/v1/ypc/get_offers call and renders one button
// per purchase/rental option), then reads the HD purchase option's price straight out of
// its aria-label — verified against a real logged-in page, that label reads like:
//   "只要 $80.00即可購買 HD 高畫質的「電影」. 原價：$450.00。"
// (the "原價" clause is only present when there's a discount). Parsing the aria-label is
// far more reliable than the visible strikethrough markup, whose class names aren't
// public API.
(function () {
  const BANNER_ID = "__storefront_price_banner__";

  function showBanner(text) {
    let el = document.getElementById(BANNER_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = BANNER_ID;
      el.style.cssText =
        "position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#d7263d;" +
        "color:#fff;font-size:14px;font-family:system-ui,sans-serif;padding:10px 16px;" +
        "text-align:center;box-shadow:0 2px 6px rgba(0,0,0,.3);";
      document.body.appendChild(el);
    }
    el.textContent = text;
  }

  function findGenericBuyButton() {
    return Array.from(document.querySelectorAll("button")).find((btn) => {
      const label = (btn.getAttribute("aria-label") || btn.textContent || "").trim();
      return label === "購買或租看" || /^(購買或租看|購買|租看)$/.test(label);
    });
  }

  function parseOfferButtons() {
    return Array.from(document.querySelectorAll("button[aria-label]"))
      .map((btn) => {
        const label = btn.getAttribute("aria-label") || "";
        const saleMatch = label.match(/只要\s*([$NT￥,.\d]+)即可(購買|租看|租)/);
        if (!saleMatch) return null;
        const originalMatch = label.match(/原價[:：]\s*([$NT￥,.\d]+)/);
        return {
          isBuy: saleMatch[2] === "購買",
          isHD: /HD|高畫質/i.test(label),
          salePrice: saleMatch[1],
          originalPrice: originalMatch ? originalMatch[1] : null,
          label,
        };
      })
      .filter(Boolean);
  }

  function pickHdBuyOffer(offers) {
    return offers.find((o) => o.isBuy && o.isHD) || offers.find((o) => o.isBuy) || null;
  }

  // The batch "check every movie in the list" job (background.js) runs this in
  // active:false background tabs so it doesn't steal focus — but Chrome throttles
  // setTimeout in background/inactive tabs, so a short fixed retry budget that's plenty
  // in a normal foreground tab can run out before the offer buttons ever render here.
  // Poll generously and rely on the early-exit once found rather than a tight timeout.
  async function waitUntil(check, { attempts, delayMs }) {
    let value = check();
    for (let i = 0; i < attempts && !value; i++) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      value = check();
    }
    return value;
  }

  // Returns a plain result object (rather than just showing the banner) so this same
  // script doubles as the worker for the batch "check every movie in the list" job in
  // background.js — chrome.scripting.executeScript awaits a returned Promise and uses
  // its resolved value as the injection result.
  async function run() {
    showBanner("正在查詢 HD 購買價格…");

    let offer = pickHdBuyOffer(parseOfferButtons());

    if (!offer) {
      const buyButton = await waitUntil(findGenericBuyButton, {
        attempts: 20,
        delayMs: 500,
      });
      if (!buyButton) {
        showBanner("找不到「購買或租看」按鈕，可能此片目前無法購買。");
        return { found: false, reason: "no-buy-button" };
      }
      buyButton.click();

      offer = await waitUntil(() => pickHdBuyOffer(parseOfferButtons()), {
        attempts: 30,
        delayMs: 500,
      });
    }

    if (!offer) {
      showBanner("點開購買選單後仍找不到 HD 購買的價格資訊。");
      return { found: false, reason: "no-offer" };
    }

    const origNum = offer.originalPrice
      ? parseFloat(offer.originalPrice.replace(/[^\d.]/g, ""))
      : null;
    const saleNum = parseFloat(offer.salePrice.replace(/[^\d.]/g, ""));
    const percent =
      origNum && saleNum ? Math.round((1 - saleNum / origNum) * 100) : null;

    if (offer.originalPrice) {
      showBanner(
        `HD 購買特價 ${offer.salePrice}（原價 ${offer.originalPrice}` +
          (percent !== null ? `，省 ${percent}%` : "") +
          `）`
      );
    } else {
      showBanner(`HD 購買價 ${offer.salePrice}（目前無特價）`);
    }

    return {
      found: true,
      salePrice: offer.salePrice,
      originalPrice: offer.originalPrice,
      discounted: !!offer.originalPrice,
      percent,
    };
  }

  return run();
})();
