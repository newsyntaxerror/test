/* ─────────────────────────────────────────────────────────────
   달콩 비서실 — AI 연결
   · GPT(OpenAI) · 클로드(Anthropic) · 제미나이(Google) 를
     브라우저에서 바로 호출합니다. 키는 이 브라우저 localStorage 에만 있습니다.
   · 키가 없는 비서는 '시뮬레이션'으로 답하고, 답변에 그 표시를 붙입니다.
   ───────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  const PROVIDER_LABEL = { openai: 'GPT', anthropic: '클로드', gemini: '제미나이' };
  const TIMEOUT_MS = 70000;

  function settings() { return window.OfficeStore.settings; }

  function keyFor(provider) {
    const k = settings().keys || {};
    return (k[provider] || '').trim();
  }
  function modelFor(member) {
    const provider = member.provider;
    const m = (settings().models || {})[provider];
    if (m && m.trim()) return m.trim();
    return (member.model || '').trim();
  }

  function proxyFor(provider) {
    const p = (settings().proxy || {})[provider] || '';
    return p.trim().replace(/\/$/, '');
  }

  function endpoint(provider, path) {
    const prox = proxyFor(provider);
    if (prox) return prox + path;
    if (provider === 'openai') return 'https://api.openai.com' + path;
    if (provider === 'anthropic') return 'https://api.anthropic.com' + path;
    return 'https://generativelanguage.googleapis.com' + path;
  }
  function isConnected(member) {
    if (!member || !member.provider || member.provider === 'none') return false;
    return !!keyFor(member.provider);
  }

  function snippet(text, n) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    return t.length > (n || 46) ? t.slice(0, n || 46) + '…' : t;
  }

  function pick(arr, seed) {
    if (!arr.length) return '';
    let h = 0;
    const s = String(seed || '');
    for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 9973;
    return arr[h % arr.length];
  }

  /* ── 프롬프트 ───────────────────────────────────────────── */
  function systemPrompt(member, ctx) {
    const base = [
      `당신은 한국어로 일하는 개인 비서실 '달콩 비서실'의 ${member.name}입니다.`,
      `역할: ${member.role || '비서'}.`,
      `사용자는 '달콩' 대장님이며 호칭은 '대장님'입니다.`,
      '원칙:',
      '- 짧고 실무적으로 답합니다. 3~6문장 또는 짧은 목록. 인사말·자기소개를 반복하지 않습니다.',
      '- 확실하지 않은 사실은 추측이라고 밝히고, 확인이 필요하면 한 번에 하나만 묻습니다.',
      '- 과장된 칭찬이나 사과를 길게 늘어놓지 않습니다.',
      '- 다른 비서(AI)의 의견을 다룰 때는 이름을 쓰고 동의/보완/반대를 분명히 합니다.',
      '- 이모지는 문장당 최대 하나.',
    ];
    if (ctx.mode === 'debate') {
      if (ctx.round === 1) {
        base.push('- 지금은 1라운드입니다. 주제에 대한 당신의 핵심 주장을 2~4문장으로 먼저 냅니다. 다른 사람 의견은 아직 없습니다.');
      } else {
        base.push('- 지금은 2라운드입니다. 1라운드에서 나온 다른 비서들의 의견을 한두 개 짚어 동의·반박하고, 결론을 한 줄로 좁힙니다. 5문장 이내.');
      }
    }
    return base.join('\n');
  }

  function userPrompt(member, ctx) {
    const parts = [];
    parts.push(`[채널] #${ctx.channelName || '종합'}`);
    const history = (ctx.transcript || []).slice(-14);
    if (history.length) {
      parts.push('[최근 대화]');
      history.forEach((m) => {
        const who = m.authorKind === 'leader' ? `${m.authorName}(대장님)` : m.authorName;
        parts.push(`${who}: ${String(m.body || '').replace(/\n/g, ' ').slice(0, 500)}`);
      });
    }
    if (ctx.mode === 'debate' && ctx.round === 2 && (ctx.round1 || []).length) {
      parts.push('[1라운드 발언]');
      ctx.round1.forEach((s) => parts.push(`${s.name}: ${s.text}`));
    }
    parts.push('[대장님의 지시]');
    parts.push(ctx.topic || '');
    parts.push('');
    parts.push(`이제 ${member.name}으로서 답하세요. 이름표나 "답변:" 같은 머리말 없이 본문만 씁니다.`);
    return parts.join('\n');
  }

  /* ── 오류 ───────────────────────────────────────────────── */
  function friendlyError(status, message) {
    const msg = String(message || '');
    if (status === 401 || status === 403) return 'API 키가 올바르지 않거나 권한이 없습니다. 설정에서 키를 확인해 주세요.';
    if (status === 429) return '요청 한도에 걸렸습니다. 잠시 뒤 다시 시도해 주세요.';
    if (status === 404) return '모델 이름을 찾을 수 없습니다. 설정에서 모델명을 확인해 주세요.';
    if (status >= 500) return 'AI 서버가 잠시 불안정합니다. 잠시 뒤 다시 시도해 주세요.';
    return msg ? msg.slice(0, 200) : 'AI 호출에 실패했습니다.';
  }

  async function readError(res) {
    let detail = '';
    try {
      const j = await res.json();
      detail = (j && j.error && (j.error.message || j.error.status)) || (j && j.message) || '';
    } catch (e) { /* 본문 없음 */ }
    return new Error(friendlyError(res.status, detail));
  }

  async function withTimeout(fn) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try { return await fn(ctrl.signal); } finally { clearTimeout(timer); }
  }

  /* ── 공급자 호출 ────────────────────────────────────────── */
  async function callOpenAI({ key, model, system, user, maxTokens }) {
    return withTimeout(async (signal) => {
      const res = await fetch(endpoint('openai', '/v1/chat/completions'), {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          max_tokens: maxTokens || 700,
          temperature: 0.7,
        }),
      });
      if (!res.ok) throw await readError(res);
      const j = await res.json();
      const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (!text) throw new Error('빈 응답을 받았습니다.');
      return String(text).trim();
    });
  }

  async function callAnthropic({ key, model, system, user, maxTokens }) {
    return withTimeout(async (signal) => {
      const res = await fetch(endpoint('anthropic', '/v1/messages'), {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens || 700,
          temperature: 0.7,
          system,
          messages: [{ role: 'user', content: user }],
        }),
      });
      if (!res.ok) throw await readError(res);
      const j = await res.json();
      const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      if (!text) throw new Error('빈 응답을 받았습니다.');
      return String(text).trim();
    });
  }

  async function callGemini({ key, model, system, user, maxTokens }) {
    return withTimeout(async (signal) => {
      const url = endpoint('gemini', `/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`);
      const res = await fetch(url, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { temperature: 0.8, maxOutputTokens: maxTokens || 700 },
        }),
      });
      if (!res.ok) throw await readError(res);
      const j = await res.json();
      const cand = (j.candidates || [])[0];
      const text = cand && cand.content && (cand.content.parts || []).map((p) => p.text || '').join('');
      if (!text) {
        if (j.promptFeedback && j.promptFeedback.blockReason) throw new Error('요청이 안전 정책으로 차단되었습니다.');
        throw new Error('빈 응답을 받았습니다.');
      }
      return String(text).trim();
    });
  }

  /* ── 시뮬레이션 (키 없을 때) ────────────────────────────── */
  function simulate(member, ctx) {
    const topic = snippet(ctx.topic, 54);
    const others = (ctx.round1 || []).map((s) => s.name).filter((n) => n !== member.name);
    const who = others.length ? others.join(', ') : '동료들';
    const seed = (ctx.topic || '') + member.id;

    if (member.kind === 'pickle') {
      if (member.id === 'subpickle') {
        return pick([
          `대장님, 서브피클입니다 (시뮬레이션). 폰에서 바로 볼 수 있는 것부터 정리해 볼게요.\n· 「${topic}」 관련해서 지금 확인 가능한 건 알림·일정·장보기 목록 정도예요.\n작업실에 '대기'로 하나 올려 주시면 제가 잡고 있을게요.`,
          `대장님, 서브피클이에요 (시뮬레이션). 밖에 있을 때 처리할 일이면 제 쪽이 편해요.\n· 「${topic}」 → 이동 중 확인할 항목 3개로 쪼개서 다음에 보고드릴게요.`,
        ], seed);
      }
      return pick([
        `대장님, 복님이입니다 (지금은 시뮬레이션 모드예요 — 설정 → AI 연결에 키를 넣으면 제 진짜 판단이 여기 나옵니다).\n· 「${topic}」 건은 제가 작업실에 카드로 올리고, 오늘 안에 확인할 것부터 하나씩 처리하겠습니다.\n· 먼저 정할 것 하나만 여쭤도 될까요? 이번 주 안에 끝내는 걸 목표로 하면 될까요?`,
        `대장님, 접수했습니다 (시뮬레이션). 「${topic}」\n· 제가 맡을 부분: 정리·업로드·확인 연락\n· ${who}에게 넘길 부분: 초안·아이디어\n작업실에 3단계로 나눠 올려 둘게요.`,
      ], seed);
    }

    if (member.provider === 'openai') {
      return pick([
        `(시뮬레이션 · 키 없음) 「${topic}」에 대해 이렇게 접근해 보면 좋겠습니다.\n1. 목표를 숫자 하나로 좁히기 — 조회수인지 저장수인지 먼저 정합니다.\n2. 잘 된 사례 3개만 골라 공통점을 뽑습니다.\n3. 이번 주에 바로 할 1개만 실행합니다.\n키를 넣어 주시면 실제 리서치와 함께 더 구체적으로 답하겠습니다.`,
        `(시뮬레이션 · 키 없음) 아이디어부터 넓게 펼쳐 볼게요.\n· 훅 첫 2초: 결과를 먼저 보여주는 방식\n· 저장 유도: '나중에 쓸 3줄 요약'을 마지막에 붙이기\n· 재활용: 하나의 소재를 숏츠·쓰레드·캐러셀로 3번 씁니다\n설정에서 OpenAI 키를 넣으면 실제 모델이 이 자리에서 답합니다.`,
      ], seed);
    }
    if (member.provider === 'anthropic') {
      return pick([
        `(시뮬레이션 · 키 없음) 「${topic}」은 문장보다 구조가 먼저인 것 같습니다.\n· 결론을 첫 문단에 두고, 근거는 두 개까지만.\n· 반대되는 경우의 수를 한 줄 넣으면 신뢰가 올라갑니다.\n초안을 주시면 문장 단위로 다듬어 드리겠습니다.`,
        `(시뮬레이션 · 키 없음) 무리하게 넓히기보다 한 사람을 정해 쓰는 편이 낫겠습니다.\n· 독자: 30대 초반, 아이 키우는 분\n· 톤: 담백하게, 과장 없이\n· 금지: 숫자로 단정하는 표현\n키를 넣어 주시면 이 기준으로 실제 퇴고해 드립니다.`,
      ], seed);
    }
    if (member.provider === 'gemini') {
      return pick([
        `(시뮬레이션 · 키 없음) 요약하면 이렇습니다 — 「${topic}」\n· 확인된 것: 아직 없음(키 미연결)\n· 바로 할 수 있는 것: 작업실에 카드 만들기, 담당 정하기\n· 확인 필요: 마감과 범위\n설정에서 Gemini 키를 넣으면 검색·요약까지 실제로 해 드립니다.`,
        `(시뮬레이션 · 키 없음) 세 줄로 정리해 봤습니다.\n1. 지금 결정할 것: 이번 주 범위\n2. 미룰 것: 새 채널 확장\n3. 확인할 것: 지난번에 만든 자료 재사용 가능 여부\n키가 연결되면 최신 정보까지 반영해 다시 정리하겠습니다.`,
      ], seed);
    }
    return `(시뮬레이션) 「${topic}」 접수했습니다. 설정에서 API 키를 넣으면 실제 답변이 여기 표시됩니다.`;
  }

  /* ── 공개 API ───────────────────────────────────────────── */
  async function ask(member, ctx) {
    const useSim = !isConnected(member);
    if (useSim) {
      await new Promise((r) => setTimeout(r, 420 + Math.random() * 380));
      return { text: simulate(member, ctx), source: 'sim' };
    }
    const provider = member.provider;
    const key = keyFor(provider);
    const model = modelFor(member);
    const system = systemPrompt(member, ctx);
    const user = userPrompt(member, ctx);
    const args = { key, model, system, user, maxTokens: ctx.mode === 'debate' ? 500 : 800 };
    try {
      let text;
      if (provider === 'openai') text = await callOpenAI(args);
      else if (provider === 'anthropic') text = await callAnthropic(args);
      else if (provider === 'gemini') text = await callGemini(args);
      else throw new Error('연결되지 않은 비서입니다.');
      return { text, source: 'api', model };
    } catch (err) {
      return { text: '', source: 'api', error: describeError(provider, err), model };
    }
  }

  function describeError(provider, err) {
    const label = PROVIDER_LABEL[provider] || provider;
    const msg = String((err && err.message) || err || '');
    if (err && err.name === 'AbortError') return '응답이 너무 늦어 취소했습니다(70초).';
    if (/Failed to fetch|NetworkError|Load failed|Network request failed/i.test(msg)) {
      return `${label}에 브라우저에서 직접 연결하지 못했습니다(CORS/네트워크). ${provider === 'openai'
        ? 'OpenAI는 브라우저 직접 호출을 막는 경우가 있습니다. 설정에서 프록시 주소를 넣거나, 무료인 제미나이·클로드를 써 보세요.'
        : '설정에서 프록시 주소를 넣거나 잠시 뒤 다시 시도해 주세요.'}`;
    }
    return msg || 'AI 호출에 실패했습니다.';
  }

  async function testKey(provider) {
    const key = keyFor(provider);
    if (!key) return { ok: false, message: '키가 비어 있습니다.' };
    const model = (settings().models || {})[provider];
    try {
      if (provider === 'openai') await callOpenAI({ key, model, system: 'ping', user: '핑', maxTokens: 5 });
      else if (provider === 'anthropic') await callAnthropic({ key, model, system: 'ping', user: '핑', maxTokens: 5 });
      else if (provider === 'gemini') await callGemini({ key, model, system: 'ping', user: '핑', maxTokens: 5 });
      return { ok: true, message: '연결됐습니다.' };
    } catch (e) {
      return { ok: false, message: (e && e.message) || '연결 실패' };
    }
  }

  window.OfficeAI = { ask, testKey, isConnected, keyFor, modelFor, PROVIDER_LABEL, simulate };
})();
