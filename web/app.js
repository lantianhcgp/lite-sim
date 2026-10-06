// lite-sim 主逻辑：拉源码 → 规则体检 → 运行页面 → 报错面板 → 上报
import { checkAll } from "/web/checker.js";
import { Reporter } from "/web/reporter.js";
import { Page, createSysMocks, parseHml } from "/web/runtime/engine.js";
import { ModuleLoader } from "/web/runtime/moduleloader.js";

const $ = s => document.querySelector(s);
const rep = new Reporter({ endpoint: "/api/logs" });
let mocks = createSysMocks(rep);
let source = null;          // { project, files, base }
let issues = [];            // 最近一次体检结果
let currentPage = null;     // Page 实例
let currentRel = "pages/index/index";

const PAGES = ["pages/index/index", "pages/edit/edit", "pages/note/note", "pages/keyboard/keyboard"];

// ================================================================ UI: 报错面板
const KINDS = [
  { k: "", label: "全部" },
  { k: "rule", label: "规则" },
  { k: "exception", label: "异常" },
  { k: "event", label: "事件" },
  { k: "api", label: "API" },
  { k: "data", label: "数据" },
  { k: "lifecycle", label: "生命周期" },
];
let filter = { level: "", kind: "", q: "" };

function buildChips() {
  const box = $("#chips");
  box.innerHTML = "";
  const lv = [["", "全部", ""], ["error", "错误", "e"], ["warn", "警告", "w"], ["info", "信息", "i"]];
  for (const [val, label, cls] of lv) {
    const b = document.createElement("div");
    b.className = "chip " + cls + (filter.level === val ? " on" : "");
    const n = countLevel(val);
    b.innerHTML = `${label}<span class="n">${n}</span>`;
    b.onclick = () => { filter.level = val; buildChips(); renderList(); };
    box.appendChild(b);
  }
  for (const it of KINDS) {
    const b = document.createElement("div");
    b.className = "chip" + (filter.kind === it.k ? " on" : "");
    b.textContent = it.label;
    b.onclick = () => { filter.kind = it.k; buildChips(); renderList(); };
    box.appendChild(b);
  }
}
function countLevel(lv) {
  if (!lv) return rep.issues.length;
  return rep.issues.filter(i => i.level === lv).length;
}

function renderCounts() {
  const s = rep.stats();
  $("#counts").innerHTML =
    `<span class="e"><b>${s.error}</b> 错误</span>` +
    `<span class="w"><b>${s.warn}</b> 警告</span>` +
    `<span class="i"><b>${s.info}</b> 信息</span>` +
    `<span>共 ${s.total}</span>`;
}

function renderList() {
  const list = rep.filter(filter);
  const box = $("#list");
  if (!list.length) {
    const err = rep.counts.error;
    box.innerHTML = `<div class="empty">${err === 0 && rep.issues.length === 0
      ? "还没有诊断结果<br><b>点上方「规则体检」</b>，再点「运行」看真机行为"
      : "当前筛选下没有问题"}</div>`;
    return;
  }
  box.innerHTML = "";
  for (const it of list.slice().reverse()) box.appendChild(card(it));
}

function card(it) {
  const d = document.createElement("div");
  d.className = "card " + it.level;
  const loc = it.file ? `${it.file}${it.line ? ":" + it.line : ""}` : "";
  d.innerHTML = `
    <div class="row1">
      <span class="lvl">${it.level === "error" ? "错误" : it.level === "warn" ? "警告" : "信息"}</span>
      <span class="code">${esc(it.code)}</span>
      <span class="title">${esc(it.title)}</span>
      ${loc ? `<span class="loc">${esc(loc)}</span>` : ""}
      <span class="loc">${it.time || ""}</span>
    </div>
    ${it.message ? `<div class="msg">${esc(it.message)}</div>` : ""}
    ${it.hint ? `<div class="hint">${esc(it.hint)}</div>` : ""}
    ${it.source ? `<div class="src">${esc(it.source)}</div>` : ""}
    ${it.context && it.context.stack ? `<div class="ctx">${esc(it.context.stack)}</div>` : ""}
    <div class="acts">
      <button data-a="copy">复制这条</button>
      ${loc ? `<button data-a="open">打开源码</button>` : ""}
    </div>`;
  d.querySelector('[data-a="copy"]').onclick = () => copy(rep.exportText([it]), "已复制该问题");
  const open = d.querySelector('[data-a="open"]');
  if (open) open.onclick = () => openSource(it.file, it.line);
  return d;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function renderLog() {
  const box = $("#log");
  const rows = rep.issues.slice(-120);
  box.innerHTML = rows.map(i =>
    `<div class="l ${i.level}"><span class="t">${i.time || ""}</span>[${i.kind}] ${esc(i.code)} · ${esc(i.title)}</div>`
  ).join("") || `<div class="l">（运行页面后这里会实时滚动 API/事件/数据变更日志）</div>`;
  box.scrollTop = box.scrollHeight;
}

rep.on(() => { renderCounts(); buildChips(); renderList(); renderLog(); });

// ============================================================ UI: 通用
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 1600);
}
async function copy(text, okMsg) {
  try { await navigator.clipboard.writeText(text); toast(okMsg || "已复制"); }
  catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); toast(okMsg || "已复制"); } catch (e2) { toast("复制失败"); }
    ta.remove();
  }
}
function openSource(file, line) {
  toast(`${file}${line ? " 第 " + line + " 行" : ""}（内容见下方日志 / 用 fs_read 取）`);
  console.log("openSource", file, line);
}

// ============================================================ 加载项目
async function loadProject() {
  const p = $("#project").value || "memo-todo";
  setInfo("正在拉取源码…");
  try {
    const r = await fetch(`/api/source?project=${encodeURIComponent(p)}`);
    source = await r.json();
    if (!source.ok) throw new Error(source.error || "加载失败");
    $("#fileInfo").textContent = source.count;
    $("#projInfo").textContent = source.project;
    setInfo("");
    return source;
  } catch (e) {
    toast("拉取源码失败: " + e.message);
    rep.push({ kind: "api", level: "error", code: "SRC_LOAD", title: "源码拉取失败", message: String(e.message),
      hint: "确认服务端已启动：python3 server/server.py 8787；项目路径 ~/hw_watch/<name>/entry/src/main/js/MainAbility" });
    return null;
  }
}
function setInfo(t) { $("#projInfo").textContent = t || ($("#project").value || "—"); }

async function listProjects() {
  try {
    const r = await fetch("/api/projects");
    const d = await r.json();
    if (d.ok && d.projects && d.projects.length) return d.projects.map(p => p.name);
  } catch (e) { /* 服务端旧版无该端点，走兜底 */ }
  return ["memo-todo", "elcton"];
}

// ============================================================ 规则体检
function runCheck() {
  if (!source || !source.files) { toast("先加载项目"); return; }
  rep.clear();
  const found = checkAll(source.files);
  issues = found;
  rep.rule(found);
  const e = found.filter(i => i.level === "error").length;
  const w = found.filter(i => i.level === "warn").length;
  toast(e || w ? `体检完成：${e} 错误 / ${w} 警告` : "体检通过：未发现问题");
  renderCounts(); buildChips(); renderList(); renderLog();
}

// ============================================================ 运行页面
function pickPageFiles(rel) {
  const base = rel;
  return {
    hml: source.files[base + ".hml"] || "",
    css: source.files[base + ".css"] || "",
    js: base + ".js",
    jsSrc: source.files[base + ".js"] || "",
  };
}

function runPage(rel) {
  currentRel = rel;
  if (currentPage) { currentPage.destroy(); currentPage = null; }
  const screen = $("#screen");
  screen.innerHTML = "";
  if (!source) { toast("先加载项目"); return; }

  const f = pickPageFiles(rel);
  if (!f.hml) {
    rep.push({ kind: "rule", level: "error", code: "PAGE_NO_HML", title: `页面不存在: ${rel}.hml`,
      message: "该页面没有 hml 源文件", hint: "检查 pages 目录名与 config.json 注册", file: rel });
    return;
  }
  // mocks 在每次运行时重建（清空 storage/file/router 栈，模拟冷启动）
  // onNavigate：源码里 router.push/replace/back 会真的切到目标页面
  mocks = createSysMocks(rep, {
    onNavigate: (uri) => {
      if (!uri || uri === currentRel) return;
      const target = PAGES.find(p => p === uri || p.endsWith(uri.replace(/^\//, "")));
      if (target && source && source.files[target + ".hml"]) {
        rep.lifecycle(currentRel, "router → " + uri, "模拟器跟随跳转");
        setTimeout(() => runPage(target), 60);
      }
    },
  });
  rep.lifecycle(rel, "load", `载入 ${f.hml.length}B hml / ${f.css.length}B css / ${f.jsSrc.length}B js`);

  let def;
  try {
    const loader = new ModuleLoader(source.files, { reporter: rep, mocks: mockProxy(), project: source.project });
    def = loader.loadEntry(f.js);
    if (!def || typeof def !== "object") throw new Error("export default 不是对象");
  } catch (e) {
    rep.exception(e, { page: rel, event: "模块加载", file: f.js });
    renderCounts(); buildChips(); renderList(); renderLog();
    return;
  }

  try {
    currentPage = new Page(def, { name: rel, hml: f.hml, css: f.css, reporter: rep, mocks });
    currentPage.mount(screen);
    $("#renderInfo").textContent = (currentPage.lastRenderMs || 0).toFixed(0) + "ms";
    // 持续跟踪渲染耗时
    const tick = () => {
      if (!currentPage || currentPage.destroyed) return;
      if (currentPage.lastRenderMs) $("#renderInfo").textContent = currentPage.lastRenderMs.toFixed(0) + "ms";
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    markActivePage(rel);
  } catch (e) {
    rep.exception(e, { page: rel, event: "页面实例化" });
  }
  renderCounts(); buildChips(); renderList(); renderLog();
}

// moduleloader 需要的 mock（createSysMocks 已把 6 个 @system.* 铺在顶层）
function mockProxy() { return mocks; }

function markActivePage(rel) {
  document.querySelectorAll("#pages button").forEach(b => b.classList.toggle("on", b.dataset.rel === rel));
}

function buildPageButtons() {
  const box = $("#pages");
  box.innerHTML = "";
  const list = PAGES.filter(p => source && source.files[p + ".hml"]);
  for (const p of list) {
    const b = document.createElement("button");
    b.textContent = p.split("/").slice(-2, -1)[0];
    b.dataset.rel = p;
    b.onclick = () => runPage(p);
    box.appendChild(b);
  }
  if (!list.length) box.innerHTML = `<span style="font-size:12px;color:var(--dim)">未发现页面</span>`;
}

// ============================================================ 事件绑定
// 系统返回键：Lite 页面靠 onBackPress 拦截（编辑页就是这么设计的）
$("#btnSysBack").onclick = () => {
  if (!currentPage) return;
  const back = currentPage.def && currentPage.def.onBackPress;
  if (typeof back === "function") {
    rep.lifecycle(currentRel, "系统返回", "触发 onBackPress");
    let ret;
    try { ret = back.call(currentPage); } catch (e) { rep.exception(e, { page: currentRel, event: "onBackPress" }); }
    if (ret !== true) history.back();
  } else {
    rep.lifecycle(currentRel, "系统返回", "页面未拦截，回上一页");
    if (currentRel !== "pages/index/index") runPage("pages/index/index");
  }
};

$("#btnCheck").onclick = runCheck;
$("#btnRun").onclick = () => runPage(currentRel);
$("#btnReset").onclick = () => runPage(currentRel);
$("#btnReload").onclick = async () => { await loadProject(); buildPageButtons(); runCheck(); runPage(currentRel); };
$("#btnClear").onclick = () => { rep.clear(); renderCounts(); buildChips(); renderList(); renderLog(); };
$("#btnCopy").onclick = () => copy(rep.exportText(rep.filter(filter)), "已复制完整报告");
$("#q").oninput = e => { filter.q = e.target.value.trim(); renderList(); };
$("#chkGrid").onchange = e => { $("#gridLine").style.display = e.target.checked ? "" : "none"; };
$("#chkDanger").onchange = e => { $("#dangerLine").style.display = e.target.checked ? "" : "none"; };
$("#project").onchange = async () => { await loadProject(); buildPageButtons(); runCheck(); runPage(currentRel); };

// ============================================================ 冒烟测试 ?smoke=1
// headless/一键验证：体检 → 运行 index → 点"+ 添加" → 断言跳到 edit → 点返回
async function smoke() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const step = (name, ok, detail) => rep.push({
    kind: "event", level: ok ? "info" : "error",
    code: ok ? "SMOKE_OK" : "SMOKE_FAIL",
    title: `${ok ? "通过" : "失败"} · ${name}`,
    message: detail || "", hint: ok ? "" : "检查该交互路径",
    file: "smoke", line: 0,
  });
  const text = sel => { const e = $(sel); return e ? e.textContent : ""; };
  const clickByText = (sel, kw) => {
    const els = document.querySelectorAll(sel);
    for (const e of els) if ((e.textContent || "").includes(kw)) { e.click(); return true; }
    return false;
  };
  // 只点真正的按钮元素：空态文案里也有"添加"两个字，按文本匹配会点错
  const clickBtn = (kw) => {
    const els = document.querySelectorAll("#screen .nav-btn, #screen .del-btn, #screen .c-btn, #screen .nav-btn-alt");
    for (const e of els) if (!kw || (e.textContent || "").includes(kw)) { e.click(); return true; }
    return false;
  };

  step("加载项目", !!(source && source.files), `文件 ${source ? source.count : 0}`);
  runCheck();
  step("规则体检", true, `问题 ${issues.length} 条（error ${issues.filter(i => i.level === "error").length}）`);

  runPage("pages/index/index");
  await sleep(150);
  const scr = $("#screen").textContent || "";
  step("index 渲染", scr.includes("待办"), scr.slice(0, 60));

  // 点击「+ 添加」→ 应触发 router.push → 自动切到 edit
  const clicked = clickBtn("添加");
  await sleep(320);
  const jumped = (currentRel || "").includes("edit");
  const navLog = (mocks.logs || []).filter(l => String(l.api).startsWith("router.")).slice(-4)
    .map(l => `${l.api}(${JSON.stringify(l.args).slice(0, 50)})`);
  step("点「+ 添加」跳转 edit", clicked && jumped,
    `clicked=${clicked} current=${currentRel} | router日志: ${navLog.join(" , ") || "(无)"}`);

  if (jumped) {
    await sleep(120);
    const e2 = $("#screen").textContent || "";
    step("edit 渲染", e2.length > 0, e2.slice(0, 60));
    // 编辑页没有返回按钮 —— 走系统返回键（onBackPress），与真机手势一致
    const backBtn = $("#btnSysBack");
    backBtn && backBtn.click();
    await sleep(320);
    step("系统返回 onBackPress", (currentRel || "").includes("index"), `current=${currentRel}`);
  }

  const errList = rep.issues.filter(i => i.level === "error" && !i.code.startsWith("SMOKE"))
    .map(i => `${i.code}:${(i.title || "").slice(0, 46)}`);
  step("运行期无 error", errList.length === 0, errList.join(" | ") || "0 条");
  rep.push({ kind: "lifecycle", level: "info", code: "SMOKE_DONE", title: "冒烟测试完成",
    message: `error ${rep.counts.error} / warn ${rep.counts.warn} / info ${rep.counts.info}`, hint: "",
    file: "", line: 0 });
  rep.flushNow();
}

// 未捕获异常兜底（跑源码时的漏网之鱼）
window.addEventListener("error", e => {
  rep.exception(e.error || new Error(e.message), { page: currentRel, event: "window.onerror", file: e.filename || "" });
});
window.addEventListener("unhandledrejection", e => {
  rep.exception(e.reason instanceof Error ? e.reason : new Error(String(e.reason)), { page: currentRel, event: "unhandledrejection" });
});

// ============================================================ 启动
(async function boot() {
  const names = await listProjects();
  const sel = $("#project");
  sel.innerHTML = names.map(n => `<option value="${n}">${n}</option>`).join("");
  sel.value = names.includes("memo-todo") ? "memo-todo" : names[0];
  await loadProject();
  buildPageButtons();
  renderCounts(); buildChips(); renderList(); renderLog();
  // 首次自动体检（零操作就能看到价值）
  if (source && source.files) runCheck();
  // 自动运行默认页面：打开就能看到渲染 + 运行期日志，无需手动点
  if (source && source.files) runPage(currentRel);
  // ?smoke=1 → 跑一遍冒烟（headless 验证 / 一键回归）
  if (new URLSearchParams(location.search).get("smoke")) {
    setTimeout(() => smoke(), 400);
  }
  // 上报状态
  const st = $("#upState");
  rep.on(() => {
    fetch("/api/logs?lines=1").then(r => { st.textContent = "上报: 已连接"; st.className = "ok"; })
      .catch(() => { st.textContent = "上报: 服务端未连接"; st.className = "err"; });
  });
})();
