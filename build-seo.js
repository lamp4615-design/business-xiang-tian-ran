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

/* ---------- 重用網站本身的文章排版程式（和官網、後台預覽完全一致）---------- */
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
function loadRenderer() {
  const a = indexHtml.indexOf("const SH_COLORS="), b = indexHtml.indexOf("const SH_DECO=");
  if (a < 0 || b < 0 || b <= a) throw new Error("index.html 找不到文章排版程式（SH_COLORS … SH_DECO）");
  return new Function("esc", indexHtml.slice(a, b) + "\nreturn { shBody, shImgUrl };")(esc);
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
.top a{color:#fff;text-decoration:none}.brand{font-family:var(--serif);font-weight:700;font-size:1.25rem;letter-spacing:.08em}.top nav a{margin-left:18px;font-size:.95rem;opacity:.9}.top nav a:hover{opacity:1;text-decoration:underline}
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
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:18px;list-style:none;padding:0;margin:0}.card{background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 8px 22px rgba(36,28,21,.08)}
.card a{display:block;color:inherit;text-decoration:none}.card .ci{aspect-ratio:4/3;background:var(--paper-2)}.card .ci img{width:100%;height:100%;object-fit:cover;display:block}.card .cb{padding:14px 16px}
.card h3{margin:0 0 2px;font-family:var(--serif);color:var(--pine);font-size:1.1rem}.card p{margin:0;color:var(--ink-70);font-size:.9rem;line-height:1.6}
.list{list-style:none;padding:0;margin:0}.list li{padding:12px 0;border-bottom:1px solid var(--line)}.list a{font-weight:700;text-decoration:none}.list small{display:block;color:var(--ink-45)}
.art-meta{color:var(--ink-45);font-size:.9rem}.lead{font-size:1.1rem;color:var(--ink-70);border-left:3px solid var(--dawn-soft);padding-left:16px;margin:12px 0 24px}
.end{text-align:center;margin:3em 0 1em;padding:24px;background:var(--paper-2);border-radius:18px}
footer.foot{margin-top:60px;background:var(--pine);color:#fff;padding:28px 0;font-size:.9rem}footer.foot a{color:#fff}footer.foot p{margin:4px 0;opacity:.85}
@media(max-width:760px){.prod{grid-template-columns:1fr}.top nav a{margin:0 14px 0 0}}
${articleCss}`;

function shell({ title, desc, canonical, image, type = "website", ld = [], body }) {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
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
<style>${CSS}</style>
<!-- Cloudflare Web Analytics --><script type='module' src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "0983c24b22934644914ceb51ef122b23"}'></script><!-- End Cloudflare Web Analytics -->
</head>
<body>
<header class="top"><div class="wrap"><a class="brand" href="${SITE}">${BRAND}</a>
<nav aria-label="主選單"><a href="${SITE}explore/">咖啡豆與文章</a><a href="${SITE}#products">線上選購</a><a href="${SITE}#flavor">風味評分</a><a href="${SITE}#member">會員</a></nav></div></header>
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
</script>
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
["products", "articles", "explore"].forEach((d) => fs.rmSync(path.join(ROOT, d), { recursive: true, force: true }));
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
    ${p.soldOut ? `<p class="soldout"><strong>已售完・待補貨</strong></p><p><button type="button" class="btn ghost" data-want="${esc(p.id)}">想再喝到這支</button></p><p style="display:none">` : `<p><button type="button" class="btn" data-atc="${esc(p.id)}">加入購物袋</button>`}<a class="btn ghost" id="cartlink" href="${SITE}#products" style="display:none">前往購物袋結帳 →</a></p>
    <p class="atc-msg" id="atc-msg"></p>
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
${posts.length ? `<section><h2>咖啡知識與風味文章</h2><ul class="list">${posts.map(postLi).join("")}</ul></section>` : ""}`;
  const ld = [{
    "@context": "https://schema.org", "@type": "CollectionPage", name: title, description: desc, url,
    mainEntity: { "@type": "ItemList", itemListElement: products.map((p, i) => ({ "@type": "ListItem", position: i + 1, url: p._url, name: p.name })) },
  }, breadcrumb([[BRAND, SITE], ["咖啡豆與文章", url]])];
  write("explore/index.html", shell({ title, desc, canonical: url, image: OG_DEFAULT, ld, body }));
}

/* ---------- sitemap.xml ---------- */
{
  const urls = [{ loc: SITE }, { loc: SITE + "explore/" }]
    .concat(products.map((p) => ({ loc: p._url })))
    .concat(posts.map((a) => ({ loc: a._url, lastmod: dateTW(a.time) })));
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) => `  <url>\n    <loc>${esc(u.loc)}</loc>${u.lastmod ? `\n    <lastmod>${u.lastmod}</lastmod>` : ""}\n  </url>`).join("\n") + `\n</urlset>\n`;
  fs.writeFileSync(path.join(ROOT, "sitemap.xml"), xml);
}

console.log(`SEO 靜態頁完成：${products.length} 個商品頁、${posts.length} 個文章頁、1 個總覽頁，sitemap 共 ${products.length + posts.length + 2} 個網址（網站：${SITE}）`);
