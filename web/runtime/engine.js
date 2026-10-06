// lite-sim 运行时引擎 —— HML 解析 / 响应式绑定 / 渲染 / 事件 / 生命周期
// 设计原则：宁可严格报错，也不静默失败（真机最坑的就是静默）。

// ================================================================ HML 解析
const VOID_LIKE = new Set(["input", "img", "progress"]);

export function parseHml(src) {
  const s = src.replace(/<!--[\s\S]*?-->/g, "");
  const root = { tag: "#root", attrs: {}, children: [], text: "" };
  const stack = [root];
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt < 0) { pushText(s.slice(i)); break; }
    if (lt > i) pushText(s.slice(i, lt));
    if (s.startsWith("</", lt)) {
      const gt = s.indexOf(">", lt);
      const tag = s.slice(lt + 2, gt).trim();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === tag) { stack.length = k; break; }
      }
      i = gt + 1;
      continue;
    }
    const gt = findTagEnd(s, lt);     // 必须跳过引号内的 >（如 if="{{ pending > 0 }}"）
    if (gt < 0) break;
    const raw = s.slice(lt + 1, gt);
    const selfClose = raw.trim().endsWith("/");
    const body = selfClose ? raw.trim().slice(0, -1) : raw;
    const tm = /^\s*([A-Za-z][\w-]*)/.exec(body);
    if (!tm) { i = gt + 1; continue; }
    const tag = tm[1];
    const node = { tag, attrs: parseAttrs(body.slice(tm[0].length)), children: [], text: "" };
    stack[stack.length - 1].children.push(node);
    if (!selfClose && !VOID_LIKE.has(tag)) { stack.push(node); i = gt + 1; }
    else if (!selfClose && tag === "input") {
      // Lite 允许 <input ...>文本</input>，文本即 value。input 在 VOID_LIKE 里不进栈，
      // 若不显式收集，文本会落到父节点变成兄弟 #text → flex column 里 input(方块)在上、
      // 文字在下（实测候选词 might/million 掉到键盘行上方就是这个）
      const start = gt + 1;                    // input 标签结束之后才是子文本起点
      const close = s.indexOf("</" + tag, start);
      if (close >= start && s.slice(start, close).indexOf("<") < 0) {
        node.text = s.slice(start, close);      // 可能含前后空白，渲染时 trim
        const gt2 = s.indexOf(">", close);
        i = gt2 >= 0 ? gt2 + 1 : close;
      } else i = gt + 1;
    }
    else i = gt + 1;
  }
  function pushText(t) {
    if (!t.trim()) return;
    // {{ ... }} 提取为文本片段
    const node = { tag: "#text", attrs: {}, children: [], text: t, expr: extractExpr(t) };
    stack[stack.length - 1].children.push(node);
  }
  return root;
}

// 从 '<' 开始找标签真正的 '>'：引号内的 > 不算（hml 属性值里常有 {{ a > b }}）
function findTagEnd(s, lt) {
  let quote = null;
  for (let i = lt + 1; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === ">") return i;
  }
  return -1;
}

function parseAttrs(s) {
  const out = {};
  const re = /([\w:@.-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(s)) !== null) out[m[1]] = m[2];
  // 无值布尔属性 —— 必须跳过已在引号内的片段，否则 style="width : 74 px;..." 里的
  // width/font-size 会被误判成布尔属性（DOM 上出现 chipw="true" 这种脏属性）
  const stripped = s.replace(/\s[\w:@.-]+\s*=\s*"[^"]*"/g, " ").replace(/"[^"]*"/g, "");
  const re2 = /(?:^|\s)([a-zA-Z][\w-]*)(?=\s|$)/g;
  while ((m = re2.exec(stripped)) !== null) if (!(m[1] in out)) out[m[1]] = true;
  return out;
}

function extractExpr(text) {
  // 整段就是 {{ expr }} → 返回 expr（纯绑定）
  const whole = /^\s*\{\{([\s\S]*?)\}\}\s*$/.exec(text);
  if (whole) return { whole: whole[1].trim() };
  // 混合文本 → 分段
  const parts = [];
  const re = /\{\{([\s\S]*?)\}\}/g;
  let m, last = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ lit: text.slice(last, m.index) });
    parts.push({ expr: m[1].trim() });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ lit: text.slice(last) });
  return { parts };
}

// ================================================================ 表达式求值
// Lite 的 hml 表达式只支持 ES5；这里同样不提供 ES6 能力，跑出错就报错。
export function makeEvaluator(reporter, pageName) {
  const cache = new Map();
  return function evalExpr(rawExpr, scope) {
    // 属性值/文本常以 "{{ expr }}" 形式到达 —— 先剥掉外层花括号再编译
    let expr = String(rawExpr == null ? "" : rawExpr).trim();
    if (expr.startsWith("{{") && expr.endsWith("}}")) expr = expr.slice(2, -2).trim();
    let fn = cache.get(expr);
    if (!fn) {
      try {
        // with + new Function：让 {{ typeData }} 直接命中 data 字段（Lite 同语义）
        fn = new Function("d", `with(d){return (${expr});}`);
        cache.set(expr, fn);
      } catch (e) {
        reporter && reporter.push({
          kind: "rule", level: "error", code: "EXPR_COMPILE",
          title: `表达式编译失败: {{ ${expr} }}`,
          message: String(e.message), file: pageName,
          hint: "Lite hml 表达式只支持 ES5：不能有箭头函数/模板字符串/let/解构，复杂逻辑移入 .js",
        });
        cache.set(expr, null);
        return undefined;
      }
    }
    if (!fn) return undefined;
    try {
      return fn.call(scope, scope);
    } catch (e) {
      reporter && reporter.exception(e, { page: pageName, event: "表达式求值", source: `{{ ${expr} }}` });
      return undefined;
    }
  };
}

// HML 静态文案用 &#xXXXX; 实体（构建要求），渲染前必须解码
export function decodeEntities(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCP(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCP(parseInt(d, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
  function safeCP(n) { try { return Number.isFinite(n) ? String.fromCodePoint(n) : ""; } catch (e) { return ""; } }
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== "" && v !== 0;
}

// ================================================================ @system mock
export function createSysMocks(reporter, opts = {}) {
  // opts.onNavigate(uri)：页面跳转时通知外层切换模拟页面
  const navigate = (uri) => { if (uri && typeof opts.onNavigate === "function") opts.onNavigate(uri); };
  const logs = [];
  const store = new Map();
  const files = new Map();      // uri -> text
  const routerStack = ["pages/index/index"];
  const timers = new Map();
  let timerId = 1;

  const byteLen = v => { try { return new TextEncoder().encode(String(v == null ? "" : v)).length; } catch (e) { return String(v == null ? "" : v).length; } };
  const rec = (api, state, args, detail) => {
    const entry = { api, state, args, at: Date.now() };
    logs.push(entry);
    if (logs.length > 400) logs.shift();
    reporter && reporter.api(api, args, state, detail);
  };

  // 路由参数仓（system_router.getParams 的返回）
  let routeParams = null;
  const def = o => { o.default = o; return o; };   // 支持 import * as x → x.default.y

  const mock = {
    router: def({
      push(o) { rec("router.push", "call", o); routerStack.push(o && o.uri); routeParams = (o && o.params) || null; notifyUri(); navigate(o && o.uri); },
      replace(o) { rec("router.replace", "call", o); if (o && o.uri) routerStack[routerStack.length - 1] = o.uri; routeParams = (o && o.params) || routeParams; notifyUri(); navigate(o && o.uri); },
      back() { rec("router.back", "call", null); if (routerStack.length > 1) routerStack.pop(); routeParams = null; notifyUri(); navigate(currentUri()); },
      getParams() { rec("router.getParams", "call", routeParams); return routeParams; },
      getState() { return { stack: routerStack.slice() }; },
    }),
    storage: {
      get(o) { rec("storage.get", "call", o); const v = store.has(o.key) ? store.get(o.key) : (o.default || ""); setTimeout(() => o.success && o.success(v), 0); },
      set(o) {
        rec("storage.set", "call", { key: o.key, bytes: byteLen(o.value) });
        // Lite 硬限制：storage 单值必须 <128B（超限真机会静默丢数据）
        const n = byteLen(o.value);
        if (n >= 128) {
          rec("storage.set", "warn", { key: o.key, bytes: n }, { code: "STORAGE_OVERSIZE" });
          reporter && reporter.push({
            kind: "api", level: "error", code: "STORAGE_OVERSIZE",
            title: `storage.${o.key} 写入 ${n}B，超过 128B 上限`,
            message: "Lite 的 @system.storage 单值必须小于 128 字节，超限会写入失败或静默丢数据。",
            hint: "大内容走 @system.file（internal://app/*.json），storage 只存开关/游标等小值",
            file: "", line: 0, context: { key: o.key, bytes: n },
          });
        }
        store.set(o.key, o.value);
        setTimeout(() => o.success && o.success(), 0);
      },
      delete(o) { rec("storage.delete", "call", o); store.delete(o.key); setTimeout(() => o.success && o.success(), 0); },
    },
    file: {
      // Lite 的 file.get 取的是「文件元信息」(length)，readLargeFile 靠 data.length
      // 算分块数。若像 readText 那样返回 text，data.length 会是 undefined →
      // read_count=NaN → idx>=NaN 永远 false → step() 无限递归 → 页面卡死（实测）
      get(o) {
        const ok = files.has(o.uri);
        rec("file.get", ok ? "ok" : "fail", { uri: o.uri }, { code: ok ? 0 : 301 });
        setTimeout(() => {
          if (!ok) { o.fail && o.fail({}, 301); return; }
          const full = files.get(o.uri) || "";
          o.success && o.success({ uri: o.uri, length: full.length });
        }, 0);
      },
      readText(o) { rec("file.readText", "call", { uri: o.uri, position: o.position }); simRead(o); },
      writeText(o) { rec("file.writeText", "call", { uri: o.uri, len: (o.text || "").length }); files.set(o.uri, (o.text || "")); setTimeout(() => o.success && o.success(), 0); },
      access(o) {
        const ok = files.has(o.uri);
        // detail 携带 code：reporter 靠它区分 301（正常）与真错误
        rec("file.access", ok ? "ok" : "fail", { uri: o.uri }, { code: ok ? 0 : 301 });
        setTimeout(() => ok ? (o.success && o.success()) : (o.fail && o.fail({}, 301)), 0);
      },
      list(o) { rec("file.list", "call", o); setTimeout(() => o.success && o.success({ fileList: [] }), 0); },
    },
    vibrator: { vibrate(o) { rec("vibrator", "call", o); } },
    brightness: { setKeepScreenOn(o) { rec("brightness.setKeepScreenOn", "call", o); } },
    app: { getInfo(o) { rec("app.getInfo", "call", o); setTimeout(() => o.success && o.success({ appName: "lite-sim", versionName: "0.1.0" }), 0); } },
    sensor: {},
  };

  function simRead(o) {
    // 分块读，与真机一致（fs.readAll 递归取 CHUNK）
    const full = files.has(o.uri) ? files.get(o.uri) : null;
    if (full === null) {
      const code = 301;
      setTimeout(() => { rec("file.readText", "fail", { uri: o.uri }, { code: 301 }); o.fail && o.fail({}, 301); }, 0);
      return;
    }
    const pos = o.position || 0, len = o.length || full.length;
    const chunk = full.slice(pos, pos + len);
    setTimeout(() => { o.success && o.success({ text: chunk, offset: pos, remaining: Math.max(0, full.length - pos - chunk.length) }); }, 0);
  }

  function timerWrap(kind, fn, ms) {
    const id = timerId++;
    rec(kind, "call", { ms });
    const handle = setTimeout(() => { timers.delete(id); try { fn(); } catch (e) { reporter && reporter.exception(e, { event: kind }); } }, ms);
    timers.set(id, { handle, kind });
    return id;
  }

  // ---- $app 全局对象（Lite 运行时提供，common/router 直接裸用）
  let paramStore = {}, dataStore = {};
  // getCurrentUri 是订阅语义：common/router.js 在模块顶层注册一次，
  // 之后每次页面变化都要回调更新 current_uri —— 只回调一次的话
  // pages_array 会永远装同一个初始 uri，back 就永远回首页（实测旅程 1.8 断在这里）
  const uriWatchers = [];
  const currentUri = () => routerStack[routerStack.length - 1] || "";
  const notifyUri = () => { const u = currentUri(); for (const cb of uriWatchers) { try { cb(u); } catch (e) {} } };

  const appGlobal = {
    addAllParams(o) { rec("app.addAllParams", "call", o); Object.assign(paramStore, o || {}); },
    getAllParams(cb) { rec("app.getAllParams", "call", null); cb && cb(Object.assign({}, paramStore)); },
    cleanAllParams() { rec("app.cleanAllParams", "call", null); paramStore = {}; },
    getData(cb) { rec("app.getData", "call", null); cb && cb(Object.assign({}, dataStore)); },
    cleanData() { rec("app.cleanData", "call", null); dataStore = {}; },
    setData(o) { Object.assign(dataStore, o || {}); },
    getCurrentUri(cb) {
      if (typeof cb === "function") { uriWatchers.push(cb); cb(currentUri()); }   // 注册 + 立即回当前
      return currentUri();
    },
    getRouterUriList(cb) { cb && cb(routerStack.slice()); },
    writeRouterUriList(list) { routerStack.length = 0; for (const u of (list || [])) routerStack.push(u); },
    onPageChange(uri) { rec("app.onPageChange", "call", { uri }); },
  };
  // Lite 中 $app 是全局变量（router.js 用 try{ var g=$app }catch{} 后直接调用）
  try { globalThis.$app = appGlobal; } catch (e) { /* 非浏览器环境忽略 */ }

  // Proxy 兜底：任何未实现的方法都记录调用并尝试回调，避免"缺方法"阻塞加载
  const withFallback = (api, apiName) => new Proxy(api, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === "symbol" || k === "then" || k === "catch" || k === "toJSON" || k === "constructor") return t[k];
      return (...args) => {
        const m = `${apiName}.${String(k)}`;
        const first = args[0];
        const isCb = first && typeof first === "object";
        rec(m, "call", isCb ? { uri: first.uri, key: first.key } : args);
        if (isCb && typeof first.success === "function") {
          setTimeout(() => first.success({ text: "", fileList: [], offset: 0, remaining: 0, data: "" }), 0);
        }
        return undefined;
      };
    },
  });
  for (const k of Object.keys(mock)) {
    if (mock[k] && typeof mock[k] === "object") mock[k] = withFallback(mock[k], k);
  }

  // 顶层直接铺开 API（moduleloader 用 mocks[name] 取），同时保留诊断辅助
  return Object.assign({}, mock, {
    mock, logs, files, store, routerStack, appGlobal,
    routeParamsGet: () => routeParams,
    timers,
    setTimeout: (fn, ms) => timerWrap("setTimeout", fn, ms),
    clearInterval: id => { const rec2 = timers.get(id); if (rec2) { clearTimeout(rec2.handle); timers.delete(id); rec("clearInterval", "call", { id }); } },
    clearTimeout: id => { const rec2 = timers.get(id); if (rec2) { clearTimeout(rec2.handle); timers.delete(id); } },
    clearAll: () => { for (const [, tv] of timers) clearTimeout(tv.handle); timers.clear(); },
    seedFiles: obj => { for (const k in obj) files.set(k, obj[k]); },
    params: { set: (o) => appGlobal.setData(o) },
  });
}

// ================================================================ 页面实例
const DOM_EVENTS = { click: "click", longpress: "contextmenu", swipe: "touchstart", touchstart: "touchstart", touchend: "touchend", change: "change" };

export class Page {
  /**
   * @param def    export default { data, onInit, methods... }
   * @param ctx    { name, reporter, mocks, files, project }
   */
  constructor(def, ctx) {
    this.def = def;
    this.ctx = ctx;
    this.name = ctx.name;
    this.project = ctx.project || "";       // 供 <image src="/common/…"> 转 /api/res
    this.rep = ctx.reporter;
    this.mocks = ctx.mocks;
    this.evalExpr = makeEvaluator(this.rep, this.name);
    this.container = null;
    this.renderQueued = false;
    this.destroyed = false;
    // $refs：hml 里 ref="xxx" → this.$refs.xxx（Lite 框架注入）。缺它会在
    // `self.$refs.courseList` 直接崩 —— elcton 实测 TypeError，非被测代码 bug
    this._refEls = new Map();
    const self = this;
    this.$refs = new Proxy({}, {
      get(_, k) {
        if (typeof k === "symbol" || k === "then") return undefined;
        const el = self._refEls.get(String(k));
        if (!el) return makeRefProxy(String(k), self, null);
        return makeRefProxy(String(k), self, el);
      },
    });
    this.fireCounts = new Map();   // 事件重复触发计数

    // ---- 方法挂载
    for (const k of Object.keys(def)) {
      if (typeof def[k] === "function" && k !== "data") this[k] = def[k].bind(this);
    }
    // ---- data 响应式（直接挂在 this，与 Lite 同语义）
    const raw = Object.assign({}, def.data || {});
    this._raw = raw;
    for (const k of Object.keys(raw)) this._define(k);
    this._reactivate(raw);
  }

  _define(k) {
    const self = this;
    Object.defineProperty(this, k, {
      configurable: true,
      enumerable: true,
      get() { return self._raw[k]; },
      set(v) {
        const before = self._raw[k];
        self._raw[k] = v;
        self.rep && self.rep.dataChange(`${self.name}.${k}`, before, v, "赋值");
        self.scheduleRender();
      },
    });
  }

  // 深度响应式：嵌套对象的属性修改也能触发渲染（治"改了不显示"）
  _reactivate(obj) {
    if (!obj || typeof obj !== "object") return;
    const self = this;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (v && typeof v === "object" && !Array.isArray(v)) {
        obj[k] = new Proxy(v, {
          get(t, p) { const rv = t[p]; return (rv && typeof rv === "object" && !Array.isArray(rv)) ? (rv.__isReactive ? rv : self._wrap(t, p, rv)) : rv; },
          set(t, p, nv) { const b = t[p]; t[p] = nv; self.rep && self.rep.dataChange(`${self.name}.${k}.${String(p)}`, b, nv, "嵌套赋值"); self.scheduleRender(); return true; },
        });
      }
    }
  }
  _wrap(parent, key, val) {
    const self = this;
    if (val.__reactive) return val;
    const p = new Proxy(val, {
      get(t, k2) { const rv = t[k2]; return (rv && typeof rv === "object" && !Array.isArray(rv)) ? self._wrap(t, k2, rv) : rv; },
      set(t, k2, nv) { const b = t[k2]; t[k2] = nv; self.rep && self.rep.dataChange(`${self.name}.${key}.${String(k2)}`, b, nv, "嵌套赋值"); self.scheduleRender(); return true; },
    });
    try { p.__reactive = true; } catch (e) { /* proxy 上挂标记失败无妨 */ }
    return p;
  }

  // ---------------------------------------------------------------- 渲染
  mount(container) {
    this.container = container;
    this.hml = this.ctx.hml;
    this.ast = parseHml(this.hml);
    this.css = this.ctx.css || "";
    this.callHook("onInit");
    this.callHook("onReady");
    this.callHook("onShow");
    this.renderNow();
    this.rep && this.rep.lifecycle(this.name, "onInit → onReady → onShow", `已挂载，data 字段 ${Object.keys(this._raw).join(", ") || "无"}`);
  }

  scheduleRender() {
    if (this.destroyed || this.renderQueued) return;
    this.renderQueued = true;
    // 用 setTimeout 而不是 requestAnimationFrame：headless / 后台标签页里 rAF 会停摆，
    // 一旦卡住 renderQueued 永远为 true，后续所有 scheduleRender 被拦截、界面就冻结了
    // （旅程实测：typeData 到了 "lite" 但 DOM 停在 "l"）。setTimeout(0) 也更贴近
    // Lite「数据变化即刷新」的语义。
    setTimeout(() => { this.renderQueued = false; this.renderNow(); }, 0);
  }

  renderNow() {
    if (!this.container || this.destroyed) return;
    try {
      const t0 = performance.now();
      this.container.innerHTML = "";
      this._renderChildren(this.ast, this.container, this._raw);
      const dt = performance.now() - t0;
      this.lastRenderMs = dt;
      if (dt > 120) {
        this.rep && this.rep.push({
          kind: "data", level: "warn", code: "PERF_RENDER",
          title: `渲染耗时 ${dt.toFixed(0)}ms`,
          message: `页面 ${this.name}，Lite 真机更慢（无 JIT + 64KB 堆）`,
          hint: "检查 item 数量与嵌套；list 高度固定时可减少一次性渲染的条数",
          file: this.name, line: 0,
        });
      }
    } catch (e) {
      this.rep && this.rep.exception(e, { page: this.name, event: "render" });
    }
  }

  _renderChildren(parentNode, domParent, scope) {
    for (const node of parentNode.children) this._renderNode(node, domParent, scope);
  }

  _renderNode(node, domParent, scope) {
    if (node.tag === "#text") return this._renderText(node, domParent, scope);

    const a = node.attrs || {};

    // for 必须最先处理：它建立子作用域（$item / $index / 循环变量），
    // 同一元素上的 if/show（如 keyboard 的 show="{{ !!$item }}") 要在子作用域里求值，
    // 否则 $item is not defined 会中断整棵树渲染。
    if (a.for !== undefined && a.for !== true) {
      const it = this._evalFor(String(a.for), scope);
      if (!it) return;
      const { names, arr } = it;
      for (let idx = 0; idx < arr.length; idx++) {
        const childScope = Object.create(scope);
        if (names.length === 2) { childScope[names[0]] = idx; childScope[names[1]] = arr[idx]; childScope.$item = arr[idx]; childScope.$index = idx; }
        else { childScope[names[0]] = arr[idx]; childScope.$item = arr[idx]; childScope.$index = idx; }
        const holder = document.createElement("div");
        holder.style.display = "contents";
        domParent.appendChild(holder);
        // 递归时去掉 for，保留 if/show —— 它们将在 childScope 中求值
        this._renderNode({ tag: node.tag, attrs: strip(a, ["for"]), children: node.children, text: node.text }, holder, childScope);
      }
      return;
    }

    // if / elif / else（此刻 scope 已是 for 建立的子作用域）
    if (a.if !== undefined && a.if !== true) {
      let cond;
      try { cond = this.evalExpr(String(a.if), scope); } catch (e) { cond = false; }
      if (!truthy(cond)) return;
    }
    let hideByShow = false;
    if (a.show !== undefined && a.show !== true) {
      try { hideByShow = !truthy(this.evalExpr(String(a.show), scope)); } catch (e) { hideByShow = true; }
    }

    // 普通元素
    const el = document.createElement(mapTag(node.tag));
    if (hideByShow) el.style.display = "none";   // Lite: show=false 仍构建节点但不显示
    this._applyAttrs(node, el, scope);

    // <image src="/common/image/…"> 是 app 内资源路径，浏览器直连 404 → 转发 /api/res；
    // 加载失败（文件名不存在等）时降级成占位块，不显示浏览器的坏图图标
    if (node.tag === "image" || node.tag === "img") {
      // src 的代理转换统一在 _applyAttrs 的属性循环里做 —— 这里绝不能再转一次，
      // 否则套娃成 /api/res?path=api%2Fres%3Fpath%3D…（实测 4 个图标全 404 降级）
      // 降级判定：等一个事件循环，看「当前」代理 URL 是否真的加载失败。
      // 光看 src 值不够 —— 原始路径的 404 会在改完 src 之后才把 error 送回来，
      // 那时 src 已是代理路径，直接降级会把好图误杀（用户实测"图标都没显示"）。
      el.addEventListener("error", () => {
        const tried = el.getAttribute("src") || el.src || "";
        setTimeout(() => {
          const cur = el.getAttribute("src") || "";
          if (!cur.includes("/api/res")) return;
          if (!(el.complete && el.naturalWidth === 0)) return;   // 当前图其实成功了
          // 诊断：把失败的完整 URL 报进日志（排查代理 404 / 编码问题）
          if (this.rep) this.rep.api("img.load", { src: cur.slice(0, 150), tried: String(tried).slice(0, 150),
            complete: el.complete, naturalWidth: el.naturalWidth }, "fail",
            { url: cur, eventSrc: tried });
          el.removeAttribute("src");
          el.style.background = "#24262C";
          el.style.border = "1px dashed #3A3F47";
        }, 0);
      });
    }

    this._bindEvents(node, el, scope);
    domParent.appendChild(el);
    this._renderChildren(node, el, scope);
  }

  _renderText(node, domParent, scope) {
    const ex = node.expr;
    if (ex && ex.whole !== undefined) {
      let v;
      try { v = this.evalExpr(ex.whole, scope); } catch (e) { v = ""; }
      domParent.appendChild(document.createTextNode(decodeEntities(fmt(v))));
      return;
    }
    if (ex && ex.parts) {
      let out = "";
      for (const p of ex.parts) {
        if (p.lit !== undefined) out += p.lit;
        else { try { out += fmt(this.evalExpr(p.expr, scope)); } catch (e) { /* 已报 */ } }
      }
      domParent.appendChild(document.createTextNode(decodeEntities(out)));
      return;
    }
    domParent.appendChild(document.createTextNode(decodeEntities(node.text || "")));
  }

  _evalFor(rawExpr, scope) {
    // 属性值形如 "{{ (idx, it) in view }}" —— 必须先剥外层花括号再解析，
    // 否则正则不匹配、会退化成整串求值并抛 idx is not defined
    let expr = String(rawExpr == null ? "" : rawExpr).trim();
    if (expr.startsWith("{{") && expr.endsWith("}}")) expr = expr.slice(2, -2).trim();
    let m;
    if ((m = /^\((\w+)\s*,\s*(\w+)\)\s+in\s+(.+)$/.exec(expr))) {
      return { names: [m[1], m[2]], arr: toArr(this.evalExpr(m[3], scope)) };
    }
    if ((m = /^(\w+)\s+in\s+(.+)$/.exec(expr))) {
      return { names: [m[1]], arr: toArr(this.evalExpr(m[2], scope)) };
    }
    // 纯数组表达式
    if (/^[\w$.\[\]]+$/.test(expr)) {
      return { names: ["$item"], arr: toArr(this.evalExpr(expr, scope)) };
    }
    return null;
    function toArr(x) { return Array.isArray(x) ? x : []; }
  }

  _applyAttrs(node, el, scope) {
    const a = node.attrs || {};
    // 注意：image 的 src 统一在下面的属性循环里转换（动态/静态一次处理），
    // 不要在这里再改 a.src —— 会和循环里的转换叠成 /api/res?path=api%2Fres%3F… 套娃

    // 收集 ref="xxx" → $refs（Lite 的 ref 由框架注入到 this.$refs）
    if (a.ref !== undefined && a.ref !== true) {
      const nm = String(a.ref).replace(/[{}"]/g, "").trim();
      if (nm) this._refEls.set(nm, el);
    }
    const cls = [], style = [];
    for (const k of Object.keys(a)) {
      const v = a[k];
      if (k === "class") { for (const c of String(v).split(/\s+/)) if (c) cls.push(c); continue; }  // "item tail" 必须拆开
      if (k === "style") {
        // hml 的 style 里常见 {{ RounderBackgroundValue.background }} 这类动态值，
        // 原样保留会让 background-color/border-radius 整条声明失效（div 变透明）
        style.push(fixCssUnits(this._bindStr(String(v), scope)));
        continue;
      }
      if (k === "id") { el.id = String(v); continue; }
      if (k === "ref") { this._ref(String(v), el); continue; }
      if (k === "if" || k === "for" || k === "show" || k === "tid") continue;
      if (k === "value" || k === "src" || k === "placeholder" || k === "type") {
        let sv = this._bindStr(String(v), scope);
        // 动态 src（src="{{ '/common/…' + menuType }}"）必须在这里就转代理路径：
        // 若先设原始路径、渲染后再改，旧的 404 error 会波及新状态把图标误降级
        if (k === "src" && (node.tag === "image" || node.tag === "img")
            && typeof sv === "string" && sv.startsWith("/") && !sv.startsWith("//")
            && !sv.includes("/api/res")) {
          sv = "/api/res?project=" + encodeURIComponent(this.project) +
               "&path=" + encodeURIComponent(sv.replace(/^\//, ""));
        }
        el.setAttribute(k, sv);
        continue;
      }
      if (k.startsWith("@") || k.startsWith("on") || k.startsWith("grab:")) continue;
      el.setAttribute(k, this._bindStr(String(v), scope));
    }
    // 应用该 class 的 css（Lite 同名类叠加，后者覆盖前者）
    const cssText = this._cssFor(cls);
    let inline = cssText ? cssTextToInline(cssText) : "";

    // Lite 盒模型：div/stack/list 等容器默认 display:flex（浏览器默认是 block，
    // 不补这句则 flex-direction/justify-content/align-items 全部无效 —— 实测按钮会纵向堆叠）
    if (LITE_FLEX_TAGS.has(node.tag) && !/display\s*:/.test(inline)) {
      inline = "display:flex;" + inline;
      // Lite 的 list 语义是纵向列表：浏览器 flex 默认 row，子项会横向排并溢出
      if (node.tag === "list" && !/flex-direction\s*:/.test(inline)) {
        inline += ";flex-direction:column";
      }
    }
    if (inline) {
      el.setAttribute("style", (el.getAttribute("style") || "") + ";" + inline);
    }
    if (cls.length) el.className = cls.join(" ");
    if (style.length) el.setAttribute("style", (el.getAttribute("style") || "") + ";" + style.join(";"));
    // 真机：带 border-radius 的容器会把溢出的子内容按圆角裁掉（用户实测键盘图标是圆角裁切的）。
    // 浏览器的 border-radius 不会自动裁子元素，必须显式 overflow:hidden。
    // 必须在「类 CSS + 元素 style」都合并之后判断 —— 图标容器（hml line 18/28/85/89）
    // 没有 class，border-radius 只在 style 属性里，放早了会漏（实测漏 4 个）。
    // 另注意别被 text-overflow:ellipsis 骗了（它含 "overflow:"），只认真正的 overflow。
    {
      const fin = el.getAttribute("style") || "";
      if (/border-radius\s*:/.test(fin) && !/(?<![-a-z])overflow\s*:/.test(fin)) {
        el.setAttribute("style", fin + ";overflow:hidden");
      }
    }
    // 透传事件属性值给 input；value 属性缺失时用子文本（Lite 的 <input>{{x}}</input> 写法）
    if (el.tagName === "INPUT") {
      const rawVal = a.value !== undefined ? a.value : String(node.text || "").trim();
      if (rawVal !== undefined && rawVal !== "") el.value = this._bindStr(String(rawVal), scope);
      else if (a.value !== undefined) el.value = "";
    }
  }

  _bindStr(v, scope) {
    if (!v.includes("{{")) return v;
    const ex = extractExpr(v);
    if (ex.whole !== undefined) { try { return decodeEntities(fmt(this.evalExpr(ex.whole, scope))); } catch (e) { return ""; } }
    let out = "";
    for (const p of ex.parts || []) out += p.lit !== undefined ? p.lit : fmt(safeEval(this, p.expr, scope));
    return decodeEntities(out);
    function safeEval(pg, e, sc) { try { return pg.evalExpr(e, sc); } catch (err) { return ""; } }
  }

  _bindEvents(node, el, scope) {
    const a = node.attrs || {};
    for (const k of Object.keys(a)) {
      let ev = null, handlerExpr = null;
      if (k.startsWith("@")) { ev = k.slice(1); handlerExpr = a[k]; }
      else if (/^on(click|longpress|swipe|touchstart|touchend|change)$/.test(k)) { ev = k.slice(2); handlerExpr = a[k]; }
      else if (/^(grab|on):(\w+)$/.test(k)) {
        // 静默失效前缀 —— 直接报错（真机最坑的行为）
        this.rep && this.rep.event("inert", { prefix: RegExp.$1 + ":" + RegExp.$2, handler: a[k], file: this.name, level: "error", code: "EVT_INERT_PREFIX" }, "error");
        continue;
      }
      if (!ev || !handlerExpr) continue;
      const domEv = DOM_EVENTS[ev] || ev;
      const m = /^([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)$/.exec(String(handlerExpr).trim());
      const fnName = m ? m[1] : String(handlerExpr).trim();
      const argSrc = m ? m[2] : "";

      if (typeof this[fnName] !== "function") {
        this.rep && this.rep.event("missing", { handler: fnName, event: ev, file: this.name, line: 0 }, "error");
        continue;
      }
      // 只在本页面实例首次绑定时上报：innerHTML 重建会重新走这里，重复报会刷屏
      const bindKey = ev + ":" + fnName;
      if (!this._boundKeys) this._boundKeys = new Set();
      if (!this._boundKeys.has(bindKey)) {
        this._boundKeys.add(bindKey);
        this.rep && this.rep.event("bind", { handler: fnName, event: ev, file: this.name });
      }
      el.addEventListener(domEv, (domEvent) => {
        const key = ev + ":" + fnName;
        const n = (this.fireCounts.get(key) || 0) + 1;
        this.fireCounts.set(key, n);
        if (n === 3 || (n > 3 && n % 5 === 0)) {
          this.rep && this.rep.event("bubbling", { handler: fnName, event: ev, times: n, file: this.name }, "warn");
        }
        let args = [];
        if (argSrc.trim()) {
          try { args = [this.evalExpr(argSrc, scope)]; } catch (e) { this.rep && this.rep.exception(e, { page: this.name, event: `${ev}:${fnName}`, source: argSrc }); }
        }
        try {
          this.rep && this.rep.event("fire", { handler: fnName, event: ev, file: this.name });
          const r = this[fnName](...args, domEvent);
          if (r && typeof r.then === "function") r.catch(e => this.rep && this.rep.exception(e, { page: this.name, event: `${ev}:${fnName}` }));
        } catch (e) {
          this.rep && this.rep.exception(e, { page: this.name, event: `${ev}:${fnName}`, source: String(handlerExpr) });
        }
      }, { passive: true });
    }
  }

  _ref(name, el) { (this.$refs || (this.$refs = {}))[name] = el; }

  _cssFor(classes) {
    if (!this.css) return "";
    let out = "";
    for (const c of classes) {
      // Lite 只支持单类选择器，逐条抽取（同时能发现复合选择器问题）
      const re = new RegExp("(^|\\n)\\s*\\." + c.replace(/[-]/g, "\\-") + "\\s*\\{[^}]*\\}", "g");
      let m; while ((m = re.exec(this.css)) !== null) out += m[0].trim() + "\n";
    }
    return out;
  }

  // ---------------------------------------------------------------- 生命周期
  callHook(name, ...args) {
    const fn = this.def[name] || this[name];
    if (typeof this.def[name] === "function") {
      try { return this.def[name].apply(this, args); }
      catch (e) { this.rep && this.rep.exception(e, { page: this.name, event: name }); }
    }
    return undefined;
  }

  show() { this.callHook("onShow"); }
  hide() { this.callHook("onHide"); }

  destroy() {
    this.destroyed = true;
    this.callHook("onDestroy");
    this.mocks && this.mocks.clearAll();
    this.rep && this.rep.lifecycle(this.name, "onDestroy", "定时器已清理");
    if (this.container) this.container.innerHTML = "";
  }
}

// ================================================================ 工具
// Lite 中默认按 flex 布局的容器（浏览器默认是 block，必须显式补）
const LITE_FLEX_TAGS = new Set(["div", "stack", "list", "list-item", "tabs", "tab-content", "swiper"]);

// $refs.xxx 的模拟组件实例：记录方法调用；scrollTo 等做可行实现，其余只记日志
function makeRefProxy(name, page, el) {
  const rec = (m, args) => page.rep && page.rep.api(`$refs.${name}.${m}`, args, "ok");
  return new Proxy({}, {
    get(_, k) {
      if (typeof k === "symbol") return undefined;
      if (k === "scrollTo") return (o) => { rec("scrollTo", o); };       // list 滚动
      if (k === "scrollIndex") return 0;
      if (k === "offset") return { x: 0, y: 0 };
      if (k === "id") return name;
      // 其他方法：记录并返回 undefined（调用方一般有 if 判空）
      return (...args) => { rec(String(k), args); return undefined; };
    },
    has: () => true,
  });
}

function mapTag(tag) {
  switch (tag) {
    case "text": return "div";
    case "list": return "div";
    case "list-item": return "div";
    case "stack": return "div";
    case "input": return "input";
    case "image": case "img": return "img";
    case "progress": return "div";
    default: return tag;
  }
}
function strip(o, keys) { const r = Object.assign({}, o); for (const k of keys) delete r[k]; return r; }
function fmt(v) { return v === undefined || v === null ? "" : String(v); }

// Lite CSS 规则 → inline style（Lite 单类选择器，可直接降维）
export // hml 常写成 `width : {{ chipW }} px`，求值后是 "74 px"（数字与单位间有空格）。
// 浏览器 CSS 视其为无效声明 → 整条丢弃 → 回退到类里的硬编码值（54px/38px），
// 于是 EN 模式的 74 宽、24 字号全失效，候选词文字撑破 54 宽的框（实测 might 溢出）。
function fixCssUnits(s) {
  return String(s).replace(/(\d)\s+(px|pt|rpx|%|em|rem|vw|vh|deg|s|ms)\b/g, "$1$2");
}

function cssTextToInline(cssText) {
  const out = [];
  const re = /(^|\n)\s*[^{]+\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(cssText)) !== null) {
    const body = m[2];
    for (const decl of body.split(";")) {
      const d = decl.trim();
      if (d) out.push(d);
    }
  }
  return fixCssUnits(out.join(";"));
}
