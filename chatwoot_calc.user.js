// ==UserScript==
// @name         Мини-калькулятор
// @namespace    sparkmoth
// @version      2.0
// @description  Калькулятор в стиле Windows рядом с «Перерывчиками». Открыть: Alt+C
// @match        https://sparkmoth.com/app/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const LS_HISTORY = "cwcalc_history";
  const HISTORY_MAX = 15;
  const NBSP = "\u00a0";

  const OPS = {
    "+": (a, b) => a + b,
    "−": (a, b) => a - b,
    "×": (a, b) => a * b,
    "÷": (a, b) => a / b,
  };

  const KEYS = [
    ["%", "p", "fn"], ["CE", "ce", "fn"], ["C", "c", "fn"], ["⌫", "bs", "fn"],
    ["1/x", "inv", "fn"], ["x²", "sqr", "fn"], ["√x", "sqrt", "fn"], ["÷", "÷", "op"],
    ["7", "7", "num"], ["8", "8", "num"], ["9", "9", "num"], ["×", "×", "op"],
    ["4", "4", "num"], ["5", "5", "num"], ["6", "6", "num"], ["−", "−", "op"],
    ["1", "1", "num"], ["2", "2", "num"], ["3", "3", "num"], ["+", "+", "op"],
    ["±", "neg", "num"], ["0", "0", "num"], [",", ".", "num"], ["=", "=", "eq"],
  ];

  let st;
  function reset(keepLast) {
    st = {
      acc: null, op: null, cur: "0", top: "",
      overwrite: true, entered: false, error: false,
      lastOp: keepLast && st ? st.lastOp : null,
      lastB: keepLast && st ? st.lastB : null,
    };
  }
  reset(false);

  const num = () => parseFloat(st.cur);
  const clean = (v) => parseFloat(v.toPrecision(15));
  const str = (v) => String(clean(v));

  function group(s) {
    const neg = s[0] === "-";
    const body = neg ? s.slice(1) : s;
    if (/e/i.test(body)) return (neg ? "-" : "") + body.replace(".", ",");
    const [i, f] = body.split(".");
    const g = i.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
    return (neg ? "-" : "") + g + (f !== undefined ? "," + f : "");
  }

  function fail(msg) {
    reset(false);
    st.error = true;
    st.cur = msg || "Ошибка";
  }

  function apply(op, a, b) {
    if (op === "÷" && b === 0) throw new Error("zero");
    return clean(OPS[op](a, b));
  }

  function digit(d) {
    if (st.error) reset(true);
    if (st.overwrite) {
      st.cur = d;
      st.overwrite = false;
      if (!st.op) st.top = "";
    } else if (st.cur === "0") {
      st.cur = d;
    } else if (st.cur.replace(/[-.]/g, "").length < 16) {
      st.cur += d;
    }
    st.entered = true;
  }

  function point() {
    if (st.error) reset(true);
    if (st.overwrite) {
      st.cur = "0.";
      st.overwrite = false;
      if (!st.op) st.top = "";
    } else if (!st.cur.includes(".")) {
      st.cur += ".";
    }
    st.entered = true;
  }

  function operator(op) {
    if (st.error) reset(true);
    if (st.op && st.entered) {
      try { st.acc = apply(st.op, st.acc, num()); } catch (e) { return fail("Деление на ноль"); }
      st.cur = str(st.acc);
    } else if (!st.op) {
      st.acc = num();
    }
    st.op = op;
    st.overwrite = true;
    st.entered = false;
    st.top = group(str(st.acc)) + " " + op;
  }

  function equals() {
    if (st.error) return;
    let a, op, b;
    if (st.op) { a = st.acc; op = st.op; b = num(); }
    else if (st.lastOp) { a = num(); op = st.lastOp; b = st.lastB; }
    else return;
    let r;
    try { r = apply(op, a, b); } catch (e) { return fail("Деление на ноль"); }
    st.top = group(str(a)) + " " + op + " " + group(str(b)) + " =";
    saveHistory(st.top, r);
    st.lastOp = op;
    st.lastB = b;
    st.acc = null;
    st.op = null;
    st.cur = str(r);
    st.overwrite = true;
    st.entered = false;
  }

  function percent() {
    if (st.error) return;
    st.cur = st.op ? str((st.acc * num()) / 100) : "0";
    st.overwrite = true;
    st.entered = true;
  }

  function unary(kind) {
    if (st.error) return;
    const v = num();
    const shown = group(str(v));
    let r, label;
    if (kind === "inv") {
      if (v === 0) return fail("Деление на ноль");
      r = 1 / v;
      label = "1/(" + shown + ")";
    } else if (kind === "sqr") {
      r = v * v;
      label = "sqr(" + shown + ")";
    } else {
      if (v < 0) return fail("Недопустимый ввод");
      r = Math.sqrt(v);
      label = "√(" + shown + ")";
    }
    st.cur = str(r);
    st.top = (st.op ? group(str(st.acc)) + " " + st.op + " " : "") + label;
    st.overwrite = true;
    st.entered = true;
  }

  function negate() {
    if (st.error || st.cur === "0") return;
    st.cur = st.cur[0] === "-" ? st.cur.slice(1) : "-" + st.cur;
    st.entered = true;
  }

  function backspace() {
    if (st.error || st.overwrite) return;
    st.cur = st.cur.slice(0, -1);
    if (st.cur === "" || st.cur === "-") st.cur = "0";
  }

  function press(k) {
    if (/^\d$/.test(k)) digit(k);
    else if (OPS[k]) operator(k);
    else if (k === ".") point();
    else if (k === "=") equals();
    else if (k === "p") percent();
    else if (k === "neg") negate();
    else if (k === "bs") backspace();
    else if (k === "c") reset(true);
    else if (k === "ce") { if (st.error) reset(true); else { st.cur = "0"; st.overwrite = true; st.entered = true; } }
    else unary(k);
    render();
  }

  function loadNumber(text) {
    const t = String(text).replace(/[\s\u00a0]/g, "").replace(",", ".");
    if (!/^-?\d+(\.\d+)?$/.test(t)) return false;
    if (st.error) reset(true);
    st.cur = t.length > 16 ? str(parseFloat(t)) : t;
    st.overwrite = true;
    st.entered = true;
    if (!st.op) st.top = "";
    render();
    return true;
  }

  const readHistory = () => { try { return JSON.parse(localStorage.getItem(LS_HISTORY)) || []; } catch (e) { return []; } };
  function saveHistory(e, r) {
    const list = readHistory();
    list.unshift({ e, r });
    localStorage.setItem(LS_HISTORY, JSON.stringify(list.slice(0, HISTORY_MAX)));
  }

  const css = `
  .cwcalc-fab{position:fixed;z-index:99998;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;cursor:pointer;user-select:none;box-sizing:border-box;
    border:1px solid rgba(255,255,255,.12);background:rgba(40,40,50,.92);box-shadow:0 2px 8px rgba(0,0,0,.35);transition:border-color .15s,background .15s}
  .cwcalc-fab:hover{border-color:rgba(129,140,248,.6)}
  .cwcalc-fab.open{border-color:rgba(129,140,248,.85);background:rgba(99,102,241,.22)}
  .cwcalc-fab .ic{width:18px;height:18px;border-radius:6px;display:grid;place-items:center;background:linear-gradient(135deg,#6366f1,#8b5cf6 55%,#ec4899)}
  .cwcalc-fab svg{width:11px;height:11px;stroke:#fff}
  .cwcalc{display:none;position:fixed;z-index:99999;width:264px;box-sizing:border-box;padding:10px;border-radius:16px;color:#ececf1;outline:0;user-select:none;
    font:13px/1.35 -apple-system,"Segoe UI",Inter,system-ui,sans-serif;background:rgba(24,24,29,.94);backdrop-filter:blur(16px);
    border:1px solid rgba(255,255,255,.09);box-shadow:0 16px 44px rgba(0,0,0,.5)}
  .cwcalc.open{display:block}
  .cwcalc *{box-sizing:border-box}
  .cwcalc-bar{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;font-size:11px;font-weight:650;color:#8d8d99;text-transform:uppercase;letter-spacing:.6px}
  .cwcalc-bar div{display:flex;gap:10px;text-transform:none;letter-spacing:0;font-weight:600}
  .cwcalc-bar b{cursor:pointer;color:#a5b4fc}
  .cwcalc-bar b:hover{color:#fff}
  .cwcalc-top{min-height:16px;text-align:right;font-size:12px;color:#8d8d99;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
  .cwcalc-main{min-height:44px;line-height:44px;text-align:right;font-weight:600;overflow:hidden;white-space:nowrap;cursor:pointer;margin-bottom:6px;font-variant-numeric:tabular-nums}
  .cwcalc-keys{display:grid;grid-template-columns:repeat(4,1fr);gap:5px}
  .cwcalc-keys button{all:unset;display:grid;place-items:center;height:40px;border-radius:9px;cursor:pointer;font:600 14px -apple-system,"Segoe UI",sans-serif;color:#fff;
    background:rgba(255,255,255,.05);transition:background .1s,transform .05s}
  .cwcalc-keys button:hover{background:rgba(255,255,255,.13)}
  .cwcalc-keys button:active{transform:scale(.95)}
  .cwcalc-keys button.num{background:rgba(255,255,255,.1)}
  .cwcalc-keys button.num:hover{background:rgba(255,255,255,.18)}
  .cwcalc-keys button.eq{background:linear-gradient(135deg,#6366f1,#8b5cf6)}
  .cwcalc-keys button.eq:hover{filter:brightness(1.15)}
  .cwcalc-list{display:none;max-height:290px;overflow-y:auto}
  .cwcalc.hist .cwcalc-keys{display:none}
  .cwcalc.hist .cwcalc-list{display:block}
  .cwcalc-list div{padding:7px 8px;border-radius:8px;cursor:pointer;text-align:right}
  .cwcalc-list div:hover{background:rgba(255,255,255,.08)}
  .cwcalc-list small{display:block;color:#8d8d99;font-size:11px}
  .cwcalc-list p{margin:0;font:600 15px ui-monospace,Menlo,Consolas,monospace}
  .cwcalc-empty{padding:18px 0;text-align:center;color:#6b7280;cursor:default}
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
  box.tabIndex = -1;
  box.innerHTML = `
    <div class="cwcalc-bar"><span>Калькулятор</span><div><b id="hbtn">Журнал</b><b id="cbtn">Копировать</b></div></div>
    <div class="cwcalc-top" id="top"></div>
    <div class="cwcalc-main" id="main" title="Клик — копировать">0</div>
    <div class="cwcalc-keys" id="keys"></div>
    <div class="cwcalc-list" id="list"></div>`;
  document.body.append(box, fab);

  const $ = (id) => box.querySelector("#" + id);

  KEYS.forEach(([label, key, cls]) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = cls;
    b.dataset.k = key;
    $("keys").appendChild(b);
  });
  $("keys").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) press(b.dataset.k);
  });

  function render() {
    $("top").textContent = st.top;
    const text = st.error ? st.cur : group(st.cur);
    const main = $("main");
    main.textContent = text;
    main.style.fontSize = text.length > 16 ? "17px" : text.length > 12 ? "22px" : text.length > 9 ? "28px" : "34px";
  }

  function renderList() {
    const list = readHistory();
    const wrap = $("list");
    wrap.innerHTML = "";
    if (!list.length) {
      const e = document.createElement("div");
      e.className = "cwcalc-empty";
      e.textContent = "Журнал пуст";
      wrap.appendChild(e);
      return;
    }
    list.forEach((h) => {
      const row = document.createElement("div");
      const small = document.createElement("small");
      const p = document.createElement("p");
      small.textContent = h.e;
      p.textContent = group(str(h.r));
      row.append(small, p);
      row.onclick = () => { box.classList.remove("hist"); loadNumber(str(h.r)); st.top = ""; render(); };
      wrap.appendChild(row);
    });
    const clear = document.createElement("div");
    clear.className = "cwcalc-empty";
    clear.style.cursor = "pointer";
    clear.textContent = "Очистить журнал";
    clear.onclick = () => { localStorage.removeItem(LS_HISTORY); renderList(); };
    wrap.appendChild(clear);
  }

  function copy() {
    if (st.error) return;
    navigator.clipboard.writeText(st.cur).then(() => {
      const b = $("cbtn");
      b.textContent = "Скопировано";
      setTimeout(() => (b.textContent = "Копировать"), 900);
    });
  }

  $("main").onclick = copy;
  $("cbtn").onclick = copy;
  $("hbtn").onclick = () => {
    const on = box.classList.toggle("hist");
    $("hbtn").textContent = on ? "Назад" : "Журнал";
    if (on) renderList();
  };

  box.addEventListener("keydown", (e) => {
    const k = e.key;
    if (e.ctrlKey || e.metaKey) {
      if (e.code === "KeyC") { e.preventDefault(); copy(); }
      return;
    }
    if (k === "Escape") { setOpen(false); return; }
    if (/^\d$/.test(k)) press(k);
    else if (k === "." || k === ",") press(".");
    else if (k === "+") press("+");
    else if (k === "-") press("−");
    else if (k === "*") press("×");
    else if (k === "/") press("÷");
    else if (k === "Enter" || k === "=") press("=");
    else if (k === "Backspace") press("bs");
    else if (k === "Delete") press("ce");
    else if (k === "%") press("p");
    else return;
    e.preventDefault();
  });

  box.addEventListener("paste", (e) => {
    e.preventDefault();
    loadNumber(e.clipboardData.getData("text"));
  });

  function place() {
    const r = fab.getBoundingClientRect();
    const w = box.offsetWidth, h = box.offsetHeight;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    const top = Math.max(8, Math.min(r.bottom + 10, window.innerHeight - h - 8));
    box.style.left = left + "px";
    box.style.top = top + "px";
  }

  function grabSelection() {
    const t = String(window.getSelection()).trim();
    return t.length > 0 && t.length <= 40 ? t : "";
  }

  function setOpen(open, prefill) {
    box.classList.toggle("open", open);
    fab.classList.toggle("open", open);
    if (!open) return;
    box.classList.remove("hist");
    $("hbtn").textContent = "Журнал";
    if (prefill) loadNumber(prefill);
    render();
    place();
    box.focus();
  }

  document.addEventListener("keydown", (e) => {
    if (e.altKey && e.code === "KeyC") {
      e.preventDefault();
      setOpen(!box.classList.contains("open"), grabSelection());
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

  render();
  positionFab();
  setInterval(positionFab, 400);
  window.addEventListener("resize", positionFab);
})();
