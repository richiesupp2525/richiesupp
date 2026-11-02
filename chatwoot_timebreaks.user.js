// ==UserScript==
// @name         Chatwoot Status: Day Plan (v5 design)
// @namespace    sparkmoth
// @version      5.10
// @description  План ТБ и обеда, авто-"Занят" за 5 минут до начала, уведомления рядом с окном. Новый дизайн.
// @match        https://sparkmoth.com/app/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const VERSION = "5.10"; // держите в синхроне со строкой @version выше

  // ===== НАСТРОЙКИ =====
  const LEAD_MIN = 5;      // за сколько минут до начала переходить в «Занят»
  const BREAK_MIN = 10;    // длительность перерыва
  const GUARD_BREAK_MIN = 0;   // за сколько минут до конца смены нельзя брать ТБ (0 — можно в любое время)
  const GUARD_LUNCH_MIN = 30;  // за сколько минут до конца смены нельзя брать обед (0 — можно в любое время)
  const LUNCH_MIN = 60;    // длительность обеда
  const FIRE_EARLY_SEC = 10; // запрос отправляется заранее, чтобы статус уже был «Занят» ровно за 5 минут (после первой смены подстраивается сам)
  const USE_SERVER_TIME = true; // сверять часы ПК с временем сервера Chatwoot (если часы ПК спешат/отстают, поправка учитывается)
  const TOAST_MS = 20000;  // сколько показывать уведомление
  const RELOAD_AFTER_CHANGE = false; // true — перезагружать страницу после смены статуса (запасной вариант)
  // =====================

  const LS_PLAN = "cw_dp_plan";
  const LS_STATE = "cw_dp_state";
  const LS_TOAST = "cw_dp_toast";
  const LS_POS = "cw_dp_pos";
  const LS_COLLAPSED = "cw_dp_collapsed";
  const LS_RETURN = "cw_dp_return";
  const LS_TIMER = "cw_dp_timer";
  const LS_LAT = "cw_dp_latency";

  const read = (k, def) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? def : v; } catch (e) { return def; } };
  const write = (k, v) => (v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)));

  // ---------- API ----------
  function getAuth() {
    const m = document.cookie.match(/(?:^|;\s*)cw_d_session_info=([^;]+)/);
    if (!m) throw new Error("нет cookie сессии");
    let data = JSON.parse(decodeURIComponent(m[1]));
    if (typeof data === "string") data = JSON.parse(data);
    return data;
  }
  function headers(a) {
    return {
      "Content-Type": "application/json",
      "access-token": a["access-token"],
      client: a.client,
      uid: a.uid,
      expiry: a.expiry,
      "token-type": a["token-type"] || "Bearer",
    };
  }
  function accountId() {
    const m = location.pathname.match(/\/accounts\/(\d+)/);
    return m ? Number(m[1]) : null;
  }
  function refreshUi(status) {
    try {
      const app = document.querySelector("#app");
      const store = app && app.__vue_app__ && app.__vue_app__.config.globalProperties.$store;
      if (store) store.dispatch("setCurrentUserAvailability", status);
    } catch (e) { console.warn("[Day Plan] не удалось обновить интерфейс", e); }
  }
  function earlyMs() {
    const a = read(LS_LAT, []);
    if (!a.length) return FIRE_EARLY_SEC * 1000;
    return Math.min(30000, Math.max(2000, Math.max.apply(null, a) + 1500));
  }
  // ---------- Сверка часов ПК с сервером ----------
  let clockOffset = 0, clockSynced = false;
  const nowMs = () => Date.now() + clockOffset;
  async function syncClock() {
    if (!USE_SERVER_TIME) return;
    const samples = [];
    for (let i = 0; i < 4; i++) {
      try {
        const t0 = Date.now();
        const r = await fetch("/api/v1/profile?_=" + t0 + i, { cache: "no-store", headers: headers(getAuth()) });
        const t1 = Date.now();
        const dh = r.headers.get("Date");
        if (dh) {
          const mid = (t0 + t1) / 2;
          samples.push({ lo: Date.parse(dh) - mid, rtt: t1 - t0 });
        }
      } catch (e) {}
      await new Promise((res) => setTimeout(res, 230 + i * 70));
    }
    if (!samples.length) return;
    const lo = Math.max.apply(null, samples.map((x) => x.lo));
    const hi = Math.min.apply(null, samples.map((x) => x.lo + 1000));
    const raw = Math.round(lo < hi ? (lo + hi) / 2 : samples.sort((a, b) => a.rtt - b.rtt)[0].lo + 500);
    clockOffset = Math.abs(raw) >= 1000 ? raw : 0;
    clockSynced = true;
  }
  function getStore() {
    const app = document.querySelector("#app");
    if (!app) return null;
    if (app.__vue_app__) return app.__vue_app__.config.globalProperties.$store || null;
    if (app.__vue__) return app.__vue__.$store || null;
    return null;
  }
  async function setStatus(status) {
    const id = accountId();
    if (!id) return;
    const t0 = performance.now();
    let via = "api";
    const store = getStore();
    if (store) {
      try {
        await store.dispatch("updateAvailability", { availability: status, account_id: id });
        if (store.getters.getCurrentUserAvailability === status) via = "store";
      } catch (e) { console.warn("[Day Plan] store:", e); }
    }
    if (via !== "store") {
      const r = await fetch("/api/v1/profile/availability", {
        method: "POST",
        headers: headers(getAuth()),
        body: JSON.stringify({ profile: { availability: status, account_id: id } }),
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      refreshUi(status);
    }
    const req = Math.round(performance.now() - t0);
    let ui = null;
    if (store && typeof store.getters.getCurrentUserAvailability === "string") {
      while (store.getters.getCurrentUserAvailability !== status && performance.now() - t0 < 12000) {
        await new Promise((r) => setTimeout(r, 150));
      }
      ui = Math.round(performance.now() - t0);
    }
    const total = Math.max(req, ui || 0);
    const lat = read(LS_LAT, []); lat.push(total); write(LS_LAT, lat.slice(-5));
    if (RELOAD_AFTER_CHANGE) setTimeout(() => location.reload(), 800);
  }
  async function safe(status) {
    try { await setStatus(status); }
    catch (e) { console.error("[Day Plan]", e); toast("⚠️ Не удалось сменить статус: " + e.message, "err"); }
  }

  // ---------- Уведомление ----------
  function toast(text, kind) { write(LS_TOAST, { text, kind: kind || "info", until: Date.now() + TOAST_MS, id: Date.now() }); renderToast(); }

  // ---------- Помощники ----------
  const hhmm = (ts) => { const d = new Date(ts); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
  const fmt = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const mm = String(m).padStart(2, "0"), ss = String(sec).padStart(2, "0");
    return h ? h + ":" + mm + ":" + ss : mm + ":" + ss;
  };
  const clamp01 = (x) => Math.min(1, Math.max(0, x));

  const guardMin = (e) => (e.type === "lunch" ? GUARD_LUNCH_MIN : GUARD_BREAK_MIN);

  function todayEvents() {
    const plan = read(LS_PLAN, null);
    if (!plan) return [];
    const out = [];
    const mk = (id, type, label, t, dur) => {
      if (!t) return;
      const [h, m] = t.split(":").map(Number);
      const d = new Date(); d.setHours(h, m, 0, 0);
      out.push({ id, type, label, start: d.getTime(), dur });
    };
    (plan.b || []).forEach((t, i) => mk("b" + i, "break", "ТБ " + (i + 1), t, BREAK_MIN));
    mk("l", "lunch", "Обед", plan.l, LUNCH_MIN);
    mk("e", "shift", "Конец смены", plan.e, 0);
    out.sort((a, b) => a.start - b.start);
    const shift = out.find((e) => e.type === "shift");
    if (shift) out.forEach((e) => { if (e.type !== "shift" && guardMin(e) > 0 && e.start >= shift.start - guardMin(e) * 60000) e.blocked = true; });
    return out;
  }
  function getState() {
    const day = new Date().toDateString();
    const st = read(LS_STATE, null);
    return st && st.day === day ? st : { day, done: {} };
  }

  async function eventsTick() {
    const evs = todayEvents();
    if (!evs.length) return false;
    const st = getState();
    const now = nowMs();
    for (const e of evs) {
      const end = e.start + e.dur * 60000;
      if (e.blocked) continue;
      const s = st.done[e.id] || (st.done[e.id] = {});
      if (e.type === "shift") {
        if (!s.busy && now >= e.start && now < e.start + 3 * 60000) {
          s.busy = true; s.end = true; write(LS_STATE, st);
          toast("🏁 Конец смены (" + hhmm(e.start) + "). Перехожу в «Занят»", "busy");
          await safe("busy");
          return true;
        }
        continue;
      }
      const early = earlyMs();
      const fireAt = e.start - LEAD_MIN * 60000 - early;
      if (!s.busy && now >= fireAt && now < end) {
        s.busy = true; write(LS_STATE, st);
        const left = Math.round((e.start - now) / 60000);
        toast((e.type === "lunch" ? "🍽 " : "☕ ") + e.label + (left > 0 ? " через " + left + " мин (" + hhmm(e.start) + ")" : " идёт") + ". Перехожу в «Занят»", "busy");
        await safe("busy");
        return true;
      }
      if (now >= end && !s.end) {
        s.end = true; write(LS_STATE, st);
        const nextSoon = evs.some((o) => o !== e && o.type !== "shift" && !o.blocked && now >= o.start - LEAD_MIN * 60000 && now < o.start + o.dur * 60000);
        if (s.busy && read(LS_RETURN, true) && !nextSoon) {
          toast("✅ " + e.label + " закончился. Возвращаю «В сети»", "ok");
          await safe("online");
          return true;
        }
      }
    }
    return false;
  }

  async function timerTick() {
    const t = read(LS_TIMER, null);
    if (!t) return false;
    const now = nowMs();
    if (t.busyAt && now >= t.busyAt) {
      write(LS_TIMER, t.backMin > 0 ? { backAt: now + t.backMin * 60000 } : null);
      toast("⏱ Таймер: перехожу в «Занят»", "busy");
      await safe("busy");
      return true;
    }
    if (t.backAt && now >= t.backAt) {
      write(LS_TIMER, null);
      toast("⏱ Таймер: возвращаю «В сети»", "ok");
      await safe("online");
      return true;
    }
    return false;
  }

  // ---------- Стили ----------
  const css = `
  .cwdp{display:none;position:fixed;z-index:99999;width:292px;overflow-y:auto;overscroll-behavior:contain;box-sizing:border-box;color:#ececf1;font:13px/1.35 -apple-system,"Segoe UI",Inter,system-ui,sans-serif;
    background:rgba(24,24,29,.86);backdrop-filter:blur(18px) saturate(1.4);-webkit-backdrop-filter:blur(18px) saturate(1.4);
    border:1px solid rgba(255,255,255,.09);border-radius:18px;box-shadow:0 18px 50px rgba(0,0,0,.5),0 2px 8px rgba(0,0,0,.3);user-select:none}
  .cwdp *{box-sizing:border-box}
  .cwdp.open{display:block;animation:cwdpIn .2s ease-out}
  .cwdp .cwdp-chev{transform:rotate(180deg)}
  .cwdp::-webkit-scrollbar{width:6px}.cwdp::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:6px}
  .cwdp-head{display:flex;align-items:center;gap:10px;padding:12px 14px;cursor:pointer}
  .cwdp-logo{width:28px;height:28px;border-radius:9px;display:grid;place-items:center;background:linear-gradient(135deg,#6366f1,#8b5cf6 55%,#ec4899);box-shadow:0 4px 12px rgba(139,92,246,.45)}
  .cwdp-logo svg{width:16px;height:16px;stroke:#fff}
  .cwdp-title{flex:1;min-width:0}
  .cwdp-title b{display:block;font-size:13px;font-weight:650;letter-spacing:.1px}
  .cwdp-title em{font-style:normal;font-size:10px;font-weight:650;color:#a5b4fc;background:rgba(129,140,248,.18);padding:1px 6px;border-radius:10px;margin-left:6px;vertical-align:1px}
  .cwdp-title span{display:block;font-size:11px;color:#8d8d99;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cwdp-chev{width:18px;height:18px;stroke:#8d8d99;transition:transform .2s}
  .cwdp.collapsed .cwdp-chev{transform:rotate(-90deg)}
  .cwdp.collapsed .cwdp-body{display:none}
  .cwdp-body{padding:0 14px 14px}
  .cwdp-hero{position:relative;overflow:hidden;border-radius:14px;padding:12px 14px;margin-bottom:12px;background:linear-gradient(135deg,rgba(99,102,241,.22),rgba(139,92,246,.12));border:1px solid rgba(139,92,246,.28)}
  .cwdp-hero.busy{background:linear-gradient(135deg,rgba(245,158,11,.25),rgba(239,68,68,.12));border-color:rgba(245,158,11,.4)}
  .cwdp-hero.idle{background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.07)}
  .cwdp-hl{font-size:11px;color:#b4b4c2;text-transform:uppercase;letter-spacing:.7px;font-weight:600}
  .cwdp-hn{font-size:12.5px;margin-top:2px;color:#d9d9e3}
  .cwdp-hc{font:700 30px/1.15 ui-monospace,"SF Mono",Menlo,Consolas,monospace;letter-spacing:-.5px;margin:6px 0 9px;font-variant-numeric:tabular-nums}
  .cwdp-bar{height:5px;border-radius:5px;background:rgba(255,255,255,.1);overflow:hidden}
  .cwdp-bar i{display:block;height:100%;width:0;border-radius:5px;background:linear-gradient(90deg,#818cf8,#c084fc);transition:width .9s linear}
  .cwdp-hero.busy .cwdp-bar i{background:linear-gradient(90deg,#fbbf24,#f87171)}
  .cwdp-clock{display:flex;align-items:center;gap:8px;padding:7px 10px;margin-bottom:12px;border-radius:10px;background:rgba(255,255,255,.04);border:1px dashed rgba(255,255,255,.12)}
  .cwdp-clock .t{flex:1;min-width:0;font-size:11px;line-height:1.3;color:#9a9aa8}
  .cwdp-clock .t b{display:block;font-size:11.5px;font-weight:600;color:#c4c4d0}
  .cwdp-clock .n{font:700 14px ui-monospace,Menlo,Consolas,monospace;color:#fff;font-variant-numeric:tabular-nums}
  .cwdp-sec{font-size:11px;font-weight:600;color:#8d8d99;text-transform:uppercase;letter-spacing:.7px;margin:0 0 7px}
  .cwdp-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:7px;margin-bottom:10px}
  .cwdp-cell{margin:0!important;min-width:0;overflow:hidden;display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:10px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.06);transition:border-color .15s}
  .cwdp-cell:focus-within{border-color:rgba(129,140,248,.7)}
  .cwdp-cell.wide{grid-column:1/-1}
  .cwdp-dot{width:8px;height:8px;border-radius:50%;flex:none;background:#60a5fa;box-shadow:0 0 8px #60a5fa88}
  .cwdp-dot.s{background:#f472b6;box-shadow:0 0 8px #f472b688}
  .cwdp-dot.l{background:#a78bfa;box-shadow:0 0 8px #a78bfa88}
  .cwdp-cell span{flex:1;min-width:0;font-size:12px;color:#c4c4d0;white-space:nowrap}
  .cwdp input[type=time],.cwdp input[type=number]{all:unset!important;box-sizing:border-box!important;display:block!important;background:transparent!important;border:0!important;box-shadow:none!important;outline:0!important;margin:0!important;height:auto!important;min-width:0!important;max-width:100%!important;color:#fff!important;font:600 12.5px ui-monospace,Menlo,Consolas,monospace!important;color-scheme:dark;padding:2px 0!important;width:auto!important;text-align:right!important;cursor:text}
  .cwdp input[type=time]{flex:none!important;width:74px!important}
  .cwdp input[type=time]::-webkit-calendar-picker-indicator{margin:0 0 0 4px;padding:0;cursor:pointer;opacity:.7}
  .cwdp input[type=time]::-webkit-datetime-edit{padding:0}
  .cwdp input[type=number]{width:44px!important;background:rgba(255,255,255,.07)!important;border-radius:6px!important;padding:3px 6px!important}
  .cwdp-btns{display:flex;gap:8px;margin-bottom:12px}
  .cwdp-btn{flex:1;border:0;border-radius:10px;padding:8px 10px;font:600 12.5px inherit;font-family:inherit;color:#fff;cursor:pointer;transition:transform .08s,filter .15s,background .15s}
  .cwdp-btn:hover{filter:brightness(1.12)}.cwdp-btn:active{transform:scale(.97)}
  .cwdp-btn.p{background:linear-gradient(135deg,#6366f1,#8b5cf6);box-shadow:0 4px 14px rgba(99,102,241,.4)}
  .cwdp-btn.g{background:rgba(255,255,255,.09)}
  .cwdp-btn.y{background:linear-gradient(135deg,#f59e0b,#f97316);color:#1a1205}
  .cwdp-tl{margin-bottom:12px}
  .cwdp-row{display:flex;align-items:center;gap:10px;padding:7px 9px;border-radius:10px;margin-bottom:5px;background:rgba(255,255,255,.04);border:1px solid transparent;transition:opacity .3s}
  .cwdp-row.now{background:rgba(245,158,11,.14);border-color:rgba(245,158,11,.4)}
  .cwdp-row.soon{background:rgba(129,140,248,.14);border-color:rgba(129,140,248,.4)}
  .cwdp-row.blocked{background:rgba(248,113,113,.08);border-color:rgba(248,113,113,.35)}
  .cwdp-row.blocked .cwdp-rt span{color:#fca5a5}
  .cwdp-row.blocked .cwdp-chip{background:rgba(248,113,113,.25);color:#fecaca}
  .cwdp-row.done{opacity:.4}
  .cwdp-ico{font-size:15px;width:20px;text-align:center}
  .cwdp-rt{flex:1;min-width:0}
  .cwdp-rt b{display:block;font-size:12.5px;font-weight:600}
  .cwdp-rt span{font:11px ui-monospace,Menlo,Consolas,monospace;color:#9a9aa8}
  .cwdp-chip{font-size:10.5px;font-weight:650;padding:3px 8px;border-radius:20px;background:rgba(255,255,255,.08);color:#b4b4c2;white-space:nowrap}
  .cwdp-row.now .cwdp-chip{background:#f59e0b;color:#1a1205}
  .cwdp-row.soon .cwdp-chip{background:#818cf8;color:#0f1030}
  .cwdp-empty{padding:10px;text-align:center;color:#707080;font-size:12px;border:1px dashed rgba(255,255,255,.12);border-radius:10px}
  .cwdp-sw{display:flex;align-items:center;justify-content:space-between;padding:2px 2px 10px;color:#c4c4d0;font-size:12.5px;cursor:pointer}
  .cwdp-sw input{display:none}
  .cwdp-sw i{position:relative;width:34px;height:20px;border-radius:20px;background:rgba(255,255,255,.18);transition:background .2s;flex:none}
  .cwdp-sw i:after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .2s;box-shadow:0 1px 3px rgba(0,0,0,.4)}
  .cwdp-sw input:checked+i{background:#6366f1}
  .cwdp-sw input:checked+i:after{transform:translateX(14px)}
  .cwdp details{border-top:1px solid rgba(255,255,255,.08);padding-top:10px}
  .cwdp summary{cursor:pointer;color:#8d8d99;font-size:12px;font-weight:600;list-style:none;display:flex;align-items:center;gap:6px}
  .cwdp summary::-webkit-details-marker{display:none}
  .cwdp summary:before{content:"▸";font-size:10px;transition:transform .15s}
  .cwdp details[open] summary:before{transform:rotate(90deg)}
  .cwdp-trow{display:flex;align-items:center;justify-content:space-between;margin-top:8px;color:#c4c4d0;font-size:12.5px}
  .cwdp-tinfo{margin-top:8px;font:12px ui-monospace,Menlo,Consolas,monospace;color:#fbbf24;min-height:14px}
  .cwdp-toast{display:none;position:fixed;z-index:100000;width:250px;padding:11px 13px 14px;border-radius:14px;color:#fff;font-size:12.5px;line-height:1.4;font-weight:550;cursor:pointer;overflow:hidden;
    background:rgba(30,30,38,.96);border:1px solid rgba(255,255,255,.1);border-left:4px solid #818cf8;box-shadow:0 14px 40px rgba(0,0,0,.5);animation:cwdpIn .28s cubic-bezier(.2,.9,.3,1.2)}
  .cwdp-toast.busy{border-left-color:#f59e0b}.cwdp-toast.ok{border-left-color:#34d399}.cwdp-toast.err{border-left-color:#f87171}
  .cwdp-toast u{position:absolute;left:0;bottom:0;height:3px;width:100%;background:currentColor;opacity:.55;transform-origin:left;animation:cwdpBar linear forwards}
  .cwdp-toast.busy u{color:#f59e0b}.cwdp-toast.ok u{color:#34d399}.cwdp-toast.err u{color:#f87171}.cwdp-toast.info u{color:#818cf8}
  .cwdp-launch{position:fixed;z-index:99998;height:26px;display:flex;align-items:center;gap:7px;padding:0 11px 0 4px;border-radius:13px;box-sizing:border-box;
    border:1px solid rgba(255,255,255,.12);background:rgba(40,40,50,.92);color:#ececf1;font:600 11.5px/1 -apple-system,"Segoe UI",Inter,system-ui,sans-serif;
    cursor:pointer;white-space:nowrap;max-width:210px;box-shadow:0 2px 8px rgba(0,0,0,.35);user-select:none;transition:border-color .15s,background .15s}
  .cwdp-launch:hover{border-color:rgba(129,140,248,.6)}
  .cwdp-launch.open{border-color:rgba(129,140,248,.85);background:rgba(99,102,241,.22)}
  .cwdp-launch.busy{border-color:rgba(245,158,11,.6);background:rgba(245,158,11,.16)}
  .cwdp-launch .ic{width:18px;height:18px;border-radius:6px;display:grid;place-items:center;flex:none;background:linear-gradient(135deg,#6366f1,#8b5cf6 55%,#ec4899)}
  .cwdp-launch .ic svg{width:11px;height:11px;stroke:#fff}
  .cwdp-launch span{overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
  @keyframes cwdpIn{from{opacity:0;transform:translateY(-6px) scale(.96)}to{opacity:1;transform:none}}
  @keyframes cwdpBar{from{transform:scaleX(1)}to{transform:scaleX(0)}}
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  // ---------- Разметка ----------
  const svgClock = '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
  const svgChev = '<svg class="cwdp-chev" viewBox="0 0 24 24" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
  const cell = (i, label, kind) => `<label class="cwdp-cell${kind ? " wide" : ""}"><i class="cwdp-dot${kind === "shift" ? " s" : kind ? " l" : ""}"></i><span>${label}</span><input id="p${i}" type="time"></label>`;

  const box = document.createElement("div");
  box.className = "cwdp";
  box.innerHTML = `
    <div class="cwdp-head" id="head">
      <div class="cwdp-logo">${svgClock}</div>
      <div class="cwdp-title"><b>Перерывчики<em>v${VERSION}</em></b><span id="sub">План не задан</span></div>
      ${svgChev}
    </div>
    <div class="cwdp-body">
      <div class="cwdp-hero idle" id="hero">
        <div class="cwdp-hl" id="hl">Ближайший</div>
        <div class="cwdp-hn" id="hn">—</div>
        <div class="cwdp-hc" id="hc">--:--</div>
        <div class="cwdp-bar"><i id="hb"></i></div>
      </div>

      <div class="cwdp-clock">
        <span style="font-size:16px">🖥</span>
        <div class="t"><b id="cltitle">Время берётся с часов компьютера</b><span id="tz"></span></div>
        <div class="n" id="clk">--:--:--</div>
      </div>

      <div class="cwdp-sec">Время на день</div>
      <div class="cwdp-grid">
        ${cell(0, "ТБ 1")}${cell(1, "ТБ 2")}${cell(2, "ТБ 3")}${cell(3, "ТБ 4")}${cell(4, "Обед", true)}${cell(5, "Конец смены", "shift")}
      </div>
      <div class="cwdp-btns">
        <button class="cwdp-btn p" id="save">Сохранить</button>
        <button class="cwdp-btn g" id="clear">Очистить</button>
      </div>

      <div class="cwdp-sec">Сегодня</div>
      <div class="cwdp-tl" id="tl"></div>

      <label class="cwdp-sw"><span>Вернуть «В сети» после</span><input type="checkbox" id="ret"><i></i></label>

      <details>
        <summary>Простой таймер</summary>
        <div class="cwdp-trow"><span>«Занят» через, мин</span><input id="tb" type="number" min="1" value="15"></div>
        <div class="cwdp-trow"><span>Вернуть через, мин (0 — нет)</span><input id="tr" type="number" min="0" value="0"></div>
        <div class="cwdp-btns" style="margin:10px 0 0">
          <button class="cwdp-btn y" id="tstart">Старт</button>
          <button class="cwdp-btn g" id="tstop">Отмена</button>
        </div>
        <div class="cwdp-tinfo" id="tinfo"></div>
      </details>
    </div>
    <div class="cwdp-toast" id="toast"></div>`;
  document.body.appendChild(box);
  const toastEl = box.querySelector("#toast");
  document.body.appendChild(toastEl);
  const $ = (id) => (id === "toast" ? toastEl : box.querySelector("#" + id));

  // ---------- Кнопка-лаунчер справа от «SG» ----------
  const launch = document.createElement("div");
  launch.className = "cwdp-launch";
  launch.setAttribute("role", "button");
  launch.title = "Перерывчики v" + VERSION;
  launch.innerHTML = '<div class="ic">' + svgClock + '</div><span>Перерывчики</span>';
  document.body.appendChild(launch);
  const launchText = launch.querySelector("span");

  // ---------- Позиция: справа от надписи «SG», раскрывается по клику ----------
  let sgEl = null, lastSearch = 0;
  function findSG() {
    for (const el of document.querySelectorAll("body *")) {
      if (el.children.length || el === launchText) continue;
      if (el.closest(".cwdp") || el.closest(".cwdp-launch") || el.closest(".cwdp-toast")) continue;
      if (el.textContent.trim() !== "SG") continue;
      const r = el.getBoundingClientRect();
      if (r.width && r.top < 80 && r.left < 260) return el;
    }
    return null;
  }
  function positionAll() {
    if ((!sgEl || !sgEl.isConnected) && Date.now() - lastSearch > 2000) { lastSearch = Date.now(); sgEl = findSG(); }
    let x = 90, y = 6;
    if (sgEl && sgEl.isConnected) {
      const r = sgEl.getBoundingClientRect();
      x = r.right + 10;
      y = r.top + r.height / 2 - 13;
    }
    launch.style.left = x + "px";
    launch.style.top = Math.max(2, y) + "px";
    if (box.classList.contains("open")) {
      const top = Math.max(2, y) + 26 + 8;
      box.style.left = Math.max(8, Math.min(x, window.innerWidth - box.offsetWidth - 8)) + "px";
      box.style.top = top + "px";
      box.style.maxHeight = Math.max(160, window.innerHeight - top - 10) + "px";
    }
  }
  function setOpen(o) {
    box.classList.toggle("open", o);
    launch.classList.toggle("open", o);
    positionAll();
    renderToast();
  }
  launch.addEventListener("click", () => setOpen(!box.classList.contains("open")));
  $("head").addEventListener("click", () => setOpen(false));
  document.addEventListener("mousedown", (e) => {
    if (!box.classList.contains("open")) return;
    if (box.contains(e.target) || launch.contains(e.target) || toastEl.contains(e.target)) return;
    setOpen(false);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") setOpen(false); });
  window.addEventListener("resize", positionAll);
  setInterval(positionAll, 400);

  // ---------- Уведомление ----------
  let lastToastId = null;
  function renderToast() {
    const t = read(LS_TOAST, null);
    const el = $("toast");
    if (!t || t.until < Date.now()) { el.style.display = "none"; lastToastId = null; if (t) write(LS_TOAST, null); return; }
    if (lastToastId !== t.id) {
      lastToastId = t.id;
      el.className = "cwdp-toast " + (t.kind || "info");
      el.textContent = "";
      const span = document.createElement("span");
      span.textContent = t.text;
      const bar = document.createElement("u");
      bar.style.animationDuration = Math.max(200, t.until - Date.now()) + "ms";
      el.append(span, bar);
      el.style.display = "block";
    }
    const open = box.classList.contains("open");
    const a = (open ? box : launch).getBoundingClientRect();
    let left = open ? a.right + 10 : a.left;
    const top = open ? a.top : a.bottom + 8;
    if (left + 258 > window.innerWidth) left = open ? Math.max(8, a.left - 260) : Math.max(8, window.innerWidth - 258);
    el.style.left = left + "px";
    el.style.right = "auto";
    el.style.top = top + "px";
  }
  $("toast").onclick = () => { write(LS_TOAST, null); renderToast(); };

  // ---------- План ----------
  const plan = read(LS_PLAN, null);
  if (plan) { (plan.b || []).forEach((t, i) => ($("p" + i).value = t || "")); $("p4").value = plan.l || ""; $("p5").value = plan.e || ""; }
  $("save").onclick = () => {
    const b = [0, 1, 2, 3].map((i) => $("p" + i).value || "");
    const l = $("p4").value || "";
    const e5 = $("p5").value || "";
    write(LS_PLAN, { b, l, e: e5 });
    write(LS_STATE, null);
    const n = b.filter(Boolean).length + (l ? 1 : 0) + (e5 ? 1 : 0);
    const bad = todayEvents().filter((x) => x.blocked);
    if (bad.length) {
      toast("⚠️ Слишком близко к концу смены, не сработают: " + bad.map((x) => x.label + " (" + hhmm(x.start) + ", нельзя за " + guardMin(x) + " мин до конца смены)").join("; "), "err");
    } else
    toast("📋 План сохранён: " + n + " пункт(ов). «Занят» включится за " + LEAD_MIN + " мин до начала" + (e5 ? ", а в " + e5 + " (конец смены) — ровно в это время" : ""), "ok");
    renderList(true);
  };
  $("clear").onclick = () => {
    write(LS_PLAN, null); write(LS_STATE, null);
    [0, 1, 2, 3, 4, 5].forEach((i) => ($("p" + i).value = ""));
    toast("План очищен");
    renderList(true);
  };
  $("ret").checked = !!read(LS_RETURN, true);
  $("ret").onchange = (e) => write(LS_RETURN, e.target.checked);

  // ---------- Список и «hero» ----------
  let lastSig = "";
  function renderList(force) {
    const evs = todayEvents();
    const now = nowMs();
    const sig = evs.map((e) => e.id + e.start + (e.blocked ? "x" : "")).join("|");
    if (force || sig !== lastSig) {
      lastSig = sig;
      $("tl").innerHTML = evs.length
        ? evs.map((e) => `<div class="cwdp-row" data-id="${e.id}"><div class="cwdp-ico">${e.type === "lunch" ? "🍽" : e.type === "shift" ? "🏁" : "☕"}</div>
            <div class="cwdp-rt"><b>${e.label}</b><span>${e.blocked ? "Нельзя: меньше " + guardMin(e) + " мин до конца смены" : e.type === "shift" ? "«Занят» в " + hhmm(e.start) : hhmm(e.start) + " – " + hhmm(e.start + e.dur * 60000)}</span></div>
            <div class="cwdp-chip"></div></div>`).join("")
        : `<div class="cwdp-empty">Укажите время и нажмите «Сохранить»</div>`;
    }
    for (const e of evs) {
      const row = box.querySelector(`.cwdp-row[data-id="${e.id}"]`);
      if (!row) continue;
      const end = e.start + e.dur * 60000, pre = e.start - (e.type === "shift" ? 0 : LEAD_MIN * 60000);
      const state = e.blocked ? "blocked" : now >= end ? "done" : now >= e.start ? "now" : now >= pre ? "soon" : "wait";
      row.className = "cwdp-row " + state;
      row.querySelector(".cwdp-chip").textContent = { done: "Готово", now: "Идёт", soon: "Скоро", wait: "Ожидает", blocked: "Нельзя" }[state];
    }

    const hero = $("hero");
    const cur = evs.find((e) => !e.blocked && now < e.start + e.dur * 60000);
    if (!evs.length) {
      hero.className = "cwdp-hero idle";
      $("hl").textContent = "План не задан"; $("hn").textContent = "Добавьте время ТБ"; $("hc").textContent = "--:--"; $("hb").style.width = "0";
      $("sub").textContent = "План не задан";
    } else if (!cur) {
      hero.className = "cwdp-hero idle";
      $("hl").textContent = "На сегодня всё"; $("hn").textContent = "Все ТБ позади"; $("hc").textContent = "✓"; $("hb").style.width = "100%";
      $("sub").textContent = "Все ТБ позади";
    } else if (cur.type === "shift") {
      hero.className = "cwdp-hero";
      $("hl").textContent = "До конца смены";
      $("hn").textContent = "🏁 Конец смены · " + hhmm(cur.start) + " · «Занят»";
      $("hc").textContent = fmt(cur.start - now);
      $("hb").style.width = clamp01(1 - (cur.start - now) / (4 * 3600000)) * 100 + "%";
      $("sub").textContent = "Конец смены в " + hhmm(cur.start);
    } else {
      const end = cur.start + cur.dur * 60000, pre = cur.start - LEAD_MIN * 60000;
      const name = (cur.type === "lunch" ? "🍽 " : "☕ ") + cur.label + " · " + hhmm(cur.start);
      $("hn").textContent = name;
      if (now < pre) {
        hero.className = "cwdp-hero";
        $("hl").textContent = "До «Занят»";
        $("hc").textContent = fmt(pre - now);
        $("hb").style.width = clamp01(1 - (pre - now) / 3600000) * 100 + "%";
        $("sub").textContent = "Далее: " + cur.label + " в " + hhmm(cur.start);
      } else if (now < cur.start) {
        hero.className = "cwdp-hero busy";
        $("hl").textContent = "Вы «Занят» · начало через";
        $("hc").textContent = fmt(cur.start - now);
        $("hb").style.width = clamp01((now - pre) / (LEAD_MIN * 60000)) * 100 + "%";
        $("sub").textContent = "Скоро: " + cur.label;
      } else {
        hero.className = "cwdp-hero busy";
        $("hl").textContent = "Идёт · осталось";
        $("hc").textContent = fmt(end - now);
        $("hb").style.width = clamp01((now - cur.start) / (cur.dur * 60000)) * 100 + "%";
        $("sub").textContent = cur.label + " до " + hhmm(end);
      }
    }

    let lt = "Перерывчики", busyNow = false;
    if (evs.length && !cur) lt = "ТБ ✓";
    else if (cur) {
      const pre2 = cur.start - (cur.type === "shift" ? 0 : LEAD_MIN * 60000), end2 = cur.start + cur.dur * 60000;
      lt = cur.label + " · " + fmt(now < pre2 ? pre2 - now : now < cur.start ? cur.start - now : end2 - now);
      busyNow = now >= pre2;
    }
    launchText.textContent = lt;
    launch.classList.toggle("busy", busyNow);
  }

  // ---------- Простой таймер ----------
  $("tstart").onclick = () => {
    const m = Number($("tb").value);
    if (!(m > 0)) return;
    write(LS_TIMER, { busyAt: nowMs() + m * 60000, backMin: Number($("tr").value) || 0 });
  };
  $("tstop").onclick = () => write(LS_TIMER, null);
  function renderTimer() {
    const t = read(LS_TIMER, null);
    const now = nowMs();
    $("tinfo").textContent = !t ? "" : t.busyAt ? "До «Занят»: " + fmt(t.busyAt - now) : "До «В сети»: " + fmt(t.backAt - now);
  }

  let tzName = "";
  try { tzName = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) {}
  function renderClock() {
    const d = new Date(nowMs());
    const p = (n) => String(n).padStart(2, "0");
    $("clk").textContent = p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    const off = -d.getTimezoneOffset(), sg = off >= 0 ? "+" : "-", ao = Math.abs(off);
    const shifted = clockSynced && Math.abs(clockOffset) >= 1000;
    const extra = shifted ? " · ПК " + (clockOffset > 0 ? "отстаёт" : "спешит") + " на " + (Math.abs(clockOffset) / 1000).toFixed(1) + " с (учтено)" : "";
    $("cltitle").textContent = shifted ? "Часы ПК со сверкой по серверу" : "Время берётся с часов компьютера";
    $("tz").textContent = (tzName ? tzName + " · " : "") + "UTC" + sg + p(Math.floor(ao / 60)) + ":" + p(ao % 60) + extra;
  }

  // ---------- Запуск ----------
  let lock = false, lastRender = 0;
  async function logic() {
    if (lock) return;
    lock = true;
    try { if (!(await eventsTick())) await timerTick(); }
    finally { lock = false; }
  }
  function frame() { logic(); }
  function tickUI() {
    renderList(false); renderTimer(); renderClock(); renderToast(); positionAll();
    setTimeout(tickUI, 1000 - (nowMs() % 1000) + 2);
  }

  syncClock();
  setInterval(syncClock, 10 * 60000);
  renderList(true);
  tickUI();
  frame();
  try {
    const w = new Worker(URL.createObjectURL(new Blob(["setInterval(function(){postMessage(1)},250)"], { type: "text/javascript" })));
    w.onmessage = frame;
  } catch (e) { console.warn("[Day Plan] Worker недоступен, используется обычный таймер", e); }
  setInterval(frame, 1000);
})();
