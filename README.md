# YouTube Storefront 本週發燒特惠清單

Chrome 擴充功能。手動掃描 YouTube Storefront 頁面上「本週發燒特惠」分類，在背景查出每部電影 HD 購買的特價資訊，清單上**只留下確認有特價的電影**。

![特價電影自動篩到只剩真划算](promo/promo-hero.png)
![四個步驟：掃描、背景查價、自動篩選、一鍵前往購買](promo/promo-howitworks.png)

## 為什麼要用擴充功能

`https://www.youtube.com/feed/storefront` 顯示的內容（含分類、片單、價格）都跟登入帳號有關。擴充功能的 content script 是在你自己已登入的分頁裡執行，能直接讀到瀏覽器已經算繪出來、屬於你帳號的真實內容，不需要另外處理登入或 cookie。

## 安裝方式

1. 開啟 `chrome://extensions`
2. 右上角開啟「開發人員模式」
3. 點「載入未封裝項目」，選擇本專案資料夾

## 使用方式

1. 登入 YouTube 帳號，開啟 `https://www.youtube.com/feed/storefront`
2. 捲動頁面，讓「本週發燒特惠」分類至少載入過一次（不需要一直停留在畫面上）
3. 點擴充功能圖示 → 按「掃描目前頁面」
4. 清單只會顯示 **2015～2022 年**的電影（本週發燒特惠目前約 190 部左右符合；2023 年之後的新片特價通常不深、2000 年以前太舊，都直接不列出），依年份新到舊排序
5. 清單裡每一部一開始都顯示「查價排隊中…」，背景會依序查詢每部的 HD 購買價格，進度列會即時顯示「正在查詢價格… 42/189（已耗時 3:12）」。**只要查到某部沒有特價、或特價金額超過 NT$150，就會直接從清單移除**，最後留下來的都是確認有特價、而且划算的電影。全部查完通常要好幾分鐘，不需要一直開著 popup 等——關掉再打開會照上次查到的結果繼續顯示，也會自動接著查還沒查完的部分。
6. 查過的結果會快取在瀏覽器本機（`chrome.storage.local`），24 小時內重新掃描不會重查同一部；超過 24 小時的快取視為過期，會自動排進佇列重新查一次（因為「本週」特惠本來就會輪替，快取太久容易顯示過期資訊）。
7. 點清單裡任一項目：會另外開一個新分頁前往該電影頁面並自動點「購買或租看」，在頁面最上方顯示一個橫幅立刻告訴你 HD 購買價格（適合單獨重查某一部）。

## 運作原理

### 掃描清單（scanner.js）
- 讀取頁面即時的 `window.ytInitialData`（YouTube 內部資料結構，用 `chrome.scripting.executeScript` 的 `world: "MAIN"` 在頁面自己的 JS context 執行才能讀到）。這個物件會隨著使用者捲動、由 YouTube 前端 JS 動態合併進更多分類資料，因此比解析初始 HTML 內嵌的 `<script>` 標籤更完整。
- 優先偵測「本週發燒特惠」旁邊是否有「查看全部」的完整格狀清單（`ytd-grid-renderer`），有的話直接讀取 DOM 裡實際渲染出來的全部項目（可能有數百部）；沒有的話（例如首頁捲動看到的橫向 shelf，固定只有 16 部預覽）才退回讀取 `ytInitialData` 裡的 JSON 預覽資料，最後才是純 DOM 掃描。

### 查價格（price-checker.js）
- 找到「購買或租看」按鈕並點擊它——這會觸發 YouTube 自己的內部 API（`/youtubei/v1/ypc/get_offers`），把畫面上原本的單一按鈕換成好幾個「租看 SD／HD、購買 SD／HD」的個別按鈕。接著從中找出「購買 HD」那顆按鈕的 `aria-label`（例如「只要 $80.00即可購買 HD 高畫質的「電影」. 原價：$450.00。」），用正規表達式解析出特價與原價，比起去抓畫面上劃線文字的 CSS class 可靠很多（class name 不是公開 API，容易隨改版失效；`aria-label` 是無障礙輔助用途的語意文字，相對穩定）。
- 找按鈕、等選單出現都用輪詢（最多各等約 10 秒、15 秒），不是固定等一下就放棄——背景批次查價用的是不搶焦點的分頁（`active:false`），Chrome 對背景分頁的 `setTimeout` 會節流，同樣的等待邏輯在背景分頁裡可能比前景分頁慢好幾倍，等太短會把明明有特價的電影誤判成查無資料而整部移除。

### 背景批次查價與清單自動篩選（background.js + popup.js）
- 掃描完成後，`popup.js` 只把 **2015～2022 年**範圍內的電影建成清單並存進 `chrome.storage.local`（`lastScanMovies`），同時丟給背景 service worker（`background.js`）排隊查價；點清單裡單一項目則是走另一條即時查價路徑（開分頁＋顯示橫幅）。這兩種情況都經過 background.js 處理，而不是 popup.js 自己等待，因為 popup 視窗會在新分頁搶走焦點的瞬間就被關閉，沒辦法自己等分頁載入完成或維持很久。
- 批次查價會**依序**（不是同時）用不會搶走你畫面焦點的背景分頁（`active: false`）逐一開啟每部電影、注入 `price-checker.js`、拿到結果後關閉分頁，換下一部，藉此避免一次消耗太多資源，也降低被 YouTube 判定為異常自動化行為的機率；`background.js` 會記錄這輪查詢開始的時間戳記（`startedAt`），popup 每秒重算一次「已耗時」顯示。
- 查詢結果與進度存在 `chrome.storage.local`（`priceCache` / `priceJob`），popup 用 `chrome.storage.onChanged` 監聽即時更新畫面：**查到「有特價」才保留、更新文字；查到「沒特價」或「查無資訊」就直接把該項目從清單移除**。
- popup 開啟時（不只是按下「掃描」之後）都會讀取上次存的 `lastScanMovies` 清單重新畫出來，並重新把候選清單送一次給 background——`enqueueMovies()` 會用快取跳過已經查過的項目，所以這只是廉價的補送，但也讓查詢在 service worker 被瀏覽器回收、批次中途中斷時能自動接著查，不會卡住不動。
- 如果背景查價途中再按一次「掃描目前頁面」，新掃到的候選電影會被併進同一個查詢佇列，不會蓋掉或中斷原本正在跑的查詢。

## 檔案結構

| 檔案 | 用途 |
|---|---|
| `manifest.json` | MV3 設定檔（權限、popup 進入點、background service worker） |
| `popup.html` / `popup.css` | 擴充功能彈出視窗介面 |
| `popup.js` | 檢查目前分頁是否為 storefront、觸發掃描、年份篩選、渲染清單／進度、依查價結果移除項目、還原上次清單 |
| `scanner.js` | 實際注入分頁執行的掃描邏輯（grid 全部項目 + JSON 預覽 + DOM 備援） |
| `background.js` | 背景 service worker：單片即時查價、以及背景批次查價佇列（含耗時起始時間） |
| `price-checker.js` | 注入電影頁面：點擊購買按鈕、解析 HD 購買價格、顯示橫幅並回傳結果 |

## 已知限制

- YouTube 內部 JSON 欄位名稱、DOM class、`aria-label` 文字格式並非公開文件、可能隨改版變動；若某天抓不到結果，多半是對應檔案裡的定位/解析邏輯需要對照當下真實頁面調整。
- 只掃描「本週發燒特惠」這個分類，其他分類（例如「暢銷電影」）目前不會被列出。
- 只顯示／自動查 **2015～2022 年**的電影（約 190 部上下），這個年份門檻寫死在 `popup.js` 的 `PRICE_CHECK_MIN_YEAR` / `PRICE_CHECK_MAX_YEAR_EXCLUSIVE`，要調整範圍可以直接改這兩個常數。
- 特價查詢只鎖定「HD 購買」選項，不會顯示 SD 或租看的價格；查到沒特價、或特價超過 `PRICE_CHECK_MAX_SALE_PRICE`（目前 NT$150，寫在 `popup.js`）的電影會直接消失，不會留著顯示。
- 查價結果快取 `PRICE_CACHE_TTL_MS`（目前 24 小時，寫在 `popup.js` 和 `background.js`，兩處數值要手動保持一致）後視為過期並自動重查；在這之前重新掃描不會重打同一部電影的查價流程。
- 背景批次查價是 MV3 service worker 裡的長時間迴圈，如果瀏覽器在查價途中把 service worker 回收，批次會中斷；已經查到的結果不會遺失（存在 `chrome.storage.local`），下次打開 popup（不用重新按掃描）就會自動接著查還沒查過的部分。

## 參考

[youtube 電影](https://www.youtube.com/feed/storefront)
