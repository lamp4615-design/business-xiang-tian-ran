/* 產生 SEO 用的靜態網頁（不需要安裝任何套件，只用 Node 內建功能）
 *
 *   node build-seo.js
 *
 * 為什麼需要：官網是「單頁式」網站，商品與文章都靠 JavaScript 在同一個網址裡切換，
 * Google 只看得到首頁一個網址，沒辦法分別收錄「某一支咖啡豆」或「某一篇文章」。
 * 這支程式讀 products.json／posts.json／reviews.json，替每個商品與每篇文章各產生一個獨立網頁，
 * 並更新 sitemap.xml。GitHub Actions 每次更新商品資料後會自動執行（見 .github/workflows/update-products.yml）。
 *
 * 產生的檔案（都可以刪掉重跑，不要手動改）：
 *   products/<商品>/index.html   商品頁（含 Product 結構化資料、風味評價）
 *   articles/<文章編號>/index.html  文章頁（含 Article 結構化資料）
 *   explore/index.html            全部咖啡豆與文章的總覽頁（站內連結的集散地）
 *   drip/index.html               耳掛咖啡頁（products.json 裡 drip:true 的品項；選組數後放進和官網共用的購物袋）
 *   sitemap.xml
 * 網站網址取自 index.html 的 <link rel="canonical">，之後換網域只要改那一行。 */
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const read = (f, def) => { try { return fs.readFileSync(path.join(ROOT, f), "utf8"); } catch (e) { return def; } };
const readJson = (f) => { try { return JSON.parse(read(f, "[]")); } catch (e) { return []; } };

const indexHtml = read("index.html", "");
const adminHtml = read("admin.html", "");
const SITE = ((indexHtml.match(/<link rel="canonical" href="([^"]+)"/) || [])[1] || "").replace(/\/?$/, "/");
if (!SITE) throw new Error("index.html 找不到 canonical 網址");
const BRAND = "翔天然";
const OG_DEFAULT = SITE + "og-image.png";

const products = readJson("products.json");
const posts = readJson("posts.json").filter((p) => p.status === "發佈").sort((a, b) => String(b.time).localeCompare(String(a.time)));
const reviews = readJson("reviews.json");

/* 耳掛（2026-10-27）：做耳掛的品項＝products.json 裡 drip:true 的（後端 Code.gs 的 DRIP_ 常數決定價格與規則，這裡只負責顯示） */
const drips = products.filter((p) => p.drip);
const DRIP_URL = SITE + "drip/";
const DRIP = { setBags: 10, bagGrams: 12, bonusSets: 5, bonusPoints: 5, ship: "5～7 天", water: "180ml", waterMax: "200ml" };
const dripPriceOf = (p) => Number(p && p.dripPrice) || Number((drips[0] || {}).dripPrice) || 350;
const API_URL = "https://script.google.com/macros/s/AKfycbyZqvkluw1OoigP2Bw_KmkqyKPzlklCWHu57MGLOULH5EVI0ctTmnw5d4WZgZU7wy-iuQ/exec";

/* ---------- 重用網站本身的文章排版程式（和官網、後台預覽完全一致）---------- */
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
function loadRenderer() {
  const a = indexHtml.indexOf("const SH_COLORS="), b = indexHtml.indexOf("const SH_DECO=");
  if (a < 0 || b < 0 || b <= a) throw new Error("index.html 找不到文章排版程式（SH_COLORS … SH_DECO）");
  return new Function("esc", indexHtml.slice(a, b) + "\nreturn { shBody, shImgUrl, shEmbed, shSafeUrl };")(esc);
}
const R = loadRenderer();
// 靜態頁不跑 JS，圖片載入失敗的處理屬性拿掉
const cleanHtml = (h) => h.replace(/\sonerror="[^"]*"/g, "").replace(/\sdata-cv="1"/g, "");

/* ---------- 小工具 ---------- */
const slugOf = (() => {
  const used = new Set();
  return (id) => {
    let s = String(id).replace(/[\\/?#%&"'<>:*|]/g, "-").replace(/[()（）\s]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "item";
    let t = s, n = 2;
    while (used.has(t)) t = s + "-" + n++;
    used.add(t);
    return t;
  };
})();
const urlOf = (dir, slug) => SITE + dir + "/" + encodeURIComponent(slug) + "/";
const dateTW = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleDateString("sv-SE", { timeZone: "Asia/Taipei" }); };
const specOf = (p, label) => ((p.specs || []).find((s) => s.label === label) || {}).value || "";
const money = (n) => "NT$ " + Number(n).toLocaleString("en-US");
const ldJson = (o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, "\\u003c")}</script>`;
const cut = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
// Google 雲端硬碟縮圖網址在社群分享常常讀不到，沒有穩定圖片就用預設分享圖
const shareImg = (u) => (u && !/drive\.google\.com/.test(u) ? u : OG_DEFAULT);

/* 風味評價：和官網一樣取「眾數」，並列時取平均 */
const AXES = [["aroma", "香氣"], ["acidity", "酸質"], ["sweetness", "甜感"], ["body", "醇厚度"], ["bitterness", "苦味"]];
const AXIS_ICON = { "香氣": "👃", "酸質": "🍋", "甜感": "🍯", "醇厚度": "🍫", "苦味": "☕" };
const modeOf = (nums) => {
  if (!nums.length) return 0;
  const f = {}; nums.forEach((n) => (f[n] = (f[n] || 0) + 1));
  const max = Math.max(...Object.values(f));
  const top = Object.keys(f).filter((k) => f[k] === max).map(Number);
  return top.reduce((s, n) => s + n, 0) / top.length;
};
const ratingOf = (name) => {
  const list = reviews.filter((r) => r.product === name);
  return list.length ? { n: list.length, axes: AXES.map(([k, label]) => ({ label, v: modeOf(list.map((r) => Number(r[k]) || 0)) })) } : null;
};

/* ---------- 字型（CR-20261017-02，與 index.html 一致） ----------
   預設不從 Google Fonts 下載中文字型，用 --sans 字型堆疊（Noto Sans TC → 蘋方 → 微軟正黑體）。
   TODO 董事會：若 index.html 的 USE_WEB_FONT 改成 true，這裡也改成 true，商品／文章頁會以非阻擋方式載入 Noto Sans TC。 */
const USE_WEB_FONT = false;
const WEB_FONT_URL = "https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700&display=swap";
const WEB_FONT_HEAD = USE_WEB_FONT
  ? `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="${WEB_FONT_URL}" media="print" onload="this.media='all'"><noscript><link rel="stylesheet" href="${WEB_FONT_URL}"></noscript>`
  : "";

/* ---------- 共用版型 ---------- */
// 文章排版樣式直接取自後台預覽（.sh-art … .sh-embed），確保文章在靜態頁長得和官網一致
const articleCss = (() => {
  const a = adminHtml.indexOf(".sh-art{max-width"), b = adminHtml.indexOf("</style>", a);
  return a > -1 && b > a ? adminHtml.slice(a, b) : ".sh-art img{max-width:100%}";
})();
const CSS = `:root{--pine:#294636;--pine-mid:#4E6B52;--dawn:#E4892B;--dawn-soft:#F3B85F;--paper:#F5F3EB;--paper-2:#EAE7DC;--ink:#241C15;--ink-70:rgba(36,28,21,.72);--ink-45:rgba(36,28,21,.48);--line:rgba(46,61,48,.16);--sans:"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif;--serif:var(--sans);--latin:Georgia,"Times New Roman",serif}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.85 var(--sans)}
a{color:var(--pine)}img{max-width:100%;height:auto}.wrap{max-width:980px;margin:0 auto;padding:0 20px}
.top{background:var(--pine);color:#fff}.top .wrap{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-top:14px;padding-bottom:14px;flex-wrap:wrap}
.top a{color:#fff;text-decoration:none}.brand{font-family:var(--serif);font-weight:700;font-size:1.25rem;letter-spacing:.08em}.top nav a{margin-left:18px;font-size:.95rem;opacity:.9;white-space:nowrap;display:inline-block}.top nav a:hover{opacity:1;text-decoration:underline}
.crumb{font-size:.85rem;color:var(--ink-45);margin:22px 0 8px}.crumb a{color:var(--ink-45)}
h1{font-family:var(--serif);font-weight:500;color:var(--pine);font-size:clamp(1.7rem,4vw,2.4rem);line-height:1.4;margin:.2em 0 .3em;letter-spacing:.03em}
h2{font-family:var(--serif);font-weight:500;color:var(--pine);font-size:1.35rem;margin:2em 0 .6em}
.prod{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:34px;align-items:start;margin-top:10px}
.pimg{border-radius:20px;overflow:hidden;background:var(--paper-2);aspect-ratio:4/3;box-shadow:0 14px 34px rgba(36,28,21,.12)}.pimg img{width:100%;height:100%;object-fit:cover;display:block}
.badge{display:inline-block;background:var(--dawn);color:var(--ink);font-size:.78rem;font-weight:700;padding:2px 12px;border-radius:99px;letter-spacing:.08em}
.origin{color:var(--ink-70);margin:0 0 14px}.specs{margin:0 0 14px;border-top:1px solid var(--line)}.specs div{display:flex;gap:14px;padding:9px 0;border-bottom:1px solid var(--line)}.specs dt{color:var(--ink-45);min-width:78px;letter-spacing:.06em}.specs dd{margin:0}
.tags{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 16px;padding:0;list-style:none}.tags li{border:1px solid var(--line);border-radius:99px;padding:2px 14px;font-size:.9rem;background:#fff}
.price{font-family:var(--serif);font-size:1.8rem;color:var(--pine);margin:6px 0 16px}.price small{font-size:.95rem;color:var(--ink-45);margin-left:4px}
.btn{display:inline-block;background:var(--dawn);color:var(--ink);font-weight:700;text-decoration:none;padding:11px 24px;border-radius:99px;margin:0 8px 8px 0}.btn.ghost{background:transparent;border:1px solid var(--pine-mid);color:var(--pine)}
.rate-list{list-style:none;margin:0;padding:0;background:#fff;border-radius:14px;overflow:hidden}
.rate-list li{display:grid;grid-template-columns:30px 70px 1fr 34px;align-items:center;gap:14px;padding:11px 16px;border-bottom:1px solid var(--line)}.rate-list li:last-child{border-bottom:0}
.rate-list .ico{font-size:1.2rem;text-align:center}.rate-list .rl-label{color:var(--ink-70);font-size:.92rem}.rate-list .rl-score{text-align:right;font-weight:700;color:var(--pine)}
.bar{height:10px;background:var(--paper-2);border-radius:6px;overflow:hidden}.bar span{display:block;height:100%;background:var(--dawn)}
.atc-msg{min-height:1.3em;font-size:.9rem;color:var(--pine-mid);margin:0 0 8px}
.drip-note{margin:4px 0 12px;padding:10px 14px;border-radius:12px;background:#FFF4E0;border:1px solid #F0D49B;color:#6B4510;font-size:.92rem}.drip-note a{color:#B96E1E;font-weight:700}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:18px;list-style:none;padding:0;margin:0}.card{background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 8px 22px rgba(36,28,21,.08)}
.card a{display:block;color:inherit;text-decoration:none}.card .ci{aspect-ratio:4/3;background:var(--paper-2)}.card .ci img{width:100%;height:100%;object-fit:cover;display:block}.card .cb{padding:14px 16px}
.card h3{margin:0 0 2px;font-family:var(--serif);color:var(--pine);font-size:1.1rem}.card p{margin:0;color:var(--ink-70);font-size:.9rem;line-height:1.6}
.list{list-style:none;padding:0;margin:0}.list li{padding:12px 0;border-bottom:1px solid var(--line)}.list a{font-weight:700;text-decoration:none}.list small{display:block;color:var(--ink-45)}
.art-meta{color:var(--ink-45);font-size:.9rem}.lead{font-size:1.1rem;color:var(--ink-70);border-left:3px solid var(--dawn-soft);padding-left:16px;margin:12px 0 24px}
.end{text-align:center;margin:3em 0 1em;padding:24px;background:var(--paper-2);border-radius:18px}
footer.foot{margin-top:60px;background:var(--pine);color:#fff;padding:28px 0;font-size:.9rem}footer.foot a{color:#fff}footer.foot p{margin:4px 0;opacity:.85}
@media(max-width:760px){.prod{grid-template-columns:1fr}.top nav a{margin:0 14px 0 0}}
${articleCss}`;

function shell({ title, desc, canonical, image, type = "website", ld = [], body, css = "", script = "", noindex = false }) {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">${noindex ? `\n<meta name="robots" content="noindex">` : ""}
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:site_name" content="${BRAND}">
<meta property="og:locale" content="zh_TW">
<meta property="og:type" content="${type}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(image || OG_DEFAULT)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(image || OG_DEFAULT)}">
<meta name="theme-color" content="#294636">
<link rel="icon" href="${SITE}%E7%BF%94%E8%87%AA%E5%9C%A8.png">
${WEB_FONT_HEAD}
${ld.map(ldJson).join("\n")}
<style>${CSS}${css}</style>
<!-- Cloudflare Web Analytics --><script type='module' src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "0983c24b22934644914ceb51ef122b23"}'></script><!-- End Cloudflare Web Analytics -->
</head>
<body>
<header class="top"><div class="wrap"><a class="brand" href="${SITE}">${BRAND}</a>
<nav aria-label="主選單"><a href="${SITE}explore/">咖啡豆與文章</a><a href="${SITE}#products">線上選購</a>${drips.length ? `<a href="${DRIP_URL}">耳掛咖啡</a>` : ""}<a href="${SITE}#flavor">風味評分</a><a href="${SITE}#member">會員</a></nav></div></header>
<main class="wrap">
${body}
</main>
<footer class="foot"><div class="wrap"><p><strong>${BRAND}，翔自在。</strong>自家烘焙精品咖啡豆，逐批手挑瑕疵豆，把一杯好咖啡帶到你的每一天。</p>
<p><a href="${SITE}">回到官網首頁</a>・<a href="${SITE}explore/">全部咖啡豆與文章</a></p><p>© ${new Date().getFullYear()} ${BRAND}</p></div></footer>
<script>
/* 這個頁面本身沒有在跑官網的程式，「加入購物袋」只做一件事：把商品寫進和官網共用的
   localStorage 購物袋（key 跟 index.html 的 CART_KEY 一致），回到官網時購物袋就看得到。
   不要改這個 key，不然兩邊的購物袋會對不起來。 */
(function(){
  var KEY="xn_cart";
  function load(){try{var a=JSON.parse(localStorage.getItem(KEY)||"[]");return Array.isArray(a)?a:[];}catch(e){return [];}}
  function save(c){try{localStorage.setItem(KEY,JSON.stringify(c));}catch(e){}}
  document.querySelectorAll("[data-want]").forEach(function(btn){
    btn.addEventListener("click",function(){
      var cid="";try{cid=localStorage.getItem("xn_cid")||"";if(!cid){cid=Math.random().toString(36).slice(2,12);localStorage.setItem("xn_cid",cid);}}catch(e){}
      fetch("https://script.google.com/macros/s/AKfycbyZqvkluw1OoigP2Bw_KmkqyKPzlklCWHu57MGLOULH5EVI0ctTmnw5d4WZgZU7wy-iuQ/exec",{method:"POST",headers:{"Content-Type":"text/plain;charset=utf-8"},body:JSON.stringify({action:"restock_interest",product_id:btn.getAttribute("data-want"),client_id:cid})}).catch(function(){});
      btn.textContent="收到了，謝謝 ✓";btn.disabled=true;
    });
  });
  document.querySelectorAll("[data-atc]").forEach(function(btn){
    btn.addEventListener("click",function(){
      var id=btn.getAttribute("data-atc");
      var cart=load();
      var item=cart.find(function(c){return String(c.id)===String(id);});
      if(item)item.qty++;else cart.push({id:id,qty:1});
      save(cart);
      btn.textContent="已加入購物袋 ✓";
      var msg=document.getElementById("atc-msg");
      if(msg)msg.textContent="已加入購物袋，前往官網即可結帳。";
      var link=document.getElementById("cartlink");
      if(link)link.style.display="";
    });
  });
})();
</script>${script}
</body>
</html>
`;
}

const breadcrumb = (items) => ({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: items.map((it, i) => ({ "@type": "ListItem", position: i + 1, name: it[0], item: it[1] })) });
const cardOf = (p) => `<li class="card"><a href="${p._url}"><div class="ci">${p.image ? `<img src="${esc(p.image)}" alt="${esc(p.name)} 咖啡豆" loading="lazy" width="400" height="300">` : ""}</div><div class="cb"><h3>${esc(p.name)}</h3><p>${esc(p.subtitle)}${specOf(p, "處理法") ? "・" + esc(specOf(p, "處理法")) : ""}</p><p>${money(p.price)}${p.unit ? " / " + esc(p.unit) : ""}</p></div></a></li>`;
const postLi = (a) => `<li><a href="${a._url}">${esc(a.title)}</a>${a.summary ? `<small>${esc(cut(a.summary, 60))}</small>` : ""}</li>`;

/* 商品頁的「怎麼沖」與常見問題：由處理法、烘焙度、風味自動帶入，只寫通用的咖啡知識與建議範圍，
 * 不寫運費、出貨、退換貨等店家規定（要寫請另外在這裡加）。 */
const PROCESS_INFO = {
  "日曬": ["日曬處理是讓咖啡果實連著果肉一起曬乾，果肉的糖分與香氣會滲進豆子裡，所以風味通常偏向莓果、熟果的甜感，口感較圓潤。", "88～91°C"],
  "水洗": ["水洗處理是先去除果肉再發酵、清洗後曬乾，風味比較乾淨透亮，能清楚喝到產區的花香、柑橘與酸甜感。", "90～93°C"],
  "蜜處理": ["蜜處理是保留部分果膠黏液一起曬乾，風味介於日曬與水洗之間，常有蜂蜜、紅糖般的甜感與圓潤的口感。", "89～92°C"],
};
const guideOf = (p, process_, roast, pack) => {
  const info = PROCESS_INFO[process_] || ["", "88～93°C"];
  const tagText = (p.tags || []).join("、");
  const qa = [
    process_ && info[0] ? [`${process_}處理的咖啡有什麼特色？`, info[0]] : null,
    tagText ? [`${p.name}喝起來是什麼風味？`, `${p.name}來自${p.subtitle}，${roast ? roast + "，" : ""}風味帶有${tagText}。每個人的味覺感受不同，也可以參考其他人喝過的風味評分。`] : null,
    ["咖啡豆要怎麼保存？", "開封後請密封、避光、放在室溫陰涼處，不建議放冰箱（取出時容易受潮）。一般建議在烘焙後約 2～4 週內喝完，風味表現較好。"],
    [`買${pack ? "「" + pack + "」" : "回去"}的豆子可以沖幾杯？`, "以一杯 15 公克咖啡粉計算，半磅（227 公克）大約可以沖 15 杯左右，實際依個人濃度喜好而定。"],
  ].filter(Boolean);
  return `<section class="guide"><h2>${esc(p.name)}怎麼沖比較好喝？</h2>
<p>手沖濾杯、聖誕壺、愛樂壓都適合。可以先從「水溫 ${info[1]}、粉水比約 1:15、總萃取時間約 2 分 30 秒」開始，覺得偏酸就把水溫調高一點或研磨稍細，覺得偏苦就反過來調整。</p>
<h2>常見問題</h2>
${qa.map((x) => `<h3>${esc(x[0])}</h3><p>${esc(x[1])}</p>`).join("\n")}</section>`;
};

/* ---------- 先替每筆資料決定網址 ---------- */
products.forEach((p) => { p._slug = slugOf("p:" + p.id).replace(/^p-/, ""); p._url = urlOf("products", p._slug); });
posts.forEach((a) => { a._url = urlOf("articles", a.id); });

/* product-urls.json：商品 id → 介紹頁網址，給官網（index.html）抓，讓產品卡可以直接連到介紹頁 */
fs.writeFileSync(path.join(ROOT, "product-urls.json"), JSON.stringify(Object.fromEntries(products.map((p) => [String(p.id), p._url]))));

/* ---------- 清掉舊的產出（下架的商品、取消發佈的文章就不會留著）---------- */
["products", "articles", "explore", "drip"].forEach((d) => fs.rmSync(path.join(ROOT, d), { recursive: true, force: true }));
const write = (rel, html) => { const f = path.join(ROOT, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, html); };

/* ---------- 商品頁 ---------- */
products.forEach((p) => {
  const process_ = specOf(p, "處理法"), roast = specOf(p, "烘焙度"), pack = specOf(p, "規格");
  const cat = p.category || "咖啡豆";
  const title = cut(`${p.name}｜${p.subtitle}${process_ ? " " + process_ : ""}${cat}｜${BRAND}`, 64);
  const tagText = (p.tags || []).join("、");
  const desc = cut(`${p.name}，${p.subtitle} 產區${process_ ? process_ + "處理" : ""}的${cat}${roast ? "，" + roast : ""}${tagText ? "，風味帶有" + tagText : ""}。${money(p.price)}${p.unit ? "／" + p.unit : ""}，${BRAND}自家烘焙，可線上選購，也能看大家喝過的風味評分。`, 140);
  const rate = ratingOf(p.name);
  const others = products.filter((x) => x !== p);
  const body = `<nav class="crumb" aria-label="導覽"><a href="${SITE}">${BRAND}</a> › <a href="${SITE}explore/">${esc(cat)}</a> › ${esc(p.name)}</nav>
<article class="prod">
  <div class="pimg">${p.image ? `<img src="${esc(p.image)}" alt="${esc(p.name)} ${esc(cat)}" width="800" height="600">` : ""}</div>
  <div>
    ${p.soldOut ? "" : p.lastCall ? `<span class="badge">即將完售</span>` : p.badge ? `<span class="badge">${esc(p.badge)}</span>` : ""}
    <h1>${esc(p.name)}</h1>
    <p class="origin">${esc(p.subtitle)}・${esc(cat)}</p>
    <dl class="specs">${(p.specs || []).map((s) => `<div><dt>${esc(s.label)}</dt><dd>${esc(s.value)}</dd></div>`).join("")}</dl>
    ${(p.tags || []).length ? `<ul class="tags" aria-label="風味">${p.tags.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
    <div class="price">${money(p.price)}${p.unit ? `<small>／ ${esc(p.unit)}</small>` : ""}</div>
    ${p.soldOut ? `<p class="soldout"><strong>已售完・待補貨</strong></p><p><button type="button" class="btn ghost" data-want="${esc(p.id)}">想再喝到這支</button></p><p style="display:none">` : `<p><button type="button" class="btn" data-atc="${esc(p.id)}">加入購物袋</button>`}<a class="btn ghost" id="cartlink" href="${SITE}#cart" style="display:none">前往購物袋結帳 →</a></p>
    <p class="atc-msg" id="atc-msg"></p>
    ${p.drip && !p.soldOut ? `<p class="drip-note">也有耳掛包：一組 ${DRIP.setBags} 包 ${money(dripPriceOf(p))}，撕開就能沖。<a href="${DRIP_URL}#d-${encodeURIComponent(p.id)}">看耳掛 →</a></p>` : ""}
  </div>
</article>
${rate ? `<section class="rate"><h2>大家喝過的風味評價</h2><p>共 ${rate.n} 則品飲評分，下表是各面向的眾數（1～5 分）。</p><ul class="rate-list">${rate.axes.map((a) => `<li><span class="ico" aria-hidden="true">${AXIS_ICON[a.label] || "●"}</span><span class="rl-label">${a.label}</span><div class="bar"><span style="width:${(a.v / 5) * 100}%"></span></div><span class="rl-score">${a.v % 1 ? a.v.toFixed(1) : a.v}</span></li>`).join("")}</ul></section>` : ""}
${guideOf(p, process_, roast, pack)}
<section><h2>其他咖啡豆</h2><ul class="cards">${others.map(cardOf).join("")}</ul></section>
${posts.length ? `<section><h2>延伸閱讀</h2><ul class="list">${posts.slice(0, 4).map(postLi).join("")}</ul></section>` : ""}`;
  const ld = [{
    "@context": "https://schema.org", "@type": "Product", name: p.name, description: desc, sku: String(p.id), category: cat,
    ...(p.image ? { image: [p.image] } : {}),
    brand: { "@type": "Brand", name: BRAND },
    offers: { "@type": "Offer", url: p._url, priceCurrency: "TWD", price: Number(p.price) || 0, availability: p.soldOut ? "https://schema.org/OutOfStock" : "https://schema.org/InStock", itemCondition: "https://schema.org/NewCondition" },
  }, breadcrumb([[BRAND, SITE], ["咖啡豆與文章", SITE + "explore/"], [p.name, p._url]])];
  write(`products/${p._slug}/index.html`, shell({ title, desc, canonical: p._url, image: shareImg(p.image), type: "product", ld, body }));
});

/* ---------- 文章頁 ---------- */
posts.forEach((a) => {
  const cover = a.cover ? R.shImgUrl(a.cover) : "";
  const date = dateTW(a.time);
  const title = cut(`${a.title}｜${BRAND}`, 64);
  const bodyHtml = cleanHtml(R.shBody(a.body));
  // 文章附的影音連結（admin.html「影音連結」欄，存在 media 欄位），和官網內頁一樣整篇插在封面圖之後、內文之前
  const lead = a.media ? (R.shEmbed(R.shSafeUrl(a.media)) || `<p><a href="${esc(R.shSafeUrl(a.media))}" target="_blank" rel="noopener">觀看影片</a></p>`) : "";
  // 摘要通常只有一句話，搜尋結果顯示的描述太短；接上內文開頭，湊成約 110 字的有內容描述
  const plain = bodyHtml.replace(/<(h2|h3|p|li|div|blockquote)[^>]*>/g, " ").replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/(?:💡|⭐|⚠️?)\s*(?:提示|重點|注意)/g, "").replace(/\s+/g, " ").trim();   // 提示框的圖示與標籤不放進描述
  const desc = cut(a.summary && a.summary.length >= 60 ? a.summary : (a.summary ? a.summary.replace(/[。！？!?]$/, "") + "。" : "") + plain, 120);
  const body = `<nav class="crumb" aria-label="導覽"><a href="${SITE}">${BRAND}</a> › <a href="${SITE}explore/">文章</a> › ${esc(a.title)}</nav>
<article class="sh-art">
  <p class="art-meta">${a.category ? esc(a.category) + "・" : ""}<time datetime="${esc(date)}">${esc(date)}</time></p>
  <h1>${esc(a.title)}</h1>
  ${a.summary ? `<p class="sh-lead">${esc(a.summary)}</p>` : ""}
  ${cover ? `<div class="sh-art-hero nat"><img src="${esc(cover)}" alt="${esc(a.title)}" width="1200" height="675"></div>` : ""}
  ${lead}
  ${bodyHtml}
  <div class="end"><p>喜歡這篇嗎？看看${BRAND}目前有哪些咖啡豆。</p><p><a class="btn" href="${SITE}explore/">看全部咖啡豆</a><a class="btn ghost" href="${SITE}#products">線上選購</a></p></div>
</article>
${posts.length > 1 ? `<section><h2>更多文章</h2><ul class="list">${posts.filter((x) => x !== a).slice(0, 5).map(postLi).join("")}</ul></section>` : ""}`;
  const ld = [{
    "@context": "https://schema.org", "@type": "Article", headline: a.title, description: desc, datePublished: a.time, dateModified: a.time,
    mainEntityOfPage: a._url, ...(cover ? { image: [cover] } : {}),
    author: { "@type": "Organization", name: BRAND }, publisher: { "@type": "Organization", name: BRAND, logo: { "@type": "ImageObject", url: SITE + "%E7%BF%94%E8%87%AA%E5%9C%A8.png" } },
  }, breadcrumb([[BRAND, SITE], ["咖啡豆與文章", SITE + "explore/"], [a.title, a._url]])];
  write(`articles/${a.id}/index.html`, shell({ title, desc, canonical: a._url, image: shareImg(cover), type: "article", ld, body }));
});

/* ---------- 總覽頁：站內連結的集散地，也是「咖啡豆」這類搜尋的落地頁 ---------- */
{
  const url = SITE + "explore/";
  const title = `${BRAND}的咖啡豆與風味文章｜${products.length} 款精品咖啡豆`;
  const origins = [...new Set(products.map((p) => p.subtitle).filter(Boolean))].slice(0, 6).join("、");
  const desc = cut(`${BRAND}目前上架 ${products.length} 款咖啡豆${origins ? "，產區包含 " + origins : ""}，自家烘焙、逐批手挑。另有咖啡知識與風味文章，也能看大家喝過的風味評分。`, 140);
  const body = `<nav class="crumb" aria-label="導覽"><a href="${SITE}">${BRAND}</a> › 咖啡豆與文章</nav>
<h1>咖啡豆與風味文章</h1>
<p class="lead">${BRAND}目前上架 ${products.length} 款咖啡豆。每一款都附完整的產地、處理法與風味，也可以看大家喝過後給的風味評分。</p>
<section><h2>咖啡豆（${products.length} 款）</h2><ul class="cards">${products.map(cardOf).join("")}</ul></section>
${drips.length ? `<section><h2>耳掛咖啡（${drips.length} 種口味）</h2><p>一組 ${DRIP.setBags} 包同口味 ${money(dripPriceOf(drips[0]))}，接單後現磨填裝：${drips.map((p) => esc(p.name)).join("、")}。</p><p><a class="btn" href="${DRIP_URL}">看耳掛咖啡</a></p></section>` : ""}
${posts.length ? `<section><h2>咖啡知識與風味文章</h2><ul class="list">${posts.map(postLi).join("")}</ul></section>` : ""}`;
  const ld = [{
    "@context": "https://schema.org", "@type": "CollectionPage", name: title, description: desc, url,
    mainEntity: { "@type": "ItemList", itemListElement: products.map((p, i) => ({ "@type": "ListItem", position: i + 1, url: p._url, name: p.name })) },
  }, breadcrumb([[BRAND, SITE], ["咖啡豆與文章", url]])];
  write("explore/index.html", shell({ title, desc, canonical: url, image: OG_DEFAULT, ld, body }));
}

/* ---------- 耳掛咖啡頁（drip/）：口味卡片＋組數加減，選好的組數直接寫進和官網共用的購物袋（localStorage xn_cart_drip），
   「前往結帳」到官網 #cart 打開購物袋。售完／即將完售在建置時寫進頁面，開頁後再向後端拿最新狀態更新。 ---------- */
const smallImg = (u) => String(u || "").replace(/([?&]sz=)w\d+/, "$1w600").replace(/(res\.cloudinary\.com\/[^?#]*?)([\/,])w_\d+(?=[,\/])/, "$1$2w_600");
const DRIP_FAQ = [
  ["一組可以混不同口味嗎？", `一組 ${DRIP.setBags} 包是同一種口味。想喝不同口味，就各選一組，例如 5 種口味就是 5 組。`],
  ["可以和半磅咖啡豆一起買嗎？", "可以。耳掛和半磅咖啡豆放在同一個購物袋，到官網一起結帳。"],
  ["多久會出貨？", `耳掛是接單後才現磨、填裝，含耳掛的訂單約 ${DRIP.ship}出貨。`],
  ["點數怎麼算？", `一組 1 點；同一張訂單耳掛買滿 ${DRIP.bonusSets} 組，再多送 ${DRIP.bonusPoints} 點。點數在訂單完成後自動加到會員中心，10 點可以折 100 元。`],
  ["一包可以沖多少？", `每包 ${DRIP.bagGrams} 克，建議注水 ${DRIP.water}；喜歡淡一點可以加到 ${DRIP.waterMax}。`],
  ["怎麼付款？運費多少？", "目前不需要線上付款。下單後我們會主動與你聯繫，確認付款方式與運費。"],
  ["要怎麼保存？", "請放在陰涼乾燥、曬不到太陽的地方。耳掛是現磨的咖啡粉，收到後早點沖來喝，風味最好。"],
];
const DRIP_CSS = `
.dp-hero{position:relative;overflow:hidden;margin:14px 0 30px;padding:clamp(28px,5vw,50px) clamp(22px,5vw,46px);border-radius:26px;color:#fff;background:linear-gradient(115deg,rgba(28,52,38,.97),rgba(41,70,54,.88) 58%,rgba(168,105,31,.66)),var(--pine)}
.dp-hero::after{content:"";position:absolute;right:-70px;top:-80px;width:280px;height:280px;border-radius:50%;background:radial-gradient(circle,var(--dawn-soft),transparent 68%);opacity:.5;pointer-events:none}
.dp-eye{position:relative;z-index:1;font-family:var(--latin);font-size:.74rem;letter-spacing:.32em;text-transform:uppercase;color:var(--dawn-soft)}
.dp-hero h1{position:relative;z-index:1;color:#fff;margin:.2em 0 .25em;font-size:clamp(2rem,6vw,3rem);letter-spacing:.08em}
.dp-hero p{position:relative;z-index:1;max-width:34em;color:rgba(255,255,255,.9);margin:0 0 20px}
.dp-facts{position:relative;z-index:1;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;list-style:none;padding:0;margin:0 0 22px}
.dp-facts li{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);border-radius:14px;padding:10px 12px;font-size:.84rem;line-height:1.5;color:rgba(255,255,255,.88)}
.dp-facts b{display:block;font-family:var(--serif);font-size:1.2rem;color:#fff;letter-spacing:.03em}
.dp-hero .btn{position:relative;z-index:1;margin:0}
.dp-steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;list-style:none;padding:0;margin:0 0 14px;counter-reset:st}
.dp-steps li{counter-increment:st;background:#fff;border:1px solid var(--line);border-radius:16px;padding:14px 16px;font-size:.92rem;line-height:1.7;color:var(--ink-70)}
.dp-steps li::before{content:counter(st);display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;background:var(--dawn);color:var(--ink);font-weight:700;font-size:.85rem;margin-bottom:6px}
.dp-steps b{display:block;color:var(--pine);font-size:1.02rem}
.dp-pts{display:flex;gap:12px;align-items:flex-start;background:#FFF4E0;border:1px solid #F0D49B;color:#6B4510;border-radius:16px;padding:14px 16px;line-height:1.75}
.dp-pts .ic{font-size:1.4rem;line-height:1.25}
.dp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:18px;list-style:none;padding:0;margin:0}
.dcard{background:#fff;border:1px solid var(--line);border-radius:18px;overflow:hidden;display:flex;flex-direction:column;scroll-margin-top:16px;transition:box-shadow .2s,border-color .2s}
.dcard.picked{border-color:var(--dawn);box-shadow:0 10px 26px rgba(228,137,43,.18)}
.dcard:target{box-shadow:0 0 0 3px rgba(228,137,43,.45)}
.dimg{position:relative;aspect-ratio:4/3;background:linear-gradient(135deg,var(--pine),var(--pine-mid))}
.dimg img{width:100%;height:100%;object-fit:cover;display:block}
.dbadge{position:absolute;left:12px;top:12px;background:#C0562C;color:#fff;border-radius:99px;padding:2px 12px;font-size:.78rem;font-weight:700;letter-spacing:.06em}
.dbadge:empty{display:none}
.dcard.off .dbadge{background:#7a7068}
.dcard.off .dimg img{filter:grayscale(.6);opacity:.75}
.dbody{padding:14px 16px 16px;display:flex;flex-direction:column;flex:1}
.dbody h3{margin:0;font-family:var(--serif);color:var(--pine);font-size:1.15rem;letter-spacing:.04em}
.dorig{margin:2px 0 8px;color:var(--ink-45);font-size:.86rem}
.dtags{display:flex;flex-wrap:wrap;gap:6px;list-style:none;padding:0;margin:0 0 12px}
.dtags li{border:1px solid var(--line);border-radius:99px;padding:0 10px;font-size:.8rem;color:var(--pine-mid)}
.dfoot{margin-top:auto;display:flex;align-items:center;justify-content:space-between;gap:10px}
.dprice{font-family:var(--serif);font-size:1.25rem;color:var(--ink);line-height:1.3}
.dprice small{display:block;font-family:var(--sans);font-size:.76rem;color:var(--ink-45)}
.step{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:99px;overflow:hidden;background:var(--paper)}
.step button{width:40px;height:40px;border:0;background:none;font-size:1.2rem;cursor:pointer;color:var(--ink);font-family:var(--sans)}
.step button:hover:not(:disabled){background:rgba(46,61,48,.08)}
.step button:disabled{opacity:.3;cursor:default}
.step output{min-width:46px;text-align:center;font-weight:700;font-size:.95rem}
.dso{display:none;margin:8px 0 0;font-size:.84rem;color:#a4432f}
.dcard.off .dso{display:block}
.dmore{margin:10px 0 0;font-size:.85rem}
.brew{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.brew li{background:#fff;border:1px solid var(--line);border-radius:16px;padding:14px;font-size:.92rem;line-height:1.7;color:var(--ink-70)}
.brew b{display:flex;width:30px;height:30px;border-radius:50%;align-items:center;justify-content:center;background:var(--pine);color:#fff;font-size:.9rem;margin-bottom:6px}
.dnote{color:var(--ink-70);font-size:.92rem;margin:12px 0 0}
.faq h3{font-family:var(--serif);color:var(--pine);font-size:1.05rem;margin:1.3em 0 .2em}
.faq p{margin:0;color:var(--ink-70)}
.dp-empty{background:#fff;border:1px dashed var(--pine-mid);border-radius:18px;padding:26px;text-align:center;color:var(--ink-70)}
.dbar{position:fixed;left:0;right:0;bottom:0;z-index:50;background:var(--pine);color:#fff;padding:10px 16px calc(10px + env(safe-area-inset-bottom));box-shadow:0 -8px 30px rgba(0,0,0,.18);transform:translateY(130%);transition:transform .3s}
.dbar.show{transform:none}
.dbar-in{max-width:980px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;gap:12px}
.dbar-t{line-height:1.4;min-width:0}
.dbar-t strong{display:block;font-size:1rem}
.dbar-t span{font-size:.82rem;opacity:.88}
.dbar .btn{margin:0;white-space:nowrap}
body.has-bar footer.foot{padding-bottom:96px}
@media(max-width:760px){.dp-facts{grid-template-columns:repeat(2,minmax(0,1fr))}.dp-steps{grid-template-columns:1fr}.brew{grid-template-columns:1fr 1fr}}
/* 手機：口味卡改成「左圖右文」，一次看得到更多口味，比較好挑好幾種 */
@media(max-width:560px){
  .dp-grid{grid-template-columns:1fr;gap:12px}
  .dcard{flex-direction:row}
  .dimg{flex:none;width:100px;aspect-ratio:auto}
  .dimg img{position:absolute;inset:0}
  .dbadge{left:6px;right:6px;top:6px;padding:1px 6px;font-size:.66rem;letter-spacing:0;text-align:center;line-height:1.5}
  .dbody{padding:12px 12px 12px 14px;min-width:0}
  .dbody h3{font-size:1.05rem}
  .dorig{font-size:.8rem;margin:0 0 6px;line-height:1.5}
  .dtags{margin:0 0 8px}.dtags li{font-size:.74rem;padding:0 8px}.dtags li:nth-child(n+4){display:none}
  .dfoot{gap:6px}
  .dprice{font-size:1.05rem}
  .dprice small{font-size:.72rem}.dprice .long{display:none}
  .dbar .btn{padding:10px 16px}
  .step button{width:34px;height:36px}
  .step output{min-width:40px;font-size:.88rem}
  .dmore{margin-top:6px;font-size:.8rem}
}`;
/* 開頁後：① 組數加減寫進 localStorage（官網購物袋讀同一個 key）② 底部列顯示已選組數、金額、點數 ③ 向後端拿最新的售完／即將完售／是否還做耳掛。
   key 與規則跟 index.html 的 DRIP_CART_KEY、dripPoints() 一致，改這裡要一起改。 */
const dripScript = () => `<script>
(function(){
  var KEY="xn_cart_drip",BEAN_KEY="xn_cart",PROD_KEY="xtr_products_v1",API=${JSON.stringify(API_URL)};
  var SET_BAGS=${DRIP.setBags},BONUS_SETS=${DRIP.bonusSets},BONUS_PTS=${DRIP.bonusPoints};
  var cards=[].slice.call(document.querySelectorAll(".dcard")),bar=document.getElementById("dbar");
  function load(k){try{var a=JSON.parse(localStorage.getItem(k)||"[]");return Array.isArray(a)?a:[];}catch(e){return [];}}
  var cart=load(KEY);
  function qtyOf(id){for(var i=0;i<cart.length;i++)if(String(cart[i].id)===String(id))return Number(cart[i].qty)||0;return 0;}
  function setQty(id,q){
    q=Math.max(0,Math.min(100,q));
    cart=cart.filter(function(c){return String(c.id)!==String(id);});
    if(q>0)cart.push({id:id,qty:q});
    try{localStorage.setItem(KEY,JSON.stringify(cart));}catch(e){}
    render();
  }
  function priceOf(id){for(var i=0;i<cards.length;i++)if(cards[i].getAttribute("data-id")===String(id))return Number(cards[i].getAttribute("data-price"))||0;return 0;}
  function render(){
    var sets=0,total=0;
    cart.forEach(function(c){sets+=Number(c.qty)||0;total+=(Number(c.qty)||0)*priceOf(c.id);});
    cards.forEach(function(el){
      var q=qtyOf(el.getAttribute("data-id")),off=el.classList.contains("off");
      el.querySelector("output").textContent=q+" 組";
      el.classList.toggle("picked",q>0);
      el.querySelector('[data-d="-1"]').disabled=q<=0;
      el.querySelector('[data-d="1"]').disabled=off||q>=100;
    });
    var beans=load(BEAN_KEY).reduce(function(s,c){return s+(Number(c.qty)||0);},0);
    var pts=sets+(sets>=BONUS_SETS?BONUS_PTS:0);
    document.getElementById("dbSets").textContent=sets?"耳掛 "+sets+" 組・NT$ "+total.toLocaleString():"購物袋裡有半磅 "+beans+" 包";
    document.getElementById("dbInfo").textContent=sets?sets*SET_BAGS+" 包・可得 "+pts+" 點"+(sets>=BONUS_SETS?"（含加贈 "+BONUS_PTS+" 點）":"・再 "+(BONUS_SETS-sets)+" 組多送 "+BONUS_PTS+" 點")+(beans?"・另有半磅 "+beans+" 包":""):"挑幾組耳掛，可以一起結帳";
    var show=sets>0||beans>0;
    bar.classList.toggle("show",show);document.body.classList.toggle("has-bar",show);
  }
  cards.forEach(function(el){
    el.querySelector(".step").addEventListener("click",function(e){
      var b=e.target.closest("button[data-d]");if(!b||b.disabled)return;
      var id=el.getAttribute("data-id");setQty(id,qtyOf(id)+Number(b.getAttribute("data-d")));
    });
  });
  function reload(){cart=load(KEY);render();}
  window.addEventListener("storage",function(e){if(e.key===KEY||e.key===BEAN_KEY)reload();});   // 在別的分頁（官網購物袋）改了數量
  window.addEventListener("pageshow",reload);   // 從官網按「上一頁」回來
  /* 售完、即將完售、這支還有沒有做耳掛：先用官網存在這台裝置的商品資料，再向後端拿最新的 */
  function apply(list,fresh){
    var map={};list.forEach(function(p){map[String(p.id)]=p;});
    cards.forEach(function(el){
      var p=map[el.getAttribute("data-id")];
      if(!p&&!fresh)return;   // 這台裝置存的舊資料裡沒有這支：等後端的最新資料
      var off=!p||!p.drip||!!p.soldOut;   // 後端清單裡沒有＝已經下架
      el.classList.toggle("off",off);
      el.querySelector(".dbadge").textContent=p&&p.soldOut?"已售完・待補貨":off?"暫停供應":p.lastCall?"即將完售":"";
      el.querySelector(".dso").textContent=p&&p.soldOut?"這支豆子已售完，耳掛也暫停供應，補貨後會再開放。":off?"這支目前沒有供應耳掛。":"";
    });
    render();
  }
  try{var c=JSON.parse(localStorage.getItem(PROD_KEY)||"null");if(Array.isArray(c)&&c.some(function(p){return p.drip;}))apply(c,false);}catch(e){}
  fetch(API+"?action=products").then(function(r){return r.json();}).then(function(list){
    if(Array.isArray(list)&&list.length){try{localStorage.setItem(PROD_KEY,JSON.stringify(list));}catch(e){}apply(list,true);}
  }).catch(function(){});
  render();
})();
</script>`;
{
  const process_ = (p) => specOf(p, "處理法"), roast = (p) => specOf(p, "烘焙度");
  const price = dripPriceOf(drips[0]);
  const title = cut(`耳掛咖啡｜一組 ${DRIP.setBags} 包 ${money(price).replace(" ", "")}・自家烘焙現磨填裝｜${BRAND}`, 64);
  const desc = cut(`${BRAND}耳掛咖啡：用自家烘焙、逐批手挑的精品咖啡豆，接單後才現磨填裝。一組 ${DRIP.setBags} 包同口味 ${money(price)}（每包 ${DRIP.bagGrams} 克），可和半磅咖啡豆一起結帳；一組 1 點，滿 ${DRIP.bonusSets} 組再送 ${DRIP.bonusPoints} 點。`, 140);
  const cardHtml = (p) => {
    const tags = (p.tags || []).slice(0, 4);
    const pr = dripPriceOf(p);
    return `<li class="dcard${p.soldOut ? " off" : ""}" id="d-${esc(p.id)}" data-id="${esc(p.id)}" data-price="${pr}">
  <div class="dimg">${p.image ? `<img src="${esc(smallImg(p.image))}" alt="${esc(p.name)} 耳掛咖啡" loading="lazy" width="400" height="300">` : ""}<span class="dbadge">${p.soldOut ? "已售完・待補貨" : p.lastCall ? "即將完售" : ""}</span></div>
  <div class="dbody">
    <h3>${esc(p.name)}</h3>
    <p class="dorig">${[p.subtitle, process_(p), roast(p)].filter(Boolean).map(esc).join("・")}</p>
    ${tags.length ? `<ul class="dtags" aria-label="風味">${tags.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
    <div class="dfoot">
      <div class="dprice">${money(pr)}<small><span class="long">一組 ${DRIP.setBags} 包・</span>每包 ${Math.round(pr / DRIP.setBags)} 元</small></div>
      <div class="step" role="group" aria-label="${esc(p.name)} 要幾組"><button type="button" data-d="-1" aria-label="少一組" disabled>−</button><output aria-live="polite">0 組</output><button type="button" data-d="1" aria-label="多一組"${p.soldOut ? " disabled" : ""}>＋</button></div>
    </div>
    <p class="dso">${p.soldOut ? "這支豆子已售完，耳掛也暫停供應，補貨後會再開放。" : ""}</p>
    <p class="dmore"><a href="${p._url}">看這支豆子的完整介紹 →</a></p>
  </div>
</li>`;
  };
  const body = drips.length ? `<nav class="crumb" aria-label="導覽"><a href="${SITE}">${BRAND}</a> › 耳掛咖啡</nav>
<section class="dp-hero">
  <span class="dp-eye">Drip Bag Coffee</span>
  <h1>耳掛咖啡</h1>
  <p>用同一批自家烘焙、逐批手挑的豆子，接單後才現磨填裝。撕開、掛上杯子、注水就是一杯，上班、出門都方便。</p>
  <ul class="dp-facts">
    <li><b>${DRIP.setBags} 包</b>一組・同一種口味</li>
    <li><b>${DRIP.bagGrams} 克</b>每包，建議沖 ${DRIP.water}</li>
    <li><b>${money(price).replace(" ", "")}</b>一組（每包 ${Math.round(price / DRIP.setBags)} 元）</li>
    <li><b>${DRIP.ship}</b>接單現磨後出貨</li>
  </ul>
  <a class="btn" href="#flavors">挑口味 ↓</a>
</section>
<section>
  <h2>怎麼買</h2>
  <ol class="dp-steps">
    <li><b>挑口味、選組數</b>一組 ${DRIP.setBags} 包是同一種口味；想喝 5 種口味，就各選 1 組。</li>
    <li><b>自動放進購物袋</b>選好的組數會直接放進購物袋，可以和半磅咖啡豆一起結帳。</li>
    <li><b>到官網確認購買</b>登入會員、按「確認購買」，我們會與你聯繫付款與寄送。</li>
  </ol>
  <p class="dp-pts"><span class="ic" aria-hidden="true">🎁</span><span>一組 1 點；同一張訂單買滿 ${DRIP.bonusSets} 組，再多送 ${DRIP.bonusPoints} 點，合計 10 點可以折 100 元。點數在訂單完成後自動入帳。</span></p>
</section>
<section id="flavors">
  <h2>口味（${drips.length} 種）</h2>
  <ul class="dp-grid">${drips.map(cardHtml).join("")}</ul>
</section>
<section>
  <h2>耳掛怎麼沖</h2>
  <ol class="brew">
    <li><b>1</b>撕開外袋，沿虛線撕開濾袋上緣，拉開兩側紙架，掛在杯緣。</li>
    <li><b>2</b>先倒少量熱水（約 20ml）讓咖啡粉濕透，悶 20～30 秒。</li>
    <li><b>3</b>分 2～3 次慢慢注水到 ${DRIP.water}；喜歡淡一點可以加到 ${DRIP.waterMax}。</li>
    <li><b>4</b>水滴完後取下耳掛，就完成了。</li>
  </ol>
  <p class="dnote">水溫約 90°C（水煮開後放約 30 秒）。每包 ${DRIP.bagGrams} 克配 ${DRIP.water}，大約是 1:15 的濃度。</p>
</section>
<section class="faq">
  <h2>常見問題</h2>
  ${DRIP_FAQ.map((q) => `<h3>${esc(q[0])}</h3><p>${esc(q[1])}</p>`).join("\n  ")}
</section>
<div class="dbar" id="dbar"><div class="dbar-in"><div class="dbar-t"><strong id="dbSets"></strong><span id="dbInfo"></span></div><a class="btn" href="${SITE}#cart">前往結帳 →</a></div></div>`
  : `<nav class="crumb" aria-label="導覽"><a href="${SITE}">${BRAND}</a> › 耳掛咖啡</nav>
<h1>耳掛咖啡</h1>
<p class="dp-empty">耳掛咖啡即將開賣，敬請期待。<br><a class="btn" href="${SITE}#products" style="margin-top:14px">先看看咖啡豆</a></p>`;
  const ld = drips.length ? [{
    "@context": "https://schema.org", "@type": "ItemList", name: `${BRAND}耳掛咖啡`, url: DRIP_URL,
    itemListElement: drips.map((p, i) => ({
      "@type": "ListItem", position: i + 1,
      item: {
        "@type": "Product", name: `${p.name} 耳掛咖啡（${DRIP.setBags} 包）`, sku: "drip-" + p.id, category: "耳掛咖啡",
        description: cut(`${p.name}，${p.subtitle}${process_(p) ? " " + process_(p) + "處理" : ""}。一組 ${DRIP.setBags} 包、每包 ${DRIP.bagGrams} 克，接單後現磨填裝。`, 120),
        ...(p.image ? { image: [p.image] } : {}), brand: { "@type": "Brand", name: BRAND },
        offers: { "@type": "Offer", url: DRIP_URL + "#d-" + encodeURIComponent(p.id), priceCurrency: "TWD", price: dripPriceOf(p), availability: p.soldOut ? "https://schema.org/OutOfStock" : "https://schema.org/InStock", itemCondition: "https://schema.org/NewCondition" },
      },
    })),
  }, {
    "@context": "https://schema.org", "@type": "FAQPage",
    mainEntity: DRIP_FAQ.map((q) => ({ "@type": "Question", name: q[0], acceptedAnswer: { "@type": "Answer", text: q[1] } })),
  }, breadcrumb([[BRAND, SITE], ["耳掛咖啡", DRIP_URL]])] : [];
  write("drip/index.html", shell({ title: drips.length ? title : `耳掛咖啡｜${BRAND}`, desc, canonical: DRIP_URL, image: OG_DEFAULT, ld, body, css: DRIP_CSS, script: drips.length ? dripScript() : "", noindex: !drips.length }));
}

/* ---------- sitemap.xml ---------- */
{
  const urls = [{ loc: SITE }, { loc: SITE + "explore/" }]
    .concat(drips.length ? [{ loc: DRIP_URL }] : [])
    .concat(products.map((p) => ({ loc: p._url })))
    .concat(posts.map((a) => ({ loc: a._url, lastmod: dateTW(a.time) })));
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) => `  <url>\n    <loc>${esc(u.loc)}</loc>${u.lastmod ? `\n    <lastmod>${u.lastmod}</lastmod>` : ""}\n  </url>`).join("\n") + `\n</urlset>\n`;
  fs.writeFileSync(path.join(ROOT, "sitemap.xml"), xml);
}

console.log(`SEO 靜態頁完成：${products.length} 個商品頁、${posts.length} 個文章頁、1 個總覽頁、耳掛頁（${drips.length ? drips.length + " 種口味" : "尚未開賣"}），sitemap 共 ${products.length + posts.length + 2 + (drips.length ? 1 : 0)} 個網址（網站：${SITE}）`);
