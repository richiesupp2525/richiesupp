// ==UserScript==
// @name         Мини-калькулятор
// @namespace    sparkmoth
// @version      1.1
// @description  Калькулятор рядом с «Перерывчиками»: выражения, проценты, история. Открыть: Alt+C
// @match        https://sparkmoth.com/app/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const LS_HISTORY = "cwcalc_history";
  const HISTORY_MAX = 10;

  function calc(src) {
    const s = src
      .replace(/\s+/g, "")
      .replace(/,/g, ".")
      .replace(/[−–—]/g, "-")
      .replace(/[×xх]/gi, "*")
      .replace(/[÷:]/g, "/");
    const tokens = s.match(/\d+(?:\.\d+)?|\.\d+|[-+*/^()%]/g) || [];
    if (!tokens.length || tokens.join("") !== s) throw new Error("bad input");

    let i = 0;
    const peek = () => tokens[i];

    function atom() {
      const t = tokens[i++];
      let v;
      if (t === "(") {
        v = expr();
        if (tokens[i++] !== ")") throw new Error("brackets");
      } else if (t !== undefined && /^[\d.]/.test(t)) {
        v = parseFloat(t);
      } else {
        throw new Error("bad input");
      }
      if (peek() === "%") {
        i++;
        return { v: v / 100, pct: true };
      }
      return { v };
    }

    function unary() {
      if (peek() === "-") {
        i++;
        const f = unary();
        return { v: -f.v, pct: f.pct };
      }
      if (peek() === "+") {
        i++;
        return unary();
      }
      return atom();
    }

    function power() {
      const base = unary();
      if (peek() === "^") {
        i++;
        return { v: Math.pow(base.v, power().v) };
      }
      return base;
    }

    function term() {
      let left = power();
      while (peek() === "*" || peek() === "/") {
        const op = tokens[i++];
        const r = power().v;
        if (op === "/" && r === 0) throw new Error("div by zero");
        left = { v: op === "*" ? left.v * r : left.v / r };
      }
      return left;
    }

    function expr() {
      let left = term();
      while (peek() === "+" || peek() === "-") {
        const op = tokens[i++];
        const r = term();
        const val = r.pct ? left.v * r.v : r.v;
        left = { v: op === "+" ? left.v + val : left.v - val };
      }
      return left.v;
    }

    const result = expr();
    if (i < tokens.length || !isFinite(result)) throw new Error("bad input");
    return Math.round(result * 1e10) / 1e10;
  }

  const show = (n) => n.toLocaleString("ru-RU", { maximumFractionDigits: 8 });
  const load = () => { try { return JSON.parse(localStorage.getItem(LS_HISTORY)) || []; } catch (e) { return []; } };

  const css = `
  .cwcalc-fab{position:fixed;z-index:99998;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;cursor:pointer;user-select:none;box-sizing:border-box;
    border:1px solid rgba(255,255,255,.12);background:rgba(40,40,50,.92);box-shadow:0 2px 8px rgba(0,0,0,.35);transition:border-color .15s,background .15s}
  .cwcalc-fab:hover{border-color:rgba(129,140,248,.6)}
  .cwcalc-fab.open{border-color:rgba(129,140,248,.85);background:rgba(99,102,241,.22)}
  .cwcalc-fab .ic{width:18px;height:18px;border-radius:6px;display:grid;place-items:center;background:linear-gradient(135deg,#6366f1,#8b5cf6 55%,#ec4899)}
  .cwcalc-fab svg{width:11px;height:11px;stroke:#fff}
  .cwcalc{display:none;position:fixed;z-index:99998;width:250px;box-sizing:border-box;padding:12px;border-radius:16px;color:#ececf1;
    font:13px/1.35 -apple-system,"Segoe UI",Inter,system-ui,sans-serif;background:rgba(24,24,29,.92);backdrop-filter:blur(16px);
    border:1px solid rgba(255,255,255,.09);box-shadow:0 16px 44px rgba(0,0,0,.5)}
  .cwcalc.open{display:block}
  .cwcalc *{box-sizing:border-box}
  .cwcalc input{all:unset!important;display:block!important;width:100%!important;padding:9px 11px!important;border-radius:10px!important;
    background:rgba(255,255,255,.07)!important;color:#fff!important;font:600 14px ui-monospace,Menlo,Consolas,monospace!important;cursor:text}
  .cwcalc input:focus{box-shadow:0 0 0 2px rgba(129,140,248,.7)!important}
  .cwcalc-res{margin:10px 2px 8px;font:700 26px ui-monospace,Menlo,Consolas,monospace;min-height:32px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
  .cwcalc-res.err{color:#6b7280}
  .cwcalc-row{display:flex;gap:6px;margin-bottom:8px}
  .cwcalc button{all:unset;flex:1;text-align:center;padding:7px 8px;border-radius:9px;background:rgba(255,255,255,.09);cursor:pointer;font:600 12px -apple-system,"Segoe UI",sans-serif;color:#fff}
  .cwcalc button:hover{background:rgba(255,255,255,.16)}
  .cwcalc-hist div{display:flex;justify-content:space-between;gap:8px;padding:5px 6px;border-radius:7px;cursor:pointer;font:12px ui-monospace,Menlo,Consolas,monospace;color:#a3a3b2}
  .cwcalc-hist div:hover{background:rgba(255,255,255,.07);color:#fff}
  .cwcalc-hist span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .cwcalc-clear{margin-top:6px;text-align:right;font-size:11px;color:#6b7280;cursor:pointer}
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  const fab = document.createElement("div");
  fab.className = "cwcalc-fab";
  fab.title = "Калькулятор (Alt+C)";
  fab.innerHTML = '<div class="ic"><svg viewBox="0 0 24 24" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3" width="14" height="18" rx="2.5"/><path d="M8.5 7.5h7"/><path d="M8.5 12h.01M12 12h.01M15.5 12h.01M8.5 16h.01M12 16h.01M15.5 16h.01"/></svg></div>';

  const box = document.createElement("div");
  box.className = "cwcalc";
  box.innerHTML = `
    <input id="in" placeholder="например: 1500 - 3%" autocomplete="off" spellcheck="false">
    <div class="cwcalc-res err" id="res" title="Клик — копировать">0</div>
    <div class="cwcalc-row">
      <button id="copy">Копировать</button>
      <button id="save">В историю</button>
    </div>
    <div class="cwcalc-hist" id="hist"></div>
    <div class="cwcalc-clear" id="clear">очистить историю</div>`;
  document.body.append(box, fab);

  const $ = (id) => box.querySelector("#" + id);
  let current = null;

  function update() {
    const text = $("in").value;
    try {
      current = calc(text);
      $("res").textContent = show(current);
      $("res").classList.remove("err");
    } catch (e) {
      current = null;
      $("res").textContent = text.trim() ? "…" : "0";
      $("res").classList.add("err");
    }
  }

  function renderHistory() {
    const list = load();
    const wrap = $("hist");
    wrap.innerHTML = "";
    list.forEach((h) => {
      const row = document.createElement("div");
      const a = document.createElement("span");
      const b = document.createElement("span");
      a.textContent = h.e;
      b.textContent = "= " + show(h.r);
      row.append(a, b);
      row.onclick = () => { $("in").value = String(h.r); update(); $("in").focus(); };
      wrap.appendChild(row);
    });
    $("clear").style.display = list.length ? "block" : "none";
  }

  function save() {
    if (current == null) return;
    const list = load();
    list.unshift({ e: $("in").value.trim(), r: current });
    localStorage.setItem(LS_HISTORY, JSON.stringify(list.slice(0, HISTORY_MAX)));
    $("in").value = String(current);
    update();
    renderHistory();
  }

  function copy() {
    if (current == null) return;
    navigator.clipboard.writeText(String(current)).then(() => {
      const b = $("copy");
      b.textContent = "Скопировано";
      setTimeout(() => (b.textContent = "Копировать"), 900);
    });
  }

  function place() {
    const r = fab.getBoundingClientRect();
    const w = box.offsetWidth;
    box.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + "px";
    box.style.top = r.bottom + 10 + "px";
  }

  function grabSelection() {
    const t = String(window.getSelection()).trim();
    return t.length > 0 && t.length <= 40 && /\d/.test(t) ? t : "";
  }

  function setOpen(open, prefill) {
    box.classList.toggle("open", open);
    fab.classList.toggle("open", open);
    if (!open) return;
    if (prefill) $("in").value = prefill;
    update();
    renderHistory();
    place();
    $("in").focus();
    $("in").select();
  }

  $("in").addEventListener("input", update);
  $("in").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); save(); }
  });
  $("res").onclick = copy;
  $("copy").onclick = copy;
  $("save").onclick = save;
  $("clear").onclick = () => { localStorage.removeItem(LS_HISTORY); renderHistory(); };

  document.addEventListener("keydown", (e) => {
    if (e.altKey && e.code === "KeyC") {
      e.preventDefault();
      setOpen(!box.classList.contains("open"), grabSelection());
    } else if (e.key === "Escape" && box.classList.contains("open")) {
      setOpen(false);
    }
  });

  document.addEventListener("mousedown", (e) => {
    if (box.classList.contains("open") && !box.contains(e.target) && !fab.contains(e.target)) setOpen(false);
  });

  let selection = "";
  fab.addEventListener("mousedown", (e) => {
    selection = grabSelection();
    e.preventDefault();
  });
  fab.addEventListener("click", () => setOpen(!box.classList.contains("open"), selection));

  let sg = null, lastSearch = 0;
  function findSG() {
    for (const el of document.querySelectorAll("body *")) {
      if (el.children.length || el.closest(".cwcalc") || el.closest(".cwcalc-fab") || el.closest(".cwdp")) continue;
      if (el.textContent.trim() !== "SG") continue;
      const r = el.getBoundingClientRect();
      if (r.width && r.top < 80 && r.left < 260) return el;
    }
    return null;
  }

  function positionFab() {
    let a = document.querySelector(".cwdp-launch");
    if (!a) {
      if ((!sg || !sg.isConnected) && Date.now() - lastSearch > 2000) {
        lastSearch = Date.now();
        sg = findSG();
      }
      a = sg;
    }
    let x = 190, y = 8;
    if (a && a.isConnected) {
      const r = a.getBoundingClientRect();
      x = r.right + 8;
      y = r.top + r.height / 2 - 13;
    }
    fab.style.left = x + "px";
    fab.style.top = Math.max(2, y) + "px";
    if (box.classList.contains("open")) place();
  }

  positionFab();
  setInterval(positionFab, 400);
  window.addEventListener("resize", positionFab);
})();
