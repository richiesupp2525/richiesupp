// ==UserScript==
// @name         Тикет в Payment
// @namespace    sparkmoth
// @version      1.1
// @description  Одна кнопка в Chatwoot: данные клиента из админки + ссылка на PDF-чек из диалога -> тикет в HelpDesk
// @match        https://sparkmoth.com/app/*
// @match        https://hd.sparkmoth.com/*
// @match        https://www2.fundist.org/ru/Users/Summary*
// @match        https://www7.fundist.org/ru/Users/Summary*
// @match        https://www9.fundist.org/ru/Users/Summary*
// @match        https://backoffice.r7.casino/ru/Users/Summary*
// @match        https://backoffice.catcasino.com/ru/Users/Summary*
// @match        https://backoffice.gama.casino/ru/Users/Summary*
// @match        https://backoffice.daddy.casino/ru/Users/Summary*
// @match        https://backoffice.spark.casino/ru/Users/Summary*
// @match        https://backoffice.mers.casino/ru/Users/Summary*
// @match        https://backoffice.kent.casino/ru/Users/Summary*
// @match        https://backoffice.kometa.casino/ru/Users/Summary*
// @match        https://backoffice.arkada.casino/ru/Users/Summary*
// @match        https://cc.boadmin.org/ru/Users/Summary*
// @match        https://gm.boadmin.org/ru/Users/Summary*
// @match        https://dy.boadmin.org/ru/Users/Summary*
// @match        https://mr.boadmin.org/ru/Users/Summary*
// @match        https://kn.boadmin.org/ru/Users/Summary*
// @match        https://rs.boadmin.org/ru/Users/Summary*
// @match        https://kt.boadmin.org/ru/Users/Summary*
// @match        https://ak.boadmin.org/ru/Users/Summary*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const TOP_HOST = "sparkmoth.com";
  const HELPDESK_HOST = "hd.sparkmoth.com";
  const HELPDESK_ORIGIN = "https://" + HELPDESK_HOST;
  const TOP_ORIGIN = "https://" + TOP_HOST;

  const AUTO_SUBMIT = true;        // false - только заполнить, отправите сами
  const ADMIN_MAX_AGE_MIN = 60;    // насколько свежими должны быть данные со страницы клиента в админке

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(fn, timeout, step = 200) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  // ---------- админка: собираем заголовок так же, как Copydep ----------
  if (location.hostname !== TOP_HOST && location.hostname !== HELPDESK_HOST) {
    const RANK = { highroll: 5, vip: 4, previp: 3, privip: 2 };
    const text = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.textContent.trim() : "";
    };

    function adminHeader() {
      const id = text("#SummaryUserId");
      if (!id) return "";

      let status = "", best = -1;
      document.querySelectorAll(".fun-page-header__statuses .name").forEach((n) => {
        const raw = n.textContent.trim();
        const p = RANK[raw.toLowerCase()] || -1;
        if (p > best) { best = p; status = raw; }
      });

      let project = text(".project-name.word-break");
      if (!project) {
        const el = document.querySelector("#CurrentLogin");
        const login = el ? el.getAttribute("data-login") || "" : "";
        project = login.includes("_") ? login.split("_")[0] : login;
      }

      const lines = [id, project];
      if (status) {
        lines.push("", status);
        const l1 = (text("#creditDebetTotals > dt:nth-child(1)") + " " + text("#creditDebetTotals > dd.text-danger")).trim();
        if (l1) lines.push(l1);
        const l2 = (text("#creditDebetTotals > dt:nth-child(9)") + " " + text("#creditDebetTotals > dd:nth-child(10)")).trim();
        if (l2) lines.push(l2);
        const div = document.querySelector("#creditDebetTotals > div:nth-child(12)");
        if (div) {
          const m = div.textContent.match(/(Ручные депозиты:[\s\S]*?)(?=Депозиты:|Возврат:|Корректировка:|$)/i);
          if (m) lines.push(m[1].trim());
        }
      }
      return lines.join("\n").trim();
    }

    let published = "";
    function publish(force) {
      const header = adminHeader();
      const id = header.split("\n")[0];
      if (!/^\d{5,}$/.test(id)) return;
      if (header !== published) {
        published = header;
        const all = GM_getValue("headers", {});
        all[id] = { text: header, at: Date.now() };
        const keys = Object.keys(all).sort((a, b) => all[b].at - all[a].at).slice(0, 20);
        const trimmed = {};
        keys.forEach((k) => (trimmed[k] = all[k]));
        GM_setValue("headers", trimmed);
      }
      if (document.visibilityState === "visible" || force) GM_setValue("last", { id, at: Date.now() });
    }

    let timer = null;
    new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => publish(false), 1200);
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    window.addEventListener("focus", () => publish(true));
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") publish(true); });
    setInterval(() => { if (document.visibilityState === "visible") publish(false); }, 60000);
    publish(false);
    return;
  }

  function buildNote(header, link) {
    const lines = header.replace(/\r/g, "").split("\n").map((s) => s.trimEnd());
    const filled = [];
    let rest = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      filled.push(lines[i].trim());
      if (filled.length === 2) { rest = lines.slice(i + 1); break; }
    }
    const tail = rest.join("\n").trim();
    const parts = [filled.slice(0, 2).join("\n")];
    if (link) parts.push(link);
    if (tail) parts.push(tail);
    return parts.join("\n\n");
  }

  // ---------- HelpDesk (внутри рамки): заполняем форму ----------
  if (location.hostname === HELPDESK_HOST) {
    const done = new Set();

    const findNote = () => {
      const label = [...document.querySelectorAll("label")].find((l) => l.textContent.includes("Приватная заметка"));
      if (label) {
        const own = label.htmlFor && document.getElementById(label.htmlFor);
        const near = label.parentElement && label.parentElement.querySelector("textarea");
        if (own || near) return own || near;
      }
      return document.querySelector("textarea");
    };
    const findSubmit = () => [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Создать тикет"));

    function setValue(el, value) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }

    window.addEventListener("message", async (e) => {
      if (e.origin !== TOP_ORIGIN) return;
      const d = e.data;
      if (!d || d.type !== "cw-ticket") return;
      e.source.postMessage({ type: "cw-ticket-ack", nonce: d.nonce }, e.origin);
      if (done.has(d.nonce)) return;
      done.add(d.nonce);

      const field = await waitFor(findNote, 8000);
      if (!field) return e.source.postMessage({ type: "cw-ticket-error", nonce: d.nonce, text: "Не нашёл поле «Приватная заметка»" }, e.origin);
      setValue(field, d.note);
      await sleep(400);
      if (d.submit) {
        const btn = findSubmit();
        if (!btn) return e.source.postMessage({ type: "cw-ticket-error", nonce: d.nonce, text: "Не нашёл кнопку «Создать тикет»" }, e.origin);
        btn.click();
      }
      e.source.postMessage({ type: "cw-ticket-done", nonce: d.nonce, submitted: !!d.submit }, e.origin);
    });
    return;
  }

  // ---------- Chatwoot ----------
  if (window !== window.top) return;

  function getAuth() {
    const m = document.cookie.match(/(?:^|;\s*)cw_d_session_info=([^;]+)/);
    if (!m) throw new Error("нет сессии Chatwoot");
    let data = JSON.parse(decodeURIComponent(m[1]));
    if (typeof data === "string") data = JSON.parse(data);
    return data;
  }
  const headers = (a) => ({
    "Content-Type": "application/json",
    "access-token": a["access-token"],
    client: a.client,
    uid: a.uid,
    expiry: a.expiry,
    "token-type": a["token-type"] || "Bearer",
  });

  async function findPdf(acc, conv) {
    let before = null;
    for (let page = 0; page < 6; page++) {
      const url = "/api/v1/accounts/" + acc + "/conversations/" + conv + "/messages" + (before ? "?before=" + before : "");
      const r = await fetch(url, { headers: headers(getAuth()) });
      if (!r.ok) throw new Error("не удалось получить сообщения (" + r.status + ")");
      const msgs = (await r.json()).payload || [];
      if (!msgs.length) break;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].message_type !== 0) continue;
        const files = (msgs[i].attachments || []).slice().reverse();
        for (const a of files) {
          const link = a.data_url || a.file_url;
          if (link && (/\.pdf(\?|$)/i.test(link) || /pdf/i.test(a.extension || ""))) return link;
        }
      }
      before = msgs[0].id;
    }
    return null;
  }

  // Данные клиента: свежая страница из админки, а если её нет - то, что лежит в буфере
  async function clientHeader() {
    const last = GM_getValue("last", null);
    const all = GM_getValue("headers", {});
    if (last && all[last.id] && Date.now() - last.at < ADMIN_MAX_AGE_MIN * 60000) return all[last.id].text;
    try {
      const clip = await navigator.clipboard.readText();
      if (/^\s*\d{5,}\s*(\n|$)/.test(clip)) return clip;
    } catch (e) {}
    return "";
  }

  const findFrame = () => [...document.querySelectorAll("iframe")].find((f) => (f.src || "").startsWith(HELPDESK_ORIGIN));

  function openHelpdeskTab() {
    const tab = [...document.querySelectorAll("button, a, [role=tab], div, span")]
      .find((n) => !n.children.length && n.textContent.trim().toLowerCase() === "helpdesk" && n.offsetParent !== null);
    if (!tab) return false;
    tab.click();
    return true;
  }

  const css = `
  .cwtk-fab{position:fixed;z-index:99998;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;cursor:pointer;user-select:none;box-sizing:border-box;
    border:1px solid rgba(255,255,255,.12);background:rgba(40,40,50,.92);box-shadow:0 2px 8px rgba(0,0,0,.35);transition:border-color .15s,background .15s}
  .cwtk-fab:hover{border-color:rgba(129,140,248,.6)}
  .cwtk-fab.busy{border-color:rgba(245,158,11,.7);background:rgba(245,158,11,.18);cursor:progress}
  .cwtk-fab .ic{width:18px;height:18px;border-radius:6px;display:grid;place-items:center;background:linear-gradient(135deg,#6366f1,#8b5cf6 55%,#ec4899)}
  .cwtk-fab svg{width:11px;height:11px;stroke:#fff}
  .cwtk-toast{display:none;position:fixed;z-index:100000;width:250px;padding:10px 12px;border-radius:12px;color:#fff;font:600 12.5px/1.4 -apple-system,"Segoe UI",Inter,sans-serif;
    background:rgba(30,30,38,.97);border:1px solid rgba(255,255,255,.1);border-left:4px solid #818cf8;box-shadow:0 14px 40px rgba(0,0,0,.5);cursor:pointer}
  .cwtk-toast.ok{border-left-color:#34d399}.cwtk-toast.err{border-left-color:#f87171}.cwtk-toast.busy{border-left-color:#f59e0b}
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  const fab = document.createElement("div");
  fab.className = "cwtk-fab";
  fab.title = "Тикет в Payment: не пришёл депозит";
  fab.innerHTML = '<div class="ic"><svg viewBox="0 0 24 24" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16v3a2 2 0 0 0 0 4v3H4v-3a2 2 0 0 0 0-4z"/><path d="M14.5 8v8" stroke-dasharray="1.5 2.2"/></svg></div>';
  const toastEl = document.createElement("div");
  toastEl.className = "cwtk-toast";
  document.body.append(fab, toastEl);

  let toastTimer = null;
  function toast(msg, kind, ms) {
    toastEl.textContent = msg;
    toastEl.className = "cwtk-toast " + (kind || "");
    toastEl.style.display = "block";
    clearTimeout(toastTimer);
    if (ms !== 0) toastTimer = setTimeout(() => (toastEl.style.display = "none"), ms || 6000);
    place();
  }
  toastEl.onclick = () => (toastEl.style.display = "none");

  let sg = null, lastSearch = 0;
  function findSG() {
    for (const el of document.querySelectorAll("body *")) {
      if (el.children.length || el.closest(".cwtk-fab") || el.closest(".cwcalc") || el.closest(".cwdp")) continue;
      if (el.textContent.trim() !== "SG") continue;
      const r = el.getBoundingClientRect();
      if (r.width && r.top < 80 && r.left < 260) return el;
    }
    return null;
  }

  function place() {
    let a = document.querySelector(".cwcalc-fab") || document.querySelector(".cwdp-launch");
    if (!a) {
      if ((!sg || !sg.isConnected) && Date.now() - lastSearch > 2000) { lastSearch = Date.now(); sg = findSG(); }
      a = sg;
    }
    let x = 230, y = 8;
    if (a && a.isConnected) {
      const r = a.getBoundingClientRect();
      x = r.right + 8;
      y = r.top + r.height / 2 - 13;
    }
    fab.style.left = x + "px";
    fab.style.top = Math.max(2, y) + "px";
    toastEl.style.left = Math.max(8, Math.min(x, window.innerWidth - 262)) + "px";
    toastEl.style.top = Math.max(2, y) + 36 + "px";
  }
  place();
  setInterval(place, 400);
  window.addEventListener("resize", place);

  let running = false;
  async function run() {
    if (running) return;
    running = true;
    fab.classList.add("busy");
    try {
      const m = location.pathname.match(/accounts\/(\d+)\/conversations\/(\d+)/);
      if (!m) throw new Error("Сначала откройте диалог с клиентом");

      const header = await clientHeader();
      if (!header) throw new Error("Нет данных клиента. Откройте его страницу в админке (Users/Summary) и нажмите снова");
      const [clientId, project] = header.split("\n").map((s) => s.trim());

      toast("Ищу PDF-чек в диалоге…", "busy", 0);
      const link = await findPdf(m[1], m[2]);
      if (!link && !confirm("В диалоге не найден PDF-чек. Создать тикет без ссылки на чек?")) {
        toast("Отменено", "", 3000);
        return;
      }

      const note = buildNote(header, link);
      toast("Открываю HelpDesk…", "busy", 0);
      let frame = findFrame();
      if (!frame) {
        if (!openHelpdeskTab()) throw new Error("Не нашёл вкладку «HelpDesk» в диалоге");
        frame = await waitFor(findFrame, 10000);
        if (!frame) throw new Error("Форма HelpDesk не загрузилась");
      }

      const nonce = Date.now() + "_" + Math.random().toString(36).slice(2, 7);
      const result = await new Promise((resolve) => {
        let acked = false;
        const onMsg = (e) => {
          if (e.origin !== HELPDESK_ORIGIN || !e.data || e.data.nonce !== nonce) return;
          if (e.data.type === "cw-ticket-ack") acked = true;
          if (e.data.type === "cw-ticket-done" || e.data.type === "cw-ticket-error") finish(e.data);
        };
        const finish = (v) => { clearInterval(timer); clearTimeout(limit); window.removeEventListener("message", onMsg); resolve(v); };
        window.addEventListener("message", onMsg);
        const send = () => {
          const f = findFrame();
          if (f && f.contentWindow && !acked) f.contentWindow.postMessage({ type: "cw-ticket", nonce, note, submit: AUTO_SUBMIT }, HELPDESK_ORIGIN);
        };
        const timer = setInterval(send, 700);
        const limit = setTimeout(() => finish({ type: "cw-ticket-error", text: "HelpDesk не ответил. Проверьте, что скрипт включён для " + HELPDESK_HOST }), 20000);
        send();
      });

      if (result.type === "cw-ticket-error") throw new Error(result.text);
      const who = clientId + (project ? " · " + project : "");
      toast((result.submitted ? "Тикет отправлен: " : "Заметка заполнена, нажмите «Создать тикет»: ") + who + (link ? "" : " (без чека)"), "ok", 8000);
    } catch (e) {
      toast(e.message, "err", 9000);
    } finally {
      running = false;
      fab.classList.remove("busy");
    }
  }
  fab.addEventListener("click", run);
})();
