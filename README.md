# 翔天然網站（翔世界翔自在）

網站：https://lamp4615-design.github.io/business-xiang-tian-ran/　後台：[admin.html](admin.html)

## 翔天然整體資料夾結構（以翔天然為主軸）
這個專案（官網）放在 `C:\github\翔天然\` 底下，和翔天然相關的東西都集中在那一層：
```
C:\github\翔天然\
├─ 1-官網\          ← 你正在看的這個專案（GitHub：business-xiang-tian-ran，網站只放這裡的檔案）
├─ 2-分享天地\      ← 行銷推廣站（GitHub：share-corner，獨立的專案與網址）
├─ 3-行銷站範本\    ← 行銷站範本（目前只有本機，沒有 GitHub 遠端）
└─ 4-素材與工具\    ← 不屬於任何網站的工作檔：咖啡標籤（原圖）、咖啡QRcode、貼紙排版
```
三個網站專案各自是獨立的 Git 專案、各有各的網址，**不要合併成同一個專案**（合併會讓網址和已印好的 QR 貼紙失效）。
`4-素材與工具` 不會上傳到 GitHub，也不在 OneDrive 裡，請定期自己備份；其中「貼紙排版」用相對路徑讀同一層的「咖啡標籤」「咖啡QRcode」，**這三個資料夾要放在一起**；輸出檔可能含客人姓名，別放進網站。

## 這個專案（官網）的檔案
- `index.html`：前台網站（商品、風味輪、分享天地、會員中心）
- `admin.html`：管理後台（需 `ADMIN_KEY` 密碼）
- `backend/Code.gs`：Google Apps Script 後端。**修改後要貼進 Apps Script →「部署」→「管理部署作業」→ 編輯 → 版本選「新版本」**，網址才不會變
- `products.json`／`reviews.json`／`posts.json`：商品、風味評分、文章的靜態備份，由 `.github/workflows/update-products.yml` 自動從 Apps Script 抓（讓網站載入更快），**不要手動改**
- `build-seo.js`：替每個商品、每篇文章產生獨立網頁（`products/`、`articles/`、`explore/`）與 `sitemap.xml`，由上面的 Actions 自動執行，**這幾個資料夾與 sitemap 不要手動改**
- `images/`、`og-image.png`、`robots.txt`、`googlebd…html`：網站素材與 SEO

## 日常操作
**新增商品**
1. 後台「商品圖片」分頁上傳圖片（走 Cloudinary，自動縮圖），複製網址
2. 試算表 `products` 分頁新增一列：`id`、`name`、`price`、`image`（貼網址）、`active=true`（建議先 false，確認好再改 true）
3. 約 15 分鐘內網站會自動更新；急的話到 GitHub → Actions →「更新商品清單」→ Run workflow
4. 新品通知、最後預購、下架通知：觸發條件請設 `notifyProductChanges`（每小時）。`last_call` 填 TRUE＝寄最後預購；`active` 改 FALSE＝寄下架通知。只會寄給**同意收行銷通知**的會員，信尾有一鍵取消
5. 為新商品做 QR code：參考 `4-素材與工具\咖啡QRcode\連結清單.txt` 的格式

**集點流程**（出貨後在後台確認）
訂單進來是「待處理」→ 後台把狀態改「已完成」→ 自動依包數加點（一包一點，滿 10 點折 100，效期為最後消費起 3 個月）；改包數會補差額，改回待處理／已取消會扣回。

## 管理後台功能
- **訂單**：改包數、改狀態、匯出 CSV
- **會員**：會員編號、購買統計（頻率、客單價、常買品項）、點數、行銷同意、來源分析、客服紀錄、資料異動紀錄；可發驗證碼、調點、匯出單一會員資料、依個資法刪除（匿名化）
- **成本／盈餘報表**：成本分「銷貨成本／銷售費用／管理費用」，報表有毛利、淨利、損益兩平營收
- **內容**：發佈分享天地文章（站台代號 `xiang`）；圖片走 Cloudinary
- **商品圖片**：上傳商品圖，複製網址貼到試算表

## 會員與個資（重要）
- 登入只靠手機號碼，只回傳遮罩後的姓名；**購買紀錄登入後直接看**，**修改資料需驗證**（Email 驗證碼，或店家在後台「產生驗證碼」）
- 會員用**會員編號**識別（M0001…），手機可更換，訂單／點數／評分會一併轉移
- 行銷信**只寄給勾選同意的會員**；同意與取消都有紀錄。來源記錄第一次進站的管道，連結加 `?src=名稱` 可標記（例如 `?src=ig-bio`）
- 試算表新分頁（自動建立）：`member_log`（資料異動）、`member_notes`（客服紀錄）。**不要手動改 members 的新欄位**（會員編號、行銷同意、同意時間、來源、狀態）
- 後台密碼：Apps Script →「專案設定」→「指令碼屬性」新增 `ADMIN_KEY`；`SESSION_SECRET` 會自動產生，**不要刪**（刪了所有會員的驗證憑證會失效）

## SEO 優化紀錄與現況（改網站前先看這裡，不用重新檢查）
**已完成**
- 首頁：title／description／OG 分享圖（og-image.png）／Twitter 卡／Organization＋WebSite 結構化資料／canonical；頁尾有 `explore/` 連結
- `build-seo.js` 自動產生：商品頁（Product＋BreadcrumbList）、文章頁（Article）、`explore/` 總覽、`sitemap.xml`（16 個網址）
- 商品頁多一段「怎麼沖比較好喝＋常見問題」（`guideOf()`，由處理法／烘焙度／風味自動帶入；只寫通用知識，不寫運費、出貨、退換貨）
- 2026-10-15 健檢：sitemap 16 個網址全部 200、標題無重複、robots 正確、首頁圖片都有 alt

**Search Console 現況（2026-10-15）**：首頁與 `explore/` 已收錄；商品頁即時測試通過、Product 資料有效；sitemap 狀態顯示「無法擷取」是 GSC 常見假象，頁面已被收錄，**不用重新提交**

**不要動**
- 商品頁網址用舊的商品代號（例：`/products/黑糖月光/` 其實是「琥珀法月」）。改網址會讓已收錄的連結失效，除非要做轉址，否則別改
- 不要手動改 `products/`、`articles/`、`explore/`、`sitemap.xml`（Actions 會覆蓋）

**待辦（依效益排序）**
1. 文章補到 800 字以上（目前約 400 字，容易被視為內容薄）——需要店家自己寫
2. 每款豆子加「自己的故事」（農場、海拔、選豆原因）——需要店家提供
3. 商品圖改用 Cloudinary（目前部分還是 Google 雲端硬碟縮圖，慢且社群分享常讀不到）
4. 首頁有 2 個 H1（單頁應用切換畫面造成），之後可整理成只留一個
5. 評估購買專屬網域（綁定 GitHub Pages；換網址要先規劃轉址）
6. 建立 Google 商家檔案、從 FB／IG 導連結過來

## 注意
- 不要在公開的 GitHub 放客人資料、後台密碼、Cloudinary 的 API Secret
- Apps Script 偶爾冷啟動很慢，所以網站優先讀靜態 json，再背景向 Apps Script 更新
