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
const SITE_URL = "https://lamp4615-design.github.io/business-xiang-tian-ran";

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
  if (action === "posts")    return json(getPosts(p.site));
  if (action === "unsub")    return unsubscribe_(p);
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

/* ========================= 個資保護 / 防洗版 ========================= */
const normPhone_ = s => String(s || "").replace(/\D/g, "").replace(/^0+/, "");

/* 姓名遮罩：保留頭尾，中間用 ○（王小明 → 王○明、王明 → 王○） */
function maskName_(n){
  const a = Array.from(String(n || "").trim());
  if (a.length <= 1) return a.join("");
  if (a.length === 2) return a[0] + "○";
  return a[0] + "○".repeat(a.length - 2) + a[a.length - 1];
}

/* 寫進試算表的文字：限制長度，並避免開頭是 = + - @ 被試算表當成公式執行 */
function safeText_(s, max){
  s = String(s == null ? "" : s).trim().slice(0, max || 200);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

/* 同一個 key 在 seconds 秒內只放行一次（用 CacheService，免費） */
function rateLimit_(key, seconds){
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try{
    const cache = CacheService.getScriptCache();
    if (cache.get(key)) return false;
    cache.put(key, "1", seconds);
    return true;
  } finally { lock.releaseLock(); }
}
/* 全站總量上限：seconds 秒內最多 max 次，避免有人灌爆你的信箱與試算表 */
function globalCap_(key, max, seconds){
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try{
    const cache = CacheService.getScriptCache();
    const n = Number(cache.get(key) || 0);
    if (n >= max) return false;
    cache.put(key, String(n + 1), seconds);
    return true;
  } finally { lock.releaseLock(); }
}

/* ========================= 會員資料欄位升級：會員編號／行銷同意／來源／狀態 =========================
 * 參考會員資料庫的常見做法：
 *   ① 會員編號（M0001…）：系統產生、永遠不變。手機、Email 會換，不適合當唯一識別；訂單、客服紀錄都記會員編號。
 *   ② 行銷同意：只有「同意收新品／預購通知」的會員才會被寄行銷信；同意與取消都記錄（時間、誰操作）。
 *   ③ 來源：會員是從哪裡來的（QR 貼紙、LINE、Facebook…），用來比較各管道帶來的客人品質。
 *   ④ 狀態：正常／已刪除（依個資法刪除或匿名化後保留編號供對帳）。
 * 這些欄位第一次用到時會自動補上，並把既有會員一次補齊（見 migrateMembers_）。 */
const MEMBER_FIELDS = ["會員編號", "行銷同意", "同意時間", "來源", "狀態"];
const WEBAPP_URL = "https://script.google.com/macros/s/AKfycbyZqvkluw1OoigP2Bw_KmkqyKPzlklCWHu57MGLOULH5EVI0ctTmnw5d4WZgZU7wy-iuQ/exec";

/* 欄位名稱 → 欄號（1 起算），沒有這欄回 0 */
function memberCols_(sh){
  const head = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(h => String(h).trim());
  const m = {};
  MEMBER_FIELDS.concat(["更新時間"]).forEach(n => { const i = head.indexOf(n); m[n] = i > -1 ? i + 1 : 0; });
  return m;
}
function hasHeader_(sh, name){
  return sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].some(h => String(h).trim() === name);
}
function nextMemberId_(sh, idCol){
  let max = 0;
  const n = sh.getLastRow() - 1;
  if (n > 0) sh.getRange(2, idCol, n, 1).getValues().forEach(r => { const m = /^M(\d+)$/.exec(String(r[0]).trim()); if (m) max = Math.max(max, Number(m[1])); });
  return "M" + ("000" + (max + 1)).slice(-Math.max(4, String(max + 1).length));
}

/* 確保欄位齊全；缺的就補、既有會員一次補齊。locked=true 表示呼叫端已經在鎖裡（Apps Script 的鎖不能巢狀）。
   回傳欄位對照表。 */
function ensureMemberSchema_(ss, locked){
  const sh = ss.getSheetByName(MEMBERS_TAB);
  if (!sh) return null;
  const orders = ss.getSheetByName(ORDERS_TAB);
  let cols = memberCols_(sh);
  if (MEMBER_FIELDS.every(n => cols[n]) && (!orders || hasHeader_(orders, "會員編號"))) return cols;
  const lock = locked ? null : LockService.getScriptLock();
  if (lock) lock.waitLock(20000);
  try{
    MEMBER_FIELDS.forEach(n => ensureCol_(sh, n));
    if (orders) ensureCol_(orders, "會員編號");
    cols = memberCols_(sh);
    migrateMembers_(ss, sh, cols);
    if (orders) stampOrderIds_(ss);
  } finally { if (lock) lock.releaseLock(); }
  return memberCols_(sh);
}

/* 既有會員補齊：編號、狀態；行銷同意——加入表單當初就寫明「填 Email＝想收新品上架通知」，所以有有效 Email 的視為已同意 */
function migrateMembers_(ss, sh, cols){
  if (sh.getLastRow() < 2) return;
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  let nextN = 0;
  rows.forEach(r => { const m = /^M(\d+)$/.exec(String(r[cols["會員編號"] - 1] || "").trim()); if (m) nextN = Math.max(nextN, Number(m[1])); });
  let granted = 0;
  rows.forEach((r, i) => {
    const row = i + 2;
    if (!r[0] && !r[1] && !r[2]) return;   // 空列
    if (!String(r[cols["會員編號"] - 1] || "").trim()){
      nextN++;
      sh.getRange(row, cols["會員編號"]).setValue("M" + ("000" + nextN).slice(-Math.max(4, String(nextN).length)));
    }
    if (!String(r[cols["狀態"] - 1] || "").trim()) sh.getRange(row, cols["狀態"]).setValue("正常");
    const cur = r[cols["行銷同意"] - 1];
    if (cur === "" || cur == null){
      const ok = EMAIL_RE.test(String(r[4] || "").trim());
      sh.getRange(row, cols["行銷同意"]).setValue(ok);
      if (ok){ sh.getRange(row, cols["同意時間"]).setValue(r[0] || new Date()); granted++; }
    }
  });
  if (granted) logChange_(ss, "", "行銷同意", "", "既有 " + granted + " 位會員自動補登為同意", "系統", "加入表單註明填 Email 即同意收新品通知；會員可隨時取消");
}

/* 把訂單補上會員編號（依手機對應）；之後新訂單會自己帶 */
function stampOrderIds_(ss){
  const msh = ss.getSheetByName(MEMBERS_TAB), osh = ss.getSheetByName(ORDERS_TAB);
  if (!msh || !osh || osh.getLastRow() < 2) return;
  const cols = memberCols_(msh);
  const idByKey = {};
  msh.getDataRange().getValues().slice(1).forEach(r => { const k = normPhone_(r[2]); const id = String(r[cols["會員編號"] - 1] || ""); if (k && id) idByKey[k] = id; });
  const rows = osh.getDataRange().getValues();
  const head = rows[0].map(h => String(h).trim());
  const pI = head.indexOf("手機"), idI = head.indexOf("會員編號");
  if (pI < 0 || idI < 0) return;
  for (let i = 1; i < rows.length; i++){
    if (String(rows[i][idI] || "").trim()) continue;
    const id = idByKey[normPhone_(rows[i][pI])];
    if (id) osh.getRange(i + 1, idI + 1).setValue(id);
  }
}

/* 手動執行一次也可以（Apps Script 選 setupMemberFields → 執行）：補齊欄位、編號、同意紀錄 */
function setupMemberFields(){ ensureMemberSchema_(SpreadsheetApp.openById(SHEET_ID), false); }

/* ----- 取消訂閱（信件裡的連結）----- */
function unsubUrl_(key){ return WEBAPP_URL + "?action=unsub&k=" + key + "&s=" + hmac_("unsub." + key); }
function htmlPage_(title, msg){
  return HtmlService.createHtmlOutput(
    '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + '</title></head>' +
    '<body style="font-family:sans-serif;max-width:460px;margin:12vh auto;padding:0 20px;color:#233a2e;line-height:1.8"><h2>' + title + '</h2><p>' + msg + '</p>' +
    '<p style="color:#777;font-size:14px">— 翔天然，翔自在</p></body></html>');
}
function unsubscribe_(p){
  const key = String(p.k || "");
  if (!/^\d{8,12}$/.test(key) || !safeEq_(hmac_("unsub." + key), String(p.s || ""))) return htmlPage_("連結無效", "這個取消訂閱連結已失效，請到網站「會員中心」自行修改，或用 LINE 聯絡我們。");
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try{
    const cols = ensureMemberSchema_(ss, true);
    const sh = ss.getSheetByName(MEMBERS_TAB);
    const row = findMemberRow_(sh, key);
    if (!row) return htmlPage_("已完成", "我們不會再寄行銷通知給這個帳號。");
    if (isTrue_(sh.getRange(row, cols["行銷同意"]).getValue())){
      sh.getRange(row, cols["行銷同意"]).setValue(false);
      sh.getRange(row, cols["同意時間"]).setValue("");
      logChange_(ss, String(sh.getRange(row, 3).getValue()), "行銷同意", "同意", "不同意", "會員本人", "信件內的取消訂閱連結");
    }
  } finally { lock.releaseLock(); }
  return htmlPage_("已取消訂閱", "之後不會再寄新品上架、預購這類行銷通知給你。訂單與驗證碼等必要通知不受影響。<br>若是誤按，可到網站「會員中心」重新開啟。");
}

/* 內部用：用手機找會員，回傳完整資料（不會直接給前台）。已刪除的會員視為不存在。 */
function lookupMember_(ss, phone){
  const sh = ss.getSheetByName(MEMBERS_TAB);
  const key = normPhone_(phone);
  if (!sh || !key) return null;
  const rows = sh.getDataRange().getValues();
  if (rows.length < 2) return null;
  const head = rows[0].map(h => String(h).trim());
  const idI = head.indexOf("會員編號"), cI = head.indexOf("行銷同意"), sI = head.indexOf("狀態");
  for (let i = 1; i < rows.length; i++){
    if (normPhone_(rows[i][2]) !== key) continue;
    if (sI > -1 && String(rows[i][sI]).trim() === "已刪除") return null;
    return { name:String(rows[i][1] || ""), city:String(rows[i][3] || ""), email:String(rows[i][4] || ""),
             id: idI > -1 ? String(rows[i][idI] || "") : "", consent: cI > -1 && isTrue_(rows[i][cI]) };
  }
  return null;
}

/* 登入：只回傳「是不是會員」與遮罩後的姓名。不回傳地址、Email，也不回傳資料庫裡存的手機。
   （下單時姓名／地區由後端依手機自己查，前台不需要持有完整個資。） */
function findMember(phone){
  const m = lookupMember_(SpreadsheetApp.openById(SHEET_ID), phone);
  if (!m) return { found:false };
  return { found:true, name:maskName_(m.name), phone:String(phone || "").slice(0, 20), city:"", email:"" };
}


/* ========================= 寫入 ========================= */
function doPost(e){
  try{
    const d = JSON.parse(e.postData.contents);
    if (d.action === "join")  return json(addMember(d));
    if (d.action === "order") return json(addOrder(d));
    if (d.action === "review") return json(addReview(d));
    if (d.action === "member_code_request") return json(requestCode(d));
    if (d.action === "member_code_verify")  return json(verifyCode(d));
    if (d.action === "member_orders")       return json(memberOrders(d));
    if (d.action === "member_profile")      return json(memberProfile(d));
    if (d.action === "member_update")       return json(memberUpdate(d));
    if (String(d.action || "").indexOf("admin_") === 0) return json(adminHandle(d));
    return json({ ok:false, error:"unknown action" });
  }catch(err){
    return json({ ok:false, error:String(err) });
  }
}

function addMember(d){
  const key = normPhone_(d.phone);
  const name = safeText_(d.name, 40);
  if (key.length < 8 || key.length > 12 || !name) return { ok:false, error:"bad input" };
  if (!rateLimit_("join_" + key, 60)) return { ok:false, error:"rate_limited" };
  if (!globalCap_("join_all", 30, 600)) return { ok:false, error:"busy" };
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const email = safeText_(d.email, 80);
  const consent = isTrue_(d.consent) && EMAIL_RE.test(email);   // 行銷同意：要有有效 Email 才有意義
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try{
    if (lookupMember_(ss, d.phone)) return { ok:true, existed:true };   // 已是會員：不重複新增，也不讓別人覆蓋他的資料
    const cols = ensureMemberSchema_(ss, true);
    const sh = ss.getSheetByName(MEMBERS_TAB);
    sh.appendRow([ new Date(), name, "", safeText_(d.city, 60), email ]);
    const row = sh.getLastRow();
    setTextCell(sh, row, 3, String(d.phone).slice(0, 20));
    sh.getRange(row, cols["會員編號"]).setValue(nextMemberId_(sh, cols["會員編號"]));
    sh.getRange(row, cols["行銷同意"]).setValue(consent);
    if (consent) sh.getRange(row, cols["同意時間"]).setValue(new Date());
    sh.getRange(row, cols["來源"]).setValue(safeText_(d.source, 30));
    sh.getRange(row, cols["狀態"]).setValue("正常");
    if (consent) logChange_(ss, String(d.phone).slice(0, 20), "行銷同意", "", "同意", "會員本人", "加入會員時勾選");
  } finally { lock.releaseLock(); }
  return { ok:true, token:signToken_(key) };   // 帳號是他剛建立的，直接給憑證，加入後馬上能看自己的資料
}

function addOrder(d){
  const key = normPhone_(d.phone);
  if (key.length < 8 || key.length > 12) return { ok:false, error:"bad phone" };
  const items = safeText_(d.items, 500);
  const total = Number(d.total) || 0;
  if (!items || !(total > 0) || total > 1000000) return { ok:false, error:"bad order" };
  if (!rateLimit_("ord_" + key, 60)) return { ok:false, error:"rate_limited" };   // 同一支手機一分鐘只能下一張
  if (!globalCap_("ord_all", 20, 600)) return { ok:false, error:"busy" };          // 全站 10 分鐘最多 20 張

  const ss = SpreadsheetApp.openById(SHEET_ID);
  ensureMemberSchema_(ss, false);
  const sh = ss.getSheetByName(ORDERS_TAB);
  // 會員的姓名／地區以試算表為準（前台只有遮罩後的姓名）；查不到才用前台送來的
  const m = lookupMember_(ss, d.phone);
  const name = m ? m.name : safeText_(d.name, 40);
  const city = m ? m.city : safeText_(d.city, 60);
  const bags = Math.min(1000, Math.max(0, Math.floor(Number(d.bags)) || parseBags(items)));
  // 欄位：建立時間/姓名/手機/所在地區/訂購內容/金額/狀態/包數/已加點
  // 點數不在下單時加；你把「狀態」改成「已完成」時才會自動加（見 onEdit）
  sh.appendRow([ new Date(), name, "", city, items, total, "待處理", bags, 0 ]);
  setTextCell(sh, sh.getLastRow(), 3, String(d.phone).slice(0, 20));
  if (m && m.id) sh.getRange(sh.getLastRow(), ensureCol_(sh, "會員編號").col).setValue(m.id);   // 訂單記會員編號，換手機也對得上
  notifyOrder({ name:name, phone:String(d.phone).slice(0, 20), city:city, items:items, total:total });   // 寄 Email 通知
  return { ok:true };
}

/* ========================= 會員驗證 / 個人資料（會員中心） =========================
 * 為什麼要驗證：登入只靠手機號碼，任何人知道別人的手機就能「登入」。
 * 所以「看購買紀錄、改資料」這類個資功能，要多過一關：
 *   ① Email 驗證碼：寄 6 碼到會員登記的 Email（10 分鐘內有效）；
 *   ② 店家發碼：沒有 Email 或收不到時，由你在管理後台「會員」按「產生驗證碼」，用 LINE／電話給會員（6 小時內有效）。
 * 驗證通過後發一張「簽章憑證」（30 天），之後查看／修改資料都要帶這張憑證。 */
const SESSION_DAYS = 30;
const MEMBER_LOG_TAB = "member_log";
const EMAIL_RE = /^[A-Za-z0-9][A-Za-z0-9._%+\-]*@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;

function secret_(){
  const props = PropertiesService.getScriptProperties();
  let s = props.getProperty("SESSION_SECRET");
  if (!s){ s = Utilities.getUuid() + Utilities.getUuid(); props.setProperty("SESSION_SECRET", s); }
  return s;
}
function hmac_(text){ return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(text, secret_())); }
function safeEq_(a, b){
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function signToken_(key){
  const payload = key + "." + (Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400);
  return payload + "." + hmac_(payload);
}
/* 憑證有效就回傳手機（去 0 後的比對用 key），否則 null */
function verifyToken_(token){
  const p = String(token || "").split(".");
  if (p.length !== 3 || !/^\d+$/.test(p[0]) || !/^\d+$/.test(p[1])) return null;
  if (!safeEq_(hmac_(p[0] + "." + p[1]), p[2])) return null;
  if (Number(p[1]) < Date.now() / 1000) return null;
  return p[0];
}

function newCode_(){ return ("00000" + (parseInt(Utilities.getUuid().replace(/-/g, "").slice(0, 8), 16) % 1000000)).slice(-6); }
function otpHash_(key, code){
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, code + ":" + key + ":" + secret_()));
}
function storeCode_(key, code, ttl){
  const c = CacheService.getScriptCache();
  c.put("otp_" + key, otpHash_(key, code), ttl);
  c.remove("otpn_" + key);
}

function findMemberRow_(sh, key){
  if (!sh || !key) return 0;
  const rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) if (normPhone_(rows[i][2]) === key) return i + 1;
  return 0;
}

/* 寄驗證碼：一律回成功，不透露這支手機是不是會員、有沒有 Email */
function requestCode(d){
  const key = normPhone_(d.phone);
  if (key.length < 8 || key.length > 12) return { ok:false, error:"bad phone" };
  if (!rateLimit_("otpreq_" + key, 60)) return { ok:false, error:"rate_limited" };
  if (!globalCap_("otph_" + key, 5, 3600)) return { ok:false, error:"rate_limited" };   // 同一支手機每小時最多 5 次
  if (!globalCap_("otp_all", 40, 600)) return { ok:false, error:"busy" };               // 全站 10 分鐘最多 40 封
  const m = lookupMember_(SpreadsheetApp.openById(SHEET_ID), d.phone);
  if (m && EMAIL_RE.test(m.email)){
    const code = newCode_();
    storeCode_(key, code, 600);
    try{
      MailApp.sendEmail(m.email, "【翔天然】會員驗證碼 " + code,
        "你的驗證碼是：" + code + "\n\n10 分鐘內有效。用來查看購買紀錄、修改會員資料。\n" +
        "如果不是你本人操作，請直接忽略這封信，你的資料不會有任何變動。\n\n— 翔天然，翔自在");
    }catch(err){ /* 寄信失敗：會員會收不到，可改走店家發碼 */ }
  }
  return { ok:true };
}

function verifyCode(d){
  const key = normPhone_(d.phone);
  const code = String(d.code || "").replace(/\D/g, "");
  if (key.length < 8 || key.length > 12 || code.length !== 6) return { ok:false, error:"bad_code" };
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try{
    const c = CacheService.getScriptCache();
    const n = Number(c.get("otpn_" + key) || 0);
    if (n >= 5){ c.remove("otp_" + key); return { ok:false, error:"too_many" }; }
    const h = c.get("otp_" + key);
    if (!h || !safeEq_(h, otpHash_(key, code))){ c.put("otpn_" + key, String(n + 1), 600); return { ok:false, error:"bad_code" }; }
    c.remove("otp_" + key); c.remove("otpn_" + key);
  } finally { lock.releaseLock(); }
  if (!lookupMember_(SpreadsheetApp.openById(SHEET_ID), d.phone)) return { ok:false, error:"bad_code" };
  return { ok:true, token:signToken_(key) };
}

/* 讀全部訂單（姓名／手機／內容／金額／狀態…），依手機 key 比對用 */
function readOrders_(ss){
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
      key: normPhone_(r[at("手機")]),
      time: r[at("建立時間")] ? new Date(r[at("建立時間")]) : null,
      items: String(r[at("訂購內容")] || ""),
      total: Number(r[at("金額")]) || 0,
      status: String(r[at("狀態")] || "待處理"),
      bags: Number(r[at("包數")]) || 0
    });
  }
  return out;
}
const orderView_ = o => ({ time: o.time ? o.time.toISOString() : "", items: o.items, total: o.total, status: o.status, bags: o.bags });

/* 登入後看自己的購買紀錄（不需驗證碼）：只回傳訂單內容，不含姓名／地址／Email。
   加上限速，避免有人拿一堆手機號碼來批次探測。 */
function memberOrders(d){
  const key = normPhone_(d.phone);
  if (key.length < 8 || key.length > 12) return { ok:false, error:"bad phone" };
  if (!rateLimit_("mo_" + key, 3)) return { ok:false, error:"rate_limited" };
  if (!globalCap_("mo_all", 120, 600)) return { ok:false, error:"busy" };
  const ss = SpreadsheetApp.openById(SHEET_ID);
  if (!lookupMember_(ss, d.phone)) return { ok:true, orders:[] };
  const orders = readOrders_(ss).filter(o => o.key === key).sort((a, b) => (b.time || 0) - (a.time || 0)).slice(0, 100).map(orderView_);
  return { ok:true, orders:orders };
}

/* 會員本人：取得完整資料＋購買紀錄＋點數 */
function memberProfile(d){
  const key = verifyToken_(d.token);
  if (!key) return { ok:false, error:"auth" };
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sh = ss.getSheetByName(MEMBERS_TAB);
  const row = findMemberRow_(sh, key);
  if (!row) return { ok:false, error:"auth" };
  const cols = ensureMemberSchema_(ss, false);
  const v = sh.getRange(row, 1, 1, Math.max(sh.getLastColumn(), 5)).getValues()[0];
  const orders = readOrders_(ss).filter(o => o.key === key).sort((a, b) => (b.time || 0) - (a.time || 0)).slice(0, 100).map(orderView_);
  const st = getMyStats(String(v[2]));
  return { ok:true, name:String(v[1] || ""), phone:String(v[2] || ""), city:String(v[3] || ""), email:String(v[4] || ""),
           joined: v[0] ? new Date(v[0]).toISOString() : "", id:String(v[cols["會員編號"] - 1] || ""), consent:isTrue_(v[cols["行銷同意"] - 1]), orders:orders, points:st.points || 0, pointsExpiry:st.pointsExpiry || "", tickets:st.tickets || 0 };
}

/* 把異動記進 member_log（誰、什麼時候、改了什麼，方便對帳／追查） */
function logChange_(ss, phone, field, oldV, newV, by, note){
  let sh = ss.getSheetByName(MEMBER_LOG_TAB);
  if (!sh){ sh = ss.insertSheet(MEMBER_LOG_TAB); sh.appendRow(["時間","手機","欄位","舊值","新值","操作者","備註"]); }
  sh.appendRow([ new Date(), "", safeText_(field, 30), safeText_(oldV, 120), safeText_(newV, 120), by, safeText_(note || "", 120) ]);
  setTextCell(sh, sh.getLastRow(), 2, phone);
}

/* 某支手機（去 0 後的 key）在 orders／points／reviews 是否已有紀錄 */
function phoneHasHistory_(ss, key){
  const spots = [[ORDERS_TAB, "手機"], [POINTS_TAB, 0], [REVIEWS_TAB, 1]];
  for (let i = 0; i < spots.length; i++){
    const sh = ss.getSheetByName(spots[i][0]);
    if (!sh || sh.getLastRow() < 2) continue;
    const rows = sh.getDataRange().getValues();
    const col = typeof spots[i][1] === "number" ? spots[i][1] : rows[0].map(h => String(h).trim()).indexOf(spots[i][1]);
    if (col < 0) continue;
    for (let r = 1; r < rows.length; r++) if (normPhone_(rows[r][col]) === key) return true;
  }
  return false;
}
/* 把這支手機名下所有紀錄改成新號碼（訂單、點數、評分、異動紀錄），歷史才不會斷掉 */
function movePhone_(ss, oldKey, newPhone){
  const spots = [[ORDERS_TAB, "手機"], [POINTS_TAB, 0], [REVIEWS_TAB, 1], [MEMBER_LOG_TAB, 1]];
  spots.forEach(sp => {
    const sh = ss.getSheetByName(sp[0]);
    if (!sh || sh.getLastRow() < 2) return;
    const rows = sh.getDataRange().getValues();
    const col = typeof sp[1] === "number" ? sp[1] : rows[0].map(h => String(h).trim()).indexOf(sp[1]);
    if (col < 0) return;
    for (let r = 1; r < rows.length; r++){
      if (normPhone_(rows[r][col]) === oldKey) setTextCell(sh, r + 1, col + 1, newPhone);
    }
  });
}

/* 套用資料變更（姓名／地區／Email／手機），回傳實際有變動的欄位數；本人與管理者共用。
   手機是帳號：換號碼時，名下的訂單、點數、評分會一併轉移；新號碼若已是別人的會員就擋下。 */
function applyMemberEdit_(ss, key, d, by){
  const cols = ensureMemberSchema_(ss, true);
  const sh = ss.getSheetByName(MEMBERS_TAB);
  const row = findMemberRow_(sh, key);
  if (!row) return { ok:false, error:"not found" };
  const name = safeText_(d.name, 40), city = safeText_(d.city, 60), email = String(d.email == null ? "" : d.email).trim().slice(0, 80);
  if (!name) return { ok:false, error:"bad_name" };
  if (email && !EMAIL_RE.test(email)) return { ok:false, error:"bad_email" };
  const old = sh.getRange(row, 1, 1, 5).getValues()[0];
  let phone = String(old[2]);
  // 先把所有檢查做完，再開始寫入（避免做一半失敗）
  let newPhone = "";
  if (d.phone != null && String(d.phone).trim() !== ""){
    const digits = String(d.phone).replace(/\D/g, "");
    const nk = normPhone_(digits);
    if (nk !== key){
      if (nk.length < 8 || nk.length > 12) return { ok:false, error:"bad_phone" };
      if (findMemberRow_(sh, nk)) return { ok:false, error:"phone_taken" };
      if (by !== "管理者" && phoneHasHistory_(ss, nk)) return { ok:false, error:"phone_has_history" };   // 新號碼已有別人的紀錄：請店家協助
      newPhone = digits;
    }
  }
  // 行銷同意：勾選要有有效 Email；Email 被清空時一併取消（沒有 Email 沒辦法寄）
  const curConsent = isTrue_(sh.getRange(row, cols["行銷同意"]).getValue());
  let wantConsent = (d.consent === undefined || d.consent === null) ? curConsent : isTrue_(d.consent);
  if (wantConsent && !EMAIL_RE.test(email)) { if (d.consent !== undefined && d.consent !== null && isTrue_(d.consent)) return { ok:false, error:"consent_needs_email" }; wantConsent = false; }
  const changes = [["姓名", String(old[1] || ""), name, 2], ["所在地區", String(old[3] || ""), city, 4], ["Email", String(old[4] || ""), email, 5]];
  let n = 0;
  if (newPhone){
    movePhone_(ss, key, newPhone);
    setTextCell(sh, row, 3, newPhone);
    logChange_(ss, newPhone, "手機", phone, newPhone, by);
    phone = newPhone;
    n++;
  }
  changes.forEach(c => {
    if (c[1] === c[2]) return;
    sh.getRange(row, c[3]).setNumberFormat("@").setValue(c[2]);
    logChange_(ss, phone, c[0], c[1], c[2], by);
    n++;
  });
  if (wantConsent !== curConsent){
    sh.getRange(row, cols["行銷同意"]).setValue(wantConsent);
    sh.getRange(row, cols["同意時間"]).setValue(wantConsent ? new Date() : "");
    logChange_(ss, phone, "行銷同意", curConsent ? "同意" : "不同意", wantConsent ? "同意" : "不同意", by);
    n++;
  }
  if (n) sh.getRange(row, ensureCol_(sh, "更新時間").col).setValue(new Date());
  return newPhone ? { ok:true, changed:n, phone:newPhone } : { ok:true, changed:n };
}

/* 會員本人修改：姓名／所在地區／Email（手機是帳號，不能自己改） */
function memberUpdate(d){
  const key = verifyToken_(d.token);
  if (!key) return { ok:false, error:"auth" };
  if (!rateLimit_("mu_" + key, 3)) return { ok:false, error:"rate_limited" };
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try{
    const r = applyMemberEdit_(SpreadsheetApp.openById(SHEET_ID), key, d, "會員本人");
    if (r.ok && r.phone) r.token = signToken_(normPhone_(r.phone));   // 換了號碼，憑證要跟著換
    return r;
  }
  finally { lock.releaseLock(); }
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

  // 只寄給「同意收行銷通知」的會員
  const emails = memberEmails_(ss);
  if (emails.length){
    const lines = ["翔天然又有新豆子上架了：", ""];
    newOnes.forEach(p => lines.push(productLine_(p)));
    lines.push("", "去看看：" + SITE_URL + "/#products", "", "— 翔天然，翔自在");
    sendToMembers_(emails, "【翔天然】新品上架囉 ☕", lines);
  }

  // 標記這些商品為「已通知」，避免下次重複寄信
  if (notifiedCol > -1){
    newOnes.forEach(p => psh.getRange(p.sheetRow, notifiedCol + 1).setValue(true));
  }
}

/* ========================= 最後預購 / 下架通知 =========================
   【最後預購】在 products 分頁把某商品的 last_call 欄填 TRUE（商品仍上架中），
              就會寄「即將下架，最後預購」給所有有填 Email 的會員，寄過自動標記 last_call_notified=TRUE。
   【下架通知】商品曾經上架通知過（notified=TRUE），之後把 active 改成 FALSE，
              就會寄「已下架」通知，寄過自動標記 off_notified=TRUE。
   這兩欄（last_call、last_call_notified、off_notified）程式會自動在 products 分頁最右邊補上，不用自己加。
   時間觸發器請改設 notifyProductChanges（一次處理：新品／最後預購／下架）。 */
function isTrue_(v){ return v === true || /^(true|yes|y|是)$/i.test(String(v).trim()); }
function isOff_(v){ return v === false || /^(false|no)$/i.test(String(v).trim()); }

/* 取得欄位位置（1 起算）；沒有這欄就自動在表頭最右邊補上。回傳 { col, created } */
function ensureCol_(sh, name){
  const lastCol = Math.max(sh.getLastColumn(), 1);
  const head = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
  const i = head.indexOf(name);
  if (i > -1) return { col: i + 1, created: false };
  const col = head.filter(String).length + 1;
  sh.getRange(1, col).setValue(name);
  return { col: col, created: true };
}

/* 行銷信的收件人：行銷同意＝是、有有效 Email、狀態正常。回傳 [{email, key}]（信箱重複只留一筆） */
function memberEmails_(ss){
  const cols = ensureMemberSchema_(ss, false);
  const msh = ss.getSheetByName(MEMBERS_TAB);
  const out = [], seen = {};
  if (!msh || !cols) return out;
  msh.getDataRange().getValues().slice(1).forEach(r => {
    const email = String(r[4] || "").trim();
    if (!email || !EMAIL_RE.test(email) || seen[email.toLowerCase()]) return;
    if (!isTrue_(r[cols["行銷同意"] - 1])) return;
    if (String(r[cols["狀態"] - 1]).trim() === "已刪除") return;
    seen[email.toLowerCase()] = 1;
    out.push({ email:email, key:normPhone_(r[2]) });
  });
  return out;
}

/* 每位收件人各寄一封，信尾附「一鍵取消訂閱」（個資法：拒絕行銷後須停止利用） */
function sendToMembers_(recipients, subject, lines){
  recipients.forEach(r => {
    const body = lines.join("\n") + "\n\n——\n不想再收到這類通知？一鍵取消：" + unsubUrl_(r.key) + "\n也可以到網站「會員中心」自行修改。";
    try{ MailApp.sendEmail(r.email, subject, body); }catch(err){ /* 單一信箱失敗不影響其他人 */ }
  });
}

function productLine_(p){
  return "・" + p.name + (p.subtitle ? "（" + p.subtitle + "）" : "") + (p.price ? " — NT$ " + p.price + (p.unit ? "/" + p.unit : "") : "");
}

/* 最後預購通知 */
function notifyLastCall(){
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const psh = ss.getSheetByName(PRODUCTS_TAB);
  if (!psh) return;
  const lc = ensureCol_(psh, "last_call").col;
  const lcn = ensureCol_(psh, "last_call_notified").col;
  const rows = psh.getDataRange().getValues();
  if (rows.length < 2) return;
  const head = rows.shift().map(h => String(h).trim());
  const at = name => head.indexOf(name);
  const list = [];
  rows.forEach((r, i) => {
    if (!r[at("id")]) return;
    if (isOff_(r[at("active")])) return;                 // 已下架的不寄最後預購
    if (!isTrue_(r[lc - 1]) || isTrue_(r[lcn - 1])) return;
    list.push({ sheetRow: i + 2, name: String(r[at("name")] || ""), subtitle: String(r[at("subtitle")] || ""),
                price: Number(r[at("price")]) || 0, unit: String(r[at("unit")] || "") });
  });
  if (!list.length) return;
  const emails = memberEmails_(ss);
  if (emails.length){
    const lines = ["這款豆子即將下架，想喝的話請把握最後預購機會：", ""];
    list.forEach(p => lines.push(productLine_(p)));
    lines.push("", "現在去訂購：" + SITE_URL + "/#products", "", "— 翔天然，翔自在");
    sendToMembers_(emails, "【翔天然】最後預購 ⏳ 即將下架", lines);
  }
  list.forEach(p => psh.getRange(p.sheetRow, lcn).setValue(true));
}

/* 下架通知 */
function notifyDiscontinued(){
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const psh = ss.getSheetByName(PRODUCTS_TAB);
  if (!psh) return;
  const off = ensureCol_(psh, "off_notified");
  const rows = psh.getDataRange().getValues();
  if (rows.length < 2) return;
  const head = rows.shift().map(h => String(h).trim());
  const at = name => head.indexOf(name);
  // 第一次啟用：先把「目前已經下架」的商品全部標記為已處理，不補寄舊商品的下架信
  if (off.created){
    rows.forEach((r, i) => { if (r[at("id")] && isOff_(r[at("active")])) psh.getRange(i + 2, off.col).setValue(true); });
    return;
  }
  const list = [];
  rows.forEach((r, i) => {
    if (!r[at("id")]) return;
    if (!isOff_(r[at("active")])) return;                // 還上架中
    if (!isTrue_(r[at("notified")])) return;             // 從沒公開過（草稿），不通知
    if (isTrue_(r[off.col - 1])) return;                 // 已通知過
    list.push({ sheetRow: i + 2, name: String(r[at("name")] || ""), subtitle: String(r[at("subtitle")] || ""),
                price: 0, unit: "" });
  });
  if (!list.length) return;
  const emails = memberEmails_(ss);
  if (emails.length){
    const lines = ["以下豆子已經下架，謝謝你的支持：", ""];
    list.forEach(p => lines.push(productLine_(p)));
    lines.push("", "看看目前還有哪些豆子：" + SITE_URL + "/#products", "", "— 翔天然，翔自在");
    sendToMembers_(emails, "【翔天然】豆子下架通知", lines);
  }
  list.forEach(p => psh.getRange(p.sheetRow, off.col).setValue(true));
}

/* 時間觸發器請設這一個：每次依序處理 新品上架／最後預購／下架 */
function notifyProductChanges(){
  notifyNewProducts();
  notifyLastCall();
  notifyDiscontinued();
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
  const key = normPhone_(d.phone);
  const product = safeText_(d.product, 60);
  if (!product) return { ok:false, error:"bad input" };
  if (!rateLimit_("rv_" + (key || "anon") + "_" + product, 5)) return { ok:false, error:"rate_limited" };
  if (!globalCap_("rv_all", 120, 600)) return { ok:false, error:"busy" };
  const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(REVIEWS_TAB);
  const v = n => Math.min(5, Math.max(0, Number(n) || 0));   // 評分限 0～5
  sh.appendRow([ new Date(), "", product, v(d.aroma), v(d.acidity), v(d.sweetness), v(d.body), v(d.bitterness) ]);
  setTextCell(sh, sh.getLastRow(), 2, String(d.phone || "").slice(0, 20));   // 手機存完整（文字），只在後台看得到
  return { ok:true };
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
/* 成本分類（參考咖啡業常見損益表：銷貨成本 → 毛利 → 銷售費用／管理費用 → 淨利）
   舊資料用過的「生豆／濾紙／包裝袋／運費／其他」仍保留，會自動歸到對應的群組。 */
const COST_GROUPS = {
  "銷貨成本": ["生豆","烘焙代工／損耗","包裝袋","濾紙／掛耳包材","貼標／紙箱","樣品／試飲"],
  "銷售費用": ["運費","金流手續費","廣告行銷","平台／網站費用"],
  "管理費用": ["租金","水電瓦斯","人事薪資","設備／折舊","稅務會計","雜項"]
};
const COST_LEGACY = { "濾紙":"銷貨成本", "其他":"管理費用" };   // 舊分類名稱 → 群組（生豆／包裝袋／運費本來就在新清單裡）
const COST_CATEGORIES = [].concat(COST_GROUPS["銷貨成本"], COST_GROUPS["銷售費用"], COST_GROUPS["管理費用"], ["濾紙","其他"]);
const ORDER_STATUSES  = ["待處理","已完成","已取消"];
const WRITE_ACTIONS   = { admin_update_order:1, admin_add_cost:1, admin_delete_cost:1, admin_save_post:1, admin_delete_post:1, admin_upload_image:1, admin_member_update:1, admin_member_code:1, admin_points_adjust:1, admin_note_add:1, admin_note_status:1, admin_member_delete:1 };

function adminAuthOk(key){
  const real = PropertiesService.getScriptProperties().getProperty("ADMIN_KEY");
  return !!real && String(key || "") === real;
}

function adminHandle(d){
  if (!adminAuthOk(d.key)) return { ok:false, error:"unauthorized" };
  const ss = SpreadsheetApp.openById(SHEET_ID);
  // 只有「寫入」才需要排隊上鎖；讀取不鎖，才不會被別的請求卡住
  const lock = WRITE_ACTIONS[d.action] ? LockService.getScriptLock() : null;
  if (lock) lock.waitLock(20000);
  try{
    if (d.action === "admin_ping") return { ok:true, categories:COST_CATEGORIES, groups:COST_GROUPS, legacy:COST_LEGACY, statuses:ORDER_STATUSES, noteCategories:NOTE_CATEGORIES };
    // 一次回傳後台需要的全部資料（原本要連線 3 次，現在 1 次）
    if (d.action === "admin_all") return { ok:true, orders:adminListOrders(ss), costs:adminListCosts(ss), posts:listPosts(ss, "", false) };
    if (d.action === "admin_orders") return { ok:true, orders:adminListOrders(ss) };
    if (d.action === "admin_members") { ensureMemberSchema_(ss, false); return { ok:true, members:adminMembers(ss) }; }
    if (d.action === "admin_member_detail") { ensureMemberSchema_(ss, false); return adminMemberDetail(ss, d); }
    if (d.action === "admin_member_update") return adminMemberUpdate(ss, d);
    if (d.action === "admin_note_add") return adminNoteAdd(ss, d);
    if (d.action === "admin_note_status") return adminNoteStatus(ss, d);
    if (d.action === "admin_member_delete") return adminMemberDelete(ss, d);
    if (d.action === "admin_member_code") return adminMemberCode(ss, d);
    if (d.action === "admin_points_adjust") return adminPointsAdjust(ss, d);
    if (d.action === "admin_update_order") return adminUpdateOrder(ss, d);
    if (d.action === "admin_costs") return { ok:true, costs:adminListCosts(ss) };
    if (d.action === "admin_add_cost") return adminAddCost(ss, d);
    if (d.action === "admin_delete_cost") return adminDeleteCost(ss, d);
    if (d.action === "admin_posts") return { ok:true, posts:listPosts(ss, String(d.site || ""), false) };
    if (d.action === "admin_save_post") return adminSavePost(ss, d);
    if (d.action === "admin_delete_post") return adminDeletePost(ss, d);
    if (d.action === "admin_upload_image") return adminUploadImage(d);
    return { ok:false, error:"unknown admin action" };
  } finally { if (lock) lock.releaseLock(); }
}

/* ========================= 後台：會員管理 =========================
 * admin_members        → 全部會員＋購買統計（訂單數、累計消費、購買頻率、最近下單、點數、資料異動）
 * admin_member_detail  → 單一會員的訂單明細與資料異動紀錄
 * admin_member_update  → 管理者修改會員資料（姓名／地區／Email），會記進 member_log
 * admin_member_code    → 產生一次性驗證碼（6 小時有效），給沒有 Email 的會員自己查看資料用
 * admin_points_adjust  → 手動加／扣點數（要填原因，會記進 member_log） */
/* ----- 客服／備註紀錄（member_notes）：用「分類」整理問題，內容簡短，避免把大量敏感內容寫進自由文字 ----- */
const NOTES_TAB = "member_notes";
const NOTE_CATEGORIES = ["物流配送", "商品品質", "使用方式", "退款退貨", "訂單問題", "其他", "一般備註"];
function notesSheet_(ss){
  let sh = ss.getSheetByName(NOTES_TAB);
  if (!sh){ sh = ss.insertSheet(NOTES_TAB); sh.appendRow(["時間", "會員編號", "分類", "內容", "狀態", "需追蹤", "處理時間"]); }
  return sh;
}
function parseItems_(text){
  const out = {};
  String(text || "").split("、").forEach(seg => {
    const m = seg.trim().match(/^(.+?)\s*[x×]\s*(\d+)$/i);
    if (m) out[m[1].trim()] = (out[m[1].trim()] || 0) + Number(m[2]);
  });
  return out;
}

function adminMembers(ss){
  const msh = ss.getSheetByName(MEMBERS_TAB);
  if (!msh || msh.getLastRow() < 2) return [];
  const rows = msh.getDataRange().getValues();
  const head = rows[0].map(h => String(h).trim());
  const ix = n => head.indexOf(n);

  const byKey = {};
  readOrders_(ss).forEach(o => { if (o.key) (byKey[o.key] = byKey[o.key] || []).push(o); });

  const pts = {};
  const psh = ss.getSheetByName(POINTS_TAB);
  if (psh && psh.getLastRow() > 1) psh.getDataRange().getValues().slice(1).forEach(r => {
    const k = normPhone_(r[0]); if (k) pts[k] = { points:Number(r[1]) || 0, expiry:r[2] ? new Date(r[2]) : null };
  });
  const rv = {};
  const rsh = ss.getSheetByName(REVIEWS_TAB);
  if (rsh && rsh.getLastRow() > 1) rsh.getDataRange().getValues().slice(1).forEach(r => {
    const k = normPhone_(r[1]); if (k) rv[k] = (rv[k] || 0) + 1;
  });
  const lg = {};
  const lsh = ss.getSheetByName(MEMBER_LOG_TAB);
  if (lsh && lsh.getLastRow() > 1) lsh.getDataRange().getValues().slice(1).forEach(r => {
    const k = normPhone_(r[1]); if (!k) return;
    const t = r[0] ? new Date(r[0]) : null;
    const o = lg[k] || (lg[k] = { n:0, last:null });
    o.n++; if (t && (!o.last || t > o.last)) o.last = t;
  });
  const openNotes = {};
  const nsh = ss.getSheetByName(NOTES_TAB);
  if (nsh && nsh.getLastRow() > 1) nsh.getDataRange().getValues().slice(1).forEach(r => {
    if (String(r[4]) === "待處理") openNotes[String(r[1])] = (openNotes[String(r[1])] || 0) + 1;
  });

  const now = new Date(), seen = {}, out = [];
  for (let i = 1; i < rows.length; i++){
    const r = rows[i], key = normPhone_(r[2]);
    if (!key || seen[key]) continue;           // 同一支手機重複列只算一次（已刪除的會員手機是空的，也會被略過）
    if (ix("狀態") > -1 && String(r[ix("狀態")]).trim() === "已刪除") continue;
    seen[key] = 1;
    const mine = byKey[key] || [];
    const all = mine.filter(o => o.status !== "已取消");
    const done = all.filter(o => o.status === "已完成" && o.time).sort((a, b) => a.time - b.time);
    const spent = done.reduce((s, o) => s + o.total, 0);
    const gap = done.length >= 2 ? Math.round((done[done.length - 1].time - done[0].time) / 86400000 / (done.length - 1)) : 0;
    const timed = all.filter(o => o.time);
    const last = timed.reduce((m, o) => (!m || o.time > m) ? o.time : m, null);
    const first = timed.reduce((m, o) => (!m || o.time < m) ? o.time : m, null);
    const items = {};
    done.forEach(o => { const it = parseItems_(o.items); Object.keys(it).forEach(k => items[k] = (items[k] || 0) + it[k]); });
    const top = Object.keys(items).sort((a, b) => items[b] - items[a]).slice(0, 2).map(k => k + "×" + items[k]).join("、");
    const p = pts[key] || { points:0, expiry:null };
    const expired = p.expiry && now > p.expiry;
    const id = ix("會員編號") > -1 ? String(r[ix("會員編號")] || "") : "";
    out.push({
      id: id, joined: r[0] ? new Date(r[0]).toISOString() : "",
      name: String(r[1] || ""), phone: String(r[2] || ""), city: String(r[3] || ""), email: String(r[4] || ""),
      source: ix("來源") > -1 ? String(r[ix("來源")] || "") : "",
      consent: ix("行銷同意") > -1 && isTrue_(r[ix("行銷同意")]),
      consentAt: ix("同意時間") > -1 && r[ix("同意時間")] ? new Date(r[ix("同意時間")]).toISOString() : "",
      updated: ix("更新時間") > -1 && r[ix("更新時間")] ? new Date(r[ix("更新時間")]).toISOString() : "",
      orders: all.length, done: done.length, cancelled: mine.length - all.length,
      spent: spent, avg: done.length ? Math.round(spent / done.length) : 0,
      bags: done.reduce((s, o) => s + o.bags, 0), topItems: top,
      gapDays: gap,                                                             // 平均每隔幾天買一次（至少 2 次已完成訂單才算）
      orders90: done.filter(o => now - o.time <= 90 * 86400000).length,       // 近 90 天已完成訂單數
      firstOrder: first ? first.toISOString() : "", lastOrder: last ? last.toISOString() : "",
      points: expired ? 0 : p.points, pointsExpiry: p.expiry ? p.expiry.toISOString() : "",
      reviews: rv[key] || 0, openNotes: openNotes[id] || 0,
      changes: lg[key] ? lg[key].n : 0, lastChange: lg[key] && lg[key].last ? lg[key].last.toISOString() : ""
    });
  }
  return out;
}

function adminMemberDetail(ss, d){
  const key = normPhone_(d.phone);
  const m = lookupMember_(ss, d.phone);
  if (!key || !m) return { ok:false, error:"not found" };
  const orders = readOrders_(ss).filter(o => o.key === key).sort((a, b) => (b.time || 0) - (a.time || 0)).slice(0, 200).map(orderView_);
  const log = [];
  const lsh = ss.getSheetByName(MEMBER_LOG_TAB);
  if (lsh && lsh.getLastRow() > 1) lsh.getDataRange().getValues().slice(1).forEach(r => {
    if (normPhone_(r[1]) !== key) return;
    log.push({ time: r[0] ? new Date(r[0]).toISOString() : "", field:String(r[2] || ""), oldV:String(r[3] || ""), newV:String(r[4] || ""), by:String(r[5] || ""), note:String(r[6] || "") });
  });
  log.sort((a, b) => b.time.localeCompare(a.time));
  const notes = [];
  const nsh = ss.getSheetByName(NOTES_TAB);
  if (nsh && nsh.getLastRow() > 1 && m.id) nsh.getDataRange().getValues().slice(1).forEach((r, i) => {
    if (String(r[1]) !== m.id) return;
    notes.push({ row: i + 2, time: r[0] ? new Date(r[0]).toISOString() : "", category:String(r[2] || ""), text:String(r[3] || ""), status:String(r[4] || ""), follow:String(r[5]) === "是", doneAt: r[6] ? new Date(r[6]).toISOString() : "" });
  });
  notes.sort((a, b) => b.time.localeCompare(a.time));
  // 會員基本資料（含同意狀態），給後台顯示與「匯出此會員全部資料」（個資法的查詢請求）用
  const sh = ss.getSheetByName(MEMBERS_TAB), row = findMemberRow_(sh, key);
  const cols = memberCols_(sh);
  const v = sh.getRange(row, 1, 1, Math.max(sh.getLastColumn(), 5)).getValues()[0];
  const profile = { id:m.id, name:m.name, phone:String(v[2]), city:m.city, email:m.email, joined: v[0] ? new Date(v[0]).toISOString() : "",
    consent:m.consent, consentAt: cols["同意時間"] && v[cols["同意時間"] - 1] ? new Date(v[cols["同意時間"] - 1]).toISOString() : "",
    source: cols["來源"] ? String(v[cols["來源"] - 1] || "") : "", status: cols["狀態"] ? String(v[cols["狀態"] - 1] || "正常") : "正常" };
  return { ok:true, profile:profile, orders:orders, log:log.slice(0, 100), notes:notes };
}

function adminNoteAdd(ss, d){
  const m = lookupMember_(ss, d.phone);
  const text = safeText_(d.text, 120);
  if (!m || !m.id) return { ok:false, error:"not found" };
  if (NOTE_CATEGORIES.indexOf(d.category) < 0) return { ok:false, error:"bad category" };
  if (!text) return { ok:false, error:"text required" };
  const follow = isTrue_(d.follow) && d.category !== "一般備註";
  notesSheet_(ss).appendRow([ new Date(), m.id, d.category, text, follow ? "待處理" : "已記錄", follow ? "是" : "否", "" ]);
  return { ok:true };
}
function adminNoteStatus(ss, d){
  const sh = notesSheet_(ss), row = Number(d.row), m = lookupMember_(ss, d.phone);
  if (!m || !row || row < 2 || row > sh.getLastRow()) return { ok:false, error:"bad row" };
  if (String(sh.getRange(row, 2).getValue()) !== m.id) return { ok:false, error:"資料已變動，請重新整理" };
  sh.getRange(row, 5).setValue("已處理");
  sh.getRange(row, 7).setValue(new Date());
  return { ok:true };
}

/* 依個資法刪除（匿名化）：清除姓名、手機、Email、地區等可識別資料，保留會員編號、訂單金額／品項（帳務需要）、去識別的評分。
   必須輸入該會員的編號確認。刪除後同一支手機可以重新註冊成新會員。 */
function adminMemberDelete(ss, d){
  const key = normPhone_(d.phone);
  const m = lookupMember_(ss, d.phone);
  if (!key || !m || !m.id) return { ok:false, error:"not found" };
  if (String(d.confirm || "").trim() !== m.id) return { ok:false, error:"confirm mismatch" };
  const cols = ensureMemberSchema_(ss, true);
  const msh = ss.getSheetByName(MEMBERS_TAB), row = findMemberRow_(msh, key);
  const DEL = "(已刪除)";
  // 會員資料
  msh.getRange(row, 2).setValue(DEL);
  setTextCell(msh, row, 3, "");
  msh.getRange(row, 4).setValue("");
  msh.getRange(row, 5).setValue("");
  msh.getRange(row, cols["行銷同意"]).setValue(false);
  msh.getRange(row, cols["同意時間"]).setValue("");
  msh.getRange(row, cols["狀態"]).setValue("已刪除");
  msh.getRange(row, ensureCol_(msh, "更新時間").col).setValue(new Date());
  // 訂單：保留金額與品項（報稅對帳），拿掉姓名、手機、地區
  const osh = ss.getSheetByName(ORDERS_TAB);
  if (osh && osh.getLastRow() > 1){
    const rows = osh.getDataRange().getValues();
    const head = rows[0].map(h => String(h).trim());
    const pI = head.indexOf("手機"), nI = head.indexOf("姓名"), aI = head.indexOf("寄送地址") > -1 ? head.indexOf("寄送地址") : head.indexOf("所在地區");
    for (let r = 1; r < rows.length; r++){
      if (normPhone_(rows[r][pI]) !== key) continue;
      if (nI > -1) osh.getRange(r + 1, nI + 1).setValue(DEL);
      if (aI > -1) osh.getRange(r + 1, aI + 1).setValue("");
      setTextCell(osh, r + 1, pI + 1, "");
    }
  }
  // 點數：刪除（由下往上刪，列號才不會跑掉）
  const psh = ss.getSheetByName(POINTS_TAB);
  if (psh && psh.getLastRow() > 1){
    const rows = psh.getDataRange().getValues();
    for (let r = rows.length - 1; r >= 1; r--) if (normPhone_(rows[r][0]) === key) psh.deleteRow(r + 1);
  }
  // 評分：保留分數（統計用），去掉手機
  const rsh = ss.getSheetByName(REVIEWS_TAB);
  if (rsh && rsh.getLastRow() > 1){
    const rows = rsh.getDataRange().getValues();
    for (let r = 1; r < rows.length; r++) if (normPhone_(rows[r][1]) === key) setTextCell(rsh, r + 1, 2, "");
  }
  // 異動紀錄：拿掉手機，並把姓名／手機／Email／地區的新舊值遮掉
  const lsh = ss.getSheetByName(MEMBER_LOG_TAB);
  if (lsh && lsh.getLastRow() > 1){
    const rows = lsh.getDataRange().getValues();
    for (let r = 1; r < rows.length; r++){
      if (normPhone_(rows[r][1]) !== key) continue;
      setTextCell(lsh, r + 1, 2, "");
      if (["姓名", "手機", "Email", "所在地區"].indexOf(String(rows[r][2])) > -1){ lsh.getRange(r + 1, 4).setValue(DEL); lsh.getRange(r + 1, 5).setValue(DEL); }
    }
  }
  // 客服紀錄：整筆刪除（內容可能含個人資訊）
  const nsh = ss.getSheetByName(NOTES_TAB);
  if (nsh && nsh.getLastRow() > 1){
    const rows = nsh.getDataRange().getValues();
    for (let r = rows.length - 1; r >= 1; r--) if (String(rows[r][1]) === m.id) nsh.deleteRow(r + 1);
  }
  logChange_(ss, "", "刪除會員資料", "", "已匿名化（保留編號 " + m.id + "）", "管理者", safeText_(d.reason || "依當事人要求", 60));
  return { ok:true, id:m.id };
}

function adminMemberUpdate(ss, d){
  const key = normPhone_(d.phone);
  if (!key) return { ok:false, error:"bad phone" };
  // d.phone 是「要找的會員」；要改成的新號碼用 d.newPhone
  return applyMemberEdit_(ss, key, Object.assign({}, d, { phone: d.newPhone }), "管理者");
}

function adminMemberCode(ss, d){
  const key = normPhone_(d.phone);
  const m = lookupMember_(ss, d.phone);
  if (!key || !m) return { ok:false, error:"not found" };
  const code = newCode_();
  storeCode_(key, code, 21600);   // CacheService 上限 6 小時
  logChange_(ss, String(d.phone), "驗證碼", "", "店家已發出", "管理者", "供會員自行查看／補登資料（驗證碼本身不記錄）");
  return { ok:true, code:code, hours:6 };
}

function adminPointsAdjust(ss, d){
  const key = normPhone_(d.phone);
  const delta = Math.trunc(Number(d.delta));
  const reason = safeText_(d.reason, 60);
  if (!key || !lookupMember_(ss, d.phone)) return { ok:false, error:"not found" };
  if (!delta || Math.abs(delta) > 1000) return { ok:false, error:"bad delta" };
  if (!reason) return { ok:false, error:"reason required" };
  const before = readPoints(d.phone).points;
  pointsAdjust(ss, d.phone, delta);
  const after = readPoints(d.phone).points;
  logChange_(ss, String(d.phone), "點數", String(before), String(after), "管理者", reason);
  return { ok:true, points:after };
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
  if (amount > 100000000) return { ok:false, error:"amount too large" };
  const m = String(d.date || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const dt = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date();
  costsSheet(ss).appendRow([ dt, String(d.item), cat, amount, String(d.note || "") ]);
  return { ok:true };
}

function adminDeleteCost(ss, d){
  const sh = costsSheet(ss);
  const row = Number(d.row);
  if (!row || row < 2 || row > sh.getLastRow()) return { ok:false, error:"bad row" };
  // 用列號刪除前，先核對那一列的項目名稱，避免另一個視窗資料過期時刪到別筆
  if (d.item !== undefined && String(sh.getRange(row, 2).getValue()) !== String(d.item)) return { ok:false, error:"資料已變動，請重新整理後再刪" };
  sh.deleteRow(row);
  return { ok:true };
}


/* ========================= 行銷推廣站：文章 / 圖片 / 影音 =========================
 * 多個獨立站共用同一個「posts」分頁，用「站台代號 site」區分（例如 xiang、class）。
 * 公開讀取：GET ?action=posts&site=xxx（只回傳狀態＝發佈的文章）
 * 管理：admin.html「內容」分頁（需 ADMIN_KEY）。圖片上傳到你的 Google 雲端硬碟「行銷站圖片」資料夾。 */
const POSTS_TAB = "posts";
const POST_HEAD = ["id","site","時間","標題","分類","摘要","內文","封面圖","影音","狀態"];
const IMAGE_FOLDER = "行銷站圖片";

function postsSheet(ss){
  let s = ss.getSheetByName(POSTS_TAB) || ss.insertSheet(POSTS_TAB);
  if (s.getLastRow() === 0) s.appendRow(POST_HEAD);
  return s;
}
function postRowToObj(r, row){
  return {
    row: row, id:String(r[0]), site:String(r[1]),
    time: r[2] ? new Date(r[2]).toISOString() : "",
    title:String(r[3]||""), category:String(r[4]||""), summary:String(r[5]||""),
    body:String(r[6]||""), cover:String(r[7]||""), media:String(r[8]||""),
    status:String(r[9]||"草稿")
  };
}
function listPosts(ss, site, onlyPublished){
  const sh = postsSheet(ss);
  if (sh.getLastRow() < 2) return [];
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, POST_HEAD.length).getValues();
  const out = [];
  rows.forEach((r, i) => {
    if (!r[0]) return;
    if (site && String(r[1]) !== site) return;
    if (onlyPublished && String(r[9]) !== "發佈") return;
    const o = postRowToObj(r, i + 2);
    if (onlyPublished) delete o.row;
    out.push(o);
  });
  out.sort((a, b) => b.time.localeCompare(a.time));
  return out;
}
function getPosts(site){
  return listPosts(SpreadsheetApp.openById(SHEET_ID), String(site || ""), true);
}

function adminSavePost(ss, d){
  const site = String(d.site || "").trim().replace(/[^\w-]/g, "");
  const title = String(d.title || "").trim();
  if (!site || !title) return { ok:false, error:"site/title required" };
  const status = d.status === "發佈" ? "發佈" : "草稿";
  const sh = postsSheet(ss);
  const vals = [ site, d.time ? new Date(d.time) : new Date(), title, String(d.category || "").trim(),
                 String(d.summary || ""), String(d.body || ""), String(d.cover || "").trim(), String(d.media || "").trim(), status ];
  if (d.id){
    const rows = sh.getRange(2, 1, Math.max(sh.getLastRow() - 1, 1), 1).getValues();
    for (let i = 0; i < rows.length; i++){
      if (String(rows[i][0]) === String(d.id)){
        sh.getRange(i + 2, 2, 1, vals.length).setValues([vals]);
        return { ok:true, id:String(d.id) };
      }
    }
  }
  const id = Utilities.getUuid().slice(0, 8);
  sh.appendRow([ id ].concat(vals));
  return { ok:true, id:id };
}
function adminDeletePost(ss, d){
  const sh = postsSheet(ss);
  if (sh.getLastRow() < 2) return { ok:false, error:"not found" };
  const ids = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++){
    if (String(ids[i][0]) === String(d.id)){ sh.deleteRow(i + 2); return { ok:true }; }
  }
  return { ok:false, error:"not found" };
}

/* 圖片上傳：前端先縮圖成 JPEG 再以 base64 傳來；存進雲端硬碟並設成「知道連結的人可檢視」 */
function adminUploadImage(d){
  const data = String(d.data || "");
  if (!data || data.length > 8 * 1024 * 1024) return { ok:false, error:"image too large" };
  const type = /^image\/(jpeg|png|webp|gif)$/.test(d.mime) ? d.mime : "image/jpeg";
  const it = DriveApp.getFoldersByName(IMAGE_FOLDER);
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder(IMAGE_FOLDER);
  const ext = type.split("/")[1];
  const file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(data), type, "img-" + Date.now() + "." + ext));
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { ok:true, url:"https://drive.google.com/thumbnail?id=" + file.getId() + "&sz=w1600" };
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
    c.appendRow([new Date(), "範例：生豆採購", "生豆", 3000, "示範用，可刪除這一列"]);
  }

  // 總覽：粗略試算「營業額 - 成本」，公式會自動抓 orders 和 costs 的加總
  let d = ss.getSheetByName(DASHBOARD_TAB) || ss.insertSheet(DASHBOARD_TAB);
  if (d.getLastRow() === 0){
    d.appendRow(["翔天然　營運總覽（粗略試算，僅供參考）"]);
    d.appendRow([""]);
    d.appendRow(["總營業額（orders「已完成」訂單金額加總）", "=SUMIF(orders!G:G,\"已完成\",orders!F:F)"]);
    d.appendRow(["總成本（costs 全部支出金額加總）",     "=SUM(costs!D:D)"]);
    d.appendRow(["粗估淨利（營業額－成本）",             "=B3-B4"]);
    d.appendRow([""]);
    d.appendRow(["＊ 營業額只計「已完成」訂單，與管理後台報表一致；只是粗估，正式對帳仍需人工確認。"]);
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
