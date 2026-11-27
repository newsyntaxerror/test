// 출력 포맷(레이아웃) 프리셋 — 기본제공 4종 + 사용자 저장 포맷

export const BUILTINS = [
  {
    id: 'ver1',
    builtin: true,
    name: 'Ver.1 다인이네',
    mode: 'ver1',
    bg: '#000000',
    accent: '#FF2A85',
    titleColor: '#FFFFFF',
    titleLines: 2,
    box: { x: 70, y: 470, w: 940, h: 1000 },
    badge: { show: true, logo: 'cat', text: '다인이네', size: 136, textSize: 62 },
    fontScale: 1,
    neon: false,
    trackLabel: false,
  },
  {
    id: 'full',
    builtin: true,
    name: '풀스크린 9:16 릴스',
    mode: 'full',
    bg: '#000000',
    accent: '#FF2A85',
    titleColor: '#FFFFFF',
    titleLines: 2,
    box: { x: 0, y: 0, w: 1080, h: 1920 },
    badge: { show: true, logo: 'cat', text: '다인이네', size: 96, textSize: 44 },
    fontScale: 1,
    neon: false,
    trackLabel: false,
  },
  {
    id: 'cream',
    builtin: true,
    name: '화이트 미니멀',
    mode: 'cream',
    bg: '#FAF7F2',
    accent: '#FF2A85',
    titleColor: '#111111',
    titleLines: 2,
    box: { x: 70, y: 470, w: 940, h: 1000 },
    badge: { show: true, logo: 'cat', text: '다인이네', size: 120, textSize: 56 },
    fontScale: 1,
    neon: false,
    trackLabel: false,
  },
  {
    id: 'neon',
    builtin: true,
    name: '클럽 네온 EDM',
    mode: 'neon',
    bg: '#05040A',
    accent: '#00F5D4',
    titleColor: '#FFFFFF',
    titleLines: 2,
    box: { x: 90, y: 500, w: 900, h: 980 },
    badge: { show: true, logo: 'cat', text: '다인이네', size: 120, textSize: 54 },
    fontScale: 1,
    neon: true,
    trackLabel: true,
  },
];

export const LOGOS = {
  cat: 'assets/daini-cat.jpg',
  dog: 'assets/daini-dog.jpg',
};

export const STORE_KEY = 'daini-remix.formats.v1';

export function loadUserFormats() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((f) => f && f.id && f.name) : [];
  } catch (e) { return []; }
}

export function saveUserFormats(list) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); return true; }
  catch (e) { return false; }
}

export function cloneFormat(f, overrides = {}) {
  return JSON.parse(JSON.stringify({ ...f, ...overrides }));
}

export function allFormats() {
  return [...BUILTINS, ...loadUserFormats()];
}

export function findFormat(id) {
  return allFormats().find((f) => f.id === id) || BUILTINS[0];
}
