// 유튜브 링크 → 오디오 (실험실)
// 공개 Cobalt 호환 API 또는 사용자 프록시를 시도하고, 실패하면 이유를 그대로 돌려준다.
// 가짜 성공은 만들지 않는다.

const PUBLICS = ['https://api.cobalt.tools/', 'https://co.wuk.sh/'];

function hostOf(u) {
  try { return new URL(u).host; } catch (e) { return u; }
}

export async function tryYoutube(url, proxy) {
  if (!/^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i.test(url)) {
    return { ok: false, errors: ['유튜브 링크 형식이 아니에요'] };
  }
  const endpoints = [];
  if (proxy) endpoints.push(proxy);
  endpoints.push(...PUBLICS);
  const errors = [];

  for (const ep of endpoints) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      const res = await fetch(ep, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ url, downloadMode: 'audio', audioFormat: 'mp3', filenameStyle: 'basic', vQuality: '720' }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch (e) {}
      if (!res.ok) {
        errors.push(`${hostOf(ep)} → HTTP ${res.status}`);
        continue;
      }
      if (data && data.status === 'error') {
        errors.push(`${hostOf(ep)} → ${(data.error && (data.error.code || data.error)) || 'error'}`);
        continue;
      }
      if (data && data.url) {
        return { ok: true, url: data.url, endpoint: ep, status: data.status || 'redirect' };
      }
      errors.push(`${hostOf(ep)} → 예상 밖 응답`);
    } catch (e) {
      const msg = /abort/i.test(e.name + e.message) ? '시간 초과' : (/Failed to fetch|NetworkError/i.test(e.message) ? 'CORS/네트워크 차단' : e.message);
      errors.push(`${hostOf(ep)} → ${msg}`);
    }
  }
  return { ok: false, errors };
}
