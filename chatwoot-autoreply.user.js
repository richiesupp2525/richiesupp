// ==UserScript==
// @name         Chatwoot Autoreply
// @namespace    sparkmoth-chatwoot
// @version      2.7.0
// @description  Автоответы клиентам в Chatwoot: приветствие и ответы на фразы вроде «сколько ждать?»
// @match        https://sparkmoth.com/app/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_addValueChangeListener
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const POLL_MS = 5 * 1000;   // как часто проверять диалоги
  const BTN_TOP = 174;        // стартовая позиция кнопки (пока вы её не перетащили)
  const BTN_RIGHT = 370;

  const TAB_ID = Math.random().toString(36).slice(2);
  const accountMatch = location.pathname.match(/\/app\/accounts\/(\d+)/);
  const ACCOUNT_ID = accountMatch ? accountMatch[1] : null;

  // ================= настройки =================
  const OLD_DEFAULT_TEXT = 'Приносим извинения за ожидание! Ваше обращение уже в работе, оператор ответит в ближайшее время.';
  const DEFAULT_VARIANTS = [
    'Уже разбираюсь.',
    'Уже занимаюсь вашим вопросом.',
    'Уже смотрю.',
    'Уже уточняю.',
  ];

  const DEFAULTS = {
    greetingEnabled: true,
    greeting: 'Здравствуйте! Мы получили ваше сообщение и скоро ответим.',
    greetingDelaySec: 0,
    greetingCooldownMin: 60,
    scope: 'me',   // me — назначенные мне; me_unassigned — мне и без агента; all — все открытые
    maxAgeMin: 15,
    rulesEnabled: true,
    rulesCooldownMin: 5,
    rules: [
      {
        id: 'wait',
        enabled: true,
        delaySec: 5,
        cooldownSec: 0,
        mode: 'sequence',
        keywords: [
          '/сколько.{0,20}(жд|ответ)/',
          '/долго.{0,25}(жд|ответ|отвеч)/',
          'почему так долго',
          'когда ответите',
          'жду ответа',
          'how long',
        ].join('\n'),
        texts: DEFAULT_VARIANTS.slice(),
      },
    ],
  };

  function loadSettings() {
    const saved = GM_getValue('settings', null);
    const s = Object.assign(JSON.parse(JSON.stringify(DEFAULTS)), saved || {});
    if (!saved) {
      const legacy = GM_getValue('message', '');
      if (legacy) s.greeting = legacy;
    }
    if (!Array.isArray(s.rules)) s.rules = JSON.parse(JSON.stringify(DEFAULTS.rules));
    s.rules = s.rules.map((r) => {
      if (Array.isArray(r.texts)) return r;
      const old = r.text || '';
      const texts = old === OLD_DEFAULT_TEXT ? DEFAULT_VARIANTS.slice() : (old ? [old] : []);
      return Object.assign({}, r, { texts });
    });
    return s;
  }

  // ================= сопоставление фраз =================
  const norm = (t) => String(t || '').toLowerCase().replace(/ё/g, 'е');
  const reCache = new Map();

  function matches(text, keywordsStr) {
    const t = norm(text);
    return String(keywordsStr || '')
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean)
      .some((k) => {
        if (k === '*') return true;
        const end = k.lastIndexOf('/');
        if (k.length > 2 && k[0] === '/' && end > 0) {
          let re = reCache.get(k);
          if (re === undefined) {
            try { re = new RegExp(k.slice(1, end).replace(/ё/gi, 'е'), 'i'); } catch (e) { re = null; }
            reCache.set(k, re);
          }
          return re ? re.test(t) : false;
        }
        return t.includes(norm(k));
      });
  }

  // ================= варианты ответов =================
  function ruleTexts(r) {
    const list = Array.isArray(r.texts) ? r.texts : (r.text ? [r.text] : []);
    return list.map((x) => String(x).trim()).filter(Boolean);
  }

  function ruleCooldown(r) {
    return r.cooldownSec === undefined ? 0 : Math.max(0, Number(r.cooldownSec) || 0);
  }

  // last — индекс варианта, отправленного в прошлый раз (или undefined)
  function pickVariant(n, mode, last) {
    if (n <= 1) return 0;
    if (mode === 'random') {
      let i = Math.floor(Math.random() * n);
      if (i === last) i = (i + 1 + Math.floor(Math.random() * (n - 1))) % n;
      return i;
    }
    return last === undefined ? 0 : (last + 1) % n;
  }

  // ================= API =================
  let clockOffsetMs = 0;
  let lastOk = 0;
  let lastErr = '';

  async function api(path, options = {}) {
    const res = await fetch(`/api/v1/accounts/${ACCOUNT_ID}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        api_access_token: GM_getValue('token', ''),
        ...(options.headers || {}),
      },
    });
    const dh = res.headers.get('Date');
    if (dh) {
      const t = Date.parse(dh);
      if (!isNaN(t)) clockOffsetMs = t - Date.now();
    }
    if (!res.ok) throw new Error(`${res.status} ${path}`);
    return res.json();
  }

  // только одна вкладка выполняет работу
  function isLeader() {
    const now = Date.now();
    const lock = GM_getValue('lock', null);
    if (!lock || lock.id === TAB_ID || now - lock.ts > POLL_MS * 3) {
      GM_setValue('lock', { id: TAB_ID, ts: now });
      return true;
    }
    return false;
  }

  // ================= основной цикл =================
  async function tickInner() {
    if (!ACCOUNT_ID || !GM_getValue('enabled', true)) return;
    if (!GM_getValue('token', '')) { lastErr = 'не указан API-токен'; renderTitle(); return; }
    if (!isLeader()) return;

    const s = loadSettings();
    let convs;
    try {
      const types = s.scope === 'all' ? ['all'] : s.scope === 'me_unassigned' ? ['me', 'unassigned'] : ['me'];
      const byId = new Map();
      for (const t of types) {
        const r = await api(`/conversations?status=open&assignee_type=${t}&page=1`);
        for (const c of (r.data && r.data.payload) || []) byId.set(c.id, c);
      }
      convs = Array.from(byId.values());
    } catch (e) {
      console.warn('[autoreply] list failed', e);
      lastErr = String((e && e.message) || e);
      renderTitle();
      return;
    }
    lastOk = Date.now();
    lastErr = '';
    renderTitle();

    const now = Math.floor((Date.now() + clockOffsetMs) / 1000);
    let nextWake = Infinity;
    const state = GM_getValue('state', {});
    state.replied = state.replied || {};
    state.done = state.done || {};   // диалог -> [id последнего обработанного сообщения клиента, время]
    state.seq = state.seq || {};
    const maxAge = Math.max(1, Number(s.maxAgeMin) || 15) * 60;

    for (const c of convs) {
      // смотрим только на самое последнее сообщение диалога: если клиент написал 5-6 раз подряд,
      // отвечаем один раз — на последнее, через заданное время после него
      const last = c.messages && c.messages[c.messages.length - 1];
      if (!last || last.message_type !== 0) continue;               // последнее сообщение не от клиента
      const prevDone = state.done[c.id];
      if (prevDone && prevDone[0] >= last.id) continue;             // это сообщение уже обработано

      if (now - last.created_at > maxAge) { state.done[c.id] = [last.id, now]; continue; }  // слишком старое

      // что отвечать: правило по фразе или приветствие
      let rule = null;
      if (s.rulesEnabled) {
        rule = s.rules.find((r) => r.enabled && ruleTexts(r).length && matches(last.content, r.keywords)) || null;
      }
      let plan = null;
      if (rule) {
        plan = { rule, delay: Number(rule.delaySec) || 0, key: `k:${c.id}:${rule.id}`, cooldown: ruleCooldown(rule) };
      } else if (s.greetingEnabled) {
        plan = { rule: null, delay: s.greetingDelaySec, key: `g:${c.id}`, cooldown: s.greetingCooldownMin * 60 };
      }
      if (!plan) { state.done[c.id] = [last.id, now]; continue; }

      // ждём заданное число секунд после последнего сообщения клиента
      const wait = plan.delay - (now - last.created_at);
      if (wait > 0) { nextWake = Math.min(nextWake, wait); continue; }

      if (now - (state.replied[plan.key] || 0) < plan.cooldown) { state.done[c.id] = [last.id, now]; continue; }

      let reply;
      let seqKey = null;
      let prevSeq;
      if (plan.rule) {
        const variants = ruleTexts(plan.rule);
        seqKey = `${c.id}:${plan.rule.id}`;
        prevSeq = state.seq[seqKey];
        const pick = pickVariant(variants.length, plan.rule.mode, prevSeq ? prevSeq[0] : undefined);
        reply = variants[pick];
        state.seq[seqKey] = [pick, now];
      } else {
        reply = s.greeting;
      }

      state.replied[plan.key] = now;
      state.done[c.id] = [last.id, now];
      GM_setValue('state', state);
      try {
        await api(`/conversations/${c.id}/messages`, {
          method: 'POST',
          body: JSON.stringify({ content: reply, message_type: 'outgoing', private: false }),
        });
      } catch (e) {
        console.warn('[autoreply] send failed', c.id, e);
        delete state.replied[plan.key];
        if (prevDone) state.done[c.id] = prevDone; else delete state.done[c.id];
        if (seqKey) {
          if (prevSeq === undefined) delete state.seq[seqKey];
          else state.seq[seqKey] = prevSeq;
        }
      }
    }

    // чистка старых записей
    const DAY = 24 * 3600;
    for (const k in state.replied) if (now - state.replied[k] > DAY) delete state.replied[k];
    for (const k in state.done) if (now - state.done[k][1] > DAY) delete state.done[k];
    for (const k in state.seq) if (now - state.seq[k][1] > DAY) delete state.seq[k];
    GM_setValue('state', state);

    // если до отправки осталось меньше интервала опроса — проснуться точно ко времени
    if (nextWake !== Infinity && nextWake < POLL_MS / 1000) {
      setTimeout(tick, nextWake * 1000 + 300);
    }
  }

  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try { await tickInner(); } finally { running = false; }
  }

  // ================= UI: хелперы =================
  function el(tag, css, props, children) {
    const n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (props) Object.assign(n, props);
    (children || []).forEach((c) => n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return n;
  }

  const FIELD = 'width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #3a3f47;border-radius:6px;background:#14161a;color:#e6e8eb;font:13px/1.4 system-ui,sans-serif;outline:none;';
  const BTN = 'padding:8px 14px;border:none;border-radius:6px;font:600 13px/1 system-ui,sans-serif;cursor:pointer;';

  function check(label, checked) {
    const input = el('input', 'margin:0 8px 0 0;width:16px;height:16px;accent-color:#22a559;', { type: 'checkbox', checked: !!checked });
    const wrap = el('label', 'display:flex;align-items:center;margin:8px 0;cursor:pointer;', null, [input, label]);
    return { wrap, input };
  }

  function field(label, node, hint) {
    const kids = [el('div', 'margin:0 0 4px;color:#a8aeb7;font-size:12px;', { textContent: label }), node];
    if (hint) kids.push(el('div', 'margin:4px 0 0;color:#7d848e;font-size:11px;', { textContent: hint }));
    return el('div', 'margin:10px 0;', null, kids);
  }

  function section(title) {
    return el('div', 'margin:18px 0 6px;padding-top:12px;border-top:1px solid #2f343b;font-weight:700;font-size:14px;', { textContent: title });
  }

  const newId = () => 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

  // ================= UI: панель настроек =================
  function openPanel() {
    if (document.getElementById('cwar-overlay')) return;
    const s = loadSettings();

    const overlay = el('div', 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;', { id: 'cwar-overlay' });
    const panel = el('div', 'width:min(660px,94vw);max-height:88vh;overflow:auto;background:#1e2126;color:#e6e8eb;border-radius:12px;padding:18px 20px;box-shadow:0 10px 40px rgba(0,0,0,.5);font:13px/1.4 system-ui,sans-serif;');
    overlay.appendChild(panel);

    const onKey = (e) => { if (e.key === 'Escape') close(); };
    function close() {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
    }
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    panel.addEventListener('keydown', (e) => e.stopPropagation());

    panel.appendChild(el('div', 'font-size:16px;font-weight:700;', { textContent: 'Автоответ — настройки' }));

    const token = el('input', FIELD, { type: 'password', value: GM_getValue('token', ''), placeholder: 'Профиль → Access Token' });
    panel.appendChild(field('API-токен Chatwoot', token));
    const scopeSel = el('select', FIELD + 'width:320px;', null, [
      el('option', '', { value: 'me', textContent: 'Только назначенные мне' }),
      el('option', '', { value: 'me_unassigned', textContent: 'Назначенные мне и без агента' }),
      el('option', '', { value: 'all', textContent: 'Все открытые диалоги' }),
    ]);
    scopeSel.value = ['me', 'me_unassigned', 'all'].includes(s.scope) ? s.scope : 'me';
    panel.appendChild(field('В каких диалогах отвечать', scopeSel, 'Скрипт отвечает от вашего имени, поэтому «Только назначенные мне» — безопасный вариант.'));
    const maxAgeIn = el('input', FIELD + 'width:120px;', { type: 'number', min: '1', value: s.maxAgeMin });
    panel.appendChild(field('Не отвечать на сообщения старше, мин', maxAgeIn, 'Защита от массовых ответов в старых диалогах.'));

    // --- приветствие ---
    panel.appendChild(section('Приветственный автоответ'));
    const gEn = check('Включить', s.greetingEnabled);
    const gText = el('textarea', FIELD + 'resize:vertical;', { rows: 3, value: s.greeting });
    const gDelay = el('input', FIELD + 'width:120px;', { type: 'number', min: '0', value: s.greetingDelaySec });
    const gCd = el('input', FIELD + 'width:120px;', { type: 'number', min: '1', value: s.greetingCooldownMin });
    panel.appendChild(gEn.wrap);
    panel.appendChild(field('Текст', gText));
    panel.appendChild(el('div', 'display:flex;gap:16px;flex-wrap:wrap;', null, [
      field('Задержка перед отправкой, сек', gDelay),
      field('Не чаще раза в N минут (на диалог)', gCd),
    ]));

    // --- правила ---
    panel.appendChild(section('Ответы на фразы клиента'));
    const rEn = check('Включить', s.rulesEnabled);
    panel.appendChild(rEn.wrap);

    const rulesBox = el('div');
    const rows = [];

    function addRuleRow(rule) {
      const row = { id: rule.id || newId() };
      const en = check('Правило включено', rule.enabled !== false);
      row.enabled = en.input;
      row.keywords = el('textarea', FIELD + 'resize:vertical;', { rows: 4, value: rule.keywords || '' });
      row.text = el('textarea', FIELD + 'resize:vertical;', { rows: 5, value: ruleTexts(rule).join('\n') });
      row.delay = el('input', FIELD + 'width:140px;', { type: 'number', min: '0', value: Number(rule.delaySec) || 0 });
      row.cooldown = el('input', FIELD + 'width:140px;', { type: 'number', min: '0', value: ruleCooldown(rule) });
      row.mode = el('select', FIELD + 'width:200px;', null, [
        el('option', '', { value: 'sequence', textContent: 'По очереди' }),
        el('option', '', { value: 'random', textContent: 'Случайно' }),
      ]);
      row.mode.value = rule.mode === 'random' ? 'random' : 'sequence';
      const del = el('button', BTN + 'background:#7a2e2e;color:#fff;padding:6px 10px;', { type: 'button', textContent: 'Удалить' });
      row.node = el('div', 'border:1px solid #2f343b;border-radius:8px;padding:6px 12px 10px;margin:10px 0;background:#1a1d22;', null, [
        el('div', 'display:flex;justify-content:space-between;align-items:center;', null, [en.wrap, del]),
        field('Фразы клиента (по одной в строке; /регулярка/ тоже можно)', row.keywords, '* — любое сообщение клиента. Правила проверяются сверху вниз, срабатывает первое подходящее.'),
        field('Варианты ответа (по одному в строке)', row.text, 'Клиент пишет снова — получает следующий вариант.'),
        el('div', 'display:flex;gap:16px;flex-wrap:wrap;', null, [
          field('Отправить через, сек', row.delay, '0 — сразу. Если оператор ответит раньше, шаблон не отправится.'),
          field('Пауза между ответами, сек', row.cooldown, 'Минимум между двумя ответами в одном диалоге. 0 — отвечать на каждое сообщение.'),
          field('Порядок вариантов', row.mode),
        ]),
      ]);
      del.addEventListener('click', () => {
        row.node.remove();
        rows.splice(rows.indexOf(row), 1);
      });
      rows.push(row);
      rulesBox.appendChild(row.node);
    }

    s.rules.forEach(addRuleRow);
    panel.appendChild(rulesBox);

    const add = el('button', BTN + 'background:#2f343b;color:#e6e8eb;', { type: 'button', textContent: '+ Добавить правило' });
    add.addEventListener('click', () => addRuleRow({ id: newId(), enabled: true, delaySec: 5, cooldownSec: 0, mode: 'sequence', keywords: '', texts: [] }));
    panel.appendChild(add);

    // --- кнопки ---
    const cancel = el('button', BTN + 'background:#2f343b;color:#e6e8eb;', { type: 'button', textContent: 'Отмена' });
    const save = el('button', BTN + 'background:#22a559;color:#fff;', { type: 'button', textContent: 'Сохранить' });
    cancel.addEventListener('click', close);
    save.addEventListener('click', () => {
      GM_setValue('token', token.value.trim());
      GM_setValue('settings', {
        greetingEnabled: gEn.input.checked,
        greeting: gText.value.trim() || DEFAULTS.greeting,
        greetingDelaySec: Math.max(0, Number(gDelay.value) || 0),
        greetingCooldownMin: Math.max(1, Number(gCd.value) || 60),
        scope: scopeSel.value,
        maxAgeMin: Math.max(1, Number(maxAgeIn.value) || 15),
        rulesEnabled: rEn.input.checked,
        rulesCooldownMin: s.rulesCooldownMin,
        rules: rows
          .map((r) => ({
            id: r.id,
            enabled: r.enabled.checked,
            delaySec: Math.max(0, Number(r.delay.value) || 0),
            cooldownSec: Math.max(0, Number(r.cooldown.value) || 0),
            mode: r.mode.value,
            keywords: r.keywords.value,
            texts: r.text.value.split('\n').map((x) => x.trim()).filter(Boolean),
          }))
          .filter((r) => r.texts.length && r.keywords.trim()),
      });
      close();
    });
    panel.appendChild(el('div', 'display:flex;justify-content:flex-end;gap:10px;margin-top:18px;', null, [cancel, save]));

    document.body.appendChild(overlay);
  }

  // ================= UI: перетаскиваемая кнопка =================
  const box = el('div', [
    'position:fixed', 'z-index:2147483646', 'display:flex', 'align-items:center', 'gap:4px',
    'padding:3px 4px', 'border-radius:999px', 'background:rgba(20,22,26,.88)',
    'box-shadow:0 1px 6px rgba(0,0,0,.35)', 'cursor:grab', 'touch-action:none', 'user-select:none',
  ].join(';'));

  const grip = el('span', 'color:#8a8f98;font:700 12px/1 system-ui,sans-serif;padding:0 2px 0 6px;letter-spacing:-2px;', { textContent: '⋮⋮', title: 'Перетащить' });
  const btn = el('button', 'padding:6px 12px;border:none;border-radius:999px;font:600 12px/1 system-ui,sans-serif;color:#fff;cursor:pointer;', { type: 'button', title: 'Включить / выключить автоответ' });
  const gear = el('button', 'padding:4px 8px;border:none;border-radius:999px;background:transparent;color:#cfd3d8;font:15px/1 system-ui,sans-serif;cursor:pointer;', { type: 'button', textContent: '⚙', title: 'Настройки' });
  box.appendChild(grip);
  box.appendChild(btn);
  box.appendChild(gear);

  function renderBtn() {
    const on = GM_getValue('enabled', true);
    btn.textContent = 'Автоответ: ' + (on ? 'ВКЛ' : 'ВЫКЛ');
    btn.style.background = on ? '#22a559' : '#8a8f98';
  }

  // в подсказке к кнопке видно, когда была последняя проверка (работает ли скрипт в фоне)
  function renderTitle() {
    const t = lastOk ? 'последняя проверка: ' + new Date(lastOk).toLocaleTimeString() : 'проверок ещё не было';
    btn.title = 'Включить / выключить автоответ\n' + t + (lastErr ? '\nошибка: ' + lastErr : '');
  }

  function toggle() {
    GM_setValue('enabled', !GM_getValue('enabled', true));
    renderBtn();
  }

  function applyPos(p) {
    const w = box.offsetWidth || 180;
    const h = box.offsetHeight || 34;
    const left = Math.min(Math.max(0, p.left), Math.max(0, window.innerWidth - w));
    const top = Math.min(Math.max(0, p.top), Math.max(0, window.innerHeight - h));
    box.style.left = left + 'px';
    box.style.top = top + 'px';
  }

  let drag = null;
  let suppressClick = false;

  box.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const r = box.getBoundingClientRect();
    drag = { sx: e.clientX, sy: e.clientY, left: r.left, top: r.top, active: false, id: e.pointerId };
  });

  box.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (!drag.active) {
      if (Math.hypot(dx, dy) < 5) return;
      drag.active = true;
      try { box.setPointerCapture(drag.id); } catch (err) { /* ignore */ }
      box.style.cursor = 'grabbing';
    }
    applyPos({ left: drag.left + dx, top: drag.top + dy });
  });

  function endDrag() {
    if (!drag) return;
    if (drag.active) {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 80);
      const r = box.getBoundingClientRect();
      GM_setValue('pos', { left: r.left, top: r.top });
    }
    box.style.cursor = 'grab';
    drag = null;
  }
  box.addEventListener('pointerup', endDrag);
  box.addEventListener('pointercancel', endDrag);

  btn.addEventListener('click', () => { if (!suppressClick) toggle(); });
  gear.addEventListener('click', () => { if (!suppressClick) openPanel(); });

  document.body.appendChild(box);
  renderBtn();
  applyPos(GM_getValue('pos', null) || { left: window.innerWidth - BTN_RIGHT - box.offsetWidth, top: BTN_TOP });

  window.addEventListener('resize', () => {
    const r = box.getBoundingClientRect();
    applyPos({ left: r.left, top: r.top });
  });

  // синхронизация между вкладками
  GM_addValueChangeListener('enabled', renderBtn);
  GM_addValueChangeListener('pos', (n, o, v, remote) => { if (remote && v) applyPos(v); });

  // ================= меню Tampermonkey =================
  GM_registerMenuCommand('Autoreply: настройки', openPanel);
  GM_registerMenuCommand('Autoreply: вкл/выкл', toggle);
  GM_registerMenuCommand('Autoreply: сбросить позицию кнопки', () => {
    GM_setValue('pos', null);
    applyPos({ left: window.innerWidth - BTN_RIGHT - box.offsetWidth, top: BTN_TOP });
  });

  function startTimer() {
    try {
      const src = `setInterval(function () { postMessage(0); }, ${POLL_MS});`;
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      w.onmessage = () => tick();
      w.onerror = () => { w.terminate(); setInterval(tick, POLL_MS); };
      return;
    } catch (e) { /* страница запретила воркеры */ }
    setInterval(tick, POLL_MS);
  }
  startTimer();
  // удерживаем Web Lock: Chrome реже «замораживает» такую вкладку (на лучшее усилие, не гарантия)
  try {
    if (navigator.locks) navigator.locks.request('cwar-keepalive-' + TAB_ID, () => new Promise(() => {}));
  } catch (e) { /* не критично */ }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  setTimeout(tick, 3000);
})();
