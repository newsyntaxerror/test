/* =========================================================
   우리끼리 — 친구끼리만 위치·채팅 (v4)
   · 닉네임만으로 시작 → 고유 친구 코드 발급 → 서로 친구 맺기
   · 위치·동선·배터리·채팅은 '서로 친구(accepted)' 사이에만
   · Supabase RPC(서버 함수) + Realtime broadcast 신호
   ========================================================= */
(() => {
  'use strict';

  /* ───────────────────────── 0. 설정 ───────────────────────── */
  const CFG = Object.assign({
    SUPABASE_URL: '',
    SUPABASE_ANON_KEY: '',
    REFRESH_SECONDS: 10,
    CARTO_KEY: '',          // CARTO 지도 타일 키(무료: carto.com/basemaps/apikey). 비우면 대체 타일 사용
  }, window.APP_CONFIG || {});

  const SUPABASE_URL = String(CFG.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const SUPABASE_KEY = String(CFG.SUPABASE_ANON_KEY || '').trim();
  const READY = /^https?:\/\//i.test(SUPABASE_URL) && SUPABASE_KEY.length > 20;

  const BASE = { lat: 37.5665, lng: 126.9780 };            // 서울시청 — 위치를 못 받을 때 기본 좌표
  const REFRESH_MS = Math.max(5, Number(CFG.REFRESH_SECONDS) || 10) * 1000;
  const STALE_MS = 10 * 60 * 1000;                          // 10분 넘게 갱신 없으면 '오프라인'
  const PALETTE = ['#0fb9a3', '#f59e0b', '#6366f1', '#ec4899', '#8b5cf6', '#0ea5e9', '#ef4444', '#14b8a6'];
  const APP_VERSION = 'v22';

  /* ── 지도 스타일(타일) — 지도 화면에서 바로 바꿔 볼 수 있어요 ──
     CARTO 래스터 타일은 2026-09-25 부터 키가 필요합니다. config.js 의 CARTO_KEY 를
     채우면 파스텔(Voyager)·미니멀(Positron)·다크(Dark Matter)가 그대로 나오고,
     비어 있으면 키가 필요 없는 대체 타일(OSM 색 보정 / Esri Dark Gray)로 보여집니다. */
  const MAP_STYLE_KEY = 'urikkiri.mapStyle.v1';
  const CARTO_KEY = String(CFG.CARTO_KEY || '').trim();
  const MAP_ATTR_OSM = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> 기여자';
  const MAP_ATTR_CARTO = MAP_ATTR_OSM + ' &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>';
  const OSM_TILE = { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: MAP_ATTR_OSM, subdomains: 'abc' };
  const MAP_STYLES = {
    voyager: {
      name: '파스텔', sub: 'Voyager', dark: false,
      carto: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
      fallback: Object.assign({}, OSM_TILE, { filter: 'saturate(.45) brightness(1.08) contrast(.88)' }),
    },
    positron: {
      name: '미니멀', sub: 'Positron', dark: false,
      carto: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
      fallback: Object.assign({}, OSM_TILE, { filter: 'grayscale(.88) brightness(1.07) contrast(.9)' }),
    },
    dark: {
      name: '다크', sub: 'Dark Matter', dark: true,
      carto: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      fallback: Object.assign({}, OSM_TILE, { filter: 'invert(1) hue-rotate(180deg) brightness(.98) contrast(1.05) saturate(.72)' }),
    },
    osm: {
      name: '기본', sub: 'OpenStreetMap', dark: false, carto: null,
      fallback: Object.assign({}, OSM_TILE, { filter: 'none' }),
    },
  };
  const MAP_STYLE_ORDER = ['voyager', 'positron', 'dark', 'osm'];
  const mapStyleKey = (key) => (Object.prototype.hasOwnProperty.call(MAP_STYLES, key) ? key : 'voyager');

  /* 지금 설정으로 실제 쓸 타일 주소·필터 */
  function mapTileSource(key) {
    const s = MAP_STYLES[mapStyleKey(key)];
    if (CARTO_KEY && s.carto) {
      return {
        url: s.carto + (s.carto.indexOf('?') >= 0 ? '&' : '?') + 'key=' + encodeURIComponent(CARTO_KEY),
        attribution: MAP_ATTR_CARTO, subdomains: 'abcd', filter: 'none',
      };
    }
    return s.fallback;
  }
  const EMOJIS = ['🙂', '🙌', '🏃', '🚇', '💼', '🏠', '🍜', '😴'];
  const POKE_EMOJIS = ['👋', '❤️', '☕', '📍', '😆'];
  const AUTO_STATUS_MIN_MS = 5 * 60 * 1000;    // 5분 이상 머문 곳은 자동 상태로
  const MUTE_KEY = 'urikkiri.muted.v1';        // 개인/그룹별 알림 끄기
  const NOTICE_MS = 5600;
  /* ── 근처 알림(카톡 '근처에 있어요') ── */
  const NEAR_M = 300;                       // 이 거리 안으로 들어오면 '근처'
  const NEAR_EXIT_M = 500;                  // 이만큼 벗어나야 다시 '밖'으로 친다(재알림 조건)
  const NEAR_COOLDOWN_MS = 30 * 60 * 1000;  // 같은 사람 알림은 30분에 한 번
  const NEAR_KEY = 'urikkiri.nearby.v1';    // { user_id: { at: 알림시각, inside: 근처인지 } }

  /* 배터리 API는 안드로이드 크롬 등에서만 열려 있어요(iOS 사파리는 막혀 있음). */
  const BATT_API = typeof navigator !== 'undefined' && typeof navigator.getBattery === 'function';

  /* 체류·속도 규칙 — 한 지점에 5분 이상 머물면 '머문 곳'으로 끊는다(사용자 지정) */
  const STAY_RADIUS_M = 60;             // 같은 장소로 보는 반경(50~75m 사이)
  const STAY_MIN_MS = 5 * 60 * 1000;    // 이 시간 이상 머물면 '체류'로 기록
  const STAY_SAMPLE_MS = 60 * 1000;     // 머무는 동안 남기는 기록 간격(시작·종료 시각 보존)
  const STAY_LONG_SAMPLE_MS = 5 * 60 * 1000;  // 오래 머물 때(10분 이후) 기록 간격
  const STAY_GAP_MAX_MS = 30 * 60 * 1000;     // 기록 사이가 이보다 벌어지면 다른 체류로 본다
  const MOVE_KMH = 2;                   // 이 속도 이상이면 '이동 중'
  const HISTORY_MAX = 240;
  const HISTORY_MAX_MS = 6 * 60 * 60 * 1000;

  const ME_KEY = 'urikkiri.me.v1';
  const histKey = (uid) => 'urikkiri.hist.' + uid;
  const SESS_COOKIE = 'urikkiri_sess';
  const SESS_MAX_AGE = 60 * 60 * 24 * 365;   // 1년

  /* 세션은 localStorage 가 지워져도 남도록 쿠키에도 같이 적어 둡니다.
     (iOS 사파리·홈 화면 앱에서 저장소가 비워지는 경우 대비) */
  function setSessionCookie(uid, token, secret) {
    try {
      const val = encodeURIComponent([uid, token || '', secret || ''].join('|'));
      const secure = location.protocol === 'https:' ? '; Secure' : '';
      document.cookie = SESS_COOKIE + '=' + val
        + '; path=/; max-age=' + SESS_MAX_AGE + '; SameSite=Lax' + secure;
    } catch (e) {}
  }

  function readSessionCookie() {
    try {
      const hit = String(document.cookie || '').split(/;\s*/)
        .find((c) => c.indexOf(SESS_COOKIE + '=') === 0);
      if (!hit) return null;
      const parts = decodeURIComponent(hit.slice(SESS_COOKIE.length + 1)).split('|');
      if (!parts[0]) return null;
      return { user_id: parts[0], session_token: parts[1] || '', secret: parts[2] || '' };
    } catch (e) { return null; }
  }

  function clearSessionCookie() {
    try {
      const secure = location.protocol === 'https:' ? '; Secure' : '';
      document.cookie = SESS_COOKIE + '=; path=/; max-age=0; SameSite=Lax' + secure;
    } catch (e) {}
  }

  /* ── 세 번째 저장소: IndexedDB ──
     iOS 사파리·홈 화면 앱은 localStorage 를 비워 버릴 때가 있어,
     로그인 열쇠를 IndexedDB 에도 남겨 '자동 로그인'을 되살립니다. */
  const IDB_NAME = 'urikkiri-auth';
  const IDB_STORE = 'session';
  const SESS_KEY = 'urikkiri.session.v1';
  const AUTO_KEY = 'urikkiri.autoLogin';
  let idbPromise = null;

  function idbOpen() {
    if (idbPromise) return idbPromise;
    idbPromise = new Promise((resolve) => {
      try {
        if (typeof indexedDB === 'undefined') { resolve(null); return; }
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch (e) { resolve(null); }
    });
    return idbPromise;
  }

  async function idbRun(mode, fn) {
    const db = await idbOpen();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE, mode);
        const store = tx.objectStore(IDB_STORE);
        const req = fn(store);
        tx.oncomplete = () => resolve(req ? req.result : true);
        tx.onerror = () => resolve(null);
        tx.onabort = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  }

  function idbGet(key) { return idbRun('readonly', (s) => s.get(key)); }
  function idbSet(key, val) { return idbRun('readwrite', (s) => s.put(val, key)); }
  function idbDel(key) { return idbRun('readwrite', (s) => s.delete(key)); }

  function readSessionStore() {
    try {
      const raw = sessionStorage.getItem(SESS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function clearSessionStore() {
    try { sessionStorage.removeItem(SESS_KEY); } catch (e) {}
  }

  function validIdentity(v) {
    return !!(v && v.user_id && (v.secret || v.session_token));
  }

  /* ───────────────────────── 1. 작은 도구들 ───────────────────────── */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const esc = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const LS = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (e) { return fallback; }
    },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {} },
    del(key) { try { localStorage.removeItem(key); } catch (e) {} },
  };

  const pad2 = (n) => String(n).padStart(2, '0');

  function timeAgo(iso) {
    if (!iso) return '—';
    const t = new Date(iso).getTime();
    if (!t || isNaN(t)) return '—';
    const diff = Math.max(0, Date.now() - t) / 1000;
    if (diff < 45) return '방금';
    if (diff < 3600) return Math.max(1, Math.floor(diff / 60)) + '분 전';
    if (diff < 86400) return Math.floor(diff / 3600) + '시간 전';
    return Math.floor(diff / 86400) + '일 전';
  }

  function clockOf(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function dayLabel(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const today = new Date();
    const y = new Date();
    y.setDate(today.getDate() - 1);
    const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    if (same(d, today)) return '오늘';
    if (same(d, y)) return '어제';
    return (d.getMonth() + 1) + '월 ' + d.getDate() + '일';
  }

  function msgTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const today = new Date();
    if (d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()) {
      const h = d.getHours();
      const ap = h < 12 ? '오전' : '오후';
      const hh = h % 12 === 0 ? 12 : h % 12;
      return ap + ' ' + hh + ':' + pad2(d.getMinutes());
    }
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + clockOf(iso);
  }

  function colorFor(id) {
    let h = 0;
    const s = String(id || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }

  function initialOf(name) {
    const s = String(name || '?').trim();
    return s ? s.slice(0, 1).toUpperCase() : '?';
  }

  function randomHex(bytes) {
    const arr = new Uint8Array(bytes);
    try { crypto.getRandomValues(arr); } catch (e) {
      for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function newIdentity() {
    const uid = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'u-' + Date.now().toString(36) + '-' + randomHex(8);
    return { user_id: uid, secret: randomHex(24) };
  }

  function normalizeCode(v) {
    return String(v == null ? '' : v)
      .trim()
      .replace(/\s+/g, '')
      .replace(/[^0-9A-Za-z-]/g, '')
      .toUpperCase()
      .slice(0, 12);
  }

  function isStale(m) {
    if (!m) return true;
    if (!m.updated_at) return true;
    return Date.now() - new Date(m.updated_at).getTime() > STALE_MS;
  }

  /* ── 거리 · 시간 표기 ── */
  const R_EARTH = 6371000;

  function haversine(a, b) {
    if (!a || !b) return 0;
    const la1 = a.lat * Math.PI / 180;
    const la2 = b.lat * Math.PI / 180;
    const dLa = la2 - la1;
    const dLo = (b.lng - a.lng) * Math.PI / 180;
    const h = Math.sin(dLa / 2) * Math.sin(dLa / 2)
      + Math.cos(la1) * Math.cos(la2) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function durText(ms) {
    const mins = Math.max(0, Math.round(ms / 60000));
    if (mins < 1) return '1분 미만';
    if (mins < 60) return mins + '분';
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h + '시간' + (m ? ' ' + m + '분' : '');
  }

  function distText(m) {
    if (!isFinite(m)) return '—';
    if (m < 1000) return Math.round(m / 10) * 10 + 'm';
    return (m / 1000).toFixed(m < 10000 ? 1 : 0) + 'km';
  }

  /* ── 배터리 ── */
  function batteryText(m) {
    if (!m || m.battery == null || isNaN(m.battery)) return '';
    const level = Math.round(m.battery);
    return (m.charging ? '⚡' : '🔋') + ' ' + level + '%';
  }

  function batteryLong(m) {
    if (!m || m.battery == null || isNaN(m.battery)) return '';
    const level = Math.round(m.battery);
    return (m.charging ? '⚡ 충전 중 · ' : '🔋 ') + level + '%';
  }

  /* ── 체류 시간 ── */
  function staySinceOf(m) {
    if (!m) return null;
    if (m.stay_since) return m.stay_since;
    const h = historyFor(m.user_id);
    if (h.length < 3) return null;
    const last = h[h.length - 1];
    let i = h.length - 1;
    while (i > 0 && haversine(h[i - 1], last) <= STAY_RADIUS_M) i--;
    if (i === h.length - 1) return null;
    const since = h[i].t;
    return (Date.now() - since >= 60 * 1000) ? new Date(since).toISOString() : null;
  }

  function stayMins(since) {
    if (!since) return 0;
    const ms = Date.now() - new Date(since).getTime();
    return Math.max(0, Math.floor(ms / 60000));
  }

  function stayPhrase(since) {
    const mins = stayMins(since);
    if (!since) return '';
    if (mins < 60) return Math.max(1, mins) + '분째 머무르는 중';
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h + '시간' + (m ? ' ' + m + '분' : '') + ' 체류';
  }

  function stayChip(since) {
    const mins = stayMins(since);
    if (mins < 60) return Math.max(1, mins) + '분째';
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h + '시간' + (m ? ' ' + m + '분' : '');
  }

  /* ── 이동 속도 ── */
  function moveKind(kmh) {
    if (kmh == null || !isFinite(kmh) || kmh < MOVE_KMH) return null;
    if (kmh >= 20) return { ico: '🚗', label: '차량' };
    if (kmh >= 7) return { ico: '🏃', label: '빠르게 이동' };
    return { ico: '🚶', label: '걷는 중' };
  }

  function speedText(m) {
    if (!m || m.speed_kmh == null || !isFinite(m.speed_kmh)) return '';
    const k = moveKind(m.speed_kmh);
    if (!k) return '';
    return k.ico + ' ' + Math.max(1, Math.round(m.speed_kmh)) + 'km/h';
  }

  function activityText(m) {
    const sp = speedText(m);
    if (sp) return { kind: 'move', text: sp };
    const since = staySinceOf(m);
    if (since) return { kind: 'stay', text: '⏱ ' + stayChip(since) };
    return null;
  }

  /* ── 프로필 사진 ──
     사진은 서버에 180×180 JPEG data URL(40KB 안팎)로만 올라갑니다.
     화면에서는 원형 avatar 의 background-image 로 깔아 어디서나 같은 모양으로 보입니다. */
  const AVATAR_RE = /^data:image\/(?:jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/;

  function avatarUrlOf(p) {
    const u = p && p.avatar_url;
    return typeof u === 'string' && AVATAR_RE.test(u) ? u : '';
  }

  function hasPhoto(p) { return !!avatarUrlOf(p); }

  function avatarStyleOf(p) {
    const color = esc((p && p.color) || colorFor(p && p.user_id));
    const url = avatarUrlOf(p);
    return '--c:' + color + (url ? ';background-image:url(' + url + ')' : '');
  }

  function avatarClass(base, p) { return base + (hasPhoto(p) ? ' has-photo' : ''); }

  /* ── 온라인 표시 ──
     지금 위치를 10분 안에 보낸 사람(그리고 나)은 초록 링이 은은하게 빗나고,
     아바타 옆에 작은 ON 배지가 붙습니다. */
  function isOnline(m) {
    if (!m) return false;
    if (state.me && m.user_id === state.me.user_id) return true;
    if (m.hidden) return false;
    return m.lat != null && isFinite(m.lat) && !isStale(m);
  }

  function onlineCls(p) { return isOnline(p) ? ' is-online' : ''; }

  function onlineBadge(p) { return isOnline(p) ? '<span class="on-badge">ON</span>' : ''; }

  function paintAvatar(node, p, label) {
    if (!node) return;
    node.classList.toggle('has-photo', hasPhoto(p));
    node.style.backgroundImage = hasPhoto(p) ? 'url(' + avatarUrlOf(p) + ')' : '';
    node.style.setProperty('--c', (p && p.color) || colorFor(p && p.user_id));
    node.textContent = label != null ? label : initialOf(p && p.nickname);
    node.classList.toggle('is-online', isOnline(p));
    if (isOnline(p)) {
      const badge = document.createElement('span');
      badge.className = 'on-badge';
      badge.textContent = 'ON';
      node.appendChild(badge);
    }
  }

  /* ── 자동 상태 ──
     직접 남긴 상태가 비어 있고, 5분 이상 한 곳에 머물면
     그 자리의 장소·업종(OpenStreetMap)으로 '☕ 스타벅스 · 12분째' 를 대신 보여줍니다. */
  function autoStatusOf(m) {
    if (!m || m.hidden || m.status_text) return null;
    if (m.lat == null || m.lng == null || !isFinite(m.lat) || !isFinite(m.lng)) return null;
    const since = m.stay_since || staySinceOf(m);
    if (!since) return null;
    const ms = Date.now() - new Date(since).getTime();
    if (!isFinite(ms) || ms < AUTO_STATUS_MIN_MS) return null;

    const mins = stayChip(since);
    const suffix = /째$/.test(mins) ? '' : '째';
    const hit = placeCached(m.lat, m.lng);
    if (hit && hit.ok && hit.name) {
      const meta = placeMeta(hit);
      return { ico: meta.ico, text: hit.name + ' · ' + mins + suffix, label: meta.ico + ' ' + hit.name + ' · ' + mins + suffix, place: true };
    }
    if (!hit) placeSoon(m.lat, m.lng, () => scheduleAutoStatusRender());
    return { ico: '⏱', text: mins + suffix + ' 머무는 중', label: '⏱ ' + mins + suffix + ' 머무는 중', place: false };
  }

  function scheduleAutoStatusRender() {
    if (state.autoStatusTimer) return;
    state.autoStatusTimer = setTimeout(() => {
      state.autoStatusTimer = null;
      if (!state.joined) return;
      renderList();
      renderPins();
      renderGroups();
      renderConvos();
      refreshModalLive();
    }, 700);
  }

  /* ── 알림 끄기/켜기 ── */
  function isMuted(id) { return !!id && state.muted[id] === true; }

  function setMuted(id, on) {
    if (!id) return;
    if (on) state.muted[id] = true;
    else delete state.muted[id];
    LS.set(MUTE_KEY, state.muted);
    const isGroup = isGroupChat(id);
    toast(on
      ? (isGroup ? '이 그룹 알림을 껐어요 🔕' : '이 사람 알림을 껐어요 🔕')
      : (isGroup ? '이 그룹 알림을 다시 켰어요 🔔' : '이 사람 알림을 다시 켰어요 🔔'), 2200);
    renderGroups();
    renderConvos();
    if (modalUser === id) renderMuteRow(personById(id), false);
  }

  /* ───────────────────────── 2. 화면 요소 ───────────────────────── */
  const el = {};
  [
    'joinScreen', 'inviteNote', 'inviteCodeLabel',
    'authTabs', 'loginForm', 'loginId', 'loginPw', 'loginMsg', 'btnLogin',
    'registerForm', 'inputNick', 'regId', 'regPw', 'regMsg', 'btnRegister', 'carryNote',
    'idBanner', 'btnIdMake', 'btnIdLater', 'idModal', 'idForm', 'idInput', 'idPw', 'idMsg',
    'btnIdSave', 'idClose',
    'app', 'map', 'meChip', 'meChipPin', 'myCode', 'myName', 'btnAddFriend', 'btnShare',
    'sheet', 'btnCollapse', 'tabs', 'tabFriends', 'tabGroups', 'tabChat', 'friendCount', 'groupCount', 'chatBadge',
    'panelGroups', 'groupList', 'btnGroupCreate', 'btnGroupJoin',
    'groupModal', 'groupModalTitle', 'groupModalSub', 'groupNameField', 'groupName', 'groupCodeField', 'groupCode',
    'groupMsg', 'groupSubmit', 'groupCancel',
    'btnSheetHide', 'btnAddFriend2', 'reqBox', 'reqCount', 'reqList',
    'fabLocate', 'sheetOpen', 'sheetOpenBadge',
    'mapStyle', 'btnMapStyle', 'mapStyleMenu', 'mapStyleDot', 'mapStyleNote',
    'panelFriends', 'panelChat', 'memberList', 'btnUpdate', 'updateSub', 'btnAuto', 'btnCopy',
    'convoList', 'toast',
    'memberModal', 'mCard', 'mAvatar', 'mName', 'mStatus', 'mRows', 'mEdit', 'mNickInput',
    'mEmojis', 'mStatusInput', 'mCopyCode', 'mClose', 'mChat', 'mSave', 'mLocate', 'mRemove',
    'mRouteBlock', 'mRouteSum', 'mRouteHint', 'mRouteOpen',
    'mPokeBlock', 'mPokeBtns', 'mMuteRow', 'mMute',
    'mPhotoInput', 'mPhotoPreview', 'mPhotoPick', 'mPhotoClear',
    'mNotifState', 'mNotifAsk', 'appVer', 'appVerJoin',
    'notice', 'noticeIco', 'noticeTitle', 'noticeText', 'noticeClose', 'pokeLayer',
    'routeView', 'rvBack', 'rvClose', 'rvWho', 'rvMeta', 'rvTlToggle', 'rvTlLabel',
    'rvTimeline', 'rvTlCount', 'rvTlHide', 'rvTlList',
    'mBatt', 'mBattModes', 'mBattManual', 'mBattRange', 'mBattVal', 'mBattCharging',
    'mAcct', 'mAcctId', 'mAcctHint', 'mAcctCreate', 'mAcctSwitch', 'mAcctLogout',
    'addModal', 'addForm', 'inputCode', 'btnSendReq', 'myCodeBig', 'btnCopyCode', 'btnCopyLink',
    'outgoingBox', 'outgoingList', 'addClose',
    'chatPanel', 'btnChatBack', 'chatAvatar', 'chatName', 'chatSub', 'btnChatLocate',
    'chatBody', 'chatForm', 'chatInput', 'btnChatSend', 'permHint', 'btnPermAsk', 'btnPermClose',
  ].forEach((id) => { el[id] = document.getElementById(id); });
  el.permText = el.permHint ? el.permHint.querySelector('span') : null;

  /* ───────────────────────── 3. 상태 ───────────────────────── */
  const state = {
    me: null,                 // 내 프로필 + 내 위치
    friends: new Map(),       // user_id → 친구(프로필+위치+안읽음)
    incoming: [],             // 받은 친구 요청
    outgoing: [],             // 보낸 친구 요청
    messages: new Map(),      // friend_id → 메시지 배열
    memberSortAt: new Map(),  // 정렬용
    map: null,
    mapStyle: mapStyleKey(LS.get(MAP_STYLE_KEY, 'voyager')),  // 지도 타일 스타일
    tile: null,               // 현재 지도 타일 레이어
    routeCasing: null,        // 동선 테두리 폴리라인(다크 지도에서 색 반전용)
    markers: new Map(),
    markerSig: new Map(),
    routeGroup: null,
    routeFor: null,
    routeView: null,       // 상세 동선을 보고 있는 사용자 user_id
    routeModel: null,      // 현재 그린 동선 모델(핀·타임라인)
    routeSig: '',          // 다시 그릴 필요가 있는지 비교용
    routeTlOpen: false,    // 상세 타임라인 열림 여부
    liveRoutes: new Map(),
    history: new Map(),
    joined: false,
    joining: false,
    auto: true,
    tab: 'friends',
    selected: null,
    chatWith: null,
    watchId: null,
    tickTimer: null,
    lastPublish: 0,
    lastHistAt: 0,
    battery: null,
    charging: false,
    battMode: BATT_API ? 'auto' : 'off',
    battManual: { level: 80, charging: false },
    lastFix: null,
    gotFix: false,
    geoDenied: false,
    geoFallback: false,    // 정밀 위치 실패 → 네트워크 위치로 받은 상태
    toastTimer: null,
    selectedEmoji: null,
    feedReq: null,
    feedQueued: false,
    errShown: false,
    addAfterStart: '',
    lastMsgAt: {},
    readSending: {},
    authMode: 'login',
    authBusy: false,
    sheetHidden: false,
    carry: null,          // 이 기기에 남아 있는(아이디를 붙일) 신원
    places: new Map(),    // '위도,경도' → 머문 곳 장소·업종(캐시)
    autoLogin: true,      // 로그인 화면의 '자동 로그인' 체크 상태
    groups: new Map(),      // group_id → 그룹(멤버 포함)
    groupPeople: new Map(), // user_id → 그룹으로만 아는 사람(위치·동선)
    viewGroup: null,        // 지도에서 보고 있는 그룹
    groupMode: 'create',    // 그룹 모달 모드
    addGroupCode: '',       // 초대 링크(?group=)로 받은 코드
    mapScope: 'friends',    // 지도에 누구를 보여줄지: friends | groups
    groupReadSentAt: {},
    muted: LS.get(MUTE_KEY, null) || {},   // user_id / group_id → 알림 끔
    nearby: LS.get(NEAR_KEY, null) || {},   // user_id → { at, inside } 근처 알림 상태(30분 쿨다운·500m 이탈 시 재발동)
    lastNearby: null,                       // 마지막 근처 알림(검증·디버그용)
    friendBase: false,      // 첫 피드는 알림 기준만 잡는다
    groupBase: false,
    groupPeopleBase: false,
    notifPerm: (typeof Notification === 'undefined') ? 'unsupported' : Notification.permission,
    noticeTimer: null,
    noticeOpen: null,
    lastNoticeKey: '',
    lastNoticeAt: 0,
    pokeIds: new Set(),
    autoStatusTimer: null,
  };

  /* ───────────────────── 3-B. 머문 곳 장소 판별 (OpenStreetMap · 키 없음) ─────────────────────
     · Overpass: 머문 좌표 반경 80m 의 카페·매장·건물·공원 등을 찾아 '가장 가까운 곳'을 고른다.
     · Nominatim 역지오코딩: 장소 이름이 없을 때 도로명·동 이름으로 채운다.
     · 좌표(소수 4자리) 캐시(메모리 + localStorage) + 1.2초 간격 큐 → 같은 곳을 두 번 묻지 않고 429 를 피한다. */
  const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';
  const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
  const PLACE_LS_KEY = 'urikkiri.places.v1';
  const PLACE_TTL_MS = 30 * 24 * 3600 * 1000;    // 찾은 곳은 30일 캐시
  const PLACE_FAIL_TTL_MS = 10 * 60 * 1000;      // 못 찾은 곳은 10분 뒤 다시 시도
  const PLACE_GAP_MS = 1200;                     // API 예절: 초당 1회 이하
  const PLACE_RADIUS_M = 80;
  const PLACE_MAX_PER_VIEW = 12;

  const PLACE_CAT = {
    cafe:    { label: '카페',        ico: '☕' },
    food:    { label: '음식점',      ico: '🍽️' },
    store:   { label: '마트/편의점', ico: '🛒' },
    mall:    { label: '쇼핑몰',      ico: '🛍️' },
    shop:    { label: '상가',        ico: '🏪' },
    medical: { label: '병원/약국',   ico: '🏥' },
    school:  { label: '학교',        ico: '🏫' },
    park:    { label: '공원',        ico: '🌳' },
    home:    { label: '집/아파트',   ico: '🏠' },
    office:  { label: '사무실',      ico: '🏢' },
    transit: { label: '역',          ico: '🚇' },
    stay:    { label: '숙소',        ico: '🛏️' },
    car:     { label: '주차/주유',   ico: '🅿️' },
    etc:     { label: '주변',        ico: '📍' },
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function catOfOsm(t) {
    if (!t) return null;
    const a = t.amenity || '', s = t.shop || '', tu = t.tourism || '', le = t.leisure || '';
    const b = t.building || '', of = t.office || '', ra = t.railway || '';
    const lu = t.landuse || '', pl = t.place || '';

    if (a === 'cafe' || a === 'ice_cream' || s === 'coffee' || s === 'bakery' || s === 'confectionery' || s === 'pastry') return 'cafe';
    if (/^(restaurant|fast_food|food_court|canteen|bar|pub|biergarten)$/.test(a)) return 'food';
    if (s === 'convenience' || s === 'supermarket' || s === 'greengrocer' || s === 'butcher' || s === 'grocery' || s === 'general' || s === 'seafood' || s === 'deli' || a === 'marketplace') return 'store';
    if (s === 'mall' || s === 'department_store' || a === 'department_store') return 'mall';
    if (/^(hospital|clinic|doctors|dentist|pharmacy|veterinary)$/.test(a) || s === 'chemist' || s === 'medical_supply') return 'medical';
    if (/^(school|university|college|kindergarten|language_school|driving_school|prep_school)$/.test(a)) return 'school';
    if (le === 'park' || le === 'garden' || le === 'playground' || le === 'nature_reserve' || a === 'fitness_centre') return 'park';
    if (/^(apartments|residential|house|detached|terrace|dormitory|bungalow|semidetached_house|hut)$/.test(b) || pl === 'house' || lu === 'residential') return 'home';
    if (of) return 'office';
    if (ra === 'station' || ra === 'subway_entrance' || ra === 'halt' || a === 'bus_station' || a === 'public_transport') return 'transit';
    if (/^(hotel|motel|guest_house|hostel|apartment|chalet)$/.test(tu)) return 'stay';
    if (/^(parking|parking_space|fuel|charging_station|car_rental|car_wash)$/.test(a) || b === 'garage' || b === 'parking') return 'car';
    if (/^(commercial|retail|kiosk|mixed|office|warehouse)$/.test(b)
        || a === 'bank' || a === 'atm' || a === 'post_office' || a === 'townhall'
        || a === 'place_of_worship' || a === 'community_centre' || a === 'library') return 'shop';
    if (s) return 'shop';
    return null;
  }

  /* 이름에 들어 있는 말로 업종을 한 번 더 다듬는다 (예: '스킨포유 NC백화점강서점' → 쇼핑몰) */
  const PLACE_NAME_RULES = [
    [/아파트|아이파크|단지|빌라|오피스텔|맨션|주공|래미안|자이|힐스테이트|푸르지오|더샵/, 'home'],
    [/백화점|쇼핑몰|아울렛|플라자|프라자|몰$/, 'mall'],
    [/스타벅스|투썸|이디야|메가커피|커피빈|폴바셋|카페|커피/, 'cafe'],
    [/마트|편의점|GS25|CU|세븐일레븐|이마트|홈플러스|노브랜드/, 'store'],
    [/병원|의원|약국|치과|한의원/, 'medical'],
    [/초등학교|중학교|고등학교|대학교|유치원|학교/, 'school'],
    [/공원/, 'park'],
    [/역$|정류장/, 'transit'],
    [/식당|국밥|치킨|피자|분식|횟집|김밥|백반|냉면/, 'food'],
  ];

  function catFromName(name) {
    const s = String(name || '');
    for (const item of PLACE_NAME_RULES) {
      if (item[0].test(s)) return item[1];
    }
    return null;
  }

  /* 장소명으로 쓰기에 의미 없는 시설(자전거 대여소·ATM·정류장 등) */
  const PLACE_SKIP_TYPE = /^(bicycle_rental|bicycle_parking|atm|parking|parking_space|bench|waste_basket|vending_machine|drinking_water|toilets|bus_stop|shelter)$/;

  function placeKeyOf(lat, lng) {
    return Number(lat).toFixed(4) + ',' + Number(lng).toFixed(4);
  }

  function placeCached(lat, lng) {
    if (lat == null || lng == null || !isFinite(lat) || !isFinite(lng)) return null;
    const key = placeKeyOf(lat, lng);
    const hit = state.places.get(key);
    if (!hit) return null;
    if (Date.now() - (Number(hit.at) || 0) > (hit.ok ? PLACE_TTL_MS : PLACE_FAIL_TTL_MS)) {
      state.places.delete(key);
      return null;
    }
    return hit;
  }

  function loadPlaceCache() {
    const saved = LS.get(PLACE_LS_KEY, null);
    if (!saved || typeof saved !== 'object') return;
    Object.keys(saved).forEach((k) => {
      const v = saved[k];
      if (v && typeof v === 'object' && v.at) state.places.set(k, v);
    });
  }

  function savePlace(key, val) {
    state.places.set(key, val);
    try {
      const all = {};
      Array.from(state.places.keys()).slice(-400).forEach((k) => { all[k] = state.places.get(k); });
      LS.set(PLACE_LS_KEY, all);
    } catch (e) {}
  }

  function fetchT(url, opts, ms) {
    if (typeof AbortController === 'undefined') return fetch(url, Object.assign({ cache: 'no-store' }, opts));
    const ac = new AbortController();
    const timer = setTimeout(() => { try { ac.abort(); } catch (e) {} }, ms || 9000);
    return fetch(url, Object.assign({ cache: 'no-store' }, opts, { signal: ac.signal }))
      .then((res) => { clearTimeout(timer); return res; },
            (err) => { clearTimeout(timer); throw err; });
  }

  async function fetchNearby(lat, lng) {
    const q = '[out:json][timeout:8];('
      + ['amenity', 'shop', 'tourism', 'office']
        .map((k) => 'nwr(around:' + PLACE_RADIUS_M + ',' + lat + ',' + lng + ')[' + k + '];').join('')
      + 'nwr(around:' + PLACE_RADIUS_M + ',' + lat + ',' + lng + ')[leisure~"^(park|garden|playground|nature_reserve)$"];'
      + 'nwr(around:' + PLACE_RADIUS_M + ',' + lat + ',' + lng + ')[building~"^(apartments|residential|house|dormitory|commercial|retail)$"];'
      + 'nwr(around:' + PLACE_RADIUS_M + ',' + lat + ',' + lng + ')[railway~"^(station|subway_entrance|halt)$"];'
      + ');out center tags 80;';
    const res = await fetchT(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: 'data=' + encodeURIComponent(q),
    }, 4000);
    if (!res || !res.ok) return null;
    const data = await res.json();
    return (data.elements || []).map((e) => {
      const tags = e.tags || {};
      const c = e.center || e;
      if (!c || !isFinite(c.lat) || !isFinite(c.lon)) return null;
      return {
        name: String(tags['name:ko'] || tags.name || tags.brand || tags.operator || '').trim(),
        tags,
        dist: haversine({ lat, lng }, { lat: c.lat, lng: c.lon }),
      };
    }).filter(Boolean);
  }

  async function fetchReverse(lat, lng) {
    const url = NOMINATIM_URL + '?format=jsonv2&accept-language=ko&zoom=18&addressdetails=1'
      + '&lat=' + encodeURIComponent(lat) + '&lon=' + encodeURIComponent(lng);
    const res = await fetchT(url, { headers: { Accept: 'application/json' } }, 9000);
    if (!res || !res.ok) return null;
    const data = await res.json();
    return data && !data.error ? data : null;
  }

  function addrOf(rev) {
    const a = (rev && rev.address) || {};
    const seen = new Set();
    const out = [];
    [a.city || a.province || a.state, a.borough || a.city_district || a.county,
      a.suburb || a.quarter || a.neighbourhood || a.village, a.road, a.house_number]
      .forEach((b) => {
        const s = String(b || '').trim();
        if (s && !seen.has(s)) { seen.add(s); out.push(s); }
      });
    return out.join(' ');
  }

  /* 도로·행정동 이름은 장소명으로 쓰지 않는다 */
  function isRoadName(s) {
    return /(로|길|대로|동|읍|면|리|구|시|군)\s*\d*\s*(길|로)?$/.test(String(s || ''));
  }

  /* Nominatim display_name 첫마디가 건물·단지 이름일 때(예: '도시개발2단지 아파트, 방화동, …') */
  function displayPlaceName(rev) {
    if (!rev) return '';
    const first = String(rev.display_name || '').split(',')[0].trim();
    if (!first || isRoadName(first)) return '';
    return first;
  }

  function refineCat(name, cat) {
    const byName = catFromName(name);
    if (!byName) return cat || 'etc';
    if (!cat || cat === 'etc' || cat === 'shop') return byName;
    return cat;
  }

  function combinePlace(pois, rev) {
    const addr = addrOf(rev);
    const list = (pois || []).slice().sort((a, b) => a.dist - b.dist);
    const named = list.filter((p) => p.name && p.dist <= PLACE_RADIUS_M);
    const biz = named.filter((p) => { const c = catOfOsm(p.tags); return !!c && c !== 'home'; });

    let pick = biz.filter((p) => p.dist <= 45)[0] || null;                          // 아주 가까운 매장·카페
    if (!pick) pick = named.filter((p) => catOfOsm(p.tags) === 'home' && p.dist <= 70)[0] || null;  // 주거 건물
    if (!pick) pick = biz[0] || null;                                               // 반경 안의 가장 가까운 곳

    const revJunk = !!(rev && PLACE_SKIP_TYPE.test(String(rev.type || '')));
    const revCat = rev ? catOfOsm({ [rev.category || '']: rev.type || '' }) : null;
    if (pick) {
      return { ok: true, name: pick.name, cat: refineCat(pick.name, catOfOsm(pick.tags)), addr,
        dist: Math.round(pick.dist), src: 'osm', at: Date.now() };
    }
    if (rev && rev.name && !revJunk && revCat) {
      return { ok: true, name: rev.name, cat: refineCat(rev.name, revCat), addr, src: 'nominatim', at: Date.now() };
    }
    if (rev && rev.name && !revJunk && rev.category !== 'highway') {
      return { ok: true, name: rev.name, cat: refineCat(rev.name, 'etc'), addr, src: 'nominatim', at: Date.now() };
    }
    const dName = displayPlaceName(rev);
    if (dName) {
      return { ok: true, name: dName, cat: refineCat(dName, 'etc'), addr, src: 'nominatim', at: Date.now() };
    }
    const a = (rev && rev.address) || {};
    const area = String(a.road || a.suburb || a.quarter || a.neighbourhood || a.city_district || '').trim();
    if (area) return { ok: true, name: area, cat: 'etc', addr, src: 'addr', at: Date.now() };
    return { ok: false, name: '', cat: 'etc', addr, at: Date.now() };
  }

  /* Nominatim 으로 먼저 찾고(빠름), 이름을 못 찾았을 때만 Overpass 로 주변 POI 를 뒤진다. */
  async function fetchPlace(lat, lng) {
    let rev = null;
    try { rev = await fetchReverse(lat, lng); } catch (e) { rev = null; }
    const quick = combinePlace(null, rev);
    if (quick && quick.ok) return quick;

    let pois = null;
    try { pois = await fetchNearby(lat, lng); } catch (e) { pois = null; }
    const better = combinePlace(pois, rev);
    return better && better.ok ? better : quick;
  }

  const placeQueue = [];
  const placeWaiting = new Map();   // key → Promise
  let placeBusy = false;
  let placeLastAt = 0;

  async function pumpPlaces() {
    if (placeBusy) return;
    placeBusy = true;
    while (placeQueue.length) {
      const wait = PLACE_GAP_MS - (Date.now() - placeLastAt);
      if (wait > 0) await sleep(wait);
      const job = placeQueue.shift();
      placeLastAt = Date.now();
      let out = null;
      try { out = await fetchPlace(job.lat, job.lng); } catch (e) { out = null; }
      const val = out || { ok: false, name: '', cat: 'etc', addr: '', at: Date.now() };
      savePlace(job.key, val);
      placeWaiting.delete(job.key);
      try { job.resolve(val); } catch (e) {}
    }
    placeBusy = false;
  }

  /* 좌표의 장소를 캐시에서 먼저 찾고, 없으면 큐에 넣어 조회한다. */
  function placeSoon(lat, lng, onDone) {
    if (lat == null || lng == null || !isFinite(lat) || !isFinite(lng)) {
      if (onDone) onDone(null);
      return;
    }
    const hit = placeCached(lat, lng);
    if (hit) { if (onDone) onDone(hit); return; }

    const key = placeKeyOf(lat, lng);
    const waiting = placeWaiting.get(key);
    if (waiting) { waiting.then((r) => { if (onDone) onDone(r); }); return; }
    if (placeQueue.length >= PLACE_MAX_PER_VIEW) { if (onDone) onDone(null); return; }

    const p = new Promise((resolve) => {
      placeQueue.push({ key, lat: Number(lat), lng: Number(lng), resolve });
      pumpPlaces();
    });
    placeWaiting.set(key, p);
    p.then((r) => { if (onDone) onDone(r); });
  }

  function placeMeta(place) {
    return PLACE_CAT[(place && place.cat) || 'etc'] || PLACE_CAT.etc;
  }

  function placeLabel(place) {
    if (!place) return '';
    const meta = placeMeta(place);
    return place.name ? place.name + ' · ' + meta.label : meta.label;
  }

  function placePinText(place) {
    if (!place) return '';
    const meta = placeMeta(place);
    return meta.ico + ' ' + (place.name || meta.label);
  }

  /* 서버에 보내는 열쇠: 로그인으로 받은 세션 토큰을 우선 쓰고, 없으면 예전 비밀 토큰 */
  function mySecret() {
    if (!state.me) return '';
    return state.me.session_token || state.me.secret || '';
  }

  function selfArgs() {
    return { p_user: state.me.user_id, p_secret: mySecret() };
  }

  function personById(id) {
    if (!id || !state.me) return null;
    if (id === state.me.user_id) return state.me;
    return state.friends.get(id) || state.groupPeople.get(id) || null;
  }

  function allPeople() {
    const arr = [];
    if (state.me) arr.push(state.me);
    for (const f of state.friends.values()) arr.push(f);
    for (const g of state.groupPeople.values()) arr.push(g);
    return arr;
  }

  /* 지도에 그릴 사람: 친구 탭 = 나 + 1:1 친구만, 그룹 탭 = 나 + 고른 그룹 멤버만.
     채팅 탭에서는 마지막으로 보고 있던 지도(친구/그룹)를 그대로 유지합니다. */
  function activeGroup() {
    if (!state.groups.size) return null;
    if (state.viewGroup && state.groups.has(state.viewGroup)) return state.groups.get(state.viewGroup);
    return state.groups.values().next().value || null;
  }

  function visiblePeople() {
    const out = [];
    if (state.me) out.push(state.me);

    if (state.mapScope === 'groups') {
      const g = activeGroup();
      if (!g) return out;
      const seen = new Set([state.me.user_id]);
      (g.members || []).forEach((mb) => {
        if (!mb || !mb.user_id || seen.has(mb.user_id)) return;
        seen.add(mb.user_id);
        const base = personById(mb.user_id) || normalizeGroupMember(mb, g);
        const hidden = !!mb.hidden;
        out.push(Object.assign({}, base, {
          hidden,
          lat: hidden ? null : (base.lat != null ? base.lat : mb.lat),
          lng: hidden ? null : (base.lng != null ? base.lng : mb.lng),
          stay_since: hidden ? null : base.stay_since,
          updated_at: hidden ? null : base.updated_at,
        }));
      });
      return out;
    }

    for (const f of state.friends.values()) out.push(f);
    return out;
  }

  function isGroupChat(id) {
    return String(id || '').indexOf('g-') === 0;
  }

  function totalUnread() {
    let n = 0;
    for (const f of state.friends.values()) n += Number(f.unread || 0);
    for (const g of state.groups.values()) n += Number(g.unread || 0);
    return n;
  }

  /* ───────────────────────── 4. 서버(RPC) ───────────────────────── */
  const API = {
    async rpc(fn, args) {
      if (!READY) throw new Error('서버 설정이 비어 있어요');
      const res = await fetch(SUPABASE_URL + '/rest/v1/rpc/' + fn, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: 'Bearer ' + SUPABASE_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(args || {}),
        cache: 'no-store',
      });
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.text()).slice(0, 240); } catch (e) {}
        const err = new Error('server ' + res.status + (detail ? ' · ' + detail : ''));
        err.status = res.status;
        err.detail = detail;
        throw err;
      }
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    },
  };

  function errText(e) {
    const raw = String((e && (e.detail || e.message)) || e || '');
    if (/not_friends/.test(raw)) return '서로 친구가 아니에요';
    if (/unauthorized/.test(raw)) return '내 정보를 다시 확인해야 해요';
    if (/empty_message/.test(raw)) return '보낼 내용을 입력해 주세요';
    if (/Failed to fetch|NetworkError|Load failed/i.test(raw)) return '인터넷 연결을 확인해 주세요';
    return raw.length > 90 ? raw.slice(0, 90) + '…' : raw;
  }

  /* ───────────────────────── 5. 토스트 · 공통 UI ───────────────────────── */
  function toast(message, ms = 2600) {
    if (!el.toast) return;
    el.toast.textContent = message;
    el.toast.classList.add('is-visible');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => el.toast.classList.remove('is-visible'), ms);
  }

  function updateSheetHeight() {
    if (!el.sheet || el.app.hidden) return;
    if (state.sheetHidden) {
      document.documentElement.style.setProperty('--sheet-h', '0px');
      return;
    }
    const h = Math.round(el.sheet.getBoundingClientRect().height);
    if (h > 0) document.documentElement.style.setProperty('--sheet-h', h + 'px');
  }

  /* 하단 시트 접기/숨기기 — 지도를 넓게 보기 */
  function setSheetHidden(hidden) {
    state.sheetHidden = !!hidden;
    if (el.sheet) el.sheet.classList.toggle('is-hidden', state.sheetHidden);
    if (el.sheetOpen) el.sheetOpen.hidden = !state.sheetHidden;
    updateSheetHeight();
    if (state.map) setTimeout(() => state.map.invalidateSize(), 260);
  }

  /* 지도 위 '내 위치' 바로가기: 내 위치로 부드럽게 이동 + 위치 갱신 */
  function focusMyLocation() {
    if (!state.me) return;
    if (state.selected) { state.selected = null; renderPins(); }
    const m = state.me;
    const hasFix = isFinite(m.lat) && isFinite(m.lng);
    if (hasFix && state.map) {
      const zoom = Math.max(state.map.getZoom() || 14, 16);
      state.map.flyTo([m.lat, m.lng], zoom, { duration: 0.75 });
    }
    askLocation({ silent: true });
    if (!hasFix) toast('내 위치를 확인하는 중이에요', 2200);
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* 아래 대체 방법 */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  function inviteLink() {
    const url = new URL(location.href);
    url.search = '';
    url.searchParams.set('add', state.me ? state.me.friend_code : '');
    return url.href;
  }

  async function copyMyCode() {
    if (!state.me) return;
    const ok = await copyText(state.me.friend_code);
    toast(ok ? '내 친구 코드 ' + state.me.friend_code + ' 를 복사했어요' : '내 친구 코드: ' + state.me.friend_code, 2400);
  }

  async function copyMyLink() {
    if (!state.me) return;
    const link = inviteLink();
    const ok = await copyText(link);
    toast(ok ? '초대 링크를 복사했어요 — 친구에게 붙여넣기 하세요' : '링크: ' + link, ok ? 3000 : 7000);
  }

  async function shareMyLink() {
    if (!state.me) return;
    const link = inviteLink();
    if (navigator.share) {
      try {
        await navigator.share({
          title: '우리끼리 — ' + state.me.nickname,
          text: '내 친구 코드는 ' + state.me.friend_code + ' 야. 이 링크로 들어와서 친구 맺자!',
          url: link,
        });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    await copyMyLink();
  }

  /* ───────────────────────── 6. 프로필 ───────────────────────── */
  function identitySnapshot() {
    if (!state.me) return null;
    return {
      user_id: state.me.user_id,
      secret: state.me.secret || state.me.session_token || '',
      session_token: state.me.session_token || '',
      username: state.me.username || '',
      friend_code: state.me.friend_code,
      nickname: state.me.nickname,
      emoji: state.me.emoji,
      status_text: state.me.status_text,
      color: state.me.color,
      avatar_url: state.me.avatar_url || '',
      lat: state.me.lat,
      lng: state.me.lng,
      accuracy: state.me.accuracy,
      auto: state.auto,
      autoLogin: state.autoLogin !== false,
    };
  }

  /* 자동 로그인 열쇠를 localStorage + 쿠키(1년) + IndexedDB 세 곳에 남긴다.
     자동 로그인이 꺼져 있으면 이번 브라우저 탭(sessionStorage)에만 남겨, 닫으면 풀린다. */
  async function persistLogin() {
    const snap = identitySnapshot();
    if (!snap) return;
    if (state.autoLogin === false) {
      try { sessionStorage.setItem(SESS_KEY, JSON.stringify(snap)); } catch (e) {}
      LS.del(ME_KEY);
      clearSessionCookie();
      await idbDel('me');
      return;
    }
    LS.set(ME_KEY, snap);
    setSessionCookie(state.me.user_id, state.me.session_token || state.me.secret, state.me.secret);
    await idbSet('me', snap);
    clearSessionStore();
  }

  function saveMe() {
    if (!state.me) return;
    if (state.autoLogin === false) {
      try { sessionStorage.setItem(SESS_KEY, JSON.stringify(identitySnapshot())); } catch (e) {}
      return;
    }
    LS.set(ME_KEY, identitySnapshot());
    setSessionCookie(state.me.user_id, state.me.session_token || state.me.secret, state.me.secret);
  }

  function applyProfile(prof) {
    if (!state.me) state.me = {};
    state.me.user_id = prof.user_id;
    state.me.friend_code = prof.friend_code;
    state.me.nickname = prof.nickname;
    state.me.emoji = prof.emoji || '🙂';
    state.me.status_text = prof.status_text || '';
    state.me.color = prof.color || colorFor(prof.user_id);
    state.me.avatar_url = prof.avatar_url || '';
    state.me.username = prof.username || '';
  }

  /* 신원 복원: localStorage → 이번 탭(sessionStorage) → 쿠키 → IndexedDB 순서로 찾는다 */
  async function loadIdentity() {
    const saved = LS.get(ME_KEY, null);
    if (validIdentity(saved)) return saved;

    const sess = readSessionStore();
    if (validIdentity(sess)) return sess;

    const c = readSessionCookie();
    if (c && c.user_id && (c.session_token || c.secret)) {
      return {
        user_id: c.user_id,
        secret: c.secret || c.session_token,
        session_token: c.session_token || '',
        nickname: LS.get('urikkiri.lastNick', ''),
        fromCookie: true,
      };
    }

    try {
      const fromIdb = await idbGet('me');
      if (validIdentity(fromIdb)) return Object.assign({ fromIdb: true }, fromIdb);
    } catch (e) {}
    return null;
  }

  function freshMe(identity) {
    return Object.assign({
      emoji: '🙂', status_text: '', color: colorFor(identity.user_id),
      lat: BASE.lat + 0.0008,
      lng: BASE.lng - 0.0006,
      accuracy: null,
      speed_kmh: null, stay_since: null, updated_at: null,
    }, identity);
  }

  async function bootstrap(nickname, identity) {
    let saved = identity || await loadIdentity();
    if (!saved || !saved.user_id || !(saved.secret || saved.session_token)) {
      saved = newIdentity();
    }
    state.me = freshMe(saved);

    const prof = await API.rpc('friend_bootstrap', {
      p_user: state.me.user_id,
      p_secret: mySecret(),
      p_nickname: String(nickname || '').trim().slice(0, 12),
    });
    applyProfile(prof);
    state.auto = saved.auto !== false;
    saveMe();
    persistLogin();
    return state.me;
  }

  /* 로그인·가입 응답(프로필 + 세션 토큰)으로 내 신원을 세팅 */
  function adoptSession(out) {
    const prof = (out && out.profile) || {};
    if (!prof.user_id || !out.session_token) throw new Error('로그인 응답이 올바르지 않아요');
    state.me = freshMe({
      user_id: prof.user_id,
      secret: out.session_token,
      session_token: out.session_token,
      username: prof.username || '',
    });
    applyProfile(prof);
    state.auto = true;
    saveMe();
    persistLogin();
    return state.me;
  }

  async function updateProfile(patch) {
    if (!state.me) return;
    const prof = await API.rpc('friend_update_profile', Object.assign(selfArgs(), {
      p_nickname: patch.nickname != null ? patch.nickname : state.me.nickname,
      p_emoji: patch.emoji != null ? patch.emoji : state.me.emoji,
      p_status: patch.status_text != null ? patch.status_text : state.me.status_text,
    }));
    applyProfile(prof);
    saveMe();
  }

  /* ───────────────────────── 7. 피드(친구·요청·대화) ───────────────────────── */
  function normalizeFriend(f) {
    return {
      user_id: String(f.user_id),
      nickname: String(f.nickname || '친구').slice(0, 20),
      emoji: f.emoji || '🙂',
      status_text: f.status_text || '',
      color: f.color || colorFor(f.user_id),
      avatar_url: f.avatar_url || '',
      lat: f.lat == null ? null : Number(f.lat),
      lng: f.lng == null ? null : Number(f.lng),
      accuracy: f.accuracy == null ? null : Number(f.accuracy),
      battery: f.battery == null ? null : Number(f.battery),
      charging: !!f.charging,
      speed_kmh: f.speed_kmh == null ? null : Number(f.speed_kmh),
      stay_since: f.stay_since || null,
      updated_at: f.updated_at || null,
      unread: Number(f.unread || 0),
      last_message: f.last_message || '',
      last_message_at: f.last_message_at || null,
      last_from_me: !!f.last_from_me,
    };
  }

  function mergeFriends(list) {
    const seen = new Set();
    (list || []).forEach((raw) => {
      if (!raw || !raw.user_id) return;
      seen.add(String(raw.user_id));
      state.friends.set(String(raw.user_id), normalizeFriend(raw));
    });
    Array.from(state.friends.keys()).forEach((id) => {
      if (!seen.has(id)) {
        state.friends.delete(id);
        state.messages.delete(id);
        if (state.chatWith === id) closeChat();
      }
    });
  }

  function refreshFeed() {
    if (!state.me || !READY) return Promise.resolve();
    if (state.feedReq) { state.feedQueued = true; return state.feedReq; }
    state.feedReq = (async () => {
      try {
        const prevPeople = peopleSnapshot();
        const out = await API.rpc('friend_feed', selfArgs());
        if (!out) return;
        mergeFriends(out.friends);
        state.incoming = Array.isArray(out.incoming) ? out.incoming : [];
        state.outgoing = Array.isArray(out.outgoing) ? out.outgoing : [];
        markMyReadIfChatting();
        checkNearby();
        checkFeedNotices(prevPeople);
        renderAll();
        syncRealtime();
        refreshGroups();
      } catch (e) {
        if (!state.errShown) {
          state.errShown = true;
          toast('친구 목록을 불러오지 못했어요 — ' + errText(e), 4200);
        }
        console.warn('[우리끼리] feed', e);
      } finally {
        state.feedReq = null;
        if (state.feedQueued) {
          state.feedQueued = false;
          setTimeout(() => refreshFeed(), 400);
        }
      }
    })();
    return state.feedReq;
  }

  /* ───────────────────────── 7-B. 알림 (채팅 · 온라인 · 이모지 콕) ─────────────────────────
     · 인앱 배너는 항상, 브라우저 알림은 허용했을 때만, 소리·진동은 가능할 때만.
     · 알림을 끈 사람(개인/그룹)의 소식은 배너도 브라우저 알림도 띄우지 않는다. */
  let audioCtx = null;

  function wakeAudioOnce() {
    initAudio();
    document.removeEventListener('pointerdown', wakeAudioOnce, true);
    document.removeEventListener('keydown', wakeAudioOnce, true);
  }

  function initAudio() {
    try {
      if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) audioCtx = new AC();
      }
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { audioCtx = null; }
  }

  function beep(base) {
    if (!audioCtx) return;
    try {
      const t = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(base || 720, t);
      osc.frequency.exponentialRampToValueAtTime((base || 720) * 1.5, t + 0.13);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.085, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.32);
    } catch (e) {}
  }

  function buzz(ms) {
    try { if (navigator.vibrate) navigator.vibrate(ms || 70); } catch (e) {}
  }

  function browserNotify(title, body, tag, opts) {
    try {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      const o = opts || {};
      const n = new Notification(title, {
        body: body || '', tag: tag || '',
        icon: './icons/icon-192.png', badge: './icons/icon-192.png',
        silent: o.sound ? false : true,
        vibrate: o.sound ? [90, 60, 90] : undefined,
      });
      n.onclick = () => { try { window.focus(); } catch (e) {} n.close(); };
    } catch (e) { /* 안드로이드 크롬 등 생성자 미지원 */ }
  }

  function showNotice(o) {
    if (!el.notice) return;
    const key = o.tag || '';
    if (key && state.lastNoticeKey === key && Date.now() - state.lastNoticeAt < 4000) return;
    el.noticeIco.textContent = o.ico || '💬';
    el.noticeTitle.textContent = o.title || '알림';
    el.noticeText.textContent = o.text || '';
    state.noticeOpen = o.open || null;
    el.notice.hidden = false;
    el.notice.classList.remove('is-in');
    void el.notice.offsetWidth;
    el.notice.classList.add('is-in');
    clearTimeout(state.noticeTimer);
    state.noticeTimer = setTimeout(hideNotice, NOTICE_MS);
    state.lastNoticeKey = key;
    state.lastNoticeAt = Date.now();
  }

  function hideNotice() {
    if (!el.notice) return;
    el.notice.hidden = true;
    el.notice.classList.remove('is-in');
    state.noticeOpen = null;
  }

  function notifyNew(o) {
    if (!o || !o.id || isMuted(o.id)) return;
    showNotice(o);
    beep(o.ico === '🟢' ? 880 : 660);
    buzz(o.ico === '🟢' ? 50 : 90);
    browserNotify(o.title, o.text, o.tag);
  }

  function refreshNotifState() {
    const perm = (typeof Notification === 'undefined') ? 'unsupported' : Notification.permission;
    state.notifPerm = perm;
    if (!el.mNotifState) return;
    el.mNotifState.textContent = perm === 'granted' ? '켜져 있어요 — 새 채팅·친구 온라인을 알려드려요'
      : perm === 'denied' ? '브라우저에서 알림이 막혀 있어요 — 설정에서 허용해 주세요'
        : perm === 'unsupported' ? '이 브라우저는 알림을 지원하지 않아요 (앱 안 배너만)'
          : '아직 꺼져 있어요 — 앱 안 배너로만 알려드려요';
    if (el.mNotifAsk) el.mNotifAsk.hidden = perm !== 'default';
  }

  async function askNotifPermission() {
    initAudio();
    if (typeof Notification === 'undefined') {
      toast('이 브라우저는 알림을 지원하지 않아요 — 앱 안 배너로 알려드릴게요', 2800);
      return;
    }
    try {
      const res = await Notification.requestPermission();
      refreshNotifState();
      if (res === 'granted') { beep(760); toast('알림을 켰어요 — 새 채팅과 친구 온라인을 알려드릴게요', 3000); }
      else if (res === 'denied') toast('알림이 막혀 있어요 — 브라우저 설정에서 허용해 주세요', 3200);
    } catch (e) { toast('알림을 켜지 못했어요', 2400); }
  }

  /* 새 채팅·온라인 전환 비교용 기준 */
  function peopleSnapshot() {
    const map = new Map();
    for (const f of state.friends.values()) {
      map.set(f.user_id, { online: f.lat != null && !isStale(f), unread: Number(f.unread || 0) });
    }
    return map;
  }

  function checkFeedNotices(prev) {
    if (!prev) return;
    const first = !state.friendBase;
    state.friendBase = true;
    if (first) return;

    for (const f of state.friends.values()) {
      const old = prev.get(f.user_id);
      if (!old || isMuted(f.user_id)) continue;
      const chatOpen = state.chatWith === f.user_id && !el.chatPanel.hidden;
      const unread = Number(f.unread || 0);

      if (unread > old.unread && !chatOpen) {
        notifyNew({
          id: f.user_id, ico: '💬',
          title: f.nickname + ' 님의 새 메시지',
          text: f.last_message || '새 메시지가 도착했어요',
          tag: 'msg-' + f.user_id,
          open: () => { if (!el.memberModal.hidden) closeModal(); openChat(f.user_id); },
        });
      }

      const online = f.lat != null && !isStale(f);
      const justNow = f.updated_at && Date.now() - new Date(f.updated_at).getTime() < 90 * 1000;
      if (!old.online && online && justNow) {
        const auto = autoStatusOf(f);
        notifyNew({
          id: f.user_id, ico: '🟢',
          title: f.nickname + ' 님이 온라인이 되었어요',
          text: f.status_text || (auto && auto.label) || '지금 위치를 공유하기 시작했어요',
          tag: 'on-' + f.user_id,
          open: () => openMember(f.user_id),
        });
      }
    }
  }

  function groupSnapshot() {
    const unread = new Map();
    const online = new Map();
    for (const [id, g] of state.groups) unread.set(id, Number(g.unread || 0));
    for (const [id, p] of state.groupPeople) online.set(id, { online: p.lat != null && !isStale(p) });
    return { unread, online };
  }

  function checkGroupNotices(prev) {
    if (!prev) return;
    const firstGroups = !state.groupBase;
    const firstPeople = !state.groupPeopleBase;
    state.groupBase = true;
    state.groupPeopleBase = true;

    if (!firstGroups) {
      for (const g of state.groups.values()) {
        const old = prev.unread.get(g.id);
        if (old == null || isMuted(g.id)) continue;
        const unread = Number(g.unread || 0);
        const chatOpen = state.chatWith === g.id && !el.chatPanel.hidden;
        if (unread > old && !chatOpen) {
          const lm = g.last_message || {};
          notifyNew({
            id: g.id, ico: '👥',
            title: g.name + ' 그룹 새 메시지',
            text: lm.body ? nickOf(lm.sender_id) + ': ' + lm.body : '새 메시지가 도착했어요',
            tag: 'grp-' + g.id,
            open: () => { if (!el.memberModal.hidden) closeModal(); openGroupChat(g.id); },
          });
        }
      }
    }

    if (!firstPeople) {
      for (const p of state.groupPeople.values()) {
        const old = prev.online.get(p.user_id);
        if (!old || old.online || isMuted(p.user_id)) continue;
        if (p.lat == null || isStale(p)) continue;
        const auto = autoStatusOf(p);
        notifyNew({
          id: p.user_id, ico: '🟢',
          title: p.nickname + ' 님이 온라인이 되었어요',
          text: (p.groupName ? p.groupName + ' · ' : '') + (p.status_text || (auto && auto.label) || '위치를 공유하기 시작했어요'),
          tag: 'on-' + p.user_id,
          open: () => openMember(p.user_id),
        });
      }
    }
  }

  /* ── 근처 알림: 친구·그룹 멤버가 300m 안으로 들어오면 알린다 ──
     · 같은 사람에게는 30분에 한 번, 500m 넘게 벗어났다가 다시 들어오면 재발동
     · 알림을 끈 사람(개인별)에서 오는 근처 알림은 띄우지 않는다
     · 그룹으로만 아는 사람은 그 사람이 보이는 그룹이 모두 '알림 끔'이면 띄우지 않는다 */
  function nearbyCandidates() {
    const out = new Map();
    for (const f of state.friends.values()) out.set(f.user_id, f);
    for (const [id, p] of state.groupPeople) if (!out.has(id)) out.set(id, p);
    return out;
  }

  function isNearbyMuted(id) {
    if (isMuted(id)) return true;
    if (state.friends.has(id)) return false;
    const gids = [];
    for (const g of state.groups.values()) {
      if ((g.members || []).some((mb) => mb.user_id === id)) gids.push(g.id);
    }
    return gids.length > 0 && gids.every((gid) => isMuted(gid));
  }

  function nearbyGroupOf(id) {
    for (const g of state.groups.values()) {
      if ((g.members || []).some((mb) => mb.user_id === id)) return g;
    }
    return null;
  }

  function notifyNearby(p, dist) {
    const m = Math.max(10, Math.round(dist / 10) * 10);
    const auto = autoStatusOf(p);
    const g = nearbyGroupOf(p.user_id);
    const where = p.status_text || (auto && auto.label) || (g ? g.name + ' · 가까이 있어요' : '가까이 있어요');
    const title = '📍 ' + p.nickname + ' 님이 근처(약 ' + m + 'm)에 있어요!';
    showNotice({
      ico: '📍',
      title: title,
      text: where,
      tag: 'near-' + p.user_id,
      open: () => openMember(p.user_id),
    });
    initAudio();
    beep(940);
    buzz([90, 60, 90]);
    browserNotify(title, where, 'near-' + p.user_id, { sound: true });
    state.lastNearby = { id: p.user_id, name: p.nickname, m: m, at: Date.now() };
  }

  function checkNearby() {
    if (!state.me || !state.joined) return;
    // 실제 위치를 한 번도 못 받았으면(서울 도심 임시 좌표) 근처 알림을 계산하지 않는다
    if (!state.gotFix) return;
    const me = state.me;
    if (me.lat == null || me.lng == null || !isFinite(me.lat) || !isFinite(me.lng)) return;
    const here = { lat: Number(me.lat), lng: Number(me.lng) };
    const now = Date.now();
    let dirty = false;

    for (const p of nearbyCandidates().values()) {
      if (!p || !p.user_id || p.user_id === me.user_id) continue;
      if (!state.nearby[p.user_id]) { state.nearby[p.user_id] = { at: 0, inside: false }; dirty = true; }
      const rec = state.nearby[p.user_id];

      // 위치를 숨겼거나·오래된(오프라인) 사람은 '밖'으로 본다
      if (p.hidden || p.lat == null || p.lng == null || !isFinite(p.lat) || !isFinite(p.lng) || isStale(p)) {
        if (rec.inside) { rec.inside = false; dirty = true; }
        continue;
      }

      const d = haversine(here, { lat: Number(p.lat), lng: Number(p.lng) });
      if (d >= NEAR_EXIT_M) {
        if (rec.inside) { rec.inside = false; dirty = true; }
        continue;
      }
      if (rec.inside) continue;          // 300~500m 사이: 아직 '근처'인 상태 유지
      if (d > NEAR_M) continue;

      rec.inside = true;
      dirty = true;
      if (now - Number(rec.at || 0) < NEAR_COOLDOWN_MS) continue;
      if (isNearbyMuted(p.user_id)) continue;
      rec.at = now;
      notifyNearby(p, d);
    }

    if (dirty) {
      // 오래된 기록은 정리(7일)
      for (const id of Object.keys(state.nearby)) {
        const r = state.nearby[id];
        if (!r || (now - Number(r.at || 0) > 7 * 24 * 60 * 60 * 1000 && !r.inside)) delete state.nearby[id];
      }
      LS.set(NEAR_KEY, state.nearby);
    }
  }

  /* ── 이모지 콕 ── */
  function flyPoke(emoji, n) {
    if (!el.pokeLayer) return;
    const count = n || 4;
    for (let i = 0; i < count; i++) {
      const s = document.createElement('span');
      s.className = 'poke-fly';
      s.textContent = emoji || '👋';
      s.style.left = (28 + Math.random() * 44) + '%';
      s.style.animationDelay = (i * 95) + 'ms';
      s.style.fontSize = (20 + Math.random() * 14) + 'px';
      el.pokeLayer.appendChild(s);
      setTimeout(() => { try { s.remove(); } catch (e) {} }, 2100 + i * 95);
    }
  }

  async function sendPoke(toId, emoji) {
    if (!toId || !state.me) return;
    try {
      await API.rpc('poke_send', Object.assign(selfArgs(), { p_to: toId, p_emoji: emoji }));
      rt.send(pairTopic(toId), 'poke', { from: state.me.user_id, emoji });
      flyPoke(emoji, 3);
      beep(560);
      toast(nickOf(toId) + ' 님에게 ' + emoji + ' 콕!', 1700);
    } catch (e) {
      const raw = String(e.detail || e.message || e);
      if (/too_fast/.test(raw)) toast('조금 있다가 다시 콕 찔러 주세요', 1800);
      else if (/not_allowed/.test(raw)) toast('친구이거나 같은 그룹일 때만 콕을 보낼 수 있어요', 2400);
      else toast('콕을 보내지 못했어요 — ' + errText(e), 2800);
    }
  }

  async function pollPokes() {
    if (!state.me || !READY) return;
    try {
      const rows = await API.rpc('poke_poll', selfArgs());
      if (!Array.isArray(rows) || !rows.length) return;
      const fresh = rows.filter((p) => p && !state.pokeIds.has(String(p.id)));
      if (!fresh.length) return;
      const ids = [];
      fresh.forEach((p) => {
        state.pokeIds.add(String(p.id));
        ids.push(Number(p.id));
        flyPoke(p.emoji || '👋', 5);
        beep(620);
        buzz(60);
        notifyNew({
          id: p.from_id, ico: p.emoji || '👋',
          title: (p.nickname || '친구') + ' 님이 ' + (p.emoji || '👋') + ' 보냈어요!',
          text: '콕 찔렀어요 — 지도에서 확인해 보세요',
          tag: 'poke-' + p.id,
          open: () => openMember(p.from_id),
        });
      });
      await API.rpc('poke_ack', Object.assign(selfArgs(), { p_ids: ids }));
    } catch (e) { /* 콕은 조용히 */ }
  }

  /* ───────────────────────── 8. 렌더링: 상단 · 카드 · 요청 · 대화 ───────────────────────── */
  /* 같은 내용이면 다시 그리지 않는다 (탭 위치·스크롤이 튀지 않게) */
  const paint = { members: '', convos: '', reqs: '', outgoing: '', chat: '' };

  function setHTML(node, html, key) {
    if (!node) return;
    if (key && paint[key] === html) return;
    if (key) paint[key] = html;
    node.innerHTML = html;
  }

  function updateChrome() {
    if (!state.me) return;
    el.myCode.textContent = state.me.friend_code;
    el.myName.textContent = state.me.nickname;
    el.meChipPin.textContent = state.me.emoji || '🙂';
    el.myCodeBig.textContent = state.me.friend_code;
    el.friendCount.textContent = state.friends.size;

    const unread = totalUnread();
    el.chatBadge.hidden = unread === 0;
    el.chatBadge.textContent = unread > 99 ? '99+' : String(unread);

    const waiting = unread + (state.incoming ? state.incoming.length : 0);
    if (el.sheetOpenBadge) {
      el.sheetOpenBadge.hidden = waiting === 0;
      el.sheetOpenBadge.textContent = waiting > 99 ? '99+' : String(waiting);
    }

    el.btnAuto.classList.toggle('is-on', state.auto);
    el.btnAuto.setAttribute('aria-pressed', String(state.auto));
    el.updateSub.textContent = state.me.updated_at ? (isStale(state.me) ? '오래됨' : timeAgo(state.me.updated_at)) : '대기 중';

    renderIdBanner();
    updateSheetHeight();
  }

  /* 아이디가 아직 없으면 상단에 한 번 안내 */
  function idHintKey() {
    return 'urikkiri.idHint.' + (state.me ? state.me.user_id : '');
  }

  function renderIdBanner() {
    if (!el.idBanner) return;
    const show = !!state.me && !state.me.username && LS.get(idHintKey(), false) !== true;
    el.idBanner.hidden = !show;
  }

  function renderAcct(isMe) {
    if (!el.mAcct) return;
    el.mAcct.hidden = !isMe;
    if (!isMe || !state.me) return;
    const uname = state.me.username || '';
    el.mAcctId.textContent = uname ? '@' + uname : '아이디 없음';
    el.mAcctHint.textContent = uname
      ? '이 아이디로 다른 기기에서 로그인하면 친구·채팅·동선이 그대로 보여요.'
      : '아이디를 만들면 앱을 지우거나 기기를 바꿔도 친구·채팅이 사라지지 않아요.';
    el.mAcctCreate.hidden = !!uname;
  }

  function openIdModal() {
    if (!state.me || state.me.username) return;
    setAuthMsg(el.idMsg, '');
    el.idInput.value = '';
    el.idPw.value = '';
    el.idModal.hidden = false;
    setTimeout(() => { try { el.idInput.focus(); } catch (e) {} }, 120);
  }

  function closeIdModal() {
    el.idModal.hidden = true;
  }

  async function saveUsername() {
    if (!state.me || state.authBusy) return;
    const uname = String(el.idInput.value || '').trim().toLowerCase();
    const pw = String(el.idPw.value || '');
    setAuthMsg(el.idMsg, '');
    if (!USERNAME_RE.test(uname)) {
      setAuthMsg(el.idMsg, '아이디는 영문으로 시작하는 영문·숫자·밑줄 4~20자로 정해 주세요');
      el.idInput.focus();
      return;
    }
    if (pw.length < 4) { setAuthMsg(el.idMsg, '비밀번호는 4자 이상으로 정해 주세요'); el.idPw.focus(); return; }

    state.authBusy = true;
    setBtnBusy(el.btnIdSave, true, '만드는 중…');
    try {
      const out = await API.rpc('auth_link_existing', Object.assign(selfArgs(), {
        p_username: uname,
        p_password: pw,
      }));
      if (out && out.session_token) state.me.session_token = out.session_token;
      if (out && out.profile) applyProfile(out.profile);
      else state.me.username = uname;
      saveMe();
      persistLogin();
      LS.set('urikkiri.lastUser', uname);
      state.authBusy = false;
      setBtnBusy(el.btnIdSave, false, '아이디 만들기');
      closeIdModal();
      renderAll();
      if (modalUser === state.me.user_id) renderAcct(true);
      toast('아이디 @' + uname + ' 를 만들었어요 — 이제 기기를 바꿔도 이어져요', 3800);
    } catch (e) {
      state.authBusy = false;
      setBtnBusy(el.btnIdSave, false, '아이디 만들기');
      setAuthMsg(el.idMsg, authErrText(e));
    }
  }

  function sortedFriends() {
    return Array.from(state.friends.values()).sort((a, b) => {
      const at = a.updated_at ? new Date(a.updated_at).getTime() : 0;
      const bt = b.updated_at ? new Date(b.updated_at).getTime() : 0;
      if (at !== bt) return bt - at;
      return String(a.nickname).localeCompare(String(b.nickname), 'ko');
    });
  }

  function memberCardHTML(p, isMe) {
    const stale = isStale(p);
    const auto = autoStatusOf(p);
    const status = p.status_text || (auto ? auto.label : (isMe ? '상태를 남겨보세요' : '상태 없음'));
    const batt = batteryText(p);
    const act = activityText(p);
    const unread = !isMe ? Number(p.unread || 0) : 0;
    const cls = ['member-card', isMe ? 'is-me' : '', state.selected === p.user_id ? 'is-selected' : ''].filter(Boolean).join(' ');

    return '<button class="' + cls + '" type="button" data-id="' + esc(p.user_id) + '">'
      + '<span class="' + avatarClass('mc-avatar', p) + onlineCls(p) + '" style="' + avatarStyleOf(p) + '">'
      + esc(initialOf(p.nickname)) + '<span class="mc-emoji">' + esc(p.emoji || '🙂') + '</span>'
      + onlineBadge(p)
      + (unread ? '<span class="mc-badge">' + (unread > 9 ? '9+' : unread) + '</span>' : '')
      + '</span>'
      + '<span class="mc-body">'
      + '<span class="mc-top"><span class="mc-name">' + esc(p.nickname) + '</span>'
      + (isMe ? '<em class="mc-me">나</em>' : '') + '</span>'
      + '<span class="mc-status">' + esc(status) + '</span>'
      + (act ? '<span class="mc-activity mc-activity--' + act.kind + '">' + esc(act.text) + '</span>' : '')
      + '<span class="mc-meta">'
      + '<span class="' + (stale ? 'mc-stale' : '') + '">'
      + (p.hidden ? '위치 숨김 중' : (isMe ? (p.lat ? '위치 공유 중' : '위치 대기') : (p.lat ? (stale ? '오프라인 · ' + timeAgo(p.updated_at) : timeAgo(p.updated_at)) : '위치 없음')))
      + '</span>'
      + (batt ? '<span>' + esc(batt) + '</span>' : '')
      + '</span></span></button>';
  }

  function renderList() {
    if (!el.memberList) return;
    const keepScroll = el.memberList.scrollLeft;
    const cards = [];
    if (state.me) cards.push(memberCardHTML(state.me, true));
    sortedFriends().forEach((f) => cards.push(memberCardHTML(f, false)));

    if (state.friends.size === 0) {
      cards.push('<div class="members-empty"><b>아직 친구가 없어요</b>'
        + '<span>내 초대 링크를 보내거나, 친구 코드를 입력해 보세요.</span>'
        + '<span class="empty-actions"><button type="button" data-act="share">초대 링크 복사</button>'
        + '<button type="button" data-act="add">친구 코드 입력</button></span></div>');
    }

    setHTML(el.memberList, cards.join(''), 'members');
    el.memberList.scrollLeft = keepScroll;
  }

  function renderRequests() {
    if (!el.reqBox) return;
    if (!state.incoming.length) {
      el.reqBox.hidden = true;
      setHTML(el.reqList, '', 'reqs');
      return;
    }
    el.reqBox.hidden = false;
    el.reqCount.textContent = state.incoming.length;
    setHTML(el.reqList, state.incoming.map((r) => (
      '<div class="req" data-req="' + esc(r.id) + '" data-uid="' + esc(r.user_id) + '">'
      + '<span class="' + avatarClass('req-avatar', r) + '" style="' + avatarStyleOf(r) + '">' + esc(initialOf(r.nickname)) + '</span>'
      + '<span class="req-body"><b>' + esc(r.nickname) + '</b><span>' + esc(timeAgo(r.created_at)) + ' · 친구 요청</span></span>'
      + '<span class="req-actions">'
      + '<button class="req-ok" type="button" data-accept="' + esc(r.id) + '">수락</button>'
      + '<button class="req-no" type="button" data-decline="' + esc(r.id) + '">거절</button>'
      + '</span></div>'
    )).join(''), 'reqs');
  }

  function convoRowHTML(f) {
    const unread = Number(f.unread || 0);
    const last = f.last_message ? ((f.last_from_me ? '나: ' : '') + f.last_message) : '아직 대화가 없어요';
    const muted = isMuted(f.user_id);
    return '<button class="convo" type="button" data-chat="' + esc(f.user_id) + '">'
      + '<span class="' + avatarClass('convo-avatar', f) + onlineCls(f) + '" style="' + avatarStyleOf(f) + '">'
      + esc(initialOf(f.nickname)) + '<span class="convo-emoji">' + esc(f.emoji || '🙂') + '</span>' + onlineBadge(f) + '</span>'
      + '<span class="convo-body">'
      + '<span class="convo-top"><b>' + esc(f.nickname) + '</b>'
      + '<span class="convo-time">' + (muted ? '🔕 ' : '') + esc(f.last_message_at ? msgTime(f.last_message_at) : '') + '</span></span>'
      + '<span class="convo-last' + (unread ? ' is-unread' : '') + '">' + esc(last) + '</span>'
      + '</span>'
      + (unread ? '<span class="convo-badge">' + (unread > 99 ? '99+' : unread) + '</span>' : '')
      + '</button>';
  }

  function renderConvos() {
    if (!el.convoList) return;
    const list = Array.from(state.friends.values()).sort((a, b) => {
      const at = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
      const bt = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
      if (at !== bt) return bt - at;
      return String(a.nickname).localeCompare(String(b.nickname), 'ko');
    });

    const groupRows = Array.from(state.groups.values()).map((g) => {
      const last = g.last_message;
      const lastTxt = last
        ? ((last.sender_id === state.me.user_id ? '나: ' : nickOf(last.sender_id) + ': ') + last.body)
        : '아직 대화가 없어요';
      const gunread = Number(g.unread || 0);
      const gmuted = isMuted(g.id);
      return '<button class="convo" type="button" data-chat="' + esc(g.id) + '">'
        + '<span class="convo-avatar" style="--c:#0fb9a3">#<span class="convo-emoji">👥</span></span>'
        + '<span class="convo-body">'
        + '<span class="convo-top"><b>' + esc(g.name) + '</b>'
        + '<span class="convo-time">' + (gmuted ? '🔕 ' : '') + esc(last ? msgTime(last.created_at) : '') + '</span></span>'
        + '<span class="convo-last' + (gunread ? ' is-unread' : '') + '">' + esc(lastTxt) + '</span>'
        + '</span>'
        + (gunread ? '<span class="convo-badge">' + (gunread > 99 ? '99+' : gunread) + '</span>' : '')
        + '</button>';
    }).join('');

    if (!list.length && !groupRows) {
      setHTML(el.convoList, '<div class="convo-empty">친구와 대화를 시작해 보세요.<br>'
        + '친구 탭에서 친구를 누르면 [채팅] 버튼이 있어요.</div>', 'convos');
      return;
    }
    setHTML(el.convoList, groupRows + list.map(convoRowHTML).join(''), 'convos');
  }

  function renderAll() {
    renderPins();
    renderList();
    renderRequests();
    renderConvos();
    updateChrome();
    syncLiveRoutes();
    refreshRouteView();
  }

  function renderTimes() {
    renderList();
    renderConvos();
    updateChrome();
    refreshModalLive();
  }

  /* ───────────────────────── 9. 지도 ───────────────────────── */
  function makeTileLayer(key) {
    const src = mapTileSource(key);
    return L.tileLayer(src.url, {
      maxZoom: 19,
      maxNativeZoom: src.maxNativeZoom || 19,
      subdomains: src.subdomains || 'abc',
      attribution: src.attribution,
    });
  }

  /* 지도 스타일 적용: 타일 교체 + 다크일 때 핀/라벨·저작권 표시 시인성 보정 */
  function applyMapStyle(key, opts = {}) {
    const next = mapStyleKey(key);
    const s = MAP_STYLES[next];
    state.mapStyle = next;

    if (state.map) {
      if (state.tile) state.map.removeLayer(state.tile);
      state.tile = makeTileLayer(next);
      state.tile.addTo(state.map);
      const pane = state.map.getPane('tilePane');
      if (pane) pane.style.filter = mapTileSource(next).filter || 'none';
    }

    const dark = !!s.dark;
    if (el.app) el.app.classList.toggle('map-dark', dark);
    if (state.routeCasing) state.routeCasing.setStyle({ color: dark ? '#0b1220' : '#ffffff' });

    if (el.btnMapStyle) {
      el.btnMapStyle.setAttribute('aria-label', '지도 스타일: ' + s.name + ' — 바꾸기');
      el.btnMapStyle.setAttribute('title', '지도 스타일: ' + s.name);
    }
    if (el.mapStyleDot) el.mapStyleDot.setAttribute('data-style', next);
    if (el.mapStyleNote) el.mapStyleNote.hidden = !!CARTO_KEY;
    if (el.mapStyleMenu) {
      el.mapStyleMenu.querySelectorAll('[data-map-style]').forEach((btn) => {
        const on = btn.getAttribute('data-map-style') === next;
        btn.classList.toggle('is-on', on);
        btn.setAttribute('aria-checked', on ? 'true' : 'false');
      });
    }
    if (opts.save !== false) LS.set(MAP_STYLE_KEY, next);
  }

  function setMapStyleMenu(open) {
    if (!el.mapStyleMenu) return;
    const show = !!open;
    el.mapStyleMenu.hidden = !show;
    if (el.btnMapStyle) {
      el.btnMapStyle.setAttribute('aria-expanded', show ? 'true' : 'false');
      el.btnMapStyle.classList.toggle('is-open', show);
    }
  }

  function initMap() {
    if (state.map || typeof L === 'undefined') return;
    const map = L.map('map', {
      zoomControl: false,
      attributionControl: false,
      maxZoom: 19,
      minZoom: 3,
      worldCopyJump: false,
    }).setView([BASE.lat, BASE.lng], 14);

    L.control.attribution({ position: 'bottomleft', prefix: false }).addTo(map);

    map.on('click', () => {
      if (!el.memberModal.hidden) { closeModal(); return; }
      state.selected = null;
      renderPins();
    });

    state.routeGroup = L.layerGroup().addTo(map);
    state.map = map;
    applyMapStyle(state.mapStyle, { save: false });
    setTimeout(() => map.invalidateSize(), 60);
  }

  function pinSignature(m) {
    const act = activityText(m);
    const auto = autoStatusOf(m);
    return [
      m.user_id, m.nickname, m.emoji, m.status_text, m.color,
      avatarUrlOf(m) ? 'p' : '',
      auto ? auto.label : '',
      isStale(m) ? 's' : '',
      state.selected === m.user_id ? 'sel' : '',
      state.me && m.user_id === state.me.user_id ? 'me' : '',
      act ? act.kind + act.text : '',
      batteryText(m),
    ].join('|');
  }

  function buildPinIcon(m) {
    const isMe = !!state.me && m.user_id === state.me.user_id;
    const stale = isStale(m) && !isMe;
    const cls = ['pin',
      isMe ? 'pin--me' : '',
      stale ? 'pin--stale' : '',
      state.selected === m.user_id ? 'is-selected' : '',
    ].filter(Boolean).join(' ');

    const auto = autoStatusOf(m);
    const label = m.status_text || (auto ? auto.label : '');
    const act = activityText(m);
    const batt = batteryText(m);

    const meta = (act || batt)
      ? '<span class="pin-meta">'
        + (act ? '<span class="pin-chip pin-chip--' + act.kind + '">' + esc(act.text) + '</span>' : '')
        + (batt ? '<span class="pin-chip">' + esc(batt) + '</span>' : '')
        + '</span>'
      : '';

    const html = '<div class="' + cls + '" style="--pin:' + esc(m.color || colorFor(m.user_id)) + '">'
      + '<div class="' + avatarClass('pin-dot', m) + onlineCls(m) + '" style="' + avatarStyleOf(m) + '">' + esc(initialOf(m.nickname))
      + '<span class="pin-emoji">' + esc(m.emoji || '🙂') + '</span>' + onlineBadge(m) + '</div>'
      + '<div class="pin-tag"><span class="pin-name">' + esc(m.nickname)
      + (isMe ? '<em class="pin-me">나</em>' : '') + '</span>'
      + (label ? '<span class="pin-status">' + esc(label) + '</span>' : '')
      + meta
      + '</div></div>';

    return L.divIcon({ className: 'pin-host', html, iconSize: [76, 76], iconAnchor: [38, 38] });
  }

  function renderPins() {
    if (!state.map) return;
    const seen = new Set();

    if (state.routeView) {
      for (const [id, marker] of Array.from(state.markers.entries())) {
        marker.remove();
        state.markers.delete(id);
        state.markerSig.delete(id);
      }
      return;
    }

    for (const m of visiblePeople()) {
      if (!isFinite(m.lat) || !isFinite(m.lng) || m.lat == null) continue;
      seen.add(m.user_id);

      const sig = pinSignature(m);
      const existing = state.markers.get(m.user_id);

      if (!existing) {
        const marker = L.marker([m.lat, m.lng], {
          icon: buildPinIcon(m),
          keyboard: false,
          riseOnHover: true,
          zIndexOffset: state.me && m.user_id === state.me.user_id ? 1200 : 0,
        }).addTo(state.map);
        marker.on('click', () => { openMember(m.user_id); });
        state.markers.set(m.user_id, marker);
        state.markerSig.set(m.user_id, sig);
      } else {
        existing.setLatLng([m.lat, m.lng]);
        if (state.markerSig.get(m.user_id) !== sig) {
          existing.setIcon(buildPinIcon(m));
          state.markerSig.set(m.user_id, sig);
        }
      }
    }

    for (const [id, marker] of Array.from(state.markers.entries())) {
      if (!seen.has(id)) {
        marker.remove();
        state.markers.delete(id);
        state.markerSig.delete(id);
      }
    }
  }

  function fitToPeople(animate = false) {
    if (!state.map) return;
    const pts = visiblePeople()
      .filter((m) => isFinite(m.lat) && isFinite(m.lng) && m.lat != null)
      .map((m) => [m.lat, m.lng]);
    if (!pts.length) return;

    if (pts.length === 1) {
      state.map.setView(pts[0], 15, { animate });
      return;
    }
    const sheetH = el.sheet ? el.sheet.getBoundingClientRect().height : 240;
    const size = state.map.getSize();
    const bottomPad = Math.min(Math.round(sheetH + 78), Math.max(140, size.y - 150));

    state.map.fitBounds(L.latLngBounds(pts), {
      paddingTopLeft: [44, 98],
      paddingBottomRight: [44, bottomPad],
      maxZoom: 15,
      animate,
    });
  }

  function centerOn(m) {
    if (!state.map || !m || !isFinite(m.lat) || !isFinite(m.lng)) return;
    state.map.flyTo([m.lat, m.lng], Math.max(state.map.getZoom(), 15), { duration: 0.7 });
  }

  /* 하단 시트·상세 시트가 가리는 만큼을 빼고, 친구 핀이 위쪽 지도 가운데에 오게 이동 */
  function sheetCoverHeight() {
    const vh = window.innerHeight || 844;
    let h = 0;
    if (el.sheet && !el.sheet.classList.contains('is-hidden') && !el.sheet.classList.contains('is-collapsed')) {
      h = Math.max(h, el.sheet.getBoundingClientRect().height);
    }
    if (el.memberModal && !el.memberModal.hidden && el.mCard) {
      h = Math.max(h, el.mCard.getBoundingClientRect().height);
    }
    return Math.min(Math.round(h), Math.round(vh * 0.62));
  }

  function focusPersonOnMap(m) {
    if (!state.map || !m || m.hidden) return false;
    if (m.lat == null || m.lng == null || !isFinite(m.lat) || !isFinite(m.lng)) return false;
    if (state.routeView) return false;
    const zoom = Math.max(state.map.getZoom() || 14, 16);
    const offsetY = Math.round(sheetCoverHeight() / 2);   // 가려진 높이의 절반만큼 위로
    const ll = L.latLng(Number(m.lat), Number(m.lng));
    const target = state.map.unproject(state.map.project(ll, zoom).add([0, offsetY]), zoom);
    state.map.flyTo(target, zoom, { duration: 0.75 });
    return true;
  }

  /* ───────────────────────── 10. 이동 기록 · 동선 ───────────────────────── */
  function historyFor(id) {
    return state.history.get(id) || [];
  }

  function setHistory(id, pts) {
    const clean = (pts || [])
      .map((p) => ({
        lat: Number(p && p.lat),
        lng: Number(p && p.lng),
        t: Number(p && (p.t != null ? p.t : (p.recorded_at ? new Date(p.recorded_at).getTime() : 0))),
        speed: p && p.speed != null && p.speed !== '' ? Number(p.speed) : (p && p.speed_kmh != null ? Number(p.speed_kmh) : null),
        since: (p && (p.since || p.stay_since)) || null,
      }))
      .filter((p) => isFinite(p.lat) && isFinite(p.lng) && isFinite(p.t) && p.t > 0)
      .sort((a, b) => a.t - b.t);
    const cutoff = Date.now() - HISTORY_MAX_MS;
    const trimmed = clean.filter((p) => p.t >= cutoff).slice(-HISTORY_MAX);
    state.history.set(id, trimmed);
    return trimmed;
  }

  /* 동선 기록 한 점.
     · 머무는 동안에도 '체류 시작 시각'을 담은 점이 남도록, 시작점은 지우지 않고
       1분(10분 넘게 머물면 5분)에 한 번씩 이어 붙인다 → 5분 체류가 사라지지 않는다.
     · 이동 중 잔떨림은 마지막 점만 갱신해 점이 쌓이지 않게 한다(체류 시작점은 건드리지 않음). */
  function addHistoryPoint(id, p) {
    if (!id || !p || !isFinite(p.lat) || !isFinite(p.lng)) return false;
    const arr = historyFor(id);
    const last = arr[arr.length - 1];
    const t = p.t || Date.now();
    const point = {
      lat: Number(p.lat), lng: Number(p.lng), t,
      speed: p.speed == null ? null : Number(p.speed),
      since: p.since || null,
    };

    if (last) {
      const dt = t - last.t;
      if (dt <= 0) return false;
      const d = haversine(last, point);

      if (point.since && d <= STAY_RADIUS_M) {
        // 머무는 중: 시작점은 그대로 두고 일정 간격으로만 남긴다
        const began = new Date(point.since).getTime();
        const stayAge = isFinite(began) ? t - began : 0;
        const gap = stayAge >= 10 * 60 * 1000 ? STAY_LONG_SAMPLE_MS : STAY_SAMPLE_MS;
        if (dt < gap) return false;
      } else if (last.since && d <= STAY_RADIUS_M && dt < STAY_SAMPLE_MS) {
        return false;   // 체류 시작점은 짧은 간격의 점으로 덮지 않는다
      } else if (dt < 15 * 1000 && d < 12) {
        return false;
      } else if (d < 10 && dt < 120 * 1000 && !last.since) {
        // 이동 중 잔떨림: 마지막 점만 새 점으로 바꾼다
        arr[arr.length - 1] = point;
        state.history.set(id, arr);
        return false;
      }
    }

    arr.push(point);
    if (arr.length > HISTORY_MAX) arr.splice(0, arr.length - HISTORY_MAX);
    state.history.set(id, arr);
    return true;
  }

  /* ── 머문 곳(체류) 찾기 ─────────────────────────────────────────────
     위치를 기록할 때마다 '머물기 시작한 시각'(since)을 점에 남긴다.
     같은 since 로 이어진 점들이 한 곳에 머문 구간이고, 그 길이가 5분 이상이면 '체류'로 센다.
     (옛 기록처럼 since 가 없을 때만 같은 자리에 머문 점을 반경으로 묶어 판단) */
  function stayStartOf(p) {
    if (!p || !p.since) return null;
    const t = new Date(p.since).getTime();
    return isFinite(t) ? t : null;
  }

  function pointMoving(p) {
    return !!(p && p.speed != null && isFinite(p.speed) && p.speed >= MOVE_KMH);
  }

  function stayGroups(pts) {
    if (!pts || pts.length < 2) return [];
    const raw = [];
    const anySince = pts.some((p) => stayStartOf(p) != null);

    if (anySince) {
      let cur = null;
      pts.forEach((p, i) => {
        const sin = stayStartOf(p);
        if (sin == null) { cur = null; return; }
        if (cur && Math.abs(cur.start - sin) <= 1000) { cur.to = i; return; }
        cur = { start: sin, from: i, to: i };
        raw.push(cur);
      });
    } else {
      let i = 0;
      while (i < pts.length) {
        if (pointMoving(pts[i])) { i++; continue; }
        let j = i;
        let sumLat = pts[i].lat, sumLng = pts[i].lng, n = 1;
        while (j + 1 < pts.length) {
          const nx = pts[j + 1];
          if (nx.t - pts[j].t > STAY_GAP_MAX_MS || pointMoving(nx)) break;
          if (haversine({ lat: sumLat / n, lng: sumLng / n }, nx) > STAY_RADIUS_M) break;
          j++;
          sumLat += nx.lat; sumLng += nx.lng; n++;
        }
        raw.push({ start: pts[i].t, from: i, to: j });
        i = j + 1;
      }
    }

    return raw.map((g) => {
      const span = pts.slice(g.from, g.to + 1);
      let sumLat = 0, sumLng = 0;
      span.forEach((p) => { sumLat += p.lat; sumLng += p.lng; });
      const lat = sumLat / span.length;
      const lng = sumLng / span.length;
      let end = pts[g.to].t;
      const nx = pts[g.to + 1];
      // 자리를 뜨는 첫 점(같은 자리 안이면)의 시각까지를 '머문 끝'으로 본다
      if (nx && stayStartOf(nx) == null && nx.t - end <= 90 * 1000
          && haversine({ lat, lng }, nx) <= STAY_RADIUS_M) end = Math.max(end, nx.t);
      return { start: g.start, end, from: g.from, to: g.to, lat, lng, ms: Math.max(0, end - g.start) };
    });
  }

  function buildSegments(pts) {
    if (!pts || pts.length < 2) return [];
    const out = [];
    const startT = pts[0].t;

    const stays = stayGroups(pts)
      .map((g) => Object.assign(g, { start: Math.max(g.start, startT), ms: Math.max(0, g.end - Math.max(g.start, startT)) }))
      .filter((g) => g.ms >= STAY_MIN_MS);

    let prev = 0;
    let prevEndT = pts[0].t;
    const pushMove = (from, to, fromT) => {
      if (to - from < 1) return;
      let dist = 0;
      for (let i = from + 1; i <= to; i++) dist += haversine(pts[i - 1], pts[i]);
      const startT = Math.max(pts[from].t, fromT || 0);
      const ms = Math.max(1, pts[to].t - startT);
      out.push({
        kind: 'move', start: startT, end: pts[to].t, ms,
        meters: dist,
        kmh: (dist / 1000) / (ms / 3600000),
        from: pts[from], to: pts[to],
      });
    };

    for (const s of stays) {
      if (s.from > prev) pushMove(prev, s.from, prevEndT);
      out.push({
        kind: 'stay', start: s.start, end: s.end,
        ms: Math.max(1, s.ms), lat: s.lat, lng: s.lng,
        place: placeCached(s.lat, s.lng),
      });
      prev = s.to;
      prevEndT = s.end;
    }
    if (prev < pts.length - 1) pushMove(prev, pts.length - 1, prevEndT);

    return out;
  }

  function routeSummary(segs) {
    const moves = segs.filter((s) => s.kind === 'move');
    const stays = segs.filter((s) => s.kind === 'stay');
    const meters = moves.reduce((a, s) => a + s.meters, 0);
    if (!segs.length) return null;
    const first = segs[0].start;
    const last = segs[segs.length - 1].end;
    return {
      meters,
      stays: stays.length,
      spanMs: Math.max(0, last - first),
      kmh: moves.length ? meters / 1000 / Math.max(0.01, (last - first) / 3600000) : 0,
    };
  }

  function clearRoute() {
    state.routeFor = null;
    state.routeModel = null;
    if (state.routeGroup) state.routeGroup.clearLayers();
    syncLiveRoutes();
  }

  /* ── 상세 동선 모델: 핀(출발·체류·현재)과 타임라인 줄을 함께 만든다 ── */
  function routeModel(pts) {
    const segs = buildSegments(pts);
    if (!segs.length) return null;

    const stays = segs.filter((s) => s.kind === 'stay');
    const moves = segs.filter((s) => s.kind === 'move');
    const meters = moves.reduce((a, s) => a + s.meters, 0);
    const startT = pts[0].t;
    const endT = pts[pts.length - 1].t;
    const spanMs = Math.max(1, endT - startT);
    const kmh = meters / 1000 / Math.max(0.01, spanMs / 3600000);

    const firstStay = stays[0] || null;
    const lastStay = stays[stays.length - 1] || null;
    const startIsStay = !!firstStay && firstStay.start <= startT + 2 * 60 * 1000;
    const endIsStay = !!lastStay && lastStay.end >= endT - 2 * 60 * 1000;

    const pins = [];
    stays.forEach((s, i) => {
      pins.push({
        key: 's' + i, kind: 'stay', num: i + 1, lat: s.lat, lng: s.lng,
        start: s.start, end: s.end, ms: s.ms,
        place: s.place || placeCached(s.lat, s.lng),
        first: i === 0 && startIsStay,
        last: i === stays.length - 1 && endIsStay,
      });
    });

    if (!startIsStay) {
      pins.push({ key: 'start', kind: 'start', num: 0, lat: pts[0].lat, lng: pts[0].lng, start: startT, end: startT, ms: 0, first: true, last: false });
    }
    if (!endIsStay) {
      const last = pts[pts.length - 1];
      pins.push({
        key: 'now', kind: 'now', num: 0, lat: last.lat, lng: last.lng, start: endT, end: endT, ms: 0, first: false, last: true,
        place: placeCached(last.lat, last.lng),
      });
    }

    const rows = segs.map((s, i) => {
      if (s.kind === 'stay') {
        const pin = pins.find((p) => p.kind === 'stay' && p.start === s.start);
        return { key: 'r' + i, kind: 'stay', seg: s, pinKey: pin ? pin.key : '', start: s.start, end: s.end, ms: s.ms, meters: 0, kmh: 0 };
      }
      return { key: 'r' + i, kind: 'move', seg: s, pinKey: '', start: s.start, end: s.end, ms: s.ms, meters: s.meters, kmh: s.kmh };
    });

    return { pts, segs, stays, moves, meters, spanMs, kmh, pins, rows, startT, endT, startIsStay, endIsStay };
  }

  function hhmm(t) {
    return clockOf(new Date(t).toISOString());
  }

  function pinByKey(key) {
    const model = state.routeModel;
    if (!model) return null;
    return model.pins.find((p) => p.key === key) || null;
  }

  function nextMoveAfter(seg, model) {
    const i = model.segs.indexOf(seg);
    for (let j = i + 1; j < model.segs.length; j++) {
      if (model.segs[j].kind === 'move') return model.segs[j];
    }
    return null;
  }

  /* ── 상세 동선: 선 · 방향 화살표 · 출발/체류/현재 핀 ── */
  function bearingDeg(a, b) {
    const la1 = a[0] * Math.PI / 180;
    const la2 = b[0] * Math.PI / 180;
    const dLo = (b[1] - a[1]) * Math.PI / 180;
    const y = Math.sin(dLo) * Math.cos(la2);
    const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLo);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  function arrowsAlong(coords) {
    const lens = [];
    let total = 0;
    for (let i = 1; i < coords.length; i++) {
      const d = haversine({ lat: coords[i - 1][0], lng: coords[i - 1][1] }, { lat: coords[i][0], lng: coords[i][1] });
      lens.push(d);
      total += d;
    }
    if (total < 45) return [];

    const count = Math.max(1, Math.min(7, Math.round(total / 800)));
    const step = total / (count + 1);
    const out = [];
    let acc = 0;
    let target = step;

    for (let i = 0; i < lens.length && out.length < count; i++) {
      const d = lens[i];
      while (target <= acc + d && out.length < count) {
        const f = d > 0 ? (target - acc) / d : 0;
        const a = coords[i];
        const b = coords[i + 1];
        out.push({
          lat: a[0] + (b[0] - a[0]) * f,
          lng: a[1] + (b[1] - a[1]) * f,
          deg: bearingDeg(a, b),
        });
        target += step;
      }
      acc += d;
    }
    return out;
  }

  function routePinIcon(pin, m, color) {
    let inner = '';
    const placeLine = pin.place
      ? '<span class="rv-pin-place">' + esc(placePinText(pin.place)) + '</span>'
      : '';
    if (pin.kind === 'stay') {
      inner = '<span class="rv-pin-num">' + pin.num + '</span>'
        + '<span class="rv-pin-txt">' + esc(durText(pin.ms)) + placeLine + '</span>';
      if (pin.first) inner += '<span class="rv-pin-tag">출발</span>';
      if (pin.last) inner += '<span class="rv-pin-tag rv-pin-tag--now">지금</span>';
    } else if (pin.kind === 'start') {
      inner = '<span class="rv-pin-dot"></span>'
        + '<span class="rv-pin-txt"><b>출발</b> ' + esc(hhmm(pin.start)) + '</span>';
    } else {
      const fresh = Date.now() - pin.start < 15 * 60 * 1000;
      inner = '<span class="rv-pin-dot"></span>'
        + '<span class="rv-pin-txt"><b>' + (fresh ? '현재' : '최근') + '</b> ' + esc(hhmm(pin.start)) + placeLine + '</span>';
    }

    const html = '<div class="rv-pin rv-pin--' + pin.kind + '" style="--c:' + esc(color) + '">' + inner + '</div>';
    return L.divIcon({ className: 'rv-pin-host', html, iconSize: [1, 1], iconAnchor: [0, 0] });
  }

  function popupRows(rows) {
    return '<dl>' + rows.map((r) =>
      '<div><dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd></div>'
    ).join('') + '</dl>';
  }

  function stayPopupHTML(pin, model) {
    const seg = model.segs.find((s) => s.kind === 'stay' && s.start === pin.start);
    const next = seg ? nextMoveAfter(seg, model) : null;
    const place = pin.place || (seg && seg.place) || null;
    const meta = placeMeta(place);
    const title = (place && place.name)
      ? meta.ico + ' ' + place.name
      : (pin.first ? '출발한 자리' : (pin.last ? '지금 머무는 곳' : '머문 곳 ' + pin.num));
    const rows = [];
    if (place) rows.push(['장소', placeLabel(place)]);
    rows.push(['머문 시간', durText(pin.ms)]);
    rows.push(['시각', hhmm(pin.start) + ' ~ ' + hhmm(pin.end)]);
    if (place && place.addr) rows.push(['주소', place.addr]);
    if (next) {
      rows.push(['다음 이동', distText(next.meters) + ' · ' + durText(next.ms) + (next.kmh >= MOVE_KMH ? ' · ' + Math.round(next.kmh) + 'km/h' : '')]);
    }
    return '<div class="rv-pop-k">' + esc(title) + '</div>'
      + '<div class="rv-pop-t">' + esc(hhmm(pin.start)) + ' ~ ' + esc(hhmm(pin.end)) + '</div>'
      + popupRows(rows)
      + '<p class="rv-pop-note">5분 이상 머문 곳만 체류로 잡아요.</p>';
  }

  function edgePopupHTML(pin, model, m) {
    const isStart = pin.kind === 'start';
    const seg = model.segs[0];
    const rows = [['시각', hhmm(pin.start)]];
    if (isStart && seg && seg.kind === 'move') {
      rows.push(['첫 이동', distText(seg.meters) + ' · ' + durText(seg.ms) + (seg.kmh >= MOVE_KMH ? ' · ' + Math.round(seg.kmh) + 'km/h' : '')]);
    }
    if (!isStart) {
      const acc = m.accuracy != null && isFinite(m.accuracy) ? '±' + Math.round(m.accuracy) + 'm' : null;
      rows.push(['최근 갱신', m.updated_at ? timeAgo(m.updated_at) + ' · ' + clockOf(m.updated_at) : '—']);
      if (acc) rows.push(['위치 정확도', acc]);
    }
    const place = !isStart ? pin.place : null;
    if (place) rows.splice(0, 0, ['장소', placeLabel(place)]);
    return '<div class="rv-pop-k">' + (isStart ? '출발 지점' : '최근 · 현재 위치') + '</div>'
      + '<div class="rv-pop-t">' + esc(hhmm(pin.start)) + '</div>'
      + popupRows(rows)
      + '<p class="rv-pop-note">' + (isStart ? '이 자리에서 이동 기록이 시작됐어요.' : '지도 위 마지막으로 기록된 자리예요.') + '</p>';
  }

  function movePopupHTML(seg) {
    const kind = moveKind(seg.kmh);
    return '<div class="rv-pop-k">이동 구간</div>'
      + '<div class="rv-pop-t">' + esc(distText(seg.meters)) + ' · ' + esc(durText(seg.ms)) + '</div>'
      + popupRows([
        ['시각', hhmm(seg.start) + ' ~ ' + hhmm(seg.end)],
        ['평균 속도', (kind ? kind.ico + ' ' : '') + Math.max(1, Math.round(seg.kmh)) + 'km/h' + (kind ? ' · ' + kind.label : '')],
      ]);
  }

  function popupOpts() {
    return { className: 'rv-pop', maxWidth: 268, autoPanPaddingTopLeft: [24, 104], autoPanPaddingBottomRight: [24, 110] };
  }

  function routeFitPadding() {
    const size = state.map ? state.map.getSize() : { x: 360, y: 640 };
    const top = 104;
    let bottom = 92;
    if (state.routeTlOpen && el.rvTimeline && !el.rvTimeline.hidden) {
      bottom = el.rvTimeline.getBoundingClientRect().height + 36;
    }
    return {
      paddingTopLeft: [34, top],
      paddingBottomRight: [34, Math.min(bottom, Math.max(70, size.y - top - 90))],
    };
  }

  function fitRoute(model) {
    if (!state.map || !model || !model.pts.length) return;
    state.map.fitBounds(L.latLngBounds(model.pts.map((p) => [p.lat, p.lng])), Object.assign({
      maxZoom: 16, animate: true, duration: 0.45,
    }, routeFitPadding()));
  }

  function focusLatLng(lat, lng, zoom) {
    if (!state.map) return;
    const z = Math.max(state.map.getZoom(), zoom || 15);
    const p = state.map.project([lat, lng], z);
    const top = 110;
    const bottom = (state.routeTlOpen && el.rvTimeline && !el.rvTimeline.hidden)
      ? el.rvTimeline.getBoundingClientRect().height + 30 : 86;
    const dy = Math.max(0, (bottom - top) / 2);
    const center = state.map.unproject(p.add([0, dy]), z);
    state.map.flyTo(center, z, { duration: 0.5 });
  }

  function drawRouteDetail(m, opts = {}) {
    if (!state.map || !m) return null;
    const pts = historyFor(m.user_id);
    const model = routeModel(pts);
    if (state.routeGroup) state.routeGroup.clearLayers();
    if (!model) { state.routeModel = null; return null; }

    const color = m.color || colorFor(m.user_id);
    const coords = pts.map((p) => [p.lat, p.lng]);

    if (coords.length > 1) {
      state.routeCasing = L.polyline(coords, {
        color: MAP_STYLES[state.mapStyle].dark ? '#0b1220' : '#ffffff',
        weight: 9, opacity: 0.9, lineJoin: 'round', lineCap: 'round', interactive: false,
      }).addTo(state.routeGroup);
      L.polyline(coords, {
        color, weight: 5, opacity: 0.96, lineJoin: 'round', lineCap: 'round', interactive: false,
      }).addTo(state.routeGroup);
    }

    arrowsAlong(coords).forEach((a) => {
      L.marker([a.lat, a.lng], {
        icon: L.divIcon({
          className: 'rv-arrow-host',
          html: '<div class="rv-arrow" style="--a:' + (a.deg - 90).toFixed(1) + 'deg;--c:' + esc(color) + '">'
            + '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4.5 17 12l-9 7.5" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>',
          iconSize: [1, 1], iconAnchor: [0, 0],
        }),
        keyboard: false, interactive: false, zIndexOffset: 200,
      }).addTo(state.routeGroup);
    });

    model.pins.forEach((pin) => {
      const marker = L.marker([pin.lat, pin.lng], {
        icon: routePinIcon(pin, m, color),
        keyboard: false,
        riseOnHover: true,
        zIndexOffset: pin.kind === 'now' ? 700 : (pin.kind === 'start' ? 500 : 400),
      });
      marker.bindPopup(pin.kind === 'stay' ? stayPopupHTML(pin, model) : edgePopupHTML(pin, model, m), popupOpts());
      marker.addTo(state.routeGroup);
      pin.marker = marker;
    });

    state.routeModel = model;
    warmStayPlaces(model, m, color);
    if (opts.fit !== false) fitRoute(model);
    return model;
  }

  /* 체류 핀마다 장소·업종을 조회해 핀 라벨·팝업·타임라인을 채운다(캐시 우선). */
  function warmStayPlaces(model, m, color) {
    if (!model) return;
    let asked = 0;
    model.pins.forEach((pin) => {
      if (pin.kind !== 'stay' && pin.kind !== 'now') return;
      if (pin.place || asked >= PLACE_MAX_PER_VIEW) return;
      asked++;
      placeSoon(pin.lat, pin.lng, (place) => {
        if (!place || !place.ok) return;
        if (state.routeModel !== model) return;
        pin.place = place;
        const seg = model.segs.find((s) => s.kind === 'stay' && s.start === pin.start);
        if (seg) seg.place = place;
        if (pin.marker) {
          try {
            pin.marker.setIcon(routePinIcon(pin, m, color));
            pin.marker.setPopupContent(pin.kind === 'stay' ? stayPopupHTML(pin, model) : edgePopupHTML(pin, model, m));
          } catch (e) {}
        }
        renderRouteTimeline(model);
      });
    });
  }

  function routeSigOf(m) {
    const pts = historyFor(m.user_id);
    const last = pts[pts.length - 1];
    // 기록(점)이 늘었을 때만 다시 그린다 — 열어 둔 핀 팝업이 갱신마다 닫히지 않도록
    return [pts.length, last ? last.t : 0].join('|');
  }

  function renderRouteBar(m, model) {
    if (!el.rvWho) return;
    el.rvWho.textContent = m.nickname + ' 님의 이동 동선';
    const bits = [model.pins.length + '개 지점'];
    if (model.stays.length) bits.push('머문 곳 ' + model.stays.length + '곳');
    bits.push('총 ' + distText(model.meters), durText(model.spanMs));
    el.rvMeta.textContent = bits.join(' · ');
    el.rvTlCount.textContent = model.rows.length + '개 구간';
  }

  function routeRowHTML(row, model, color) {
    const t = hhmm(row.start) + ' ~ ' + hhmm(row.end);
    if (row.kind === 'stay') {
      const pin = model.pins.find((p) => p.key === row.pinKey);
      const place = (pin && pin.place) || (row.seg && row.seg.place) || null;
      const meta = placeMeta(place);
      const title = place
        ? meta.ico + ' ' + (place.name ? place.name + ' · ' + meta.label : meta.label)
        : '머문 곳' + (pin ? ' ' + pin.num : '');
      return '<li><button type="button" class="rv-row rv-row--stay" data-row="' + esc(row.key) + '">'
        + '<span class="rv-row-num" style="--c:' + esc(color) + '">' + (pin ? pin.num : '·') + '</span>'
        + '<span class="rv-row-body"><b>' + esc(title) + '</b><span>' + esc(t) + ' · ' + esc(durText(row.ms)) + ' 머묾</span></span>'
        + '<span class="rv-row-go">핀</span></button></li>';
    }
    const kind = moveKind(row.kmh);
    return '<li><button type="button" class="rv-row rv-row--move" data-row="' + esc(row.key) + '">'
      + '<span class="rv-row-ico">' + (kind ? kind.ico : '🚶') + '</span>'
      + '<span class="rv-row-body"><b>이동 ' + esc(distText(row.meters)) + '</b><span>' + esc(t) + ' · ' + esc(durText(row.ms)) + ' · ' + Math.max(1, Math.round(row.kmh)) + 'km/h</span></span>'
      + '<span class="rv-row-go">구간</span></button></li>';
  }

  function renderRouteTimeline(model) {
    if (!el.rvTlList || !model) return;
    const m = state.routeView ? personById(state.routeView) : null;
    const color = m ? (m.color || colorFor(m.user_id)) : '#0fb9a3';
    el.rvTlList.innerHTML = model.rows.map((r) => routeRowHTML(r, model, color)).join('')
      || '<li class="rv-empty">아직 나눌 구간이 없어요.</li>';
    el.rvTlCount.textContent = model.rows.length + '개 구간';
  }

  function renderRouteBlock(m) {
    const pts = historyFor(m.user_id);
    const model = pts.length >= 2 ? routeModel(pts) : null;

    if (!model) {
      el.mRouteSum.textContent = pts.length
        ? '이동 기록이 아직 짧아요 — 위치가 두 번 이상 갱신되면 동선이 그려져요.'
        : '아직 이동 기록이 없어요 — 위치가 갱신되면 자동으로 쌓여요.';
      el.mRouteHint.textContent = '';
      el.mRouteOpen.disabled = true;
      return;
    }

    el.mRouteSum.textContent = '최근 ' + durText(model.spanMs) + ' · ' + model.pins.length + '개 지점 · 총 ' + distText(model.meters)
      + (model.stays.length ? ' · 머문 곳 ' + model.stays.length + '곳' : '');
    el.mRouteHint.textContent = hhmm(model.startT) + '~' + hhmm(model.endT);
    el.mRouteOpen.disabled = false;
  }

  function closeRouteView() {
    if (!state.routeView) return;
    state.routeView = null;
    state.routeFor = null;
    state.routeModel = null;
    state.routeSig = '';
    state.routeTlOpen = false;
    el.routeView.hidden = true;
    el.rvTimeline.hidden = true;
    el.app.classList.remove('is-route');
    if (state.routeGroup) state.routeGroup.clearLayers();
    if (state.map) {
      try { state.map.closePopup(); } catch (e) {}
    }
    renderPins();
    syncLiveRoutes();
  }

  function openRouteView(id) {
    const m = personById(id);
    if (!m || !state.map) return;
    const pts = historyFor(m.user_id);
    const model = pts.length >= 2 ? routeModel(pts) : null;
    if (!model) {
      toast('아직 이동 기록이 짧아 동선을 그릴 수 없어요', 2600);
      return;
    }

    if (!el.memberModal.hidden) {
      el.memberModal.hidden = true;
      modalUser = null;
      state.selected = null;
    }

    state.routeView = m.user_id;
    state.routeFor = m.user_id;
    state.routeSig = '';
    state.routeTlOpen = false;
    el.routeView.hidden = false;
    el.app.classList.add('is-route');
    el.rvTimeline.hidden = true;
    el.rvTlToggle.classList.remove('is-on');
    el.rvTlToggle.setAttribute('aria-expanded', 'false');

    renderRouteBar(m, model);
    renderRouteTimeline(model);
    dropLiveRoute(m.user_id);
    renderPins();
    syncLiveRoutes();

    setTimeout(() => {
      if (state.routeView !== m.user_id) return;
      state.map.invalidateSize();
      const drawn = drawRouteDetail(m, { fit: true });
      if (drawn) {
        renderRouteBar(m, drawn);
        renderRouteTimeline(drawn);
        state.routeSig = routeSigOf(m);
      }
    }, 70);
  }

  function setRouteTimeline(open) {
    state.routeTlOpen = !!open;
    el.rvTimeline.hidden = !state.routeTlOpen;
    el.rvTlToggle.classList.toggle('is-on', state.routeTlOpen);
    el.rvTlToggle.setAttribute('aria-expanded', String(state.routeTlOpen));
    if (state.routeModel) {
      setTimeout(() => { if (state.routeView) fitRoute(state.routeModel); }, 40);
    }
  }

  function focusRouteRow(key) {
    const model = state.routeModel;
    if (!model || !state.map) return;
    const row = model.rows.find((r) => r.key === key);
    if (!row) return;

    $$('.rv-row', el.rvTlList).forEach((b) => b.classList.toggle('is-active', b.getAttribute('data-row') === key));

    if (row.kind === 'stay') {
      const pin = pinByKey(row.pinKey);
      if (!pin) return;
      focusLatLng(pin.lat, pin.lng, 15.5);
      if (pin.marker) setTimeout(() => { try { pin.marker.openPopup(); } catch (e) {} }, 320);
      return;
    }

    const s = row.seg;
    const bounds = L.latLngBounds([[s.from.lat, s.from.lng], [s.to.lat, s.to.lng]]);
    state.map.flyToBounds(bounds, Object.assign({ maxZoom: 16, animate: true, duration: 0.5 }, routeFitPadding()));
    const mid = [(s.from.lat + s.to.lat) / 2, (s.from.lng + s.to.lng) / 2];
    setTimeout(() => {
      if (!state.routeView) return;
      L.popup(popupOpts()).setLatLng(mid).setContent(movePopupHTML(s)).openOn(state.map);
    }, 320);
  }

  function refreshRouteView() {
    if (!state.routeView || !state.map) return;
    const m = personById(state.routeView);
    if (!m) { closeRouteView(); return; }
    const sig = routeSigOf(m);
    if (sig === state.routeSig) return;
    state.routeSig = sig;

    const model = drawRouteDetail(m, { fit: false });
    if (!model) { closeRouteView(); toast('동선 기록이 사라졌어요', 2400); return; }
    renderRouteBar(m, model);
    const scroll = el.rvTlList ? el.rvTlList.scrollTop : 0;
    renderRouteTimeline(model);
    if (el.rvTlList) el.rvTlList.scrollTop = scroll;
  }

  const LIVE_TRAIL_MS = 30 * 60 * 1000;

  function dropLiveRoute(id) {
    const line = state.liveRoutes.get(id);
    if (!line) return;
    try { line.remove(); } catch (e) {}
    state.liveRoutes.delete(id);
  }

  function syncLiveRoutes() {
    if (!state.map) return;
    const keep = new Set();

    for (const m of visiblePeople()) {
      if (m.user_id === state.routeFor) continue;

      const pts = historyFor(m.user_id).filter((p) => p.t > Date.now() - LIVE_TRAIL_MS);
      if (pts.length < 2) continue;

      const moving = m.speed_kmh != null && isFinite(m.speed_kmh) && m.speed_kmh >= MOVE_KMH;
      const hadTrail = state.liveRoutes.has(m.user_id);
      const lastT = pts[pts.length - 1].t;
      const recent = lastT && Date.now() - lastT < 3 * 60 * 1000;
      if (!moving && !(hadTrail && recent)) continue;

      keep.add(m.user_id);
      const coords = pts.map((p) => [p.lat, p.lng]);
      const color = m.color || colorFor(m.user_id);

      let line = state.liveRoutes.get(m.user_id);
      if (!line) {
        line = L.polyline(coords, {
          color, weight: 3.5, opacity: 0.85,
          lineJoin: 'round', lineCap: 'round', interactive: false,
        }).addTo(state.map);
        state.liveRoutes.set(m.user_id, line);
      } else {
        line.setStyle({ color });
        line.setLatLngs(coords);
      }
    }

    for (const [id, line] of Array.from(state.liveRoutes.entries())) {
      if (keep.has(id)) continue;
      try { line.remove(); } catch (e) {}
      state.liveRoutes.delete(id);
    }
  }

  /* ───────────────────────── 11. 상세 모달 ───────────────────────── */
  let modalUser = null;

  function modalRow(key, label, value) {
    return '<div class="row" data-row="' + esc(key) + '"><dt>' + esc(label) + '</dt><dd>' + value + '</dd></div>';
  }

  function speedLong(m) {
    if (m.speed_kmh == null || !isFinite(m.speed_kmh)) return '측정 중';
    const k = moveKind(m.speed_kmh);
    if (!k) return '정지 중';
    return k.ico + ' ' + Math.max(1, Math.round(m.speed_kmh)) + 'km/h · ' + k.label;
  }

  function stayLong(m) {
    const since = staySinceOf(m);
    if (!since) return '<span class="muted">이동 중</span>';
    return esc(stayPhrase(since)) + ' <span class="sub">· ' + esc(clockOf(since)) + '부터</span>';
  }

  function batteryLongRow(m, isMe) {
    if (m.battery != null && isFinite(m.battery)) {
      const manual = isMe && state.battMode === 'manual';
      return esc(batteryLong(m)) + (manual ? ' <span class="sub">· 직접 입력</span>' : '');
    }
    if (isMe && !BATT_API) return '<span class="muted">미지원 (iOS 웹)</span>';
    if (isMe && state.battMode === 'off') return '<span class="muted">표시 안 함</span>';
    return '<span class="muted">측정 불가</span>';
  }

  function renderRows(m, isMe) {
    const rows = [];
    rows.push(modalRow('speed', '이동 속도', esc(speedLong(m))));
    rows.push(modalRow('stay', '체류', stayLong(m)));
    rows.push(modalRow('battery', '배터리', batteryLongRow(m, isMe)));
    rows.push(modalRow('updated', '최근 업데이트', esc(m.updated_at ? timeAgo(m.updated_at) + ' · ' + clockOf(m.updated_at) : '아직 없음')));
    rows.push(modalRow('acc', '위치 정확도', esc(m.accuracy != null && isFinite(m.accuracy) ? '±' + Math.round(m.accuracy) + 'm' : '—')));
    el.mRows.innerHTML = rows.join('');
  }

  function refreshModalLive() {
    if (!modalUser || el.memberModal.hidden) return;
    const m = personById(modalUser);
    if (!m) return;
    const isMe = !!state.me && m.user_id === state.me.user_id;
    el.mChat.setAttribute('data-unread', String(isMe ? 0 : Number(m.unread || 0)));
    const set = (key, html) => {
      const dd = el.mRows.querySelector('[data-row="' + key + '"] dd');
      if (dd) dd.innerHTML = html;
    };
    set('updated', esc(m.updated_at ? timeAgo(m.updated_at) + ' · ' + clockOf(m.updated_at) : '아직 없음'));
    set('speed', esc(speedLong(m)));
    set('stay', stayLong(m));
    set('battery', batteryLongRow(m, isMe));
  }

  async function openMember(id) {
    const m = personById(id);
    if (!m) return;
    const isMe = m.user_id === state.me.user_id;
    modalUser = m.user_id;
    state.selected = id;
    renderPins();

    paintAvatar(el.mAvatar, m, initialOf(m.nickname));
    el.mName.textContent = m.nickname + (isMe ? ' (나)' : '');
    el.mStatus.textContent = (m.emoji || '🙂') + ' ' + (m.status_text || (autoStatusOf(m) ? autoStatusOf(m).label : '상태 없음'));

    renderRows(m, isMe);
    renderPokeBlock(m, isMe);
    renderMuteRow(m, false);

    el.mChat.setAttribute('data-unread', String(isMe ? 0 : Number(m.unread || 0)));
    el.mCard.classList.toggle('is-me', isMe);
    el.mEdit.hidden = !isMe;
    renderAcct(isMe);
    el.mSave.hidden = !isMe;
    el.mChat.hidden = isMe;
    el.mLocate.hidden = isMe || m.lat == null;
    el.mRemove.hidden = isMe;
    renderBatteryBox(isMe);

    const actions = el.mCard.querySelector('.modal-actions');
    if (actions) {
      el.mCard.insertBefore(el.mRouteBlock, isMe ? actions : el.mRows);
    }

    if (isMe) {
      state.selectedEmoji = state.me.emoji || '🙂';
      el.mNickInput.value = state.me.nickname || '';
      el.mStatusInput.value = state.me.status_text || '';
      el.mEmojis.innerHTML = EMOJIS.map((e) =>
        '<button class="emoji-btn' + ((state.me.emoji || '🙂') === e ? ' is-on' : '') + '" type="button" data-emoji="' + esc(e) + '">' + e + '</button>'
      ).join('');
      paintAvatar(el.mPhotoPreview, state.me, initialOf(state.me.nickname));
      refreshNotifState();
    }

    el.memberModal.hidden = false;
    focusPersonOnMap(m);

    await ensureHistory(m);
    const fresh = personById(id) || m;
    renderRows(fresh, isMe);
    renderRouteBlock(fresh);
    clearRoute();
  }

  function closeModal() {
    el.memberModal.hidden = true;
    modalUser = null;
    state.selected = null;
    clearRoute();
    renderPins();
  }

  function renderPokeBlock(m, isMe) {
    if (!el.mPokeBlock || !el.mPokeBtns) return;
    el.mPokeBlock.hidden = !!isMe;
    if (isMe) { el.mPokeBtns.innerHTML = ''; return; }
    el.mPokeBtns.innerHTML = POKE_EMOJIS.map((e) =>
      '<button class="poke-btn" type="button" data-poke="' + esc(e) + '" aria-label="' + esc(e) + ' 콕 보내기">' + e + '</button>'
    ).join('');
  }

  function renderMuteRow(m, isMe) {
    if (!el.mMuteRow || !el.mMute) return;
    el.mMuteRow.hidden = !m || !!isMe;
    if (!m || isMe) return;
    const muted = isMuted(m.user_id);
    el.mMute.textContent = muted ? '🔕 알림 끔' : '🔔 알림 켜짐';
    el.mMute.classList.toggle('is-muted', muted);
    el.mMute.setAttribute('aria-pressed', String(muted));
  }

  function renderBatteryBox(isMe) {
    const show = isMe && !BATT_API;
    el.mBatt.hidden = !show;
    if (!show) return;
    $$('#mBattModes [data-mode]').forEach((b) => {
      b.classList.toggle('is-on', b.getAttribute('data-mode') === state.battMode);
    });
    el.mBattManual.hidden = state.battMode !== 'manual';
    el.mBattRange.value = String(state.battManual.level);
    el.mBattRange.style.setProperty('--p', state.battManual.level + '%');
    el.mBattVal.textContent = state.battManual.level + '%';
    el.mBattCharging.checked = !!state.battManual.charging;
  }

  /* ───────────────────────── 12. 채팅 ───────────────────────── */
  function openChat(friendId) {
    if (isGroupChat(friendId)) { openGroupChat(friendId); return; }
    const f = state.friends.get(friendId);
    if (!f) { toast('친구 목록에 없는 사람이에요', 2200); return; }
    state.chatWith = friendId;
    state.selected = friendId;
    el.chatPanel.hidden = false;
    paintAvatar(el.chatAvatar, f, initialOf(f.nickname));
    el.chatName.textContent = f.nickname;
    renderChatSub();
    renderChatMessages();
    el.chatBody.scrollTop = el.chatBody.scrollHeight;
    loadMessages(friendId, { full: true }).then(() => {
      markRead(friendId);
      el.chatInput.focus();
      el.chatBody.scrollTop = el.chatBody.scrollHeight;
    });
  }

  function renderChatSub() {
    if (isGroupChat(state.chatWith)) {
      const g = state.groups.get(state.chatWith);
      if (g) el.chatSub.textContent = '그룹 · ' + (g.member_count || (g.members || []).length) + '명';
      return;
    }
    const f = state.chatWith ? state.friends.get(state.chatWith) : null;
    if (!f) return;
    const bits = [];
    const auto = autoStatusOf(f);
    if (f.status_text) bits.push(f.status_text);
    else if (auto) bits.push(auto.label);
    if (f.lat != null) {
      const since = staySinceOf(f);
      if (since) bits.push(stayChip(since) + ' 머무는 중');
      else if (f.updated_at) bits.push(timeAgo(f.updated_at) + ' 위치');
      else bits.push('위치 공유 중');
    } else {
      bits.push('위치 없음');
    }
    el.chatSub.textContent = bits.join(' · ');
  }

  function closeChat() {
    state.chatWith = null;
    el.chatPanel.hidden = true;
    renderAll();
  }

  function renderChatMessages() {
    if (!el.chatBody) return;
    const id = state.chatWith;
    if (!id) { el.chatBody.innerHTML = ''; return; }
    const list = state.messages.get(id) || [];

    if (!list.length) {
      setHTML(el.chatBody, '<div class="chat-empty">첫 메시지를 보내 보세요.<br>이 대화는 친구끼리만 보여요.</div>', 'chat');
      return;
    }

    let html = '';
    let lastDay = '';
    list.forEach((msg) => {
      const day = dayLabel(msg.created_at);
      if (day && day !== lastDay) {
        html += '<div class="day-sep">' + esc(day) + '</div>';
        lastDay = day;
      }
      const mine = state.me && msg.sender_id === state.me.user_id;
      const group = isGroupChat(id);
      // 카톡식 안 읽은 숫자 — 내 말풍선 왼쪽에 노란 숫자
      //  · 그룹: 아직 안 읽은 멤버 수(3 → 2 → 1 → 사라짐)
      //  · 1:1 : 상대가 읽기 전에는 1, 읽으면 바로 사라짐
      const left = !mine ? 0 : (group ? Number(msg.unread || 0) : (msg.read_at ? 0 : 1));
      const count = left > 0
        ? '<span class="msg-unread" aria-label="' + (group ? '안 읽은 ' + left + '명' : '상대가 아직 읽지 않았어요') + '">' + left + '</span>'
        : '';
      html += '<div class="msg' + (mine ? ' msg--me' : '') + (group && !mine ? ' msg--group' : '') + '" data-msg="' + esc(msg.id) + '">'
        + (group && !mine ? '<span class="msg-who">' + esc(nickOf(msg.sender_id)) + '</span>' : '')
        + '<span class="msg-line">' + count + '<span class="msg-bubble">' + esc(msg.body) + '</span></span>'
        + '<span class="msg-time">' + esc(msgTime(msg.created_at)) + (mine && msg.read_at ? ' · 읽음' : '') + '</span>'
        + '</div>';
    });
    setHTML(el.chatBody, html, 'chat');
  }

  async function loadMessages(friendId, opts = {}) {
    if (!state.me) return [];
    const group = isGroupChat(friendId);
    try {
      const args = group
        ? Object.assign(selfArgs(), { p_group: friendId })
        : Object.assign(selfArgs(), { p_friend: friendId });
      if (!opts.full) {
        const list = state.messages.get(friendId) || [];
        const last = list[list.length - 1];
        if (last && last.created_at) args.p_since = last.created_at;
      }
      const rows = await API.rpc(group ? 'group_messages' : 'friend_messages', args);
      const incoming = Array.isArray(rows) ? rows : [];
      const prev = opts.full ? [] : (state.messages.get(friendId) || []);
      const byId = new Map(prev.map((m) => [String(m.id), m]));
      incoming.forEach((m) => { byId.set(String(m.id), m); });
      const merged = Array.from(byId.values()).sort((a, b) => {
        const at = new Date(a.created_at).getTime();
        const bt = new Date(b.created_at).getTime();
        if (at !== bt) return at - bt;
        return Number(a.id) - Number(b.id);
      });
      state.messages.set(friendId, merged);

      if (state.chatWith === friendId && !el.chatPanel.hidden) {
        const nearBottom = el.chatBody.scrollHeight - el.chatBody.scrollTop - el.chatBody.clientHeight < 90;
        renderChatMessages();
        if (nearBottom || opts.full) el.chatBody.scrollTop = el.chatBody.scrollHeight;
      }
      return merged;
    } catch (e) {
      if (!/not_friends/.test(String(e.detail || e.message))) {
        console.warn('[우리끼리] messages', e);
      }
      return [];
    }
  }

  function markMyReadIfChatting() {
    if (!state.chatWith) return;
    const f = state.friends.get(state.chatWith);
    if (f && f.unread) markRead(state.chatWith);
  }

  async function markRead(friendId) {
    if (!state.me || !friendId) return;
    const f = state.friends.get(friendId);
    if (f) f.unread = 0;
    updateChrome();
    if (state.readSending[friendId]) return;
    state.readSending[friendId] = true;
    try {
      await API.rpc('friend_mark_read', Object.assign(selfArgs(), { p_friend: friendId }));
      // 상대 화면의 노란 '1'도 바로 사라지도록 알린다
      rt.send(pairTopic(friendId), 'read', { from: state.me.user_id });
    } catch (e) { /* 다음 피드에서 다시 시도 */ }
    setTimeout(() => { state.readSending[friendId] = false; }, 1200);
  }

  async function sendMessage() {
    const friendId = state.chatWith;
    if (!friendId || !state.me) return;
    const body = String(el.chatInput.value || '').trim();
    if (!body) return;
    el.chatInput.value = '';
    el.btnChatSend.classList.add('is-busy');
    const group = isGroupChat(friendId);
    try {
      if (group) {
        await API.rpc('group_send_message', Object.assign(selfArgs(), { p_group: friendId, p_body: body }));
        await loadMessages(friendId, { full: false });
        const g = state.groups.get(friendId);
        if (g) g.last_message = { body, sender_id: state.me.user_id, created_at: new Date().toISOString() };
        rt.send('grp-' + friendId, 'chat', { from: state.me.user_id, group: friendId });
        renderConvos();
        el.chatBody.scrollTop = el.chatBody.scrollHeight;
        return;
      }
      await API.rpc('friend_send_message', Object.assign(selfArgs(), { p_to: friendId, p_body: body }));
      await loadMessages(friendId, { full: false });
      const f = state.friends.get(friendId);
      if (f) {
        f.last_message = body;
        f.last_message_at = new Date().toISOString();
        f.last_from_me = true;
      }
      renderConvos();
      el.chatBody.scrollTop = el.chatBody.scrollHeight;
      rt.send(pairTopic(friendId), 'msg', { from: state.me.user_id });
    } catch (e) {
      toast('메시지를 보내지 못했어요 — ' + errText(e), 3600);
      if (!el.chatInput.value) el.chatInput.value = body;
    } finally {
      el.btnChatSend.classList.remove('is-busy');
    }
  }

  /* ───────────────────────── 12-B. 그룹 (친구 추가 없이 위치·채팅) ───────────────────────── */
  function normalizeGroupMember(mb, group) {
    return {
      user_id: String(mb.user_id),
      nickname: String(mb.nickname || '친구').slice(0, 20),
      emoji: mb.emoji || '🙂',
      status_text: mb.status_text || '',
      color: mb.color || colorFor(mb.user_id),
      avatar_url: mb.avatar_url || '',
      hidden: !!mb.hidden,
      lat: mb.lat == null ? null : Number(mb.lat),
      lng: mb.lng == null ? null : Number(mb.lng),
      accuracy: mb.accuracy == null ? null : Number(mb.accuracy),
      battery: mb.battery == null ? null : Number(mb.battery),
      charging: !!mb.charging,
      speed_kmh: mb.speed_kmh == null ? null : Number(mb.speed_kmh),
      stay_since: mb.stay_since || null,
      updated_at: mb.updated_at || null,
      unread: 0,
      isFriend: !!mb.is_friend,
      groupId: group.id,
      groupName: group.name,
      viaGroup: true,
    };
  }

  async function refreshGroups() {
    if (!state.me || !READY || !state.joined) return;
    try {
      const prev = groupSnapshot();
      const rows = await API.rpc('group_feed', selfArgs());
      const list = Array.isArray(rows) ? rows : [];
      const groups = new Map();
      const people = new Map();
      list.forEach((g) => {
        groups.set(g.id, g);
        (g.members || []).forEach((mb) => {
          if (mb.user_id === state.me.user_id) return;
          if (state.friends.has(mb.user_id)) return;   // 친구는 친구 정보를 그대로
          const next = normalizeGroupMember(mb, g);
          const kept = people.get(mb.user_id);
          // 여러 그룹에 있으면 한 곳이라도 공개한 그룹의 위치를 쓴다
          if (!kept || !next.hidden) people.set(mb.user_id, next);
        });
      });
      state.groups = groups;
      if (!state.viewGroup || !groups.has(state.viewGroup)) {
        state.viewGroup = groups.size ? groups.keys().next().value : null;
      }
      state.groupPeople = people;
      checkNearby();
      checkGroupNotices(prev);
      renderGroups();
      renderList();
      renderPins();
      renderConvos();
      syncLiveRoutes();
      syncRealtime();
    } catch (e) {
      console.warn('[우리끼리] groups', e);
    }
  }

  function groupMemberChip(p) {
    const off = isStale(p);
    const hidden = !!p.hidden;
    const since = p.stay_since || (p.lat != null ? staySinceOf(p) : null);
    const auto = hidden ? null : autoStatusOf(p);
    const stay = hidden
      ? '<em class="is-hidden">위치 숨김 중</em>'
      : (auto ? '<em>' + esc(auto.ico + ' ' + auto.text.split(' · ')[0]) + '</em>'
        : (since ? '<em>⏱ ' + esc(stayChip(since)) + '</em>' : ''));
    return '<button type="button" class="gc-mem' + (off ? ' is-off' : '') + (hidden ? ' is-hidden' : '') + '" data-gmem="' + esc(p.user_id) + '">'
      + '<i class="' + (hasPhoto(p) ? 'has-photo' : '') + onlineCls(p) + '" style="' + avatarStyleOf(p) + '">' + esc(p.emoji || initialOf(p.nickname))
      + (isOnline(p) ? '<span class="on-dot"></span>' : '') + '</i>' + esc(p.nickname)
      + stay
      + '</button>';
  }

  function renderGroups() {
    if (!el.groupList) return;
    const groups = Array.from(state.groups.values());
    if (el.groupCount) el.groupCount.textContent = String(groups.length);
    if (!groups.length) {
      setHTML(el.groupList, '<div class="group-empty">아직 그룹이 없어요.<br>'
        + '그룹을 만들고 초대 코드를 보내면<br>친구 추가 없이도 서로의 위치가 보여요.</div>', 'groups');
      return;
    }
    const html = groups.map((g) => {
      const meMb = (g.members || []).find((mb) => mb.user_id === state.me.user_id);
      const hidden = !!(meMb && meMb.hidden);
      const gunread = Number(g.unread || 0);
      const gmuted = isMuted(g.id);
      const chips = (g.members || [])
        .filter((mb) => mb.user_id !== state.me.user_id)
        .map((mb) => groupMemberChip(Object.assign(
          {},
          state.friends.get(mb.user_id) || state.groupPeople.get(mb.user_id) || normalizeGroupMember(mb, g),
          { hidden: !!mb.hidden, groupId: g.id, groupName: g.name }
        )))
        .join('');
      return '<div class="group-card' + (state.mapScope === 'groups' && state.viewGroup === g.id ? ' is-on' : '') + '" data-group="' + esc(g.id) + '">'
        + '<div class="gc-head"><span class="gc-name">' + esc(g.name) + '</span>'
        + (state.mapScope === 'groups' && state.viewGroup === g.id ? '<span class="gc-scope">지도 표시 중</span>' : '')
        + (gunread ? '<span class="gc-unread">' + (gunread > 9 ? '9+' : gunread) + '</span>' : '')
        + '<span class="gc-count">' + (g.member_count || (g.members || []).length) + '명</span></div>'
        + '<div class="gc-code"><span>초대 코드</span><b>' + esc(g.invite_code) + '</b>'
        + '<button type="button" class="gc-mini" data-gcopy="' + esc(g.invite_code) + '">코드 복사</button>'
        + '<button type="button" class="gc-mini" data-glink="' + esc(g.invite_code) + '">링크 복사</button></div>'
        + '<div class="gc-members">' + (chips || '<span class="gc-nobody">아직 나뿐이에요 — 초대 코드를 보내 보세요.</span>') + '</div>'
        + '<div class="gc-hide"><span>내 위치</span>'
        + '<button type="button" class="gc-switch' + (hidden ? ' is-off' : '') + '" data-ghide="' + esc(g.id) + '" aria-pressed="' + String(!hidden) + '">'
        + (hidden ? '숨김' : '공개') + '</button>'
        + '<span>' + (hidden ? '이 그룹에는 내 위치·동선이 보이지 않아요' : '이 그룹에 내 위치·동선을 공유해요') + '</span></div>'
        + '<div class="gc-acts">'
        + '<button type="button" class="btn btn--primary" data-gchat="' + esc(g.id) + '">단체 채팅</button>'
        + '<button type="button" class="btn btn--ghost gc-mute" data-gmute="' + esc(g.id) + '" title="그룹 알림" aria-pressed="' + String(gmuted) + '">' + (gmuted ? '🔕' : '🔔') + '</button>'
        + '<button type="button" class="btn btn--ghost" data-gleave="' + esc(g.id) + '">나가기</button>'
        + '</div></div>';
    }).join('');
    setHTML(el.groupList, html, 'groups');
  }

  function focusGroup(g) {
    if (!state.map || !g) { renderGroups(); return; }
    const pts = (g.members || []).filter((m) => m.lat != null && m.lng != null);
    if (!pts.length) { renderGroups(); return; }
    const bounds = L.latLngBounds(pts.map((m) => [m.lat, m.lng]));
    if (pts.length === 1 || bounds.getNorthEast().equals(bounds.getSouthWest())) {
      state.map.flyTo(bounds.getCenter(), 15, { duration: 0.5 });
    } else {
      state.map.flyToBounds(bounds, { padding: [46, 46], maxZoom: 16, duration: 0.5 });
    }
    renderGroups();
  }

  function openGroupModal(mode) {
    state.groupMode = mode === 'join' ? 'join' : 'create';
    const join = state.groupMode === 'join';
    el.groupModalTitle.textContent = join ? '초대 코드로 참여' : '그룹 만들기';
    el.groupModalSub.textContent = join
      ? '친구에게 받은 그룹 초대 코드를 넣으면 바로 들어가요.'
      : '그룹에 들어가면 서로 친구가 아니어도 위치와 동선이 보여요.';
    el.groupNameField.hidden = join;
    el.groupCodeField.hidden = !join;
    el.groupSubmit.textContent = join ? '참여' : '만들기';
    delete el.groupSubmit.dataset.label;
    setAuthMsg(el.groupMsg, '');
    el.groupModal.hidden = false;
    setTimeout(() => { try { (join ? el.groupCode : el.groupName).focus(); } catch (e) {} }, 120);
  }

  function closeGroupModal() {
    if (el.groupModal) el.groupModal.hidden = true;
  }

  async function submitGroup() {
    const join = state.groupMode === 'join';
    const name = String(el.groupName.value || '').trim();
    const code = normalizeCode(el.groupCode.value || '');
    setAuthMsg(el.groupMsg, '');
    if (!join && !name) { setAuthMsg(el.groupMsg, '그룹 이름을 입력해 주세요'); el.groupName.focus(); return; }
    if (join && !code) { setAuthMsg(el.groupMsg, '초대 코드를 입력해 주세요'); el.groupCode.focus(); return; }

    setBtnBusy(el.groupSubmit, true, join ? '참여 중…' : '만드는 중…');
    try {
      const out = await API.rpc(join ? 'group_join' : 'group_create', join
        ? Object.assign(selfArgs(), { p_code: code })
        : Object.assign(selfArgs(), { p_name: name }));
      closeGroupModal();
      el.groupName.value = '';
      el.groupCode.value = '';
      await refreshGroups();
      if (out && out.id) {
        state.viewGroup = out.id;
        focusGroup(state.groups.get(out.id) || out);
      }
      setTab('groups');
      toast(join ? (out.name || '그룹') + '에 참여했어요' : (out.name || '그룹') + '을 만들었어요 — 초대 코드를 보내 보세요', 3400);
    } catch (e) {
      const raw = String(e.detail || e.message || e);
      setAuthMsg(el.groupMsg, /not_found/.test(raw) ? '그런 초대 코드를 찾지 못했어요' : authErrText(e));
    } finally {
      setBtnBusy(el.groupSubmit, false, join ? '참여' : '만들기');
    }
  }

  async function joinGroupByCode(code, silent) {
    const c = normalizeCode(code || '');
    if (!c || !state.me) return false;
    try {
      const out = await API.rpc('group_join', Object.assign(selfArgs(), { p_code: c }));
      await refreshGroups();
      setTab('groups');
      if (out && out.id) { state.viewGroup = out.id; focusGroup(state.groups.get(out.id) || out); }
      toast((out.name || '그룹') + '에 참여했어요', 3200);
      return true;
    } catch (e) {
      const raw = String(e.detail || e.message || e);
      if (!silent) {
        toast(/not_found/.test(raw) ? '그룹 초대 코드를 찾지 못했어요' : '그룹에 참여하지 못했어요 — ' + errText(e), 3600);
      }
      return false;
    }
  }

  async function toggleGroupHide(gid) {
    const g = state.groups.get(gid);
    if (!g || !state.me) return;
    const me = (g.members || []).find((mb) => mb.user_id === state.me.user_id);
    const next = !(me && me.hidden);
    try {
      const out = await API.rpc('group_toggle_hide', Object.assign(selfArgs(), { p_group: gid, p_hide: next }));
      await refreshGroups();
      const hid = out ? !!out.hidden : next;
      toast(hid
        ? '이 그룹에서는 내 위치를 잠깐 숨겼어요 — 채팅은 그대로 돼요'
        : '이 그룹에 내 위치를 다시 공개했어요', 3000);
    } catch (e) {
      toast('위치 공개 설정을 바꾸지 못했어요 — ' + errText(e), 3000);
    }
  }

  async function markGroupRead(gid) {
    if (!state.me || !gid) return;
    const now = Date.now();
    state.groupReadSentAt = state.groupReadSentAt || {};
    if (state.groupReadSentAt[gid] && now - state.groupReadSentAt[gid] < 4000) return;
    state.groupReadSentAt[gid] = now;
    try {
      await API.rpc('group_mark_read', Object.assign(selfArgs(), { p_group: gid }));
      const g = state.groups.get(gid);
      if (g) g.unread = 0;
      rt.send('grp-' + gid, 'read', { from: state.me.user_id, group: gid });
      renderConvos();
      updateChrome();
    } catch (e) { /* 다음 피드에서 다시 */ }
  }

  async function leaveGroup(gid) {
    const g = state.groups.get(gid);
    if (!g) return;
    if (!window.confirm(g.name + '에서 나갈까요?\n나가면 이 그룹의 위치·동선·대화가 보이지 않아요.')) return;
    try {
      await API.rpc('group_leave', Object.assign(selfArgs(), { p_group: gid }));
      if (state.chatWith === gid) closeChat();
      state.viewGroup = null;
      await refreshGroups();
      toast(g.name + '에서 나왔어요', 2600);
    } catch (e) {
      toast('그룹에서 나가지 못했어요 — ' + errText(e), 3200);
    }
  }

  function openGroupChat(gid) {
    const g = state.groups.get(gid);
    if (!g) { toast('그룹을 찾지 못했어요', 2200); return; }
    state.chatWith = gid;
    el.chatPanel.hidden = false;
    el.chatAvatar.textContent = '#';
    el.chatAvatar.style.setProperty('--c', '#0fb9a3');
    el.chatName.textContent = g.name;
    el.chatSub.textContent = '그룹 · ' + (g.member_count || (g.members || []).length) + '명';
    renderChatMessages();
    el.chatBody.scrollTop = el.chatBody.scrollHeight;
    loadMessages(gid, { full: true }).then(() => {
      markGroupRead(gid);
      el.chatInput.focus();
      el.chatBody.scrollTop = el.chatBody.scrollHeight;
    });
  }

  function nickOf(userId) {
    if (state.me && userId === state.me.user_id) return state.me.nickname;
    const p = state.friends.get(userId) || state.groupPeople.get(userId);
    return p ? p.nickname : '친구';
  }

  async function copyText(text, okMsg) {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMsg, 2200);
      return true;
    } catch (e) {
      toast(text, 4000);
      return false;
    }
  }

  /* ───────────────────────── 13. 친구 요청 · 수락 ───────────────────────── */
  async function sendFriendRequest(code, opts = {}) {
    const c = normalizeCode(code);
    if (!c) { toast('친구 코드를 입력해 주세요', 2000); return; }
    if (state.me && c === state.me.friend_code) { toast('내 친구 코드예요', 2000); return; }

    el.btnSendReq.disabled = true;
    try {
      const out = await API.rpc('friend_request', Object.assign(selfArgs(), { p_code: c }));
      const st = out && out.status;
      if (st === 'sent') {
        toast(out.nickname + ' 님에게 친구 요청을 보냈어요', 3000);
        rt.send('friend-' + out.user_id, 'req', { from: state.me.user_id });
        el.inputCode.value = '';
      } else if (st === 'accepted') {
        toast(out.nickname + ' 님과 바로 친구가 됐어요!', 3000);
        rt.send('friend-' + out.user_id, 'req', { from: state.me.user_id });
        el.inputCode.value = '';
      } else if (st === 'already_friends') {
        toast('이미 친구예요 — ' + out.nickname, 2400);
      } else if (st === 'already_requested') {
        toast('이미 요청을 보내고 기다리는 중이에요', 2600);
      } else if (st === 'self') {
        toast('내 친구 코드예요', 2000);
      } else {
        toast('그런 친구 코드를 찾지 못했어요 — 코드를 다시 확인해 주세요', 3200);
      }
      await refreshFeed();
      renderOutgoing();
      if (opts.closeOnSent && (st === 'sent' || st === 'accepted')) {
        setTimeout(closeAddModal, 600);
      }
    } catch (e) {
      toast('요청을 보내지 못했어요 — ' + errText(e), 3600);
    } finally {
      el.btnSendReq.disabled = false;
    }
  }

  async function respondRequest(id, accept) {
    const req = state.incoming.find((r) => String(r.id) === String(id));
    try {
      const out = await API.rpc('friend_respond', Object.assign(selfArgs(), { p_id: Number(id), p_accept: !!accept }));
      if (out && out.status === 'not_found') {
        toast('이미 처리된 요청이에요', 2200);
      } else if (accept) {
        toast((req ? req.nickname + ' 님과' : '') + ' 친구가 됐어요!', 2600);
      } else {
        toast('요청을 거절했어요', 2000);
      }
      if (req) rt.send('friend-' + req.user_id, 'req', { from: state.me.user_id });
    } catch (e) {
      toast('요청을 처리하지 못했어요 — ' + errText(e), 3200);
    }
    await refreshFeed();
  }

  async function cancelRequest(userId) {
    try {
      await API.rpc('friend_remove', Object.assign(selfArgs(), { p_friend: userId }));
      toast('보낸 요청을 취소했어요', 2000);
      await refreshFeed();
      renderOutgoing();
    } catch (e) {
      toast('취소하지 못했어요 — ' + errText(e), 3000);
    }
  }

  async function removeFriend(friendId) {
    const f = state.friends.get(friendId);
    if (!f) return;
    if (!window.confirm(f.nickname + ' 님과 친구를 끊을까요?\n서로의 위치와 대화가 보이지 않게 됩니다.')) return;
    try {
      await API.rpc('friend_remove', Object.assign(selfArgs(), { p_friend: friendId }));
      toast(f.nickname + ' 님과 친구를 끊었어요', 2400);
      closeModal();
      closeChat();
      await refreshFeed();
    } catch (e) {
      toast('친구를 끊지 못했어요 — ' + errText(e), 3200);
    }
  }

  function renderOutgoing() {
    if (!el.outgoingBox) return;
    if (!state.outgoing.length) {
      el.outgoingBox.hidden = true;
      setHTML(el.outgoingList, '', 'outgoing');
      return;
    }
    el.outgoingBox.hidden = false;
    setHTML(el.outgoingList, state.outgoing.map((r) => (
      '<div class="out-item" data-uid="' + esc(r.user_id) + '">'
      + esc(r.nickname) + '<span>' + esc(timeAgo(r.created_at)) + ' 요청</span>'
      + '<button type="button" data-cancel="' + esc(r.user_id) + '">취소</button></div>'
    )).join(''), 'outgoing');
  }

  /* ───────────────────────── 14. 친구 추가 모달 · 탭 ───────────────────────── */
  function openAddModal() {
    el.addModal.hidden = false;
    el.myCodeBig.textContent = state.me ? state.me.friend_code : '—';
    renderOutgoing();
    setTimeout(() => { try { el.inputCode.focus(); } catch (e) {} }, 120);
  }

  function closeAddModal() {
    el.addModal.hidden = true;
    el.inputCode.value = '';
  }

  function setTab(tab) {
    state.tab = tab === 'chat' ? 'chat' : (tab === 'groups' ? 'groups' : 'friends');
    if (state.tab === 'friends') state.mapScope = 'friends';
    if (state.tab === 'groups') state.mapScope = 'groups';
    el.tabFriends.classList.toggle('is-on', state.tab === 'friends');
    if (el.tabGroups) el.tabGroups.classList.toggle('is-on', state.tab === 'groups');
    el.tabChat.classList.toggle('is-on', state.tab === 'chat');
    el.panelFriends.hidden = state.tab !== 'friends';
    if (el.panelGroups) el.panelGroups.hidden = state.tab !== 'groups';
    el.panelChat.hidden = state.tab !== 'chat';
    el.sheet.classList.toggle('sheet--chat', state.tab === 'chat');
    setTimeout(updateSheetHeight, 30);
    if (state.tab === 'chat') renderConvos();
    if (state.tab === 'groups') { renderGroups(); refreshGroups(); }
    if (state.joined && (state.tab === 'friends' || state.tab === 'groups')) {
      renderPins();
      syncLiveRoutes();
      setTimeout(() => fitToPeople(true), 80);
    }
  }

  /* ───────────────────────── 15. 이동 기록 채우기 ───────────────────────── */
  async function ensureHistory(person) {
    const id = person.user_id;
    const isMe = !!state.me && id === state.me.user_id;
    let pts = historyFor(id);

    if (isMe) {
      const saved = LS.get(histKey(id), null);
      if (Array.isArray(saved) && saved.length >= 2) {
        const merged = new Map();
        saved.concat(pts).forEach((p) => {
          const t = Number(p.t);
          if (isFinite(t)) merged.set(t, { lat: Number(p.lat), lng: Number(p.lng), t, speed: p.speed == null ? null : Number(p.speed), since: p.since || null });
        });
        pts = setHistory(id, Array.from(merged.values()));
      }
    }

    if (pts.length >= 2) return pts;

    const groupOnly = !isMe && !state.friends.has(id) && state.groupPeople.has(id);
    try {
      const rows = groupOnly
        ? await API.rpc('group_history', Object.assign(selfArgs(), {
          p_group: state.groupPeople.get(id).groupId,
          p_since: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
        })).then((all) => (Array.isArray(all) ? all.filter((r) => r.user_id === id) : []))
        : await API.rpc('friend_history', Object.assign(selfArgs(), {
          p_friend: isMe ? '' : id,
          p_since: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
        }));
      if (Array.isArray(rows) && rows.length) pts = setHistory(id, rows.map((r) => ({
        lat: r.lat, lng: r.lng,
        t: new Date(r.recorded_at).getTime(),
        speed: r.speed_kmh,
        since: r.stay_since,
      })));
    } catch (e) {
      console.warn('[우리끼리] history', e);
    }

    return pts;
  }

  async function loadHistoryAll() {
    try {
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const [friendRows, groupRows] = await Promise.all([
        API.rpc('friends_history_since', Object.assign(selfArgs(), { p_since: since })).catch(() => []),
        state.groups.size
          ? API.rpc('groups_history_since', Object.assign(selfArgs(), { p_since: new Date(Date.now() - 6 * 3600 * 1000).toISOString() })).catch(() => [])
          : Promise.resolve([]),
      ]);
      const rows = [].concat(Array.isArray(friendRows) ? friendRows : [], Array.isArray(groupRows) ? groupRows : []);
      if (!rows.length) return;

      const byUser = new Map();
      rows.forEach((r) => {
        if (!r || !r.user_id) return;
        const arr = byUser.get(r.user_id) || [];
        arr.push({
          lat: r.lat, lng: r.lng, t: new Date(r.recorded_at).getTime(),
          speed: r.speed_kmh, since: r.stay_since,
        });
        byUser.set(r.user_id, arr);
      });

      byUser.forEach((pts, id) => {
        if (historyFor(id).length >= pts.length) return;
        setHistory(id, pts);
      });
      renderAll();
    } catch (e) {
      console.warn('[우리끼리] history all', e);
    }
  }

  function persistMyHistory() {
    if (!state.me) return;
    const arr = historyFor(state.me.user_id);
    if (arr.length) LS.set(histKey(state.me.user_id), arr.slice(-HISTORY_MAX));
  }

  /* ───────────────────────── 16. 위치 ───────────────────────── */
  function applyBattery() {
    if (!state.me) return;
    if (state.battMode === 'manual') {
      state.battery = Math.max(0, Math.min(100, Math.round(state.battManual.level)));
      state.charging = !!state.battManual.charging;
    } else if (state.battMode === 'off') {
      state.battery = null;
      state.charging = false;
    }
    state.me.battery = state.battery;
    state.me.charging = state.charging;
  }

  async function readBattery() {
    if (!BATT_API) {
      state.battMode = LS.get('urikkiri.battMode', 'off') === 'manual' ? 'manual' : 'off';
      const saved = LS.get('urikkiri.battManual', null);
      if (saved && isFinite(saved.level)) state.battManual = { level: saved.level, charging: !!saved.charging };
      applyBattery();
      return;
    }
    try {
      const b = await navigator.getBattery();
      const apply = () => {
        state.battery = Math.round(b.level * 100);
        state.charging = !!b.charging;
        if (state.me) {
          state.me.battery = state.battery;
          state.me.charging = state.charging;
          renderList();
        }
      };
      apply();
      b.addEventListener('levelchange', apply);
      b.addEventListener('chargingchange', apply);
    } catch (e) { /* 지원하지 않는 브라우저 */ }
  }

  function computeSpeed(c, prev, now) {
    let speed = null;
    if (typeof c.speed === 'number' && isFinite(c.speed) && c.speed >= 0) speed = c.speed * 3.6;

    if (prev) {
      const dt = (now - prev.t) / 1000;
      const d = haversine(prev, { lat: c.latitude, lng: c.longitude });
      if (dt >= 1.5 && d >= 4) {
        const calc = (d / dt) * 3.6;
        if (calc > 200) return null;
        speed = (speed != null && Math.abs(calc - speed) <= 3) ? (speed * 0.5 + calc * 0.5) : calc;
      } else if (dt <= 90 && d < 8) {
        speed = 0;
      }
    }
    if (speed == null) return null;
    speed = Math.max(0, Math.min(160, speed));
    return speed < 1.5 ? 0 : speed;
  }

  function touchStay(m, lat, lng, speed) {
    const moving = speed != null && speed >= MOVE_KMH;
    if (moving) {
      // GPS 가 한 번 튀었다고 '머무는 중'이 끊기지 않도록, 이동이 두 번 연속 잡혀야 끊는다
      m._moveFixes = (m._moveFixes || 0) + 1;
      if (m.stay_since == null || m._moveFixes >= 2) {
        m.stay_since = null;
        m._stayLat = lat;
        m._stayLng = lng;
      }
      return;
    }
    m._moveFixes = 0;
    if (m._stayLat == null || m.stay_since == null) {
      m.stay_since = new Date().toISOString();
      m._stayLat = lat;
      m._stayLng = lng;
      return;
    }
    if (haversine({ lat: m._stayLat, lng: m._stayLng }, { lat, lng }) > STAY_RADIUS_M) {
      m.stay_since = new Date().toISOString();
      m._stayLat = lat;
      m._stayLng = lng;
    }
  }

  function onPosition(pos) {
    if (!state.me) return;
    const c = pos.coords;
    const now = Date.now();
    const lat = c.latitude;
    const lng = c.longitude;
    const me = state.me;
    const prevFix = state.lastFix;

    const raw = computeSpeed(c, prevFix, now);
    if (raw != null) {
      if (raw === 0) me.speed_kmh = 0;
      else me.speed_kmh = (me.speed_kmh == null) ? raw : (me.speed_kmh * 0.35 + raw * 0.65);
      if (me.speed_kmh < 1.5) me.speed_kmh = 0;
    }

    me.lat = lat;
    me.lng = lng;
    me.accuracy = c.accuracy == null ? null : c.accuracy;
    me.updated_at = new Date().toISOString();
    touchStay(me, lat, lng, me.speed_kmh);
    state.lastFix = { lat, lng, t: now };

    const first = !state.gotFix;
    state.gotFix = true;
    state.geoDenied = false;
    if (el.permHint) el.permHint.hidden = true;

    const added = addHistoryPoint(me.user_id, { lat, lng, t: now, speed: me.speed_kmh, since: me.stay_since });
    if (added) {
      persistMyHistory();
      pushHistoryPoint();
    }

    renderAll();
    if (first) {
      fitToPeople(false);
      toast('내 위치를 찾았어요', 1600);
    }

    if (now - state.lastPublish > REFRESH_MS * 0.8 && added) publishMe(false); else saveMe();
  }

  function onGeoError(err, silent) {
    const denied = err && (err.code === 1 || /denied|PERMISSION/i.test(err.message || ''));
    if (denied) state.geoDenied = true;
    if (!state.me) return;

    if (!state.gotFix) {
      state.me.updated_at = new Date().toISOString();
      renderAll();
    }
    if (!silent) {
      if (state.geoDenied) {
        el.permText.textContent = '위치 권한이 거부됐어요 — 브라우저 설정에서 허용해 주세요. 지금은 서울 도심 기준 위치로 표시 중이에요.';
        el.btnPermAsk.hidden = true;
        el.permHint.hidden = false;
        return;
      }
      el.permText.textContent = '위치를 확인하지 못했어요 — 잠시 서울 도심 기준 위치로 표시할게요.';
      el.btnPermAsk.hidden = false;
      el.permHint.hidden = false;
      toast('위치를 확인하지 못해 서울 도심 기준 위치로 표시 중이에요', 3400);
    }
  }

  /* 정밀 위치(enableHighAccuracy)가 실패하면 네트워크 위치로 한 번 더 시도한다.
     PC 와이파이·실내처럼 GPS 가 없는 환경에서도 위치가 잡히게. */
  const GEO_FINE = { enableHighAccuracy: true, timeout: 9000, maximumAge: 3000 };
  const GEO_COARSE = { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 };

  function getPosition(onOk, onErr, opts = {}) {
    if (!navigator.geolocation) {
      onErr({ code: 0, message: 'geolocation unsupported' });
      return;
    }
    const fine = Object.assign({}, GEO_FINE, opts);
    const coarse = Object.assign({}, GEO_COARSE, { maximumAge: opts.maximumAge != null ? opts.maximumAge : GEO_COARSE.maximumAge, timeout: GEO_COARSE.timeout });

    try {
      navigator.geolocation.getCurrentPosition(
        (pos) => { state.geoFallback = false; onOk(pos); },
        (err) => {
          const retryable = err && (err.code === 2 || err.code === 3);
          if (!retryable) { onErr(err); return; }
          try {
            navigator.geolocation.getCurrentPosition(
              (pos) => { state.geoFallback = true; onOk(pos); },
              (err2) => onErr(err2),
              coarse
            );
          } catch (e) { onErr(err); }
        },
        fine
      );
    } catch (e) { onErr(e); }
  }

  function askLocation(opts = {}) {
    if (!navigator.geolocation) {
      if (!opts.silent) toast('이 브라우저는 위치 기능을 지원하지 않아요', 3000);
      return;
    }
    getPosition(
      onPosition,
      (err) => onGeoError(err, !!opts.silent),
      { enableHighAccuracy: true, timeout: 9000, maximumAge: 3000 }
    );
  }

  function startWatch() {
    stopWatch();
    if (!navigator.geolocation) return;
    startWatchPass(false);
  }

  function startWatchPass(coarse) {
    try {
      state.watchId = navigator.geolocation.watchPosition(
        (pos) => { state.geoFallback = coarse; onPosition(pos); },
        (err) => {
          const retryable = err && (err.code === 2 || err.code === 3);
          if (retryable && !coarse) {
            // 정밀 위치가 이 환경에서 안 잡힌다 → 네트워크 위치로 다시 감시 시작
            stopWatch();
            startWatchPass(true);
            return;
          }
          onGeoError(err, true);
        },
        coarse
          ? { enableHighAccuracy: false, timeout: 20000, maximumAge: 60000 }
          : { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
      );
    } catch (e) { state.watchId = null; }
  }

  function stopWatch() {
    if (state.watchId != null && navigator.geolocation) {
      try { navigator.geolocation.clearWatch(state.watchId); } catch (e) {}
    }
    state.watchId = null;
  }

  /* ───────────────────────── 17. 발행 ───────────────────────── */
  async function publishMe(showFeedback) {
    if (!state.me || !state.joined || !READY) return;
    applyBattery();
    state.me.updated_at = new Date().toISOString();
    state.lastPublish = Date.now();
    saveMe();
    renderAll();

    try {
      await API.rpc('friend_publish', Object.assign(selfArgs(), {
        p_lat: state.me.lat,
        p_lng: state.me.lng,
        p_accuracy: state.me.accuracy == null ? null : state.me.accuracy,
        p_battery: state.me.battery == null ? null : Math.round(state.me.battery),
        p_charging: !!state.me.charging,
        p_speed_kmh: state.me.speed_kmh == null ? null : Number(state.me.speed_kmh),
        p_stay_since: state.me.stay_since || null,
      }));
      notifyFriends('loc', { from: state.me.user_id });
      if (showFeedback) toast('위치를 업데이트했어요', 1800);
    } catch (e) {
      if (!state.errShown) {
        state.errShown = true;
        toast('위치를 보내지 못했어요 — ' + errText(e), 4200);
      }
      console.warn('[우리끼리] publish', e);
    }
  }

  async function pushHistoryPoint() {
    if (!state.me || !state.joined || !READY) return;
    const arr = historyFor(state.me.user_id);
    const last = arr[arr.length - 1];
    if (!last) return;
    if (Date.now() - state.lastHistAt < 45 * 1000) return;
    state.lastHistAt = Date.now();
    try {
      await API.rpc('friend_log_point', Object.assign(selfArgs(), {
        p_lat: last.lat,
        p_lng: last.lng,
        p_accuracy: state.me.accuracy == null ? null : state.me.accuracy,
        p_speed_kmh: last.speed == null ? null : last.speed,
        p_stay_since: last.since || null,
        p_recorded_at: new Date(last.t).toISOString(),
      }));
    } catch (e) {
      console.warn('[우리끼리] history point', e);
    }
  }

  async function manualUpdate() {
    if (!state.me) return;
    el.btnUpdate.classList.add('is-busy');

    const done = () => {
      el.btnUpdate.classList.remove('is-busy');
      renderAll();
    };

    if (!navigator.geolocation) {
      await publishMe(true);
      done();
      return;
    }

    getPosition(
      async (pos) => {
        onPosition(pos);
        await publishMe(false);
        await pushHistoryPoint();
        const sp = state.me.speed_kmh;
        toast('내 위치를 업데이트했어요'
          + (sp != null && sp >= MOVE_KMH ? ' · ' + Math.round(sp) + 'km/h' : '')
          + (pos.coords.accuracy ? ' · 정확도 ±' + Math.round(pos.coords.accuracy) + 'm' : '')
          + (state.geoFallback ? ' · 네트워크 위치' : ''), 2400);
        done();
      },
      async (err) => {
        onGeoError(err, false);
        await publishMe(false);
        done();
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  }

  async function setAuto(on) {
    state.auto = !!on;
    saveMe();
    updateChrome();
    if (state.auto) {
      startWatch();
      toast('자동 갱신 ON · ' + Math.round(REFRESH_MS / 1000) + '초마다 위치를 보내요', 2200);
      askLocation({ silent: true });
    } else {
      stopWatch();
      toast('자동 갱신 OFF · 버튼을 눌러야 위치가 갱신돼요', 2600);
    }
  }

  async function saveMyProfile() {
    if (!state.me) return;
    const nick = el.mNickInput.value.trim().slice(0, 12);
    if (!nick) { toast('닉네임을 입력해 주세요', 1800); return; }
    const status = el.mStatusInput.value.trim().slice(0, 24);
    el.mSave.disabled = true;
    try {
      await updateProfile({ nickname: nick, emoji: state.selectedEmoji || state.me.emoji, status_text: status });
      await publishMe(false);
      closeModal();
      toast('내 정보를 저장했어요', 1600);
    } catch (e) {
      toast('저장하지 못했어요 — ' + errText(e), 3200);
    } finally {
      el.mSave.disabled = false;
    }
  }

  /* ── 프로필 사진: 정사각 가운데 자르기 + 180×180 JPEG 압축 ── */
  function readImageFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('bad_image'));
        img.src = reader.result;
      };
      reader.onerror = () => reject(new Error('read_failed'));
      reader.readAsDataURL(file);
    });
  }

  async function handlePhotoFile(file) {
    if (!state.me || !file) return;
    if (!/^image\//.test(file.type || '')) { toast('사진 파일을 골라 주세요', 2200); return; }
    if (file.size > 15 * 1024 * 1024) { toast('15MB 이하 사진으로 골라 주세요', 2600); return; }
    toast('사진을 준비하는 중…', 1400);
    try {
      const img = await readImageFile(file);
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      const side = Math.min(w, h);
      if (!side) throw new Error('bad_image');
      const canvas = document.createElement('canvas');
      canvas.width = 180;
      canvas.height = 180;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 180, 180);
      ctx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, 180, 180);
      let url = canvas.toDataURL('image/jpeg', 0.82);
      if (url.length > 42000) url = canvas.toDataURL('image/jpeg', 0.7);
      if (url.length > 70000) url = canvas.toDataURL('image/jpeg', 0.55);

      paintAvatar(el.mPhotoPreview, Object.assign({}, state.me, { avatar_url: url }), initialOf(state.me.nickname));
      const prof = await API.rpc('friend_set_avatar', Object.assign(selfArgs(), { p_avatar: url }));
      applyProfile(prof);
      saveMe();
      renderAll();
      paintAvatar(el.mPhotoPreview, state.me, initialOf(state.me.nickname));
      toast('프로필 사진을 바꿨어요', 1900);
    } catch (e) {
      toast('사진을 올리지 못했어요 — ' + errText(e), 3200);
    }
  }

  async function clearMyPhoto() {
    if (!state.me) return;
    try {
      const prof = await API.rpc('friend_set_avatar', Object.assign(selfArgs(), { p_avatar: '' }));
      applyProfile(prof);
      saveMe();
      renderAll();
      paintAvatar(el.mPhotoPreview, state.me, initialOf(state.me.nickname));
      toast('프로필 사진을 지웠어요', 1800);
    } catch (e) {
      toast('사진을 지우지 못했어요 — ' + errText(e), 3000);
    }
  }

  async function setBatteryMode(mode) {
    if (!state.me) return;
    state.battMode = mode;
    LS.set('urikkiri.battMode', mode);
    applyBattery();
    renderBatteryBox(true);
    renderRows(state.me, true);
    await publishMe(false);
    toast(mode === 'manual' ? '배터리를 직접 입력해서 표시할게요' : '배터리를 표시하지 않을게요', 2000);
  }

  function saveBatteryManual() {
    state.battManual = { level: Number(el.mBattRange.value), charging: !!el.mBattCharging.checked };
    LS.set('urikkiri.battManual', state.battManual);
    applyBattery();
    if (state.me) {
      renderRows(state.me, true);
      publishMe(false);
    }
    toast('배터리 ' + state.battManual.level + '%' + (state.battManual.charging ? ' · 충전 중' : '') + '으로 표시할게요', 2000);
  }

  /* ───────────────────────── 18. 실시간 신호(broadcast) ───────────────────────── */
  function pairTopic(friendId) {
    const a = state.me.user_id;
    const pair = [a, friendId].sort();
    return 'pair-' + pair[0] + '__' + pair[1];
  }

  function notifyFriends(event, payload) {
    if (!state.me) return;
    for (const id of state.friends.keys()) {
      rt.send(pairTopic(id), event, payload || {});
    }
  }

  const rt = (() => {
    let ws = null;
    let hb = null;
    let retry = null;
    let ref = 0;
    let disposed = false;
    let want = [];
    const joined = new Set();

    function wsUrl() {
      return SUPABASE_URL.replace(/^http/i, 'ws')
        + '/realtime/v1/websocket?apikey=' + encodeURIComponent(SUPABASE_KEY) + '&vsn=1.0.0';
    }

    function sendRaw(topic, event, payload) {
      if (!ws || ws.readyState !== 1) return;
      try {
        ws.send(JSON.stringify({
          topic: 'realtime:' + topic,
          event,
          payload: payload || {},
          ref: String(++ref),
        }));
      } catch (e) {}
    }

    function join(topic) {
      sendRaw(topic, 'phx_join', {
        config: {
          broadcast: { self: false, ack: false },
          presence: { key: '' },
          postgres_changes: [],
        },
      });
    }

    function handleBroadcast(topic, event, payload) {
      if (event === 'loc') {
        scheduleFeedRefresh(900);
      } else if (event === 'msg') {
        const friendId = topic.replace(/^pair-/, '').split('__').find((id) => id !== state.me.user_id);
        if (!friendId) return;
        if (state.chatWith === friendId && !el.chatPanel.hidden) {
          loadMessages(friendId, { full: false }).then(() => markRead(friendId));
        }
        scheduleFeedRefresh(200);
      } else if (event === 'req') {
        scheduleFeedRefresh(300);
      } else if (event === 'poke') {
        pollPokes();
      } else if (event === 'chat') {
        const gid = (payload && payload.group) || topic.replace(/^grp-/, '');
        if (gid && state.chatWith === gid && !el.chatPanel.hidden) {
          loadMessages(gid, { full: true }).then(() => markGroupRead(gid));
        }
        scheduleFeedRefresh(200);
      } else if (event === 'read') {
        // 그룹·1:1 둘 다: 상대가 읽으면 내 말풍선 숫자를 바로 다시 그린다
        const gid = (payload && payload.group) || (/^grp-/.test(topic) ? topic.replace(/^grp-/, '') : '');
        const fid = gid ? '' : topic.replace(/^pair-/, '').split('__').find((id) => id !== state.me.user_id);
        const target = gid || fid;
        if (target && state.chatWith === target && !el.chatPanel.hidden) {
          loadMessages(target, { full: true });
        }
      }
    }

    function connect() {
      if (disposed || !READY || !state.me) return;
      try { ws = new WebSocket(wsUrl()); } catch (e) { scheduleReconnect(); return; }

      ws.onopen = () => {
        joined.clear();
        want.forEach((t) => { join(t); joined.add(t); });
        clearInterval(hb);
        hb = setInterval(() => {
          if (!ws || ws.readyState !== 1) return;
          try {
            ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(++ref) }));
          } catch (e) {}
        }, 25000);
      };

      ws.onmessage = (ev) => {
        let parsed;
        try { parsed = JSON.parse(ev.data); } catch (e) { return; }
        const list = Array.isArray(parsed) ? parsed : [parsed];
        for (const msg of list) {
          if (!msg) continue;
          const topic = String(msg.topic || '').replace(/^realtime:/, '');
          if (msg.event === 'broadcast') {
            const data = msg.payload || {};
            handleBroadcast(topic, data.event, data.payload || {});
          } else if (msg.event === 'phx_error' || msg.event === 'phx_close') {
            joined.delete(topic);
          }
        }
      };

      ws.onerror = () => {};
      ws.onclose = () => {
        clearInterval(hb);
        joined.clear();
        ws = null;
        scheduleReconnect();
      };
    }

    function scheduleReconnect() {
      if (disposed) return;
      clearTimeout(retry);
      retry = setTimeout(connect, 6000);
    }

    return {
      connect,
      setTopics(topics) {
        const next = Array.from(new Set(topics.filter(Boolean)));
        want = next;
        if (!ws || ws.readyState !== 1) return;
        next.forEach((t) => { if (!joined.has(t)) { join(t); joined.add(t); } });
        Array.from(joined).forEach((t) => {
          if (next.indexOf(t) === -1) {
            sendRaw(t, 'phx_leave', {});
            joined.delete(t);
          }
        });
      },
      send(topic, event, payload) {
        if (!topic || !ws || ws.readyState !== 1) return;
        sendRaw(topic, 'broadcast', { type: 'broadcast', event, payload: payload || {} });
      },
      dispose() {
        disposed = true;
        clearInterval(hb);
        clearTimeout(retry);
        if (ws) { try { ws.close(); } catch (e) {} ws = null; }
      },
    };
  })();

  let feedTimer = null;
  function scheduleFeedRefresh(ms) {
    if (feedTimer) return;
    feedTimer = setTimeout(() => {
      feedTimer = null;
      refreshFeed();
    }, Math.max(150, ms || 600));
  }

  function syncRealtime() {
    if (!state.me) return;
    const topics = ['friend-' + state.me.user_id];
    for (const id of state.friends.keys()) topics.push(pairTopic(id));
    for (const id of state.groups.keys()) topics.push('grp-' + id);
    rt.setTopics(topics);
  }

  /* ───────────────────────── 19. 타이머 ───────────────────────── */
  function startTimers() {
    stopTimers();
    state.tickTimer = setInterval(tick, REFRESH_MS);
  }

  function stopTimers() {
    if (state.tickTimer) clearInterval(state.tickTimer);
    state.tickTimer = null;
  }

  async function tick() {
    if (!state.joined) return;
    if (state.auto) {
      if (state.watchId == null) askLocation({ silent: true });
      else if (Date.now() - state.lastPublish > REFRESH_MS * 0.9) publishMe(false);
    }
    await refreshFeed();
    pollPokes();
    renderTimes();
    if (state.routeView) refreshRouteView();
    const opened = modalUser && !el.memberModal.hidden ? personById(modalUser) : null;
    if (opened) renderRouteBlock(opened);
    if (state.chatWith && !el.chatPanel.hidden) {
      renderChatSub();
      // 열려 있는 대화는 매번 전체를 다시 받아 읽음(노란 숫자) 상태를 맞춘다
      loadMessages(state.chatWith, { full: true });
      if (isGroupChat(state.chatWith)) markGroupRead(state.chatWith);
    }
    checkNearby();
  }

  /* ───────────────────────── 20. 입장 ───────────────────────── */
  async function enterApp() {
    if (!state.me) return;
    el.joinScreen.hidden = true;
    el.app.hidden = false;
    initMap();
    if (state.map) state.map.invalidateSize();
    state.joined = true;
    applyBattery();
    renderAll();
    fitToPeople(false);
    updateChrome();
    rt.connect();

    await publishMe(false);
    await refreshFeed();
    await loadHistoryAll();
    renderAll();
    refreshNotifState();
    pollPokes();

    readBattery();
    if (state.auto) startWatch();
    startTimers();
    setTimeout(() => askLocation({ silent: false }), 400);

    if (state.addAfterStart) {
      const code = state.addAfterStart;
      state.addAfterStart = '';
      setTimeout(() => sendFriendRequest(code), 500);
    }
    if (state.addGroupCode) {
      const gcode = state.addGroupCode;
      state.addGroupCode = '';
      setTimeout(() => { joinGroupByCode(gcode, true).then((ok) => { if (!ok) toast('그룹 초대 코드를 확인하지 못했어요 — 코드를 다시 확인해 주세요', 3600); }); }, 700);
    }
    clearAddParam();
  }

  /* ───────────────────────── 20-2. 로그인 / 회원가입 ───────────────────────── */
  const USERNAME_RE = /^[a-z][a-z0-9_]{3,19}$/;

  function authErrText(e) {
    const raw = String((e && (e.detail || e.message)) || e || '');
    if (/invalid_login/.test(raw)) return '아이디 또는 비밀번호가 맞지 않아요';
    if (/no_password/.test(raw)) return '이 아이디에는 비밀번호가 없어요. 이 기기에서 [처음이에요]로 아이디를 만들어 주세요';
    if (/username_taken/.test(raw)) return '이미 쓰고 있는 아이디예요 — 다른 아이디로 해보세요';
    if (/invalid_username/.test(raw)) return '아이디는 영문으로 시작하는 영문·숫자·밑줄 4~20자로 정해 주세요';
    if (/invalid_password/.test(raw)) return '비밀번호는 4자 이상으로 정해 주세요';
    if (/already_has_username/.test(raw)) return '이 기기 계정에는 이미 아이디가 있어요 — [로그인]에서 그 아이디로 들어와 주세요';
    if (/unauthorized/.test(raw)) return '내 정보를 다시 확인해야 해요 — 로그인해 주세요';
    if (/Failed to fetch|NetworkError|Load failed/i.test(raw)) return '인터넷 연결을 확인해 주세요';
    return raw.length > 90 ? raw.slice(0, 90) + '…' : raw;
  }

  function setAuthMsg(node, text, ok) {
    if (!node) return;
    node.textContent = text || '';
    node.hidden = !text;
    node.classList.toggle('is-ok', !!ok);
  }

  function setAuthMode(mode) {
    state.authMode = mode === 'register' ? 'register' : 'login';
    $$('#authTabs [data-auth]').forEach((b) => {
      const on = b.getAttribute('data-auth') === state.authMode;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', String(on));
    });
    if (el.loginForm) el.loginForm.hidden = state.authMode !== 'login';
    if (el.registerForm) el.registerForm.hidden = state.authMode !== 'register';
    if (el.carryNote) el.carryNote.hidden = !(state.carry && state.authMode === 'register');
  }

  function showJoin(mode, message) {
    el.joinScreen.hidden = false;
    el.app.hidden = true;
    setAuthMode(mode || 'login');
    setAuthMsg(el.loginMsg, '');
    setAuthMsg(el.regMsg, '');
    setAutoLogin(readAutoLoginPref(), true);
    if (message) setAuthMsg(state.authMode === 'login' ? el.loginMsg : el.regMsg, message);
    const lastUser = LS.get('urikkiri.lastUser', '');
    if (lastUser) {
      if (el.loginId && !el.loginId.value) el.loginId.value = lastUser;
      if (el.regId && !el.regId.value) el.regId.value = lastUser;
    }
    const lastNick = LS.get('urikkiri.lastNick', '');
    if (lastNick && el.inputNick && !el.inputNick.value) el.inputNick.value = lastNick;
  }

  /* 로그인 화면의 '자동 로그인' 체크박스(로그인·가입 폼 공통) */
  function autoLoginBoxes() {
    return $$('.auto-login');
  }

  function readAutoLoginPref() {
    return LS.get(AUTO_KEY, true) !== false;
  }

  function setAutoLogin(on, silent) {
    state.autoLogin = on !== false;
    if (!silent) LS.set(AUTO_KEY, state.autoLogin);
    autoLoginBoxes().forEach((b) => { b.checked = state.autoLogin; });
  }

  function formAutoLogin(sel) {
    const box = $(sel);
    return box ? !!box.checked : readAutoLoginPref();
  }

  /* 저장된 로그인 열쇠를 모두 지우고 로그인 화면으로 */
  async function forgetLogin(message) {
    LS.del(ME_KEY);
    clearSessionCookie();
    clearSessionStore();
    try { await idbDel('me'); } catch (e) {}
    state.carry = null;
    const lastUser = LS.get('urikkiri.lastUser', '');
    showJoin(lastUser ? 'login' : 'register', message);
  }

  function setBtnBusy(btn, busy, label) {
    if (!btn) return;
    if (busy) {
      if (!btn.dataset.label) btn.dataset.label = btn.textContent;
      btn.disabled = true;
      btn.textContent = label || '처리 중…';
    } else {
      btn.disabled = false;
      btn.textContent = btn.dataset.label || label || '확인';
    }
  }

  async function submitLogin() {
    if (state.joining || state.authBusy) return;
    const uname = String(el.loginId.value || '').trim().toLowerCase();
    const pw = String(el.loginPw.value || '');
    setAuthMsg(el.loginMsg, '');
    if (!uname) { setAuthMsg(el.loginMsg, '아이디를 입력해 주세요'); el.loginId.focus(); return; }
    if (!pw) { setAuthMsg(el.loginMsg, '비밀번호를 입력해 주세요'); el.loginPw.focus(); return; }

    state.autoLogin = formAutoLogin('#loginForm .auto-login');
    state.authBusy = true;
    setBtnBusy(el.btnLogin, true, '로그인 중…');
    try {
      const out = await API.rpc('auth_login', { p_username: uname, p_password: pw });
      adoptSession(out);
      state.carry = null;
      LS.set('urikkiri.lastUser', uname);
      LS.set('urikkiri.lastNick', state.me.nickname);
      state.authBusy = false;
      setBtnBusy(el.btnLogin, false, '로그인');
      await enterApp();
    } catch (e) {
      state.authBusy = false;
      setBtnBusy(el.btnLogin, false, '로그인');
      setAuthMsg(el.loginMsg, authErrText(e));
    }
  }

  async function submitRegister() {
    if (state.joining || state.authBusy) return;
    const nick = String(el.inputNick.value || '').trim().slice(0, 12);
    const uname = String(el.regId.value || '').trim().toLowerCase();
    const pw = String(el.regPw.value || '');
    setAuthMsg(el.regMsg, '');
    if (!nick) { setAuthMsg(el.regMsg, '닉네임을 입력해 주세요'); el.inputNick.focus(); return; }
    if (!USERNAME_RE.test(uname)) {
      setAuthMsg(el.regMsg, '아이디는 영문으로 시작하는 영문·숫자·밑줄 4~20자로 정해 주세요');
      el.regId.focus();
      return;
    }
    if (pw.length < 4) { setAuthMsg(el.regMsg, '비밀번호는 4자 이상으로 정해 주세요'); el.regPw.focus(); return; }

    state.autoLogin = formAutoLogin('#registerForm .auto-login');
    state.authBusy = true;
    setBtnBusy(el.btnRegister, true, '만드는 중…');
    const carry = state.carry;
    try {
      const out = await API.rpc('auth_register', {
        p_username: uname,
        p_password: pw,
        p_nickname: nick,
        p_link_user: carry ? carry.user_id : null,
        p_link_secret: carry ? (carry.session_token || carry.secret) : null,
      });
      adoptSession(out);
      state.carry = null;
      LS.set('urikkiri.lastUser', uname);
      LS.set('urikkiri.lastNick', state.me.nickname);
      state.authBusy = false;
      setBtnBusy(el.btnRegister, false, '회원가입');
      await enterApp();
      toast(out.linked ? '아이디를 만들었어요 — 쓰던 친구·채팅이 그대로 이어져요' : '가입 완료 — 친구 코드를 친구에게 알려 주세요', 3800);
    } catch (e) {
      state.authBusy = false;
      setBtnBusy(el.btnRegister, false, '회원가입');
      setAuthMsg(el.regMsg, authErrText(e));
    }
  }

  async function signOut(switchAccount) {
    const me = state.me;
    try { if (me && READY) await API.rpc('auth_logout', selfArgs()); } catch (e) {}
    clearSessionCookie();
    clearSessionStore();
    LS.del(ME_KEY);
    try { await idbDel('me'); } catch (e) {}
    if (me) LS.del('urikkiri.idHint.' + me.user_id);
    state.me = null;
    state.joined = false;
    try { LS.set('urikkiri.lastNick', me ? me.nickname : ''); } catch (e) {}
    LS.set('urikkiri.authNext', switchAccount ? 'switch' : 'login');
    location.reload();
  }

  /* ───────────────────────── 21. 이벤트 ───────────────────────── */
  function bindEvents() {
    el.authTabs.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-auth]');
      if (!btn) return;
      setAuthMode(btn.getAttribute('data-auth'));
      setAuthMsg(el.loginMsg, '');
      setAuthMsg(el.regMsg, '');
      const first = state.authMode === 'login' ? el.loginId : el.inputNick;
      setTimeout(() => { try { first.focus(); } catch (err) {} }, 90);
    });
    autoLoginBoxes().forEach((box) => {
      box.addEventListener('change', () => {
        LS.set(AUTO_KEY, box.checked);
        state.autoLogin = box.checked;
        autoLoginBoxes().forEach((b) => { b.checked = box.checked; });
      });
    });
    el.loginForm.addEventListener('submit', (e) => { e.preventDefault(); submitLogin(); });
    el.registerForm.addEventListener('submit', (e) => { e.preventDefault(); submitRegister(); });
    el.inputNick.addEventListener('input', () => {
      el.inputNick.value = el.inputNick.value.slice(0, 12);
    });
    const tidyUser = (input) => {
      const pos = input.selectionStart;
      input.value = String(input.value || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20);
      try { input.setSelectionRange(pos, pos); } catch (err) {}
    };
    el.regId.addEventListener('input', () => tidyUser(el.regId));
    el.loginId.addEventListener('input', () => tidyUser(el.loginId));

    el.meChip.addEventListener('click', () => openMember(state.me.user_id));
    el.btnShare.addEventListener('click', shareMyLink);
    el.btnAddFriend.addEventListener('click', openAddModal);
    el.btnAddFriend2.addEventListener('click', openAddModal);
    el.btnCopy.addEventListener('click', copyMyLink);
    el.btnUpdate.addEventListener('click', manualUpdate);
    el.btnAuto.addEventListener('click', () => setAuto(!state.auto));
    el.fabLocate.addEventListener('click', focusMyLocation);
    if (el.btnMapStyle) {
      el.btnMapStyle.addEventListener('click', (e) => {
        e.stopPropagation();
        setMapStyleMenu(el.mapStyleMenu.hidden);
      });
    }
    if (el.mapStyleMenu) {
      el.mapStyleMenu.addEventListener('click', (e) => {
        const opt = e.target.closest('[data-map-style]');
        if (!opt) return;
        applyMapStyle(opt.getAttribute('data-map-style'), { save: true });
        setMapStyleMenu(false);
      });
    }
    document.addEventListener('pointerdown', (e) => {
      if (!el.mapStyleMenu || el.mapStyleMenu.hidden) return;
      if (el.mapStyle && el.mapStyle.contains(e.target)) return;
      setMapStyleMenu(false);
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && el.mapStyleMenu && !el.mapStyleMenu.hidden) setMapStyleMenu(false);
    });
    el.btnSheetHide.addEventListener('click', () => setSheetHidden(true));
    el.sheetOpen.addEventListener('click', () => setSheetHidden(false));

    el.btnCollapse.addEventListener('click', () => {
      if (state.sheetHidden) { setSheetHidden(false); return; }
      el.sheet.classList.toggle('is-collapsed');
      setTimeout(updateSheetHeight, 240);
    });

    el.tabs.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tab]');
      if (!btn) return;
      setTab(btn.getAttribute('data-tab'));
    });

    el.memberList.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]');
      if (act) {
        const what = act.getAttribute('data-act');
        if (what === 'share') copyMyLink();
        if (what === 'add') openAddModal();
        return;
      }
      const card = e.target.closest('[data-id]');
      if (!card) return;
      const id = card.getAttribute('data-id');
      if (!personById(id)) return;
      openMember(id);
    });

    el.convoList.addEventListener('click', (e) => {
      const row = e.target.closest('[data-chat]');
      if (!row) return;
      openChat(row.getAttribute('data-chat'));
    });

    el.reqList.addEventListener('click', (e) => {
      const ok = e.target.closest('[data-accept]');
      const no = e.target.closest('[data-decline]');
      if (ok) { respondRequest(ok.getAttribute('data-accept'), true); return; }
      if (no) { respondRequest(no.getAttribute('data-decline'), false); }
    });

    el.outgoingList.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-cancel]');
      if (!btn) return;
      cancelRequest(btn.getAttribute('data-cancel'));
    });

    el.mClose.addEventListener('click', closeModal);
    el.memberModal.addEventListener('click', (e) => {
      if (e.target.hasAttribute('data-close')) closeModal();
    });
    el.addModal.addEventListener('click', (e) => {
      if (e.target.hasAttribute('data-close')) closeAddModal();
    });

    /* 아이디 만들기 · 로그아웃 · 계정 전환 */
    el.btnIdMake.addEventListener('click', openIdModal);
    el.mAcctCreate.addEventListener('click', openIdModal);
    el.btnIdLater.addEventListener('click', () => {
      if (state.me) LS.set(idHintKey(), true);
      renderIdBanner();
    });
    el.idModal.addEventListener('click', (e) => {
      if (e.target.hasAttribute('data-close')) closeIdModal();
    });
    el.idClose.addEventListener('click', closeIdModal);
    el.idForm.addEventListener('submit', (e) => { e.preventDefault(); saveUsername(); });
    el.idInput.addEventListener('input', () => {
      const pos = el.idInput.selectionStart;
      el.idInput.value = String(el.idInput.value || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20);
      try { el.idInput.setSelectionRange(pos, pos); } catch (err) {}
    });
    el.mAcctLogout.addEventListener('click', () => {
      if (!confirm('로그아웃하면 이 기기에서는 다시 아이디로 로그인해야 해요. 친구·채팅은 서버에 그대로 남아요.')) return;
      signOut(false);
    });
    el.mAcctSwitch.addEventListener('click', () => {
      if (!confirm('다른 계정으로 들어갈까요? 지금 계정의 친구·채팅은 서버에 그대로 남아 있어요.')) return;
      signOut(true);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!el.idModal.hidden) { closeIdModal(); return; }
      if (!el.addModal.hidden) { closeAddModal(); return; }
      if (!el.chatPanel.hidden) { closeChat(); return; }
      if (state.routeView) { closeRouteView(); return; }
      if (!el.memberModal.hidden) closeModal();
    });

    el.mEmojis.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-emoji]');
      if (!btn) return;
      state.selectedEmoji = btn.getAttribute('data-emoji');
      $$('.emoji-btn', el.mEmojis).forEach((b) => b.classList.toggle('is-on', b === btn));
    });

    el.mSave.addEventListener('click', saveMyProfile);
    if (el.mPokeBtns) el.mPokeBtns.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-poke]');
      if (!btn || !modalUser) return;
      sendPoke(modalUser, btn.getAttribute('data-poke'));
    });
    if (el.mMute) el.mMute.addEventListener('click', () => {
      if (!modalUser) return;
      setMuted(modalUser, !isMuted(modalUser));
    });
    if (el.mPhotoPick) el.mPhotoPick.addEventListener('click', () => { try { el.mPhotoInput.click(); } catch (e) {} });
    if (el.mPhotoInput) el.mPhotoInput.addEventListener('change', () => {
      const file = el.mPhotoInput.files && el.mPhotoInput.files[0];
      handlePhotoFile(file);
      el.mPhotoInput.value = '';
    });
    if (el.mPhotoClear) el.mPhotoClear.addEventListener('click', clearMyPhoto);
    if (el.mNotifAsk) el.mNotifAsk.addEventListener('click', askNotifPermission);
    if (el.noticeClose) el.noticeClose.addEventListener('click', (e) => { e.stopPropagation(); hideNotice(); });
    if (el.notice) el.notice.addEventListener('click', () => {
      const open = state.noticeOpen;
      hideNotice();
      if (typeof open === 'function') open();
    });
    el.mChat.addEventListener('click', () => {
      const id = modalUser;
      closeModal();
      if (!id) return;
      const gp = state.groupPeople.get(id);
      openChat(gp ? gp.groupId : id);
    });
    el.mLocate.addEventListener('click', () => {
      const m = personById(modalUser || state.selected);
      closeModal();
      if (m) centerOn(m);
    });
    el.mRemove.addEventListener('click', () => {
      const id = modalUser;
      if (id) removeFriend(id);
    });
    el.mCopyCode.addEventListener('click', copyMyCode);

    el.mRouteOpen.addEventListener('click', () => {
      const id = modalUser;
      if (id) openRouteView(id);
    });
    el.rvClose.addEventListener('click', closeRouteView);
    el.rvBack.addEventListener('click', closeRouteView);
    el.rvTlToggle.addEventListener('click', () => setRouteTimeline(!state.routeTlOpen));
    el.rvTlHide.addEventListener('click', () => setRouteTimeline(false));
    el.rvTlList.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-row]');
      if (btn) focusRouteRow(btn.getAttribute('data-row'));
    });

    el.mBattModes.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-mode]');
      if (!btn) return;
      setBatteryMode(btn.getAttribute('data-mode'));
    });
    el.mBattRange.addEventListener('input', () => {
      el.mBattVal.textContent = el.mBattRange.value + '%';
      el.mBattRange.style.setProperty('--p', el.mBattRange.value + '%');
    });
    el.mBattRange.addEventListener('change', saveBatteryManual);
    el.mBattCharging.addEventListener('change', saveBatteryManual);

    el.addForm.addEventListener('submit', (e) => {
      e.preventDefault();
      sendFriendRequest(el.inputCode.value, { closeOnSent: true });
    });
    el.inputCode.addEventListener('input', () => {
      const pos = el.inputCode.selectionStart;
      el.inputCode.value = normalizeCode(el.inputCode.value);
      try { el.inputCode.setSelectionRange(pos, pos); } catch (e) {}
    });
    el.addClose.addEventListener('click', closeAddModal);

    /* ── 그룹 ── */
    if (el.btnGroupCreate) el.btnGroupCreate.addEventListener('click', () => openGroupModal('create'));
    if (el.btnGroupJoin) el.btnGroupJoin.addEventListener('click', () => openGroupModal('join'));
    if (el.groupSubmit) el.groupSubmit.addEventListener('click', submitGroup);
    if (el.groupCancel) el.groupCancel.addEventListener('click', closeGroupModal);
    if (el.groupModal) {
      el.groupModal.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeGroupModal(); });
      [el.groupName, el.groupCode].forEach((input) => {
        if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitGroup(); } });
      });
    }
    if (el.groupList) {
      el.groupList.addEventListener('click', (e) => {
        const chat = e.target.closest('[data-gchat]');
        if (chat) { openGroupChat(chat.getAttribute('data-gchat')); return; }
        const leave = e.target.closest('[data-gleave]');
        if (leave) { leaveGroup(leave.getAttribute('data-gleave')); return; }
        const mem = e.target.closest('[data-gmem]');
        if (mem) { const p = personById(mem.getAttribute('data-gmem')); if (p) openMember(p.user_id); return; }
        const ghide = e.target.closest('[data-ghide]');
        if (ghide) { toggleGroupHide(ghide.getAttribute('data-ghide')); return; }
        const gmute = e.target.closest('[data-gmute]');
        if (gmute) { const gid = gmute.getAttribute('data-gmute'); setMuted(gid, !isMuted(gid)); renderGroups(); return; }
        const cp = e.target.closest('[data-gcopy]');
        if (cp) { copyText(cp.getAttribute('data-gcopy'), '그룹 초대 코드를 복사했어요'); return; }
        const lk = e.target.closest('[data-glink]');
        if (lk) {
          const url = location.origin + location.pathname + '?group=' + encodeURIComponent(lk.getAttribute('data-glink'));
          copyText(url, '그룹 초대 링크를 복사했어요 — 보내면 바로 들어와요');
          return;
        }
        const card = e.target.closest('[data-group]');
        if (card) {
          const gid = card.getAttribute('data-group');
          state.viewGroup = gid;
          state.mapScope = 'groups';
          renderGroups();
          renderPins();
          syncLiveRoutes();
          focusGroup(state.groups.get(gid));
        }
      });
    }
    el.btnCopyCode.addEventListener('click', copyMyCode);
    el.btnCopyLink.addEventListener('click', copyMyLink);

    el.btnChatBack.addEventListener('click', closeChat);
    el.btnChatLocate.addEventListener('click', () => {
      const id = state.chatWith;
      closeChat();
      const f = id ? state.friends.get(id) : null;
      if (f && f.lat != null) centerOn(f);
    });
    el.chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      sendMessage();
    });
    el.btnPermAsk.addEventListener('click', () => askLocation({ silent: false }));
    el.btnPermClose.addEventListener('click', () => { el.permHint.hidden = true; });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !state.joined) return;
      if (state.map) state.map.invalidateSize();
      renderTimes();
      refreshFeed();
      pollPokes();
      if (state.auto) askLocation({ silent: true });
    });

    window.addEventListener('online', () => { if (state.joined) { refreshFeed(); rt.connect(); } });

    if ('ResizeObserver' in window) {
      const ro = new ResizeObserver(() => updateSheetHeight());
      ro.observe(el.sheet);
    }
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      updateSheetHeight();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!state.joined || !state.map) return;
        state.map.invalidateSize();
        if (state.routeView) {
          const m = personById(state.routeView);
          if (m) {
            const model = drawRouteDetail(m, { fit: true });
            if (model) { renderRouteBar(m, model); renderRouteTimeline(model); }
          }
        } else if (el.memberModal.hidden) fitToPeople(false);
      }, 260);
    });
  }

  function clearAddParam() {
    try {
      const url = new URL(location.href);
      if (!url.searchParams.has('add') && !url.searchParams.has('group')) return;
      url.searchParams.delete('add');
      url.searchParams.delete('group');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    } catch (e) {}
  }

  /* ───────────────────────── 22. 시작 ───────────────────────── */
  async function init() {
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      setTimeout(() => {
        navigator.serviceWorker.register('./sw.js').catch(() => {});
      }, 1500);
    }

    bindEvents();
    if (el.appVer) el.appVer.textContent = APP_VERSION;
    if (el.appVerJoin) el.appVerJoin.textContent = APP_VERSION;
    ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => {
      document.addEventListener(ev, initAudio, { once: true, passive: true });
    });
    updateSheetHeight();
    readBattery();
    loadPlaceCache();

    let addCode = '';
    let addGroup = '';
    try { addCode = normalizeCode(new URLSearchParams(location.search).get('add') || ''); } catch (e) {}
    try { addGroup = normalizeCode(new URLSearchParams(location.search).get('group') || ''); } catch (e) {}
    state.addGroupCode = addGroup;
    if (addCode) {
      el.inviteNote.hidden = false;
      el.inviteCodeLabel.textContent = addCode;
    }

    if (!READY) {
      showJoin('login');
      toast('서버 설정(config.js)이 비어 있어요', 5000);
      return;
    }

    const saved = await loadIdentity();
    state.addAfterStart = addCode;
    state.autoLogin = saved ? saved.autoLogin !== false : readAutoLoginPref();

    /* 이 기기에 남은 신원이 있고, 아직 아이디가 없으면 가입 화면에서 그 계정에 아이디를 붙일 수 있다 */
    state.carry = saved && !saved.username ? saved : null;

    if (saved) {
      try {
        /* 자동 로그인: 세션 토큰이 남아 있으면 서버에 한 번 확인하고 바로 들어간다 */
        let restored = false;
        if (saved.session_token) {
          try {
            const out = await API.rpc('auth_login_session', { p_token: saved.session_token });
            if (out && out.profile && out.profile.user_id) {
              state.me = freshMe({
                user_id: out.profile.user_id,
                secret: saved.secret || saved.session_token,
                session_token: out.session_token || saved.session_token,
                username: out.profile.username || '',
              });
              applyProfile(out.profile);
              state.auto = saved.auto !== false;
              saveMe();
              persistLogin();
              restored = true;
            }
          } catch (e) {
            const detail = String(e.detail || e.message || e);
            if (/unauthorized/.test(detail)) throw e;   // 세션이 죽었다 → 아래 만료 처리
            console.warn('[우리끼리] 세션 확인 실패 — 저장된 열쇠로 계속', e);
          }
        }
        if (!restored) await bootstrap(saved.nickname || '', saved);
        await enterApp();
        return;
      } catch (e) {
        const detail = String(e.detail || e.message || e);
        if (/unauthorized/.test(detail)) {
          // 열쇠가 만료됐다: 네 저장소를 모두 비우고 아이디로 다시 로그인하게 한다
          console.warn('[우리끼리] 저장된 열쇠가 만료됐어요 — 다시 로그인해 주세요');
          await forgetLogin(saved.username
            ? '세션이 만료됐어요 — 아이디로 다시 로그인해 주세요'
            : '이 기기의 계정을 다시 확인해야 해요');
          return;
        }
        console.warn('[우리끼리] 자동 시작 실패', e);
        // 연결 문제: 열쇠는 그대로 두고 다시 시도할 수 있게 한다
        showJoin(saved.username ? 'login' : 'register', '연결이 잠시 불안정해요 — 다시 시도해 주세요');
        return;
      }
    }

    const next = LS.get('urikkiri.authNext', '');
    if (next) LS.del('urikkiri.authNext');
    showJoin(next === 'switch' ? 'login' : (addCode ? 'register' : 'login'));
    if (next === 'switch') {
      el.loginId.value = '';
      el.loginPw.value = '';
      setAuthMsg(el.loginMsg, '다른 계정으로 로그인해 주세요');
    }
  }

  window.__URIKKIRI__ = {
    state,
    api: API,
    live: READY,
    refreshFeed,
    sendFriendRequest,
    openChat,
    openMember,
    closeChat,
    closeMember: closeModal,
    history: (id) => historyFor(id).slice(),
    loadHistory: () => loadHistoryAll(),
    segments: (id) => buildSegments(historyFor(id)),
    addPoint: (id, p) => addHistoryPoint(id, p),
    place: (lat, lng) => new Promise((resolve) => placeSoon(lat, lng, resolve)),
    places: () => Array.from(state.places.entries()),
    fit: () => fitToPeople(false),
    reloadChat: () => (state.chatWith ? loadMessages(state.chatWith, { full: true }) : Promise.resolve([])),
    checkNearby,
    nearby: () => JSON.parse(JSON.stringify(state.nearby)),
    sendMessage: (text) => { el.chatInput.value = text; return sendMessage(); },
    dump: () => ({
      me: state.me ? { ...state.me } : null,
      friends: Array.from(state.friends.values()),
      incoming: state.incoming,
      outgoing: state.outgoing,
      chatWith: state.chatWith,
      errors: (window.__ERRORS__ || []).slice(),
    }),
  };

  document.addEventListener('pointerdown', wakeAudioOnce, true);
  document.addEventListener('keydown', wakeAudioOnce, true);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
