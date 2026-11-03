// ==UserScript==
// @name         Dep-tickets
// @namespace    sparkmoth
// @version      1.19
// @description  Одна кнопка в Chatwoot: данные клиента из админки + ссылка на PDF-чек из диалога -> тикет в HelpDesk
// @match        https://sparkmoth.com/app/*
// @match        https://hd.sparkmoth.com/*
// @match        https://www2.fundist.org/*
// @match        https://www7.fundist.org/*
// @match        https://www9.fundist.org/*
// @match        https://backoffice.r7.casino/*
// @match        https://backoffice.catcasino.com/*
// @match        https://backoffice.gama.casino/*
// @match        https://backoffice.daddy.casino/*
// @match        https://backoffice.spark.casino/*
// @match        https://backoffice.mers.casino/*
// @match        https://backoffice.kent.casino/*
// @match        https://backoffice.kometa.casino/*
// @match        https://backoffice.arkada.casino/*
// @match        https://cc.boadmin.org/*
// @match        https://gm.boadmin.org/*
// @match        https://dy.boadmin.org/*
// @match        https://mr.boadmin.org/*
// @match        https://kn.boadmin.org/*
// @match        https://rs.boadmin.org/*
// @match        https://kt.boadmin.org/*
// @match        https://ak.boadmin.org/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @connect      plevantis.net
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const TOP_HOST = "sparkmoth.com";
  const HELPDESK_HOST = "hd.sparkmoth.com";
  const HELPDESK_ORIGIN = "https://" + HELPDESK_HOST;
  const TOP_ORIGIN = "https://" + TOP_HOST;

  const AUTO_SUBMIT = true;        // false - только заполнить, отправите сами
  const REQUIRE_RECEIPT = true;    // true - без PDF-чека в диалоге тикет не создаётся (чек обязателен по регламенту)
  const ALLOW_DUPLICATE_OVERRIDE = false; // false - если тикет по чеку уже есть, создание блокируется; true - можно подтвердить и создать ещё один
  const ADMIN_MAX_AGE_MIN = 60;    // свежесть данных, если ID клиента в Chatwoot найти не удалось (берётся последняя страница админки)
  const VERIFIED_MAX_AGE_MIN = 480; // свежесть данных, когда ID совпал с контактом в Chatwoot
  const FRESH_MIN = 10;            // если данные клиента моложе - страницу админки заново не открываем
  const ADMIN_HOSTS = [
    "www2.fundist.org", "www7.fundist.org", "www9.fundist.org", "backoffice.r7.casino", "backoffice.catcasino.com",
    "backoffice.gama.casino", "backoffice.daddy.casino", "backoffice.spark.casino", "backoffice.mers.casino",
    "backoffice.kent.casino", "backoffice.kometa.casino", "backoffice.arkada.casino", "cc.boadmin.org", "gm.boadmin.org",
    "dy.boadmin.org", "mr.boadmin.org", "kn.boadmin.org", "rs.boadmin.org", "kt.boadmin.org", "ak.boadmin.org",
  ];

  const VERSION = "1.19";

  // Команда в форме HelpDesk (поле «Команда»). Определяем по проекту из заметки и по домену админки
  const TEAM_BY_PROJECT = [
    [/cat/i, "VIP Cat Payment"], [/gam+a/i, "VIP Gama Payment"], [/kent/i, "Kent Payment VIP"], [/arkada/i, "Arkada Payment VIP"],
    [/kometa/i, "Kometa Payment VIP"], [/daddy/i, "Daddy Payment VIP"], [/r7/i, "R7 Payment VIP"],
  ];
  const TEAM_BY_HOST = {
    "cc.boadmin.org": "VIP Cat Payment", "backoffice.catcasino.com": "VIP Cat Payment",
    "gm.boadmin.org": "VIP Gama Payment", "backoffice.gama.casino": "VIP Gama Payment",
    "kn.boadmin.org": "Kent Payment VIP", "backoffice.kent.casino": "Kent Payment VIP",
    "ak.boadmin.org": "Arkada Payment VIP", "backoffice.arkada.casino": "Arkada Payment VIP",
    "kt.boadmin.org": "Kometa Payment VIP", "backoffice.kometa.casino": "Kometa Payment VIP",
    "dy.boadmin.org": "Daddy Payment VIP", "backoffice.daddy.casino": "Daddy Payment VIP",
    "rs.boadmin.org": "R7 Payment VIP", "backoffice.r7.casino": "R7 Payment VIP",
  };
  function resolveTeam(project, cands) {
    const p = (TEAM_BY_PROJECT.find(([re]) => re.test(project || "")) || [])[1] || "";
    const withUrl = (cands || []).find((c) => c.url);
    const h = withUrl ? TEAM_BY_HOST[new URL(withUrl.url).hostname] || "" : "";
    if (p && h && p !== h) return { team: "", warn: "проект в данных (" + project + ") не совпадает с админкой клиента" };
    return { team: p || h, warn: "" };
  }
  // Обязательные строки в тикете по регламенту: без любой из них тикет не создаётся
  const REQUIRED_SUMS = [
    [/^Выводы.*\d/m, "Выводы через платежные системы"],
    [/^Депозиты.*\d/m, "Депозиты через платежную систему"],
    [/^Ручные депозиты.*\d/m, "Ручные депозиты"],
  ];
  const missingSums = (t) => REQUIRED_SUMS.filter(([re]) => !re.test(t || "")).map(([, name]) => name);
  const isPartial = (t) => missingSums(t).length > 0;

  // Формат тикета по регламенту (ровно так, без пустых строк):
  //   ID клиента
  //   проект
  //   ссылка на чек
  //   статус клиента (если есть)
  //   Выводы через платежные системы: ...
  //   Депозиты через платежную систему: ...
  //   Ручные депозиты: ...
  function noteProblems(note) {
    const L = String(note || "").replace(/\r/g, "").split("\n").map((s) => s.trim());
    const bad = [];
    if (!/^\d{5,}$/.test(L[0] || "")) bad.push("первая строка не ID клиента");
    if (!L[1]) bad.push("во второй строке нет проекта");
    const link = L[2] || "";
    const linkOk = /^https:\/\/\S+$/.test(link);
    if (REQUIRE_RECEIPT ? !linkOk : link && !linkOk) bad.push("в третьей строке нет ссылки на чек");
    const tail = L.slice(3);
    while (tail.length && !tail[tail.length - 1]) tail.pop();
    if (tail.length < 3 || tail.length > 4 || tail.some((x) => !x)) {
      bad.push("после ссылки на чек должны идти статус (если есть) и три строки с суммами, без пустых строк");
    } else {
      const sums = tail.slice(-3);
      REQUIRED_SUMS.forEach(([re, name], i) => { if (!re.test(sums[i])) bad.push("нет строки «" + name + "» на своём месте"); });
      if (tail.length === 4 && /[\d:]/.test(tail[0])) bad.push("строка статуса клиента выглядит некорректно");
    }
    return bad;
  }

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
    if (document.querySelector('input[type="password"]') && !document.querySelector("#SummaryUserId")) {
      GM_setValue("adminLogin", { host: location.hostname, at: Date.now() });
      return;
    }
    if (!location.pathname.includes("/Users/Summary")) return;

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
      const totals = [];
      const clean = (t) => String(t || "").replace(/\s+/g, " ").trim();
      // запасной способ: ищем строку по подписи, а не по номеру позиции (на случай, если вёрстка блока сдвинется)
      const byLabel = (re) => {
        const root = document.querySelector("#creditDebetTotals");
        if (!root) return "";
        for (const dt of root.querySelectorAll("dt")) {
          const label = clean(dt.textContent);
          const dd = dt.nextElementSibling;
          if (re.test(label) && dd && dd.tagName === "DD") return clean(label + " " + dd.textContent);
        }
        return "";
      };
      const withdrawRe = /^Выводы через платеж/i, depositRe = /^Депозиты через платеж/i, manualRe = /^Ручные депозиты/i;

      let l1 = clean(text("#creditDebetTotals > dt:nth-child(1)") + " " + text("#creditDebetTotals > dd.text-danger"));
      if (!withdrawRe.test(l1)) l1 = byLabel(withdrawRe);
      if (l1) totals.push(l1);

      let l2 = clean(text("#creditDebetTotals > dt:nth-child(9)") + " " + text("#creditDebetTotals > dd:nth-child(10)"));
      if (!depositRe.test(l2)) l2 = byLabel(depositRe);
      if (l2) totals.push(l2);

      let manual = "";
      const div = document.querySelector("#creditDebetTotals > div:nth-child(12)");
      if (div) {
        const m = div.textContent.match(/(Ручные депозиты:[\s\S]*?)(?=Депозиты:|Возврат:|Корректировка:|$)/i);
        if (m) manual = clean(m[1]);
      }
      if (!manualRe.test(manual) || !/\d/.test(manual)) manual = byLabel(manualRe).replace(/^(Ручные депозиты:)\s*/i, "$1");
      if (manual) totals.push(manual);
      if (status || totals.length) lines.push("");
      if (status) lines.push(status);
      lines.push(...totals);
      return lines.join("\n").trim();
    }

    let published = "";
    function publish(force) {
      const header = adminHeader();
      const id = header.split("\n")[0];
      if (!/^\d{5,}$/.test(id)) return;
      if (header !== published || document.visibilityState === "visible") {
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

  // Собирает заметку строго по регламенту: ID, проект, чек (на месте пустой строки), статус и суммы
  function buildNote(header, link) {
    const L = header.replace(/\r/g, "").split("\n").map((x) => x.trim());
    const rest = L.slice(2).filter(Boolean);
    return [L[0] || "", L[1] || "", link || "", ...rest].join("\n");
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

    const norm = (t) => (t || "").replace(/\s+/g, " ").trim().toLowerCase();
    const findTeamControl = () => {
      const label = [...document.querySelectorAll("label")].find((l) => norm(l.textContent).startsWith("команда"));
      if (!label) return null;
      const own = label.htmlFor && document.getElementById(label.htmlFor);
      return own || (label.parentElement && label.parentElement.querySelector("select, input, [role=combobox], [role=button], button")) || null;
    };
    const readTeam = (el) => {
      if (el instanceof HTMLSelectElement) return el.selectedOptions[0] ? el.selectedOptions[0].textContent : "";
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
      return el.textContent;
    };
    const fire = (n, types) => types.forEach((t) => n.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })));
    // Выбирает команду в форме. Возвращает "" при успехе или текст ошибки
    async function setTeam(team) {
      const el = await waitFor(findTeamControl, 8000);
      if (!el) return "не нашёл поле «Команда»";
      const want = norm(team);
      if (norm(readTeam(el)) === want) return "";
      if (el instanceof HTMLSelectElement) {
        const opt = [...el.options].find((o) => norm(o.textContent) === want);
        if (!opt) return "в списке «Команда» нет пункта «" + team + "»";
        el.value = opt.value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        const findOption = () => [...document.querySelectorAll("[role=option], li, option, div, span, button, a")]
          .find((n) => !n.children.length && norm(n.textContent) === want && n.offsetParent !== null && !el.contains(n) && !n.contains(el));
        el.focus();
        fire(el, ["mousedown", "mouseup", "click"]);
        let opt = await waitFor(findOption, 1500);
        if (!opt && (el instanceof HTMLInputElement) && !el.readOnly) {
          setValue(el, team);
          opt = await waitFor(findOption, 1500);
        }
        if (!opt) return "не нашёл пункт «" + team + "» в списке «Команда»";
        fire(opt, ["mousedown", "mouseup", "click"]);
      }
      await sleep(600);
      return norm(readTeam(findTeamControl() || el)) === want ? "" : "не удалось выбрать команду «" + team + "»";
    }

    window.addEventListener("message", async (e) => {
      if (e.origin !== TOP_ORIGIN) return;
      const d = e.data;
      if (!d || d.type !== "cw-ticket") return;
      e.source.postMessage({ type: "cw-ticket-ack", nonce: d.nonce }, e.origin);
      if (done.has(d.nonce)) return;
      done.add(d.nonce);

      // страховка: заметка без обязательных сумм не заполняется и не отправляется
      const lack = noteProblems(d.note);
      if (lack.length) return e.source.postMessage({ type: "cw-ticket-error", nonce: d.nonce, text: "Тикет не создан: заметка не по формату (" + lack.join("; ") + ")" }, e.origin);

      let teamError = "";
      if (d.team) {
        teamError = await setTeam(d.team);
        await sleep(300);
      }
      const field = await waitFor(findNote, 8000);
      if (!field) return e.source.postMessage({ type: "cw-ticket-error", nonce: d.nonce, text: "Не нашёл поле «Приватная заметка»" }, e.origin);
      setValue(field, d.note);
      await sleep(400);
      if (teamError) return e.source.postMessage({ type: "cw-ticket-error", nonce: d.nonce, text: "Заметка заполнена, но " + teamError + ". Выберите команду вручную и создайте тикет" }, e.origin);
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

  // Ищет последний PDF-чек клиента и заодно собирает приватные заметки/ответы (чтобы найти уже созданный тикет)
  const linkKey = (l) => String(l).split("?")[0];
  async function findPdf(acc, conv) {
    let before = null;
    const notes = [];
    for (let page = 0; page < 6; page++) {
      const url = "/api/v1/accounts/" + acc + "/conversations/" + conv + "/messages" + (before ? "?before=" + before : "");
      const r = await fetch(url, { headers: headers(getAuth()) });
      if (!r.ok) throw new Error("не удалось получить сообщения (" + r.status + ")");
      const msgs = (await r.json()).payload || [];
      if (!msgs.length) break;
      msgs.forEach((m) => {
        if ((m.private || m.message_type !== 0) && m.content) notes.push({ content: String(m.content), at: m.created_at, who: (m.sender && m.sender.name) || "" });
      });
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].message_type !== 0) continue;
        const files = (msgs[i].attachments || []).slice().reverse();
        for (const a of files) {
          const link = a.data_url || a.file_url;
          if (link && (/\.pdf(\?|$)/i.test(link) || /pdf/i.test(a.extension || ""))) return { link, notes };
        }
      }
      before = msgs[0].id;
    }
    return { link: null, notes };
  }

  // Уже создан ли тикет по этому чеку: своя отметка или заметка в диалоге со ссылкой на этот чек
  function findDuplicate(link, notes) {
    const key = linkKey(link);
    const mine = GM_getValue("tickets", {})[key];
    const hit = notes.find((n) => n.content.includes(key));
    if (hit) return { at: hit.at * 1000, who: hit.who };
    if (mine) return { at: mine };
    return null;
  }
  function markCreated(link) {
    if (!link) return;
    const all = GM_getValue("tickets", {});
    all[linkKey(link)] = Date.now();
    const keys = Object.keys(all).sort((a, b) => all[b] - all[a]).slice(0, 100);
    const trimmed = {};
    keys.forEach((k) => (trimmed[k] = all[k]));
    GM_setValue("tickets", trimmed);
  }

  // ---------- проверка дубля на портале тикетов ----------
  const PORTAL_API = "https://plevantis.net/api/helpdesk/tickets";
  const PORTAL_UI = "https://plevantis.net/support/tickets";
  // ключ чека: подписанный id из ссылки (стабилен и не ломается кодировкой имени файла)
  const portalKey = (l) => { const m = String(l).match(/\/redirect\/([^\/?]+)\//); return m ? m[1] : linkKey(l); };
  function gmGet(url, timeout) {
    return new Promise((resolve) => {
      // защита: только чтение и только адреса API портала
      if (!String(url).startsWith(PORTAL_API)) return resolve({ error: "запрос к чужому адресу заблокирован" });
      try {
        GM_xmlhttpRequest({
          method: "GET", url, timeout: timeout || 12000, headers: { Accept: "application/json" }, redirect: "error",
          onload: (r) => resolve({ status: r.status, text: r.responseText || "" }),
          onerror: () => resolve({ error: "нет ответа" }),
          ontimeout: () => resolve({ error: "таймаут" }),
        });
      } catch (e) { resolve({ error: String((e && e.message) || e) }); }
    });
  }
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function collectTickets(node, out) {
    if (!node || typeof node !== "object" || out.length >= 10) return;
    if (Array.isArray(node)) { node.forEach((n) => collectTickets(n, out)); return; }
    const tid = node.ID || node.id;
    if (typeof tid === "string" && UUID_RE.test(tid) && ("shortID" in node || "subject" in node || "status" in node)) { out.push(node); return; }
    Object.values(node).forEach((v) => collectTickets(v, out));
  }
  // Ищет тикеты по ID клиента и проверяет, есть ли среди них ссылка на этот чек
  async function portalCheck(clientId, link) {
    const key = portalKey(link);
    const s = await gmGet(PORTAL_API + "?query=" + encodeURIComponent(clientId) + "&sortBy=lastMessageAt&order=desc");
    if (s.error) return { error: "нет ответа, скорее всего слетел вход на портал" };
    if (s.status === 401 || s.status === 403) return { error: "слетел вход на портал (HTTP " + s.status + ")" };
    if (s.status !== 200) return { error: "HTTP " + s.status };
    let data;
    try { data = JSON.parse(s.text); } catch (e) { return { error: "ответ портала не JSON, возможно нужен вход" }; }
    const tickets = [];
    collectTickets(data, tickets);
    const idOf = (t) => t.ID || t.id;
    const urlOf = (t) => (t.shortID ? "#" + t.shortID + " " : "") + PORTAL_UI + "?ticket=" + idOf(t);
    const hit = tickets.find((t) => JSON.stringify(t).includes(key));
    if (hit) return { found: urlOf(hit), total: tickets.length };
    if (s.text.includes(key)) return { found: PORTAL_UI, total: tickets.length };
    const details = await Promise.all(tickets.map(async (t) => ({ t, d: await gmGet(PORTAL_API + "/" + idOf(t)) })));
    for (const x of details) if (!x.d.error && x.d.status === 200 && x.d.text.includes(key)) return { found: urlOf(x.t), total: tickets.length };
    return { total: tickets.length, failed: details.filter((x) => x.d.error || x.d.status !== 200).length };
  }

  // ID клиента из карточки контакта: ссылка на админку в атрибуте (например userId) или просто число
  async function contactIds(acc, conv) {
    try {
      const r = await fetch("/api/v1/accounts/" + acc + "/conversations/" + conv, { headers: headers(getAuth()) });
      if (!r.ok) return [];
      const sender = ((await r.json()).meta || {}).sender || {};
      const out = [];
      const add = (id, url) => {
        const known = out.find((o) => o.id === id);
        if (!known) out.push({ id, url });
        else if (url && !known.url) known.url = url;
      };
      const scan = (v) => {
        const s = String(v == null ? "" : v).trim();
        const m = s.match(/^https:\/\/([^\s/]+)\/ru\/Users\/Summary\/(\d{5,})/);
        if (m && ADMIN_HOSTS.includes(m[1])) add(m[2], "https://" + m[1] + "/ru/Users/Summary/" + m[2]);
        else if (/^\d{6,12}$/.test(s)) add(s, null);
      };
      scan(sender.identifier);
      const byKey = (a, b) => /id|ид|айди/i.test(b[0]) - /id|ид|айди/i.test(a[0]);
      Object.entries(sender.custom_attributes || {}).sort(byKey).forEach(([, v]) => scan(v));
      Object.entries(sender.additional_attributes || {}).sort(byKey).forEach(([, v]) => scan(v));
      return out;
    } catch (e) {
      return [];
    }
  }

  // Открывает страницу клиента в фоновой вкладке, ждёт пока скрипт админки сохранит данные, и закрывает вкладку
  async function loadViaTab(c) {
    const start = Date.now();
    const host = new URL(c.url).hostname;
    let tab = null;
    try { tab = GM_openInTab(c.url, { active: false, insert: true, setParent: true }); } catch (e) { return null; }
    const closeTab = () => { try { if (tab) tab.close(); } catch (e) {} };
    // суммы в админке догружаются поздно: пока есть статус, но нет сумм, ждём долго; без статуса тоже ждём подольше (статус мог не успеть)
    const needStable = (t) => (isPartial(t) ? 20000 : 4500);
    let text = "", changed = Date.now();
    const end = Date.now() + 50000;
    while (Date.now() < end) {
      await sleep(500);
      const login = GM_getValue("adminLogin", null);
      if (login && login.host === host && login.at >= start) { closeTab(); return { login: true }; }
      const h = GM_getValue("headers", {})[c.id];
      if (!h || h.at < start) continue;
      if (h.text !== text) { text = h.text; changed = Date.now(); continue; }
      if (Date.now() - changed > needStable(text)) { closeTab(); return { text }; }
    }
    closeTab();
    return text ? { text } : null;
  }

  // Данные клиента: свежие из админки, иначе открываем его страницу, иначе старые, иначе буфер
  async function clientHeader(cands) {
    const saved = (id) => GM_getValue("headers", {})[id];
    for (const c of cands) {
      const h = saved(c.id);
      if (h && Date.now() - h.at < FRESH_MIN * 60000 && !isPartial(h.text)) return { text: h.text, verified: true };
    }
    const withUrl = cands.find((c) => c.url);
    let loginUrl = "";
    if (withUrl) {
      toast("Получаю данные клиента из админки…", "busy", 0);
      const res = await loadViaTab(withUrl);
      if (res && res.text) return { text: res.text, verified: true };
      if (res && res.login) loginUrl = withUrl.url;
    }
    for (const c of cands) {
      const h = saved(c.id);
      if (h && Date.now() - h.at < VERIFIED_MAX_AGE_MIN * 60000) {
        if (!loginUrl) return { text: h.text, verified: true };
        // админка не залогинена, но старые данные есть: спрашиваем
        const mins = Math.max(1, Math.round((Date.now() - h.at) / 60000));
        const age = mins >= 60 ? Math.floor(mins / 60) + " ч " + (mins % 60) + " мин" : mins + " мин";
        const use = confirm("Админка не залогинена, данные клиента от " + age + " назад. Использовать их?\n\nОК - создать тикет с этими данными (вкладка входа откроется в фоне)\nОтмена - ничего не создавать, открыть вкладку входа");
        try { GM_openInTab(loginUrl, { active: !use }); } catch (e) {}
        if (use) return { text: h.text, verified: true, stale: true };
        return { login: true, declined: true };
      }
    }
    try {
      const clip = await navigator.clipboard.readText();
      const cid = (clip.trim().split("\n")[0] || "").trim();
      if (/^\d{5,}$/.test(cid) && (!cands.length || cands.some((c) => c.id === cid))) return { text: clip, verified: cands.some((c) => c.id === cid) };
    } catch (e) {}
    if (loginUrl) {
      try { GM_openInTab(loginUrl, { active: true }); } catch (e) {}
      return { login: true };
    }
    if (cands.length) return { missing: cands[0].id };
    const last = GM_getValue("last", null);
    const h = last && saved(last.id);
    if (h && Date.now() - last.at < ADMIN_MAX_AGE_MIN * 60000) return { text: h.text, verified: false };
    return null;
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
  fab.title = "Dep-tickets v" + VERSION + " (автоотправка: " + (AUTO_SUBMIT ? "ВКЛ" : "выкл") + ")";
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

  // true - остановить создание (дубль найден и не подтверждён)
  function stopOnDuplicate(text) {
    if (!ALLOW_DUPLICATE_OVERRIDE) { toast(text + ". Создание заблокировано", "err", 12000); return true; }
    if (!confirm(text + ". Создать ещё один?")) { toast("Отменено: тикет по этому чеку уже создан", "", 6000); return true; }
    return false;
  }

  let running = false;
  async function run() {
    if (running) return;
    running = true;
    fab.classList.add("busy");
    try {
      const m = location.pathname.match(/accounts\/(\d+)\/conversations\/(\d+)/);
      if (!m) throw new Error("Сначала откройте диалог с клиентом");

      toast("Ищу PDF-чек в диалоге…", "busy", 0);
      const scan = await findPdf(m[1], m[2]);
      const link = scan.link;
      if (!link) {
        if (REQUIRE_RECEIPT) throw new Error("Тикет не создан: в диалоге нет PDF-чека от клиента");
        if (!confirm("В диалоге не найден PDF-чек. Создать тикет без ссылки на чек?")) {
          toast("Отменено", "", 3000);
          return;
        }
      }
      if (link) {
        const dup = findDuplicate(link, scan.notes);
        if (dup) {
          const when = new Date(dup.at).toLocaleString("ru-RU") + (dup.who ? ", " + dup.who : "");
          if (!ALLOW_DUPLICATE_OVERRIDE) {
            toast("Тикет по этому чеку уже создан (" + when + "). Создание заблокировано", "err", 10000);
            return;
          }
          if (!confirm("По этому чеку тикет уже создан (" + when + "). Создать ещё один?")) {
            toast("Отменено: тикет по этому чеку уже создан", "", 6000);
            return;
          }
        }
      }

      const cands = await contactIds(m[1], m[2]);

      let portalNote = "";
      const portalStep = async (id) => {
        if (!link || !id) return false;
        toast("Проверяю тикеты на портале…", "busy", 0);
        const r = await portalCheck(id, link);
        if (r.error) {
          // портал недоступен или слетел вход: без проверки дубля не создаём, пока вы не подтвердите
          if (confirm("Не удалось проверить дубль на портале (" + r.error + ").\n\nОК - продолжить без этой проверки (по диалогу дубль уже проверен)\nОтмена - открыть портал для входа и ничего не создавать")) {
            portalNote = ". Проверка по порталу пропущена (" + r.error + ")";
            return false;
          }
          try { GM_openInTab(PORTAL_UI, { active: true }); } catch (e) {}
          toast("Отменено. Войдите на портал и нажмите кнопку снова", "err", 9000);
          return true;
        }
        if (r.found) return stopOnDuplicate("Тикет по этому чеку уже есть на портале: " + r.found);
        portalNote = ". Портал: тикетов клиента " + r.total + ", дубля нет" + (r.failed ? " (" + r.failed + " не открылись)" : "");
        return false;
      };
      const portalId = cands.length ? cands[0].id : "";
      if (portalId && (await portalStep(portalId))) return;

      const found = await clientHeader(cands);
      if (!found) throw new Error("Нет данных клиента. Откройте его страницу в админке (Users/Summary) и нажмите снова");
      if (found.login) throw new Error(found.declined ? "Отменено. Войдите в админку (2FA) во вкладке входа и нажмите кнопку снова" : "Нужен вход в админку (там 2FA). Открыл вкладку входа: войдите и нажмите кнопку снова");
      if (found.missing) throw new Error("Откройте в админке страницу клиента " + found.missing + " и нажмите снова");
      const header = found.text;
      const [clientId, project] = header.split("\n").map((s) => s.trim());
      const lacking = missingSums(header);
      if (lacking.length) throw new Error("Тикет не создан: в данных клиента нет обязательных строк (" + lacking.join(", ") + "). Откройте страницу клиента в админке, дождитесь загрузки сумм и нажмите кнопку снова");
      if (!portalId && (await portalStep(clientId))) return;


      const note = buildNote(header, link);
      const bad = noteProblems(note);
      if (bad.length) throw new Error("Тикет не создан: заметка не по формату (" + bad.join("; ") + ")");
      const tm = resolveTeam(project, cands);
      const team = tm.team;
      const submit = AUTO_SUBMIT && !!team;
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
          if (f && f.contentWindow && !acked) f.contentWindow.postMessage({ type: "cw-ticket", nonce, note, team, submit }, HELPDESK_ORIGIN);
        };
        const timer = setInterval(send, 700);
        const limit = setTimeout(() => finish({ type: "cw-ticket-error", text: "HelpDesk не ответил. Проверьте, что скрипт включён для " + HELPDESK_HOST }), 20000);
        send();
      });

      if (result.type === "cw-ticket-error") throw new Error(result.text);
      if (result.submitted) markCreated(link);
      const who = clientId + (project ? " · " + project : "");
      toast((result.submitted ? "Тикет отправлен: " : "Заметка заполнена, нажмите «Создать тикет»: ") + who + (team ? " → " + team : "") + (team ? "" : ". ВНИМАНИЕ: команду определить не удалось" + (tm.warn ? " (" + tm.warn + ")" : "") + ", выберите вручную; автоотправка отключена") + (link ? "" : " (без чека)") + (found.verified ? "" : ". ID не сверен с контактом, проверьте") + (found.stale ? ". Админка не залогинена, данные могли устареть" : "") + portalNote + " [v" + VERSION + ", автоотправка: " + (AUTO_SUBMIT ? "ВКЛ" : "выкл") + "]", "ok", 8000);
    } catch (e) {
      toast(e.message, "err", 9000);
    } finally {
      running = false;
      fab.classList.remove("busy");
    }
  }
  fab.addEventListener("click", run);
})();
