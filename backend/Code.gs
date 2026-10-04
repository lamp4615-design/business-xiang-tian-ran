/*************************************************************************
 * 翔天然 — 後台 API（Google Apps Script + Google 試算表）
 *
 *   GET  ?action=products            → 商品清單
 *   GET  ?action=login&phone=xxxx    → 用手機比對會員（登入）
 *   POST {action:"join"}             → 寫入會員
 *   POST {action:"order"}            → 寫入訂單、自動加點，並自動寄 Email 通知你
 *************************************************************************/

// ── 貼上你的試算表 ID ─────────────────────────────────────────────
const SHEET_ID = "13eKgaxdYNDzOiy8GHpje7Ze2wvPrZRXK_zgmvh2idOc";

// ── 訂單通知會寄到這個信箱（要改就改這裡）─────────────────────────
const NOTIFY_EMAIL = "lamp4615@gmail.com";

// ── 你的網站網址（新品通知信裡會附上這個連結）─────────────────────
const SITE_URL = "https://lamp4615-design.github.io/xiang-natural";

const PRODUCTS_TAB  = "products";
const MEMBERS_TAB   = "members";
const ORDERS_TAB    = "orders";
const REVIEWS_TAB   = "reviews";
const POINTS_TAB    = "points";
const POINT_EXPIRE_MONTHS = 3;   // 點數效期：最後一次消費起算幾個月
const COSTS_TAB     = "costs";
const DASHBOARD_TAB = "總覽";


/* ========================= 讀取 ========================= */
function doGet(e){
  const p = (e && e.parameter) || {};
  const action = p.action || "products";
  if (action === "products") return json(getProducts());
  if (action === "login")    return json(findMember(p.phone));
  if (action === "reviews")  return json(getReviews());
  if (action === "mystats")  return json(getMyStats(p.phone));
  return json({ ok:false, error:"unknown action" });
}

function getProducts(){
  const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(PRODUCTS_TAB);
  if (!sh) return [];
  const rows = sh.getDataRange().getValues();
  if (rows.length < 2) return [];
  const head = rows.shift().map(h => String(h).trim());
  const at = name => head.indexOf(name);
  const out = [];
  rows.forEach(r => {
    const id = r[at("id")];
    if (!id) return;
    const active = r[at("active")];
    if (active === false || String(active).toLowerCase() === "false" || String(active).toLowerCase() === "no") return;
    const spec = (l, v) => ({ label: String(r[at(l)] || ""), value: String(r[at(v)] || "") });
    const specs = [ spec("spec1_label","spec1_value"), spec("spec2_label","spec2_value"), spec("spec3_label","spec3_value") ]
                  .filter(s => s.label && s.value);
    out.push({
      id: String(id), category: String(r[at("category")] || "其他"), name: String(r[at("name")] || ""),
      subtitle: String(r[at("subtitle")] || ""), price: Number(r[at("price")]) || 0, unit: String(r[at("unit")] || ""),
      image: toImageUrl(r[at("image")]), hue: String(r[at("hue")] || "green"), badge: String(r[at("badge")] || ""),
      tags: String(r[at("tags")] || "").split(",").map(s => s.trim()).filter(Boolean), specs: specs
    });
  });
  return out;
}

/* 圖片欄位：貼 Google 雲端硬碟分享連結會自動轉成可顯示的網址；
   一般圖片網址或相對路徑（如 images/a.jpg）則原樣使用。 */
function toImageUrl(s){
  s = String(s || "").trim();
  if (!s) return "";
  var m = s.match(/drive\.google\.com\/file\/d\/([^\/]+)/) || s.match(/[?&]id=([^&]+)/);
  if (m) return "https://drive.google.com/thumbnail?id=" + m[1] + "&sz=w1000";
  return s;
}

/* 用手機查會員（比對時忽略開頭 0 與符號） */
function findMember(phone){
  const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(MEMBERS_TAB);
  if (!sh) return { found:false };
  const norm = s => String(s || "").replace(/\D/g, "").replace(/^0+/, "");
  const key = norm(phone);
  if (!key) return { found:false };
  const rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++){
    if (norm(rows[i][2]) === key){
      return { found:true, name:String(rows[i][1]), phone:String(rows[i][2]), city:String(rows[i][3]), email:String(rows[i][4]||"") };
    }
  }
  return { found:false };
}


/* ========================= 寫入 ========================= */
function doPost(e){
  try{
    const d = JSON.parse(e.postData.contents);
    if (d.action === "join")  { addMember(d); return json({ ok:true }); }
    if (d.action === "order") { addOrder(d);  return json({ ok:true }); }
    if (d.action === "review"){ addReview(d); return json({ ok:true }); }
    if (String(d.action || "").indexOf("admin_") === 0) return json(adminHandle(d));
    return json({ ok:false, error:"unknown action" });
  }catch(err){
    return json({ ok:false, error:String(err) });
  }
}

function addMember(d){
  const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(MEMBERS_TAB);
  sh.appendRow([ new Date(), d.name || "", "", d.city || "", d.email || "" ]);
  setTextCell(sh, sh.getLastRow(), 3, d.phone);
}

function addOrder(d){
  const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(ORDERS_TAB);
  // 欄位：建立時間/姓名/手機/所在地區/訂購內容/金額/狀態/包數/已加點
  // 點數不在下單時加；你把「狀態」改成「已完成」時才會自動加（見 onEdit）
  sh.appendRow([ new Date(), d.name || "", "", d.city || "", d.items || "", Number(d.total) || 0, "待處理", Number(d.bags) || parseBags(d.items), 0 ]);
  setTextCell(sh, sh.getLastRow(), 3, d.phone);
  notifyOrder(d);   // 寄 Email 通知
}

/* 新訂單 Email 通知 */
function notifyOrder(d){
  try{
    var subject = "【翔天然】新訂單 — " + (d.name || "");
    var lines = [
      "你有一筆新訂單：", "",
      "姓名：" + (d.name || ""),
      "手機：" + (d.phone || ""),
      "地區：" + (d.city || ""),
      "內容：" + (d.items || ""),
      "金額：NT$ " + (Number(d.total) || 0),
      "時間：" + new Date().toLocaleString("zh-TW"), "",
      "— 訂單也已存入試算表 orders 分頁。"
    ];
    MailApp.sendEmail(NOTIFY_EMAIL, subject, lines.join("\n"));
  }catch(err){ /* 寄信失敗不影響訂單寫入 */ }
}


/* ========================= 新品上架通知 ========================= */
/* 用法：在 products 分頁新增/上架商品後，執行這個函式（或設定時間觸發器自動跑），
   就會把「尚未通知過」的上架商品，寄信給所有「有填 Email」的會員。
   寄過的商品會在 products 分頁自動標記 notified=TRUE，不會重複通知。 */
function notifyNewProducts(){
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const psh = ss.getSheetByName(PRODUCTS_TAB);
  if (!psh) return;
  const rows = psh.getDataRange().getValues();
  if (rows.length < 2) return;
  const head = rows.shift().map(h => String(h).trim());
  const at = name => head.indexOf(name);
  const notifiedCol = at("notified");

  const newOnes = []; // { rowIndex(試算表實際列號), name, subtitle, price, unit }
  rows.forEach((r, i) => {
    const id = r[at("id")];
    if (!id) return;
    const active = r[at("active")];
    const isActive = !(active === false || String(active).toLowerCase() === "false" || String(active).toLowerCase() === "no");
    const notified = notifiedCol > -1 ? r[notifiedCol] : "";
    const alreadyNotified = notified === true || String(notified).toLowerCase() === "true";
    if (isActive && !alreadyNotified){
      newOnes.push({
        sheetRow: i + 2, // +1 表頭 +1 從0起算
        name: String(r[at("name")] || ""),
        subtitle: String(r[at("subtitle")] || ""),
        price: Number(r[at("price")]) || 0,
        unit: String(r[at("unit")] || "")
      });
    }
  });
  if (!newOnes.length) return; // 沒有新上架商品，不用寄信

  // 找出所有「有填 Email」的會員
  const msh = ss.getSheetByName(MEMBERS_TAB);
  const emails = [];
  if (msh){
    const mrows = msh.getDataRange().getValues();
    for (let i = 1; i < mrows.length; i++){
      const email = String(mrows[i][4] || "").trim();
      if (email) emails.push(email);
    }
  }

  if (emails.length){
    const subject = "【翔天然】新品上架囉 ☕";
    const lines = ["翔天然又有新豆子上架了：", ""];
    newOnes.forEach(p => {
      lines.push("・" + p.name + (p.subtitle ? "（" + p.subtitle + "）" : "") + " — NT$ " + p.price + (p.unit ? "/" + p.unit : ""));
    });
    lines.push("", "去看看：" + SITE_URL + "/#products", "", "— 翔天然，翔自在");
    const body = lines.join("\n");
    emails.forEach(addr => {
      try{ MailApp.sendEmail(addr, subject, body); }catch(err){ /* 單一信箱失敗不影響其他人 */ }
    });
  }

  // 標記這些商品為「已通知」，避免下次重複寄信
  if (notifiedCol > -1){
    newOnes.forEach(p => psh.getRange(p.sheetRow, notifiedCol + 1).setValue(true));
  }
}

/* ========================= 風味評分（五軸） ========================= */
const FLAVOR_AXES = ["aroma","acidity","sweetness","body","bitterness"];
// 對應 reviews 分頁欄位順序：建立時間/手機/品項/香氣/酸質/甜感/醇厚度/苦味

function getReviews(){
  const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(REVIEWS_TAB);
  if (!sh) return [];
  const rows = sh.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < rows.length; i++){
    if (!rows[i][2]) continue; // 沒品項的空列略過
    out.push({
      time:      rows[i][0] ? new Date(rows[i][0]).toISOString() : "",
      product:   String(rows[i][2]),
      aroma:     Number(rows[i][3]) || 0,
      acidity:   Number(rows[i][4]) || 0,
      sweetness: Number(rows[i][5]) || 0,
      body:      Number(rows[i][6]) || 0,
      bitterness:Number(rows[i][7]) || 0
      // 手機不回傳給前端，只用來後台防重複評分／辨識，保護隱私
    });
  }
  return out;
}

function addReview(d){
  const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(REVIEWS_TAB);
  sh.appendRow([ new Date(), "", d.product || "",
    Number(d.aroma) || 0, Number(d.acidity) || 0, Number(d.sweetness) || 0,
    Number(d.body) || 0, Number(d.bitterness) || 0 ]);
  setTextCell(sh, sh.getLastRow(), 2, d.phone);   // 手機存完整（文字），只在後台看得到
}

/* ========================= 抽獎券 / 抽獎 ========================= */
/* 會員的抽獎券 = 他評過的「不同品項」數量（鼓勵嘗試更多豆子） */
function getMyStats(phone){
  const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(REVIEWS_TAB);
  const norm = s => String(s || "").replace(/\D/g, "").replace(/^0+/, "");
  const key = norm(phone);
  if (!sh || !key) return { found:false, tickets:0, products:[] };
  const rows = sh.getDataRange().getValues(); // 建立時間/手機/品項/...
  const set = {};
  for (let i = 1; i < rows.length; i++){
    if (norm(rows[i][1]) === key){
      const product = String(rows[i][2] || "").trim();
      if (product) set[product] = true;
    }
  }
  const products = Object.keys(set);
  const pts = readPoints(phone);
  return { found:true, tickets:products.length, products:products, points:pts.points, pointsExpiry:pts.expiry };
}

/* 讀取某會員目前有效的點數（過期則回傳 0） */
function readPoints(phone){
  const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(POINTS_TAB);
  const norm = s => String(s || "").replace(/\D/g, "").replace(/^0+/, "");
  const key = norm(phone);
  if (!sh || !key) return { points:0, expiry:"" };
  const rows = sh.getDataRange().getValues(); // 手機/點數/到期日/最後消費日
  for (let i = 1; i < rows.length; i++){
    if (norm(rows[i][0]) === key){
      const bal = Number(rows[i][1]) || 0;
      const exp = rows[i][2] ? new Date(rows[i][2]) : null;
      if (exp && new Date() > exp) return { points:0, expiry:"" };   // 已過期
      return { points:bal, expiry: exp ? exp.toISOString() : "" };
    }
  }
  return { points:0, expiry:"" };
}

/* 調整某會員的點數。delta>0 加點（過期舊點數先歸零，效期從今天起算 POINT_EXPIRE_MONTHS 個月）；
   delta<0 扣點（最低扣到 0，不動效期）。 */
function pointsAdjust(ss, phone, delta){
  delta = Number(delta) || 0;
  if (delta === 0) return;
  const norm = s => String(s || "").replace(/\D/g, "").replace(/^0+/, "");
  const key = norm(phone);
  if (!key) return;
  let sh = ss.getSheetByName(POINTS_TAB);
  if (!sh){ sh = ss.insertSheet(POINTS_TAB); sh.appendRow(["手機","點數","到期日","最後消費日"]); }
  const now = new Date();
  const expiry = new Date(now.getFullYear(), now.getMonth() + POINT_EXPIRE_MONTHS, now.getDate());
  const rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++){
    if (norm(rows[i][0]) === key){
      const oldExp = rows[i][2] ? new Date(rows[i][2]) : null;
      const cur = (oldExp && now > oldExp) ? 0 : (Number(rows[i][1]) || 0);
      sh.getRange(i+1, 2).setValue(Math.max(0, cur + delta));
      if (delta > 0){
        sh.getRange(i+1, 3).setValue(expiry);
        sh.getRange(i+1, 4).setValue(now);
      }
      return;
    }
  }
  if (delta < 0) return;   // 沒有紀錄的人不用扣
  sh.appendRow(["", delta, expiry, now]);
  setTextCell(sh, sh.getLastRow(), 1, phone);
}
function pointsAdd(ss, phone, pts){ pointsAdjust(ss, phone, Math.max(0, Number(pts) || 0)); }

/* 從訂購內容文字（如「阿里山 x2、緬甸精品 x1」）粗估總包數，作為沒有「包數」欄位時的備援 */
function parseBags(text){
  text = String(text || "");
  const re = /x\s*(\d+)/gi;
  let m, sum = 0;
  while ((m = re.exec(text)) !== null) sum += Number(m[1]) || 0;
  return sum;
}

/* 抽獎：在 Apps Script 手動執行這個函式，會依「抽獎券數（評過的不同豆子數）」
   加權隨機抽出一位中獎會員，並把結果與名單寄到你的信箱。
   券越多的人中獎機率越高。 */
function drawWinner(){
  const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(REVIEWS_TAB);
  if (!sh){ MailApp.sendEmail(NOTIFY_EMAIL, "【翔天然】抽獎", "找不到 reviews 分頁，無法抽獎。"); return; }
  const rows = sh.getDataRange().getValues();
  const map = {}; // phone -> { product:true }
  for (let i = 1; i < rows.length; i++){
    const phone = String(rows[i][1] || "").trim();
    const product = String(rows[i][2] || "").trim();
    if (!phone || !product) continue;
    (map[phone] = map[phone] || {})[product] = true;
  }
  const entries = Object.keys(map).map(ph => ({ phone: ph, tickets: Object.keys(map[ph]).length }));
  if (!entries.length){ MailApp.sendEmail(NOTIFY_EMAIL, "【翔天然】抽獎", "目前沒有會員評分紀錄，無法抽獎。"); return; }

  // 依券數加權隨機
  const pool = [];
  entries.forEach(e => { for (let k = 0; k < e.tickets; k++) pool.push(e.phone); });
  const winner = pool[Math.floor(Math.random() * pool.length)];

  entries.sort((a, b) => b.tickets - a.tickets);
  const lines = ["翔天然 抽獎結果", "", "中獎手機：" + winner, "",
                 "—— 目前抽獎券統計（依評過的不同豆子數）——"];
  entries.forEach(e => lines.push(e.phone + "：" + e.tickets + " 張"));
  lines.push("", "（可到 members 分頁用這支手機，找到中獎會員的姓名與聯絡方式）");
  MailApp.sendEmail(NOTIFY_EMAIL, "【翔天然】抽獎結果 — 中獎：" + winner, lines.join("\n"));
}

/* ========================= 訂單處理 → 自動加點 =========================
 * 管理者網頁（或你直接在試算表）操作：
 *   1. 狀態選「已完成」          → 依「包數」幫會員加點，「已加點」欄自動記下已加的點數
 *   2. 之後改「包數」             → 自動補差額（例如 4 改 3，會扣回 1 點）
 *   3. 狀態改回「待處理／已取消」 → 已加的點數自動扣回，「已加點」歸零
 * 「已加點」欄是系統記帳用，請勿手動輸入。 */

/* 依該列目前的「狀態」「包數」對帳並調整點數（onEdit 與管理者網頁共用） */
function syncOrderPoints(ss, sh, row){
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(x => String(x).trim());
  const statusCol  = headers.indexOf("狀態") + 1;
  const phoneCol   = headers.indexOf("手機") + 1;
  const bagsCol    = headers.indexOf("包數") + 1;
  const itemsCol   = headers.indexOf("訂購內容") + 1;
  const awardedCol = headers.indexOf("已加點") + 1;
  if (!statusCol || !phoneCol || !awardedCol) return;

  const status = String(sh.getRange(row, statusCol).getValue()).trim();
  const phone  = String(sh.getRange(row, phoneCol).getValue());
  let bags = bagsCol ? Number(sh.getRange(row, bagsCol).getValue()) : 0;
  if (!bags || bags < 0){
    bags = parseBags(itemsCol ? sh.getRange(row, itemsCol).getValue() : "");
  }
  const rawAwarded = sh.getRange(row, awardedCol).getValue();
  // 舊資料的 TRUE 視為「已照包數加過」；其餘當成數字
  const awarded = (rawAwarded === true || String(rawAwarded).toLowerCase() === "true") ? bags : (Number(rawAwarded) || 0);

  const target = (status === "已完成") ? bags : 0;
  const delta = target - awarded;
  if (delta !== 0 && phone) pointsAdjust(ss, phone, delta);
  sh.getRange(row, awardedCol).setValue(phone ? target : awarded);
}

function onEdit(e){
  try{
    if (!e || !e.range) return;
    const sh = e.range.getSheet();
    if (sh.getName() !== ORDERS_TAB) return;
    if (e.range.getNumRows() !== 1 || e.range.getNumColumns() !== 1) return;   // 只處理單一儲存格編輯
    const row = e.range.getRow();
    if (row === 1) return;
    const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(x => String(x).trim());
    const col = e.range.getColumn();
    if (col !== headers.indexOf("狀態") + 1 && col !== headers.indexOf("包數") + 1) return;

    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try{ syncOrderPoints(e.source, sh, row); } finally { lock.releaseLock(); }
  }catch(err){ /* 靜默失敗，不影響手動編輯 */ }
}


/* ========================= 管理者 API（管理者網頁 admin.html 使用） =========================
 * 密碼不寫在程式碼裡：Apps Script →「專案設定」→「指令碼屬性」新增  ADMIN_KEY = 你的密碼。
 * 全部走 POST：{action:"admin_xxx", key:"密碼", ...} */
const COST_CATEGORIES = ["生豆","濾紙","包裝袋","運費","其他"];
const ORDER_STATUSES  = ["待處理","已完成","已取消"];

function adminAuthOk(key){
  const real = PropertiesService.getScriptProperties().getProperty("ADMIN_KEY");
  return !!real && String(key || "") === real;
}

function adminHandle(d){
  if (!adminAuthOk(d.key)) return { ok:false, error:"unauthorized" };
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try{
    if (d.action === "admin_ping") return { ok:true, categories:COST_CATEGORIES, statuses:ORDER_STATUSES };
    if (d.action === "admin_orders") return { ok:true, orders:adminListOrders(ss) };
    if (d.action === "admin_update_order") return adminUpdateOrder(ss, d);
    if (d.action === "admin_costs") return { ok:true, costs:adminListCosts(ss) };
    if (d.action === "admin_add_cost") return adminAddCost(ss, d);
    if (d.action === "admin_delete_cost") return adminDeleteCost(ss, d);
    return { ok:false, error:"unknown admin action" };
  } finally { lock.releaseLock(); }
}

function adminListOrders(ss){
  const sh = ss.getSheetByName(ORDERS_TAB);
  if (!sh || sh.getLastRow() < 2) return [];
  const rows = sh.getDataRange().getValues();
  const head = rows[0].map(h => String(h).trim());
  const at = n => head.indexOf(n);
  const out = [];
  for (let i = 1; i < rows.length; i++){
    const r = rows[i];
    if (!r[at("訂購內容")] && !r[at("金額")]) continue;
    out.push({
      row: i + 1,
      time: r[at("建立時間")] ? new Date(r[at("建立時間")]).toISOString() : "",
      name: String(r[at("姓名")] || ""),
      phone: String(r[at("手機")] || ""),
      city: String(r[at(head.indexOf("寄送地址") > -1 ? "寄送地址" : "所在地區")] || ""),
      items: String(r[at("訂購內容")] || ""),
      total: Number(r[at("金額")]) || 0,
      status: String(r[at("狀態")] || "待處理"),
      bags: Number(r[at("包數")]) || 0,
      awarded: Number(r[at("已加點")]) || 0
    });
  }
  return out.reverse();   // 新的在前
}

function adminUpdateOrder(ss, d){
  const sh = ss.getSheetByName(ORDERS_TAB);
  const row = Number(d.row);
  if (!sh || !row || row < 2 || row > sh.getLastRow()) return { ok:false, error:"bad row" };
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(x => String(x).trim());
  if (d.status !== undefined){
    if (ORDER_STATUSES.indexOf(d.status) < 0) return { ok:false, error:"bad status" };
    sh.getRange(row, headers.indexOf("狀態") + 1).setValue(d.status);
  }
  if (d.bags !== undefined){
    const b = Math.floor(Number(d.bags));
    if (!(b >= 0)) return { ok:false, error:"bad bags" };
    sh.getRange(row, headers.indexOf("包數") + 1).setValue(b);
  }
  syncOrderPoints(ss, sh, row);   // 程式改儲存格不會觸發 onEdit，所以這裡主動對帳
  return { ok:true };
}

function costsSheet(ss){
  let c = ss.getSheetByName(COSTS_TAB) || ss.insertSheet(COSTS_TAB);
  if (c.getLastRow() === 0) c.appendRow(["日期","項目","分類","金額","備註"]);
  return c;
}

function adminListCosts(ss){
  const sh = costsSheet(ss);
  if (sh.getLastRow() < 2) return [];
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues();
  const out = [];
  rows.forEach((r, i) => {
    if (!r[1] && !r[3]) return;
    const dt = r[0] instanceof Date ? r[0] : new Date(r[0]);
    out.push({
      row: i + 2,
      date: isNaN(dt) ? "" : Utilities.formatDate(dt, "Asia/Taipei", "yyyy-MM-dd"),
      item: String(r[1] || ""), category: String(r[2] || "其他"),
      amount: Number(r[3]) || 0, note: String(r[4] || "")
    });
  });
  return out.reverse();
}

function adminAddCost(ss, d){
  const amount = Number(d.amount);
  if (!(amount > 0) || !d.item) return { ok:false, error:"item/amount required" };
  const cat = COST_CATEGORIES.indexOf(d.category) > -1 ? d.category : "其他";
  const m = String(d.date || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const dt = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date();
  costsSheet(ss).appendRow([ dt, String(d.item), cat, amount, String(d.note || "") ]);
  return { ok:true };
}

function adminDeleteCost(ss, d){
  const sh = costsSheet(ss);
  const row = Number(d.row);
  if (!row || row < 2 || row > sh.getLastRow()) return { ok:false, error:"bad row" };
  sh.deleteRow(row);
  return { ok:true };
}


/* ========================= 共用 ========================= */
function setTextCell(sh, row, col, value){
  sh.getRange(row, col).setNumberFormat("@").setValue(String(value || ""));
}
function json(obj){
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* 選用：第一次先跑這個，自動建立所有分頁與標題列（含「總覽」試算） */
function setupSheets(){
  const ss = SpreadsheetApp.openById(SHEET_ID);

  let p = ss.getSheetByName(PRODUCTS_TAB) || ss.insertSheet(PRODUCTS_TAB);
  if (p.getLastRow() === 0){
    p.appendRow(["id","category","name","subtitle","price","unit","tags",
      "spec1_label","spec1_value","spec2_label","spec2_value","spec3_label","spec3_value",
      "image","hue","badge","active","notified"]);
    p.appendRow(["alishan","咖啡豆","阿里山","Alishan, Taiwan",620,"半磅","柑橘,蜂蜜,滑順回甘",
      "處理法","水洗","烘焙度","中焙","規格","半磅 · 227g","","green","招牌",true,true]);
  }

  let m = ss.getSheetByName(MEMBERS_TAB) || ss.insertSheet(MEMBERS_TAB);
  if (m.getLastRow() === 0) m.appendRow(["建立時間","姓名","手機","所在地區","Email"]);

  let o = ss.getSheetByName(ORDERS_TAB) || ss.insertSheet(ORDERS_TAB);
  if (o.getLastRow() === 0){
    o.appendRow(["建立時間","姓名","手機","所在地區","訂購內容","金額","狀態","包數","已加點"]);
  } else {
    // 既有的 orders 分頁：把缺少的「包數」「已加點」欄補到最後面
    const oh = o.getRange(1, 1, 1, o.getLastColumn()).getValues()[0].map(x => String(x).trim());
    if (oh.indexOf("包數") < 0)   o.getRange(1, o.getLastColumn() + 1).setValue("包數");
    if (oh.indexOf("已加點") < 0) o.getRange(1, o.getLastColumn() + 1).setValue("已加點");
  }

  let rv = ss.getSheetByName(REVIEWS_TAB) || ss.insertSheet(REVIEWS_TAB);
  if (rv.getLastRow() === 0) rv.appendRow(["建立時間","手機","品項","香氣","酸質","甜感","醇厚度","苦味"]);

  // 集點：每位會員的點數餘額（訂單「已完成」時自動累積）
  let pt = ss.getSheetByName(POINTS_TAB) || ss.insertSheet(POINTS_TAB);
  if (pt.getLastRow() === 0) pt.appendRow(["手機","點數","到期日","最後消費日"]);

  // 花費成本：直接手動在這個分頁輸入，一列一筆支出
  let c = ss.getSheetByName(COSTS_TAB) || ss.insertSheet(COSTS_TAB);
  if (c.getLastRow() === 0){
    c.appendRow(["日期","項目","分類","金額","備註"]);
    c.appendRow([new Date(), "範例：生豆採購", "原料", 3000, "示範用，可刪除這一列"]);
  }

  // 總覽：粗略試算「營業額 - 成本」，公式會自動抓 orders 和 costs 的加總
  let d = ss.getSheetByName(DASHBOARD_TAB) || ss.insertSheet(DASHBOARD_TAB);
  if (d.getLastRow() === 0){
    d.appendRow(["翔天然　營運總覽（粗略試算，僅供參考）"]);
    d.appendRow([""]);
    d.appendRow(["總營業額（orders 全部訂單金額加總）", "=SUM(orders!F:F)"]);
    d.appendRow(["總成本（costs 全部支出金額加總）",     "=SUM(costs!D:D)"]);
    d.appendRow(["粗估淨利（營業額－成本）",             "=B3-B4"]);
    d.appendRow([""]);
    d.appendRow(["＊ 營業額包含所有狀態的訂單（含「待處理」尚未收款的），只是粗估，正式對帳仍需人工確認。"]);
    d.setColumnWidth(1, 340);
    d.setColumnWidth(2, 160);
  }
}

/* 選用：測試 Email 是否能正常寄出（會寄一封測試信到 NOTIFY_EMAIL） */
function testEmail(){
  MailApp.sendEmail(NOTIFY_EMAIL, "【翔天然】測試通知", "這是一封測試信，代表訂單通知設定成功。");
}

/* 執行一次：把 orders「狀態」欄做成下拉選單（待處理／已完成／已取消），
   並整理舊資料：狀態不是「已完成」的列，「已加點」一律歸零，避免之後少加點。 */
function setupOrderDropdown(){
  const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(ORDERS_TAB);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(x => String(x).trim());
  const statusCol  = headers.indexOf("狀態") + 1;
  const awardedCol = headers.indexOf("已加點") + 1;
  if (!statusCol) return;
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(["待處理","已完成","已取消"], true).setAllowInvalid(false).build();
  sh.getRange(2, statusCol, Math.max(sh.getMaxRows() - 1, 1), 1).setDataValidation(rule);
  if (awardedCol && sh.getLastRow() > 1){
    const n = sh.getLastRow() - 1;
    const st = sh.getRange(2, statusCol, n, 1).getValues();
    const aw = sh.getRange(2, awardedCol, n, 1).getValues();
    for (let i = 0; i < n; i++){
      if (String(st[i][0]).trim() !== "已完成") aw[i][0] = 0;
    }
    sh.getRange(2, awardedCol, n, 1).setValues(aw);
  }
}
