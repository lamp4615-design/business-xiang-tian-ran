# 翔天然網站（翔世界翔自在）

- `index.html.html`：前端網站（部署到 Netlify）
- `backend/Code.gs`：Google Apps Script 後台（貼到 Apps Script，修改後要「管理部署 → 新版本」重新部署）
- `新增資料夾*`：舊版備份，只保留不維護

## 集點流程
1. 顧客下單 → 前端送 `action:"order"`（含 `bags` 包數）
2. 後台 `addOrder` 寫入訂單並立刻 `pointsAdd`，在 orders「已加點」欄標 true
3. 前端 `addPendingPoints` 立即顯示點數，之後 `fetchMyStats` 以後台為準
4. `onEdit`（狀態改「已完成」）只補加尚未加點的舊訂單

規則：一包一點，滿 10 點折 100，效期為最後消費起 3 個月。
