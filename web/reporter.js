// lite-sim 报错反馈系统 —— 所有诊断的统一总线
// 来源：rule(规则体检) / exception(JS异常) / event(事件) / api(@system.*) / data(绑定) / lifecycle(生命周期)
// 每条 issue 必带：kind level code title message hint file line source context
// 落地：1) 渲染到 UI 面板  2) 批量上报服务端(我通过 MCP log_tail 直接取)

const LEVELS = { error: 0, warn: 1, info: 2 };
let seq = 0;

function now() { return Date.now(); }
function ts() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 从浏览器堆栈里挖出文件:行（动态执行的代码也能定位到调用点）
function parseStack(stack) {
  if (!stack) return { line: 0, file: "", top: "" };
  const lines = String(stack).split("\n").map(s => s.trim()).filter(s => s.startsWith("at") || s.includes(":"));
  for (const l of lines) {
    // at fn (http://host/web/xxx.js:12:34)  |  at http://host/...:12:34
    const m = /\(?([^()\s]+?):(\d+):(\d+)\)?/.exec(l);
    if (m && !/native/i.test(m[1])) {
      return { line: parseInt(m[2], 10), col: parseInt(m[3], 10), file: m[1].split("/").slice(-2).join("/"), top: l.slice(0, 140) };
    }
  }
  return { line: 0, file: "", top: lines[0] ? lines[0].slice(0, 140) : "" };
}

// JS 异常 → 带中文修复建议
function hintFor(err, ctx) {
  const m = String(err && err.message || err);
  const name = String(err && err.name || "Error");
  if (/is not a function/i.test(m)) return "调用了不存在的方法——多半是方法名拼错，或 hml 绑定的 handler 没在 export default 里实现";
  if (/Cannot read propert(y|ies) of null|undefined/.test(m)) {
    if (ctx && ctx.api) return `访问 ${ctx.api} 的返回值前判空：回调可能没触发（fail 路径没处理）`;
    return "读取了 undefined/null 的属性——检查：1) data 字段是否在 data: {} 里声明 2) 是否在 onInit 之前访问 3) 参数是否没传";
  }
  if (/Maximum call stack/i.test(m)) return "递归没出口——检查 rebuild/reload 是否自触发（回调里又调自己）";
  if (/is not defined/.test(m)) return "变量/函数未定义——检查 import 路径与方法是否在 export default 里";
  if (name === "SyntaxError") return "语法错误——多半是 ES6+ 写法（可选链/模板字符串/展开）Lite 不支持";
  if (name === "RangeError") return "超范围——检查字符串截取、数组索引是否越界";
  return "查看 message 与堆栈定位；若是 Lite 特有写法，对照腕上词典原版实现";
}

export class Reporter {
  constructor(opts = {}) {
    this.issues = [];
    this.listeners = [];
    this.queue = [];
    this.flushTimer = null;
    this.endpoint = opts.endpoint || "/api/logs";
    this.max = opts.max || 500;
    this.counts = { error: 0, warn: 0, info: 0 };
    this.startedAt = ts();
    this.seq = 0;
  }

  // ---------------------------------------------------------------- 入口
  push(iss) {
    if (!iss || !iss.title) return null;
    const rec = Object.assign({
      id: `L${String(++seq).padStart(4, "0")}`,
      ts: now(),
      time: ts(),
      kind: "rule",
      level: "error",
      code: "GENERIC",
      message: "",
      hint: "",
      file: "",
      line: 0,
      col: 0,
      source: "",
      context: {},
    }, iss);
    rec.level = LEVELS[rec.level] === undefined ? "error" : rec.level;
    this.issues.push(rec);
    this.counts[rec.level] = (this.counts[rec.level] || 0) + 1;
    if (this.issues.length > this.max) {
      const drop = this.issues.splice(0, this.issues.length - this.max);
      for (const d of drop) this.counts[d.level]--;
    }
    this.queue.push(rec);
    this.scheduleFlush();
    for (const fn of this.listeners) { try { fn(rec); } catch (e) { /* UI 监听器异常不再级联 */ } }
    return rec;
  }

  batch(arr) { for (const a of arr || []) this.push(a); return this; }

  // ---------------------------------------------------------------- 各来源
  rule(arr) {
    return this.batch((arr || []).map(r => Object.assign({ kind: "rule" }, r)));
  }

  exception(err, ctx = {}) {
    const st = parseStack(err && err.stack);
    return this.push({
      kind: "exception",
      level: "error",
      code: `JS_${(err && err.name || "Error").replace(/\W/g, "").toUpperCase() || "ERROR"}`,
      title: `${err && err.name || "Error"}: ${(err && err.message || String(err)).slice(0, 160)}`,
      message: [
        ctx.page ? `页面: ${ctx.page}` : "",
        ctx.event ? `触发: ${ctx.event}` : "",
        st.top ? `堆栈: ${st.top}` : "",
      ].filter(Boolean).join("  |  "),
      hint: hintFor(err, ctx),
      file: ctx.file || st.file || "",
      line: st.line || 0,
      col: st.col || 0,
      source: ctx.source || "",
      context: Object.assign({ stack: (err && err.stack || "").slice(0, 900) }, ctx),
    });
  }

  // 事件没注册 / handler 缺失 / 触发异常
  event(what, detail = {}, level = "info") {
    const titleMap = {
      bind: `事件绑定 ${detail.event} → ${detail.handler}`,
      fire: `${detail.event} 触发 ${detail.handler}`,
      inert: `${detail.prefix} 前缀不注册（真机静默失效）`,
      missing: `handler ${detail.handler} 未实现`,
      bubbling: `事件冒泡 ${detail.handler} 第 ${detail.times} 次触发（可能是重复绑定）`,
    };
    return this.push({
      kind: "event", level,
      code: detail.code || ({ bind: "EVT_BIND", fire: "EVT_FIRE", inert: "EVT_INERT", missing: "EVT_MISSING", bubbling: "EVT_DUP" }[what] || "EVT"),
      title: titleMap[what] || `事件 ${what}`,
      message: detail.message || JSON.stringify(detail).slice(0, 200),
      hint: what === "inert" ? "改用 @event 或裸名 onevent" :
            what === "missing" ? "在 export default 里实现该方法" :
            what === "bubbling" ? "同一事件绑在多层（list-item + 子 div）会重复触发，保留一处或加防重入" : "",
      file: detail.file || "", line: detail.line || 0,
      context: detail,
    });
  }

  // @system.* 调用日志（含回调是否执行的监督）
  api(name, args, state, detail = {}) {
    // 301 = 文件不存在，Lite 上是首次使用的正常初始化路径，不算错误
    const notFound = state === "fail" && String(detail.code) === "301";
    const level = notFound ? "warn" : (state === "fail" || state === "timeout" ? "error" : state === "warn" ? "warn" : "info");
    const title = state === "call" ? `API 调用 ${name}(${short(args)})` :
                  state === "ok" ? `${name} 回调成功` :
                  state === "fail" ? `${name} 回调失败` :
                  state === "timeout" ? `${name} 回调超时未触发` : `${name} ${state}`;
    return this.push({
      kind: "api", level,
      code: state === "timeout" ? "API_NO_CALLBACK" : state === "fail" ? "API_FAIL" : "API_CALL",
      title,
      message: detail.message || (state === "call" ? `参数: ${short(args)}` : ""),
      hint: notFound ? "文件还不存在（301）——首次使用/首次保存前属正常，代码应按「不存在 → 用默认值」处理" :
            state === "timeout" ? "success/fail 回调一个都没走——检查参数格式，或该 API 在 Lite 上需要权限/存在性判断" :
            state === "fail" ? `失败码: ${detail.code || "?"} —— 对照 Lite 错误码表` : "",
      file: detail.file || "", line: detail.line || 0,
      context: Object.assign({ args: safe(args) }, detail),
    });
  }

  // data 变更追踪（专治"改了不刷新"）
  dataChange(path, before, after, where = "") {
    const b = fmtVal(before), a = fmtVal(after);
    if (b === a) return null;
    return this.push({
      kind: "data", level: "info",
      code: "DATA_CHANGE",
      title: `${path}: ${b} → ${a}`,
      message: where ? `位置: ${where}` : "",
      hint: before === undefined ? `字段 ${path} 首次赋值——若 hml 没显示，检查是否声明在 data: {} 里（未声明不会触发响应式）` : "",
      context: { path, before: safe(before), after: safe(after), where },
    });
  }

  lifecycle(page, hook, detail = "") {
    return this.push({
      kind: "lifecycle", level: "info", code: "LIFE",
      title: `${page} ${hook}`,
      message: detail, hint: "", file: "", line: 0,
      context: { page, hook },
    });
  }

  clear() {
    this.issues = [];
    this.counts = { error: 0, warn: 0, info: 0 };
    this.queue = [];
  }

  // ---------------------------------------------------------------- 查询
  filter({ level = "", kind = "", q = "", page = "" } = {}) {
    return this.issues.filter(it => {
      if (level && it.level !== level) return false;
      if (kind && it.kind !== kind) return false;
      if (page && !(it.file || "").includes(page)) return false;
      if (q) {
        const s = `${it.code} ${it.title} ${it.message} ${it.file} ${it.hint}`.toLowerCase();
        if (!s.includes(q.toLowerCase())) return false;
      }
      return true;
    });
  }

  stats() {
    return Object.assign({ total: this.issues.length, since: this.startedAt }, this.counts);
  }

  // 一键复制（给 AI 用的紧凑格式）
  exportText(list) {
    const arr = list || this.issues;
    return arr.map(it =>
      `[${it.level.toUpperCase()}] ${it.code}  ${it.file || "-"}${it.line ? ":" + it.line : ""}\n` +
      `  ${it.title}\n` +
      (it.message ? `  详情: ${it.message}\n` : "") +
      (it.hint ? `  建议: ${it.hint}\n` : "")
    ).join("\n") || "(无问题)";
  }

  // ---------------------------------------------------------------- 上报
  on(fn) { this.listeners.push(fn); return () => { const i = this.listeners.indexOf(fn); if (i >= 0) this.listeners.splice(i, 1); }; }

  scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, 600);
  }

  async flush() {
    if (!this.queue.length) return;
    const items = this.queue.splice(0, this.queue.length);
    try {
      await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(items),
      });
    } catch (e) {
      // 服务端没起也不影响本地使用，回填队列避免丢
      this.queue.unshift(...items);
    }
  }

  flushNow() { if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; } return this.flush(); }
}

function short(v) {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return (s || "").length > 90 ? s.slice(0, 90) + "…" : s;
  } catch (e) { return String(v); }
}
function safe(v) { try { return JSON.parse(JSON.stringify(v)); } catch (e) { return String(v); } }
function fmtVal(v) {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (typeof v === "string") return v.length > 40 ? `"${v.slice(0, 40)}…(${v.length})"` : `"${v}"`;
  if (Array.isArray(v)) return `Array(${v.length})`;
  if (typeof v === "object") return "{…}";
  return String(v);
}

export { parseStack, hintFor };
