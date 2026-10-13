# 翔天然網站（翔世界翔自在）

網站：https://lamp4615-design.github.io/business-xiang-tian-ran/　後台：[admin.html](admin.html)

## 資料夾說明
**會公開上傳到網站的（GitHub Pages）**
- `index.html`：前台網站（商品、風味輪、分享天地、會員中心）
- `admin.html`：管理後台（需 `ADMIN_KEY` 密碼）
- `backend/Code.gs`：Google Apps Script 後端。**修改後要貼進 Apps Script →「部署」→「管理部署作業」→ 編輯 → 版本選「新版本」**，網址才不會變
- `products.json`／`reviews.json`／`posts.json`：商品、風味評分、文章的靜態備份，由 `.github/workflows/update-products.yml` 自動從 Apps Script 抓（讓網站載入更快），**不要手動改**
- `images/`、`og-image.svg`、`sitemap.xml`、`robots.txt`、`googlebd…html`：網站素材與 SEO

**工作用、不會上傳**（已寫進 `.gitignore`）
- `咖啡標籤/`：各品項的標籤原圖
- `咖啡QRcode/`：每個品項的 QR code 與列印貼紙（連結格式 `網址/?p=商品名稱#flavor`）
- `貼紙排版/`：貼紙排版小工具（`node layout.js 品項名…`），它用相對路徑讀 `咖啡標籤/`、`咖啡QRcode/`，**這兩個資料夾不要搬位置**；輸出檔可能含客人姓名，別放進網站
- `分享天地/`：另一個獨立的小專案

## 日常操作
**新增商品**
1. 後台「商品圖片」分頁上傳圖片（走 Cloudinary，自動縮圖），複製網址
2. 試算表 `products` 分頁新增一列：`id`、`name`、`price`、`image`（貼網址）、`active=true`（建議先 false，確認好再改 true）
3. 約 15 分鐘內網站會自動更新；急的話到 GitHub → Actions →「更新商品清單」→ Run workflow
4. 新品通知、最後預購、下架通知：觸發條件請設 `notifyProductChanges`（每小時）。`last_call` 填 TRUE＝寄最後預購；`active` 改 FALSE＝寄下架通知。只會寄給**同意收行銷通知**的會員，信尾有一鍵取消
5. 為新商品做 QR code：參考 `咖啡QRcode/連結清單.txt` 的格式

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

## 注意
- 不要在公開的 GitHub 放客人資料、後台密碼、Cloudinary 的 API Secret
- Apps Script 偶爾冷啟動很慢，所以網站優先讀靜態 json，再背景向 Apps Script 更新
