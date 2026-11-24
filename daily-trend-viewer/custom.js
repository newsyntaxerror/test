/* 데일리 트렌드 뷰어 — 웹 커스텀 모듈
   정적 GitHub Pages 버전에서 '내 분야'(카테고리·키워드·참고 계정)를 브라우저에서 직접
   바꿀 수 있게 해줍니다. 설정은 localStorage에만 저장되고 서버로 나가지 않습니다.
   - 카테고리 켜기/끄기·순서 변경·새 분야(이름+키워드) 추가/삭제
   - 내 참고 계정(유튜브/인스타/틱톡/스레드/X) 추가·삭제 + 바로가기 카드
   - 정적 JSON(수집 스냅샷)에서 내 키워드 필터·하이라이트, 키워드 검색
   - 설정을 JSON/텍스트로 복사해 수집 목록에 반영 요청
   server.py의 CATEGORIES / collect.py의 CATEGORY_SLUGS와 이름을 맞춰 주세요. */
(function () {
  "use strict";

  var STORE_KEY = "dtv.custom.v1";

  // 기본 카테고리 표 (앞의 세 개는 달콩 님 관심 분야)
  // slug: collect.py가 만든 data/videos_<slug>_<period>_<shorts>.json 파일 이름
  var BUILTIN = [
    { name: "전체", slug: "all", keywords: [], lock: true },
    { name: "육아·살림", slug: "parenting", keywords: ["육아", "이유식", "아기", "기저귀", "육퇴", "살림", "집안일", "정리", "청소", "주부", "어린이집"] },
    { name: "쿠파스·쇼핑템", slug: "shopping", keywords: ["쿠팡", "추천템", "꿀템", "가성비", "생활템", "살림템", "쇼핑", "리뷰", "파트너스", "최저가"] },
    { name: "예짜·밈", slug: "memes", keywords: ["짜집기", "예능", "레전드", "밈", "웃긴", "짤", "명장면"] },
    { name: "AI", slug: "ai", keywords: ["AI", "인공지능", "sora", "runway", "kling", "veo", "생성"] },
    { name: "먹방", slug: "mukbang", keywords: ["먹방", "대식", "먹스타"] },
    { name: "뷰티/패션", slug: "beauty", keywords: ["뷰티", "메이크업", "패션", "코디"] },
    { name: "브이로그", slug: "vlog", keywords: ["브이로그", "일상"] },
    { name: "예능/코미디", slug: "fun", keywords: ["예능", "코미디", "웃긴"] },
    { name: "영화/드라마", slug: "movie", keywords: ["영화", "드라마"] },
    { name: "테크/IT", slug: "tech", keywords: ["테크", "IT", "스마트폰", "리뷰"] },
    { name: "지식/교육", slug: "edu", keywords: ["지식", "교양", "교육"] },
    { name: "여행", slug: "travel", keywords: ["여행", "관광"] },
    { name: "동물", slug: "animal", keywords: ["강아지", "고양이", "동물"] }
  ];

  var KINDS = [
    { key: "youtube", label: "유튜브", url: function (h) { return "https://www.youtube.com/@" + h; } },
    { key: "instagram", label: "인스타그램", url: function (h) { return "https://www.instagram.com/" + h + "/"; } },
    { key: "tiktok", label: "틱톡", url: function (h) { return "https://www.tiktok.com/@" + h; } },
    { key: "threads", label: "스레드", url: function (h) { return "https://www.threads.com/@" + h; } },
    { key: "x", label: "X(트위터)", url: function (h) { return "https://x.com/" + h; } }
  ];
  var KIND_MAP = {};
  KINDS.forEach(function (k) { KIND_MAP[k.key] = k; });

  var settings = null;
  var poolCache = {};
  var sheet = null;
  var listeners = [];

  /* ---------------------------------------------------------- 저장/불러오기 */
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function defaultSettings() {
    return {
      v: 1,
      categories: BUILTIN.map(function (b) {
        return { name: b.name, slug: b.slug || null, keywords: b.keywords.slice(), enabled: true, lock: !!b.lock };
      }),
      accounts: { youtube: [], instagram: [], tiktok: [], threads: [], x: [] }
    };
  }

  function readStore() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (s && Array.isArray(s.categories) && s.categories.length) return s;
    } catch (e) { /* 저장값이 깨졌으면 기본값 사용 */ }
    return null;
  }

  function normalize(s) {
    var base = defaultSettings();
    var out = { v: 1, categories: [], accounts: {} };
    var stored = (s && s.categories) || [];
    // 저장된 순서를 유지하되, 기본 카테고리의 slug/키워드는 최신 표로 보정합니다
    stored.forEach(function (c) {
      if (!c || !c.name) return;
      var b = BUILTIN.filter(function (x) { return x.name === c.name; })[0];
      if (b) {
        out.categories.push({
          name: b.name, slug: b.slug || null, keywords: b.keywords.slice(),
          enabled: b.lock ? true : c.enabled !== false, lock: !!b.lock
        });
      } else if (out.categories.every(function (x) { return x.name !== c.name; })) {
        out.categories.push({
          name: String(c.name).slice(0, 40), slug: null,
          keywords: (c.keywords || []).map(function (k) { return String(k).trim(); }).filter(Boolean).slice(0, 20),
          enabled: c.enabled !== false, lock: false
        });
      }
    });
    // 새로 추가된 기본 카테고리는 뒤에 붙입니다
    base.categories.forEach(function (b) {
      if (out.categories.every(function (x) { return x.name !== b.name; })) out.categories.push(b);
    });
    var src = (s && s.accounts) || {};
    KINDS.forEach(function (k) {
      var list = Array.isArray(src[k.key]) ? src[k.key] : [];
      out.accounts[k.key] = list.map(normalizeHandle).filter(Boolean).slice(0, 60);
    });
    return out;
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (e) { /* 저장 불가(사생활 모드 등) */ }
  }

  /* ---------------------------------------------------------- 유틸 */
  function normalizeHandle(raw) {
    var h = String(raw || "").trim();
    if (!h) return "";
    h = h.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
    var m = h.match(/(?:youtube\.com|instagram\.com|tiktok\.com|threads\.(?:com|net)|x\.com|twitter\.com)\/@?([^\/?#\s]+)/i);
    if (m) h = m[1];
    h = h.replace(/^@/, "").split(/[\/?#\s]/)[0];
    return h.trim();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function byName(name) {
    return settings.categories.filter(function (c) { return c.name === name; })[0] || null;
  }

  function activeCategories() {
    return settings.categories.filter(function (c) { return c.enabled || c.lock; });
  }

  function keywordsOf(name) {
    var c = byName(name);
    return c && c.keywords ? c.keywords : [];
  }

  function allKeywords() {
    var out = [];
    activeCategories().forEach(function (c) {
      if (c.name === "전체") return;
      (c.keywords || []).forEach(function (k) {
        if (k && out.indexOf(k) === -1) out.push(k);
      });
    });
    return out;
  }

  function matchAny(text, kws) {
    if (!text || !kws || !kws.length) return false;
    var t = text.toLowerCase();
    for (var i = 0; i < kws.length; i++) {
      var k = String(kws[i] || "").toLowerCase();
      if (k && t.indexOf(k) !== -1) return true;
    }
    return false;
  }

  /* 제목/채널에서 키워드를 <mark>로 감싸 하이라이트 */
  function highlight(el, kws) {
    if (!el || !kws || !kws.length) return;
    var text = el.textContent || "";
    var lower = text.toLowerCase();
    var ranges = [];
    kws.forEach(function (k) {
      var kl = String(k || "").toLowerCase();
      if (!kl) return;
      var from = 0, i;
      while ((i = lower.indexOf(kl, from)) !== -1) {
        ranges.push([i, i + kl.length]);
        from = i + kl.length;
      }
    });
    if (!ranges.length) return;
    ranges.sort(function (a, b) { return a[0] - b[0]; });
    var merged = [];
    ranges.forEach(function (r) {
      var last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    });
    el.textContent = "";
    var pos = 0;
    merged.forEach(function (r) {
      if (r[0] > pos) el.appendChild(document.createTextNode(text.slice(pos, r[0])));
      var m = document.createElement("mark");
      m.className = "kw";
      m.textContent = text.slice(r[0], r[1]);
      el.appendChild(m);
      pos = r[1];
    });
    if (pos < text.length) el.appendChild(document.createTextNode(text.slice(pos)));
  }

  /* ---------------------------------------------------------- 데이터 */
  function getPool(period, shorts) {
    var key = period + "_" + (shorts ? "1" : "0");
    if (!poolCache[key]) {
      poolCache[key] = fetch("data/pool_" + key + ".json")
        .then(function (r) { if (!r.ok) throw new Error("pool " + r.status); return r.json(); })
        .catch(function () { return { videos: [], fetchedAt: 0 }; });
    }
    return poolCache[key];
  }

  function filterVideos(videos, kws) {
    return (videos || []).filter(function (v) {
      return matchAny((v.title || "") + " " + (v.channel || ""), kws);
    });
  }

  /* 탭·카테고리·검색에 맞는 영상 목록을 돌려줍니다.
     { videos, fetchedAt, note, emptyReason } */
  function loadVideos(opt) {
    var category = opt.category || "전체";
    var period = opt.period || "week";
    var shorts = !!opt.shorts;
    var search = (opt.search || "").trim();
    var kwOnly = !!opt.kwOnly;
    var def = byName(category);

    if (search) {
      var tokens = search.toLowerCase().split(/\s+/).filter(Boolean);
      return getPool(period, shorts).then(function (pool) {
        var vids = (pool.videos || []).filter(function (v) {
          var hay = ((v.title || "") + " " + (v.channel || "")).toLowerCase();
          return tokens.every(function (t) { return hay.indexOf(t) !== -1; });
        });
        return {
          videos: vids.slice(0, 60),
          fetchedAt: pool.fetchedAt,
          note: "‘" + search + "’ 검색 결과 · 수집된 영상 전체에서 찾았어요",
          emptyReason: "‘" + search + "’에 맞는 영상이 이번 수집분에 없습니다. 다른 단어로 검색하거나 유튜브에서 직접 찾아보세요."
        };
      });
    }

    if (kwOnly && category === "전체") {
      var kws = allKeywords();
      return getPool(period, shorts).then(function (pool) {
        var vids = filterVideos(pool.videos, kws);
        return {
          videos: vids.slice(0, 60),
          fetchedAt: pool.fetchedAt,
          note: "내 분야 키워드 " + kws.length + "개에 걸린 영상만 모았어요",
          emptyReason: "내 분야 키워드에 맞는 영상이 이번 수집분에 없습니다. 설정에서 키워드를 더 넣어 보세요."
        };
      });
    }

    if (def && def.slug) {
      var q = new URLSearchParams({
        category: category, period: period,
        shorts: shorts ? "1" : "0", force: "0", enrich: "0"
      });
      return fetch("/api/videos?" + q.toString())
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var vids = data.videos || [];
          if (kwOnly) vids = filterVideos(vids, def.keywords || []);
          return {
            videos: vids,
            fetchedAt: data.fetchedAt,
            note: kwOnly ? "‘" + category + "’ 안에서 내 키워드에 걸린 영상만" : "",
            emptyReason: "결과가 없습니다."
          };
        });
    }

    // 내가 추가한 분야: 수집된 전체 풀에서 키워드로 골라냅니다
    var customKws = def ? (def.keywords || []) : [];
    return getPool(period, shorts).then(function (pool) {
      var vids = filterVideos(pool.videos, customKws);
      return {
        videos: vids.slice(0, 60),
        fetchedAt: pool.fetchedAt,
        note: "‘" + category + "’ 키워드 " + customKws.length + "개로 수집분에서 골랐어요",
        emptyReason: "‘" + category + "’에 맞는 영상이 이번 수집분에 없습니다. 키워드를 넓히거나, 아래 설정을 복사해 복님에게 보내면 다음 수집부터 이 분야도 직접 모아 옵니다."
      };
    });
  }

  /* ---------------------------------------------------------- 칩 렌더 */
  function renderChips(box, state, onPick) {
    if (!box) return;
    box.innerHTML = "";
    activeCategories().forEach(function (c) {
      var b = document.createElement("button");
      b.className = "chip" + (c.name === state.category && !state.search ? " active" : "");
      if (!c.slug) b.className += " custom-chip";
      b.textContent = c.name;
      b.onclick = function () {
        state.category = c.name;
        state.search = "";
        var si = document.getElementById("searchInput");
        if (si) si.value = "";
        onPick();
      };
      box.appendChild(b);
    });
    var add = document.createElement("button");
    add.className = "chip chip-add";
    add.textContent = "＋ 내 분야 설정";
    add.onclick = function () { openSettings(); };
    box.appendChild(add);
  }

  /* ---------------------------------------------------------- 참고 계정 카드 */
  function hostFor(kind) {
    var id = "myAcc_" + kind;
    var el = document.getElementById(id);
    if (el) return el;
    var anchor = { youtube: "videoView", instagram: "reelsView", tiktok: "tiktokView", threads: "threadsView", x: "xView" }[kind];
    var view = document.getElementById(anchor);
    if (!view) return null;
    el = document.createElement("div");
    el.id = id;
    el.className = "myacc";
    if (kind === "youtube") {
      var status = document.getElementById("status");
      view.insertBefore(el, status || view.firstChild);
    } else {
      var chips = view.querySelector(".acc-chips");
      view.insertBefore(el, chips || view.firstChild);
    }
    return el;
  }

  function renderAccountShortcuts(kind, collected) {
    var host = hostFor(kind);
    if (!host) return;
    var list = (settings.accounts && settings.accounts[kind]) || [];
    host.innerHTML = "";
    if (!list.length) {
      if (kind === "youtube") { host.style.display = "none"; return; }
      host.style.display = "block";
      var hint = document.createElement("p");
      hint.className = "note";
      hint.style.margin = "0 0 12px";
      hint.textContent = "⭐ 내 " + KIND_MAP[kind].label + " 계정을 여기에 모아둘 수 있어요 — 상단 ⚙️ 내 분야에서 추가하세요.";
      host.appendChild(hint);
      return;
    }
    host.style.display = "block";
    var head = document.createElement("div");
    head.className = "myacc-head";
    head.textContent = "⭐ 내 참고 계정";
    host.appendChild(head);
    var row = document.createElement("div");
    row.className = "myacc-row";
    var seen = (collected || []).map(function (x) { return String(x).toLowerCase(); });
    list.forEach(function (h) {
      var a = document.createElement("a");
      a.className = "myacc-card";
      a.href = KIND_MAP[kind].url(h);
      a.target = "_blank";
      a.rel = "noopener";
      var b = document.createElement("b");
      b.textContent = "@" + h;
      var small = document.createElement("small");
      small.textContent = seen.indexOf(h.toLowerCase()) !== -1 ? "수집 중 · 바로가기 ↗" : "바로가기 ↗";
      a.appendChild(b);
      a.appendChild(small);
      row.appendChild(a);
    });
    host.appendChild(row);
  }

  /* ---------------------------------------------------------- 설정 시트 */
  var CSS = [
    ".kw{background:rgba(255,209,102,.24);color:#ffd166;border-radius:3px;padding:0 1px}",
    ".chip-add{background:transparent;border-style:dashed}",
    ".chip.custom-chip::after{content:'✦';margin-left:5px;color:#ffd166;font-size:11px}",
    ".kwbtn{background:var(--card);border:1px solid var(--border);color:var(--muted);border-radius:10px;padding:6px 12px;font-size:13px;cursor:pointer;white-space:nowrap}",
    ".kwbtn.on{background:rgba(255,209,102,.16);border-color:#ffd166;color:#ffd166;font-weight:700}",
    "#kwNote{color:var(--muted);font-size:12.5px;margin:-6px 0 12px}",
    ".myacc{margin:0 0 16px}",
    ".myacc-head{font-size:12.5px;color:var(--muted);margin-bottom:7px}",
    ".myacc-row{display:flex;gap:8px;overflow-x:auto;padding-bottom:4px;-webkit-overflow-scrolling:touch}",
    ".myacc-card{flex:0 0 auto;display:block;text-decoration:none;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:9px 13px;color:var(--text);font-size:13px;font-weight:700}",
    ".myacc-card small{display:block;color:var(--muted);font-weight:400;font-size:11px;margin-top:3px}",
    ".myacc-card:hover{border-color:#ffd166}",
    "#customSheet{position:fixed;inset:0;z-index:120;display:none;background:rgba(0,0,0,.6);align-items:flex-end;justify-content:center}",
    "#customSheet.open{display:flex}",
    ".sheet-box{background:var(--bg);border:1px solid var(--border);border-radius:18px 18px 0 0;width:min(760px,100%);max-height:92vh;overflow-y:auto;padding:0 0 env(safe-area-inset-bottom)}",
    ".cs-head{position:sticky;top:0;z-index:2;background:var(--bg);display:flex;align-items:center;gap:10px;padding:16px 18px;border-bottom:1px solid var(--border)}",
    ".cs-head h3{font-size:16px;flex:1}",
    ".cs-head button{background:var(--panel);border:1px solid var(--border);color:var(--text);border-radius:9px;padding:8px 14px;font-size:13px;cursor:pointer}",
    ".cs-body{padding:16px 18px 28px}",
    ".cs-body h4{font-size:13.5px;margin:20px 0 8px;color:#ffd166}",
    ".cs-body h4:first-child{margin-top:0}",
    ".cs-hint{color:var(--muted);font-size:12px;line-height:1.6;margin-bottom:10px}",
    ".cs-list{display:flex;flex-direction:column;gap:6px}",
    ".cs-row{display:flex;align-items:center;gap:8px;background:var(--card);border:1px solid var(--border);border-radius:11px;padding:9px 11px}",
    ".cs-row.off{opacity:.5}",
    ".cs-row .cs-cat{flex:1;min-width:0}",
    ".cs-row .cs-name{font-size:13.5px;font-weight:700;display:flex;align-items:center;gap:6px}",
    ".cs-row .cs-kw{color:var(--muted);font-size:11.5px;margin-top:3px;line-height:1.45;word-break:keep-all}",
    ".cs-badge{font-size:10px;font-weight:700;color:var(--muted);border:1px solid var(--border);border-radius:999px;padding:1px 6px}",
    ".cs-badge.mine{color:#ffd166;border-color:#7a6420}",
    ".cs-switch{position:relative;flex:0 0 auto;width:38px;height:22px}",
    ".cs-switch input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer}",
    ".cs-switch span{position:absolute;inset:0;background:var(--panel);border:1px solid var(--border);border-radius:999px;transition:.15s}",
    ".cs-switch span::after{content:'';position:absolute;top:3px;left:3px;width:14px;height:14px;background:var(--muted);border-radius:50%;transition:.15s}",
    ".cs-switch input:checked + span{background:rgba(255,77,109,.25);border-color:var(--accent)}",
    ".cs-switch input:checked + span::after{transform:translateX(16px);background:var(--accent)}",
    ".cs-switch input:disabled + span{opacity:.6}",
    ".cs-move{display:flex;flex-direction:column;gap:2px}",
    ".cs-move button,.cs-del{background:var(--panel);border:1px solid var(--border);color:var(--muted);border-radius:7px;min-width:26px;height:22px;font-size:11px;cursor:pointer;line-height:1}",
    ".cs-move button:disabled{opacity:.3}",
    ".cs-del{color:var(--accent);height:26px;min-width:26px;font-size:13px}",
    ".cs-add{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}",
    ".cs-add input,.cs-add select{flex:1;min-width:130px;background:var(--card);border:1px solid var(--border);border-radius:9px;padding:10px 12px;color:var(--text);font-size:13px}",
    ".cs-add button{background:var(--accent2);border:none;border-radius:9px;padding:10px 16px;color:#fff;font-weight:700;font-size:13px;cursor:pointer}",
    ".cs-accrow{display:flex;align-items:center;gap:8px;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:8px 11px;font-size:13px}",
    ".cs-accrow .cs-kind{color:var(--muted);font-size:11.5px;flex:0 0 auto;min-width:52px}",
    ".cs-accrow a{color:var(--accent2);text-decoration:none;font-size:12px;margin-left:auto}",
    ".cs-actions{display:flex;gap:8px;flex-wrap:wrap}",
    ".cs-actions button{background:var(--card);border:1px solid var(--border);color:var(--text);border-radius:9px;padding:10px 14px;font-size:13px;cursor:pointer}",
    ".cs-actions button.danger{color:var(--accent)}",
    ".cs-msg{color:#7ee2a8;font-size:12px;margin-top:8px;min-height:16px;word-break:break-all}",
    ".cs-preview{width:100%;margin-top:10px;background:var(--card);border:1px solid var(--border);border-radius:9px;color:var(--text);font-size:12px;padding:10px;min-height:120px;line-height:1.5;font-family:ui-monospace,Menlo,monospace}",
    "@media (max-width:640px){",
    "  header{padding:10px 12px;gap:8px}",
    "  header h1{font-size:17px}",
    "  #today{font-size:11.5px;order:9;width:100%}",
    "  #searchForm{order:3;width:100%;margin-left:0}",
    "  #searchInput{width:100%;font-size:16px}",
    "  #customBtn,#refreshBtn{padding:8px 11px;font-size:12.5px}",
    "  .tabs{padding:10px 12px 0;gap:6px}",
    "  .tab{padding:8px 12px;font-size:13px}",
    "  .toolbar{padding:10px 12px;gap:8px}",
    "  .periods{margin-left:0}",
    "  main{padding:14px 12px 48px}",
    "  .grid{gap:10px;grid-template-columns:repeat(auto-fill,minmax(160px,1fr))}",
    "  .grid.shorts{grid-template-columns:repeat(auto-fill,minmax(140px,1fr))}",
    "  .postlist{grid-template-columns:1fr}",
    "  .chip{padding:7px 12px;font-size:12.5px}",
    "  .sheet-box{max-height:96vh}",
    "  .cs-body{padding:14px 14px 24px}",
    "  .cs-row .cs-kw{display:none}",
    "  .myacc-row{padding-bottom:8px}"
  ].join("\n");

  function injectStyle() {
    if (document.getElementById("dtvCustomStyle")) return;
    var s = document.createElement("style");
    s.id = "dtvCustomStyle";
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function exportText() {
    var lines = ["[데일리 트렌드 뷰어 · 내 분야 설정]", ""];
    lines.push("관심 분야 (앞이 우선순위):");
    activeCategories().forEach(function (c, i) {
      lines.push((i + 1) + ". " + c.name + (c.keywords.length ? " — 키워드: " + c.keywords.join(", ") : ""));
    });
    var off = settings.categories.filter(function (c) { return !c.enabled && !c.lock; });
    if (off.length) lines.push("", "꺼둔 분야: " + off.map(function (c) { return c.name; }).join(", "));
    lines.push("", "참고 계정:");
    var any = false;
    KINDS.forEach(function (k) {
      var list = settings.accounts[k.key] || [];
      if (list.length) { any = true; lines.push("- " + k.label + ": " + list.map(function (h) { return "@" + h; }).join(", ")); }
    });
    if (!any) lines.push("- (없음)");
    lines.push("", "위 목록을 데일리 트렌드 뷰어 수집 목록에 반영해 주세요.");
    return lines.join("\n");
  }

  function exportJSON() {
    return JSON.stringify({
      app: "daily-trend-viewer",
      version: settings.v,
      exportedAt: new Date().toISOString(),
      interests: activeCategories().filter(function (c) { return c.name !== "전체"; }).map(function (c) {
        return { name: c.name, keywords: c.keywords, builtin: !!c.slug, priority: activeCategories().indexOf(c) };
      }),
      disabled: settings.categories.filter(function (c) { return !c.enabled && !c.lock; }).map(function (c) { return c.name; }),
      accounts: settings.accounts
    }, null, 2);
  }

  function copyText(text, okMsg) {
    var done = function () { showMsg(okMsg || "복사했어요. 복님에게 붙여넣어 주세요."); showPreview(text); };
    var fail = function () { showMsg("자동 복사가 막혀 있어요. 아래 내용을 길게 눌러 복사해 주세요."); showPreview(text); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { legacyCopy(text, done, fail); });
    } else {
      legacyCopy(text, done, fail);
    }
  }
  function legacyCopy(text, done, fail) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      var ok = document.execCommand("copy");
      document.body.removeChild(ta);
      (ok ? done : fail)();
    } catch (e) { fail(); }
  }
  function showMsg(m) {
    var el = document.getElementById("csMsg");
    if (el) el.textContent = m;
  }
  function showPreview(text) {
    var el = document.getElementById("csPreview");
    if (!el) return;
    el.value = text;
    el.style.display = "block";
  }

  function buildSheet() {
    if (sheet) return sheet;
    sheet = document.createElement("div");
    sheet.id = "customSheet";
    sheet.innerHTML =
      '<div class="sheet-box" role="dialog" aria-modal="true" aria-label="내 분야 설정">' +
      '<div class="cs-head"><h3>⚙️ 내 분야 설정</h3><button type="button" id="csClose">닫기</button></div>' +
      '<div class="cs-body">' +
      '<p class="cs-hint">켜둔 분야만 상단 칩에 나옵니다. ↑↓로 순서를 바꾸고, 새 분야는 이름과 키워드로 추가하세요. 설정은 이 브라우저(휴대폰)에만 저장돼요.</p>' +
      '<h4>관심 분야</h4><div class="cs-list" id="csCatList"></div>' +
      '<div class="cs-add"><input id="csNewName" maxlength="24" placeholder="새 분야 이름 (예: 이유식 레시피)">' +
      '<input id="csNewKw" maxlength="200" placeholder="키워드, 쉼표로 구분 (예: 이유식, 아기밥)">' +
      '<button type="button" id="csAddBtn">추가</button></div>' +
      '<h4>내 참고 계정</h4>' +
      '<p class="cs-hint">유튜브·인스타·틱톡·스레드·X 계정을 넣으면 해당 탭 위에 바로가기 카드가 생깁니다. 계정명(@ 없이)이나 프로필 주소를 붙여넣어도 됩니다.</p>' +
      '<div class="cs-list" id="csAccList"></div>' +
      '<div class="cs-add"><select id="csKind"></select>' +
      '<input id="csHandle" maxlength="120" placeholder="@계정명 또는 프로필 주소">' +
      '<button type="button" id="csAccAdd">추가</button></div>' +
      '<h4>설정 내보내기</h4>' +
      '<p class="cs-hint">복님에게 전달하면 수집 목록(서버)에 반영할 수 있어요. JSON은 그대로, 텍스트는 읽어보기 좋은 형태입니다.</p>' +
      '<div class="cs-actions"><button type="button" id="csCopyJson">JSON 복사</button>' +
      '<button type="button" id="csCopyText">텍스트 복사</button>' +
      '<button type="button" id="csReset" class="danger">초기화</button></div>' +
      '<div class="cs-msg" id="csMsg"></div>' +
      '<textarea class="cs-preview" id="csPreview" style="display:none" readonly></textarea>' +
      '<p class="cs-hint" style="margin-top:14px">💡 웹 버전은 1시간마다 수집된 스냅샷이라, 내가 새로 추가한 분야는 이미 모인 영상에서 키워드로 골라 보여줍니다. 이 설정을 복님에게 보내면 다음 수집부터 그 분야를 직접 모아 오게 할 수 있어요.</p>' +
      "</div></div>";
    document.body.appendChild(sheet);

    var kindSel = sheet.querySelector("#csKind");
    KINDS.forEach(function (k) {
      var o = document.createElement("option");
      o.value = k.key;
      o.textContent = k.label;
      kindSel.appendChild(o);
    });

    sheet.addEventListener("click", function (e) { if (e.target === sheet) closeSettings(); });
    sheet.querySelector("#csClose").onclick = closeSettings;
    sheet.querySelector("#csAddBtn").onclick = function () { addCategory(); };
    sheet.querySelector("#csAccAdd").onclick = function () { addAccount(); };
    sheet.querySelector("#csCopyJson").onclick = function () { copyText(exportJSON(), "JSON을 복사했어요."); };
    sheet.querySelector("#csCopyText").onclick = function () { copyText(exportText(), "텍스트를 복사했어요."); };
    sheet.querySelector("#csReset").onclick = function () {
      if (confirm("내 분야 설정을 처음 상태로 되돌릴까요? (참고 계정도 지워집니다)")) {
        settings = defaultSettings(); save(); renderCatList(); renderAccList(); notify();
        showMsg("처음 상태로 되돌렸어요.");
      }
    };
    ["csNewName", "csNewKw"].forEach(function (id) {
      sheet.querySelector("#" + id).addEventListener("keydown", function (e) { if (e.key === "Enter") addCategory(); });
    });
    sheet.querySelector("#csHandle").addEventListener("keydown", function (e) { if (e.key === "Enter") addAccount(); });
    return sheet;
  }

  function addCategory() {
    var nameEl = sheet.querySelector("#csNewName");
    var kwEl = sheet.querySelector("#csNewKw");
    var name = (nameEl.value || "").trim();
    var kws = (kwEl.value || "").split(/[,，\n]/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (!name) { showMsg("분야 이름을 입력해 주세요."); nameEl.focus(); return; }
    if (settings.categories.some(function (c) { return c.name === name; })) { showMsg("이미 있는 분야예요."); return; }
    if (!kws.length) { showMsg("키워드를 하나 이상 넣어 주세요. (예: 이유식, 아기밥)"); kwEl.focus(); return; }
    settings.categories.push({ name: name.slice(0, 24), slug: null, keywords: kws.slice(0, 20), enabled: true, lock: false });
    save(); nameEl.value = ""; kwEl.value = "";
    renderCatList(); notify();
    showMsg("‘" + name + "’ 분야를 추가했어요. 수집된 영상에서 키워드로 골라 보여줍니다.");
  }

  function addAccount() {
    var kind = sheet.querySelector("#csKind").value;
    var el = sheet.querySelector("#csHandle");
    var h = normalizeHandle(el.value);
    if (!h) { showMsg("계정명을 입력해 주세요."); el.focus(); return; }
    var list = settings.accounts[kind] || (settings.accounts[kind] = []);
    if (list.some(function (x) { return x.toLowerCase() === h.toLowerCase(); })) { showMsg("이미 넣은 계정이에요."); return; }
    list.push(h);
    save(); el.value = "";
    renderAccList(); notify();
    showMsg("@" + h + " 계정을 넣었어요. 해당 탭 위에 바로가기 카드가 생깁니다.");
  }

  function renderCatList() {
    var box = sheet.querySelector("#csCatList");
    box.innerHTML = "";
    settings.categories.forEach(function (c, idx) {
      var row = document.createElement("div");
      row.className = "cs-row" + (c.enabled || c.lock ? "" : " off");

      var sw = document.createElement("label");
      sw.className = "cs-switch";
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!c.enabled || !!c.lock;
      cb.disabled = !!c.lock;
      cb.setAttribute("aria-label", c.name + " 켜기");
      cb.onchange = function () {
        c.enabled = cb.checked;
        row.className = "cs-row" + (c.enabled ? "" : " off");
        save(); notify();
      };
      var track = document.createElement("span");
      sw.appendChild(cb); sw.appendChild(track);
      row.appendChild(sw);

      var info = document.createElement("div");
      info.className = "cs-cat";
      var nm = document.createElement("div");
      nm.className = "cs-name";
      nm.textContent = c.name;
      var badge = document.createElement("span");
      badge.className = "cs-badge" + (c.slug ? "" : " mine");
      badge.textContent = c.lock ? "고정" : (c.slug ? "기본" : "내 분야");
      nm.appendChild(badge);
      info.appendChild(nm);
      if (c.keywords.length) {
        var kw = document.createElement("div");
        kw.className = "cs-kw";
        kw.textContent = c.keywords.join(" · ");
        info.appendChild(kw);
      }
      row.appendChild(info);

      var move = document.createElement("div");
      move.className = "cs-move";
      var up = document.createElement("button");
      up.type = "button"; up.textContent = "↑"; up.title = "위로";
      up.disabled = idx === 0 || settings.categories[idx - 1].lock;
      up.onclick = function () { swap(idx, idx - 1); };
      var down = document.createElement("button");
      down.type = "button"; down.textContent = "↓"; down.title = "아래로";
      down.disabled = idx >= settings.categories.length - 1;
      down.onclick = function () { swap(idx, idx + 1); };
      move.appendChild(up); move.appendChild(down);
      row.appendChild(move);

      if (!c.slug && !c.lock) {
        var del = document.createElement("button");
        del.type = "button"; del.className = "cs-del"; del.textContent = "✕"; del.title = "분야 삭제";
        del.onclick = function () {
          settings.categories = settings.categories.filter(function (x) { return x !== c; });
          save(); renderCatList(); notify();
        };
        row.appendChild(del);
      }
      box.appendChild(row);
    });
  }

  function swap(i, j) {
    if (j < 0 || j >= settings.categories.length) return;
    if (settings.categories[j].lock) return;
    var tmp = settings.categories[i];
    settings.categories[i] = settings.categories[j];
    settings.categories[j] = tmp;
    save(); renderCatList(); notify();
  }

  function renderAccList() {
    var box = sheet.querySelector("#csAccList");
    box.innerHTML = "";
    var any = false;
    KINDS.forEach(function (k) {
      (settings.accounts[k.key] || []).forEach(function (h) {
        any = true;
        var row = document.createElement("div");
        row.className = "cs-accrow";
        var kind = document.createElement("span");
        kind.className = "cs-kind";
        kind.textContent = k.label;
        var handle = document.createElement("span");
        handle.textContent = "@" + h;
        var a = document.createElement("a");
        a.href = k.url(h); a.target = "_blank"; a.rel = "noopener"; a.textContent = "열기 ↗";
        var del = document.createElement("button");
        del.type = "button"; del.className = "cs-del"; del.textContent = "✕"; del.title = "계정 삭제";
        del.onclick = function () {
          settings.accounts[k.key] = settings.accounts[k.key].filter(function (x) { return x !== h; });
          save(); renderAccList(); notify();
        };
        row.appendChild(kind); row.appendChild(handle); row.appendChild(a); row.appendChild(del);
        box.appendChild(row);
      });
    });
    if (!any) {
      var empty = document.createElement("p");
      empty.className = "cs-hint";
      empty.style.margin = "0";
      empty.textContent = "아직 넣은 계정이 없어요. 아래에서 계정을 추가하면 각 탭 위에 바로가기 카드가 생깁니다.";
      box.appendChild(empty);
    }
  }

  function notify() {
    listeners.forEach(function (fn) { try { fn(); } catch (e) { /* ignore */ } });
  }

  function openSettings() {
    buildSheet();
    renderCatList(); renderAccList();
    showMsg("");
    var prev = document.getElementById("csPreview");
    if (prev) { prev.style.display = "none"; prev.value = ""; }
    sheet.classList.add("open");
    document.body.style.overflow = "hidden";
  }
  function closeSettings() {
    if (!sheet) return;
    sheet.classList.remove("open");
    document.body.style.overflow = "";
  }

  /* ---------------------------------------------------------- init */
  function init() {
    injectStyle();
    settings = normalize(readStore());
    save();
    var btn = document.getElementById("customBtn");
    if (btn) btn.onclick = openSettings;
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeSettings(); });
    return Promise.resolve();
  }

  window.DTVCustom = {
    init: init,
    settings: function () { return settings; },
    enabledCategories: activeCategories,
    renderChips: renderChips,
    loadVideos: loadVideos,
    keywordsOf: keywordsOf,
    allKeywords: allKeywords,
    highlight: highlight,
    matchAny: matchAny,
    renderAccountShortcuts: renderAccountShortcuts,
    openSettings: openSettings,
    closeSettings: closeSettings,
    onSettingsChange: function (fn) { listeners.push(fn); },
    exportText: exportText,
    exportJSON: exportJSON,
    BUILTIN: BUILTIN,
    KINDS: KINDS
  };
})();
