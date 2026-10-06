// lite-sim 规则体检 —— 把 Lite Wearable 真机踩过的坑变成可执行规则
// 全部规则均有实测依据（litewearable-api10-dev / huawei-lite-watch-development skill + FIT3 真机）。
// 纯浏览器可跑，零依赖。checkAll(files) -> Issue[]

// ---------------------------------------------------------------- Lite 白名单
const LITE_TAGS = new Set(("div canvas stack qrcode list list-item swiper tabs tab-bar tab-content " +
  "image-animator image img progress text marquee analog-clock clock-hand chart input slider switch picker-view").split(" "));

const LITE_EVENTS = new Set(("click longpress touchstart touchmove touchcancel touchend key swipe change scrollend".split(" ")));

const DATA_RESERVED = new Set(["for", "if", "show", "tid"]);

// JerryScript / Lite JS 子集不允许的语法（构建链会拦，但现场编译路径会撞错误码34）
const ES6_FORBIDDEN = [
  { re: /\?\./g, code: "JS_OPTIONAL_CHAIN", title: "可选链 ?. 不受支持", hint: "改写成 if 判空或 && 短路" },
  { re: /\?\?/g, code: "JS_NULLISH", title: "空值合并 ?? 不受支持", hint: "改用 || 或显式判空" },
  { re: /\basync\s+function|\bawait\s+/g, code: "JS_ASYNC", title: "async/await 不在 Lite JS 子集内", hint: "改用回调（@system.* 全是回调式）" },
  { re: /\.\.\.(?=[A-Za-z_$\[\(])/g, code: "JS_SPREAD", title: "展开语法 ... 不支持", hint: "用 concat / 循环展开" },
];

// ---------------------------------------------------------------- 工具
function lineOf(src, idx) { return src.slice(0, idx).split("\n").length; }
function colOf(src, idx) { const s = src.slice(0, idx); return idx - s.lastIndexOf("\n"); }
function lineText(src, line) { return (src.split("\n")[line - 1] || ""); }
function issue(o) {
  return Object.assign({ id: "", ts: Date.now(), kind: "rule", level: "error" }, o);
}

// 把 hml 内的注释去掉（保留长度，保证行号不变），返回可扫描文本
function stripComments(src) {
  return src.replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, " "));
}

// 遍历 hml 开标签（跳过注释/文本）
function eachOpenTag(hml, cb) {
  const s = stripComments(hml);
  const re = /<([\w-]+)((?:[^>"]|"[^"]*")*)>/g;   // 必须含 -：picker-view/list-item/tab-bar
  let m;
  while ((m = re.exec(s)) !== null) {
    const tag = m[1], attrs = m[2];
    if (attrs.trim().endsWith("/")) continue; // 自闭合
    cb({ tag, attrs, index: m.index, raw: m[0] });
  }
}

function attr(attrs, name) {
  const m = new RegExp("\\s" + name + '="((?:[^"]|\\\\")*)"').exec(attrs);
  return m ? m[1] : null;
}
function hasAttr(attrs, name) { return new RegExp("\\s" + name + "=").test(attrs); }

// ---------------------------------------------------------------- 1. HML 规则
function checkHml(rel, hml, out) {
  const s = stripComments(hml);

  // A1 事件前缀 grab: / on: → 真机静默不注册（实测 clickable=false）
  const prefixRe = /\s(grab|on):(click|longpress|touchstart|touchmove|touchend|swipe|key)\s*=/g;
  let pm;
  while ((pm = prefixRe.exec(s)) !== null) {
    out.push(issue({
      code: "EVT_INERT_PREFIX", level: "error", file: rel, line: lineOf(s, pm.index), col: colOf(s, pm.index),
      title: `${pm[1]}:${pm[2]} 前缀在真机上完全不注册`,
      message: "语法合法但运行时布局树 clickable=false，事件永远不会触发（uitest 实测）。这类写法最危险——编译通过、装表成功，但点了没反应。",
      hint: `改用 @${pm[2]} 或裸名 on${pm[2] === "click" ? "click" : pm[2] === "longpress" ? "longpress" : pm[2]}（例：@${pm[2]}="${pm[2] === "click" ? "handler" : "onLong"}(...)")`,
      source: lineText(s, lineOf(s, pm.index)),
    }));
  }

  // A2 class 动态绑定
  let cm = /\sclass="\{\{/.exec(s);
  if (cm) out.push(issue({
    code: "HML_CLASS_BINDING", level: "error", file: rel, line: lineOf(s, cm.index), col: colOf(s, cm.index),
    title: "Lite 不支持 class=\"{{...}}\" 动态绑定",
    message: "动态 class 会被静默忽略，样式不生效。",
    hint: "改用固定 class + if/show 切换多个节点，或绑定具体 style 属性",
    source: lineText(s, lineOf(s, cm.index)),
  }));

  // A3 同元素 if + for
  eachOpenTag(hml, ({ tag, attrs, index }) => {
    if (hasAttr(attrs, "if") && hasAttr(attrs, "for")) {
      out.push(issue({
        code: "HML_IF_FOR", level: "error", file: rel, line: lineOf(s, index), col: colOf(s, index),
        title: `<${tag}> 同时设置 if 和 for`,
        message: "Lite 明确禁止同一元素同时使用 if 与 for，构建会失败。",
        hint: "拆成两层：外层 div 用 if，内层元素用 for",
        source: `<${tag} ... if=... for=...>`,
      }));
    }
  });

  // A4 非白名单标签
  eachOpenTag(hml, ({ tag, index }) => {
    if (!LITE_TAGS.has(tag)) {
      out.push(issue({
        code: "HML_UNKNOWN_TAG", level: "error", file: rel, line: lineOf(s, index), col: colOf(s, index),
        title: `<${tag}> 不在 Lite 组件白名单`,
        message: "HML 不是 HTML：button/span/p/section 等 Web 标签一律不可用。",
        hint: tag === "button" ? "Lite 按钮用 <input type=\"button\">" : "白名单：" + Array.from(LITE_TAGS).join(" "),
        source: lineText(s, lineOf(s, index)),
      }));
    }
  });

  // A5 list 直接子节点必须是 list-item
  const listRe = /<list(?![\w-])((?:[^>"]|"[^"]*")*)>([\s\S]*?)<\/list>/g;
  let lm;
  while ((lm = listRe.exec(s)) !== null) {
    const inner = lm[2];
    // 顶层（深度0）元素
    let depth = 0, i = 0;
    while (i < inner.length) {
      const lt = inner.indexOf("<", i);
      if (lt < 0) break;
      if (inner.startsWith("</", lt)) { depth--; i = lt + 1; if (depth < 0) break; continue; }
      if (inner.startsWith("<!--", lt)) { i = inner.indexOf("-->", lt) + 3; continue; }
      const gt = inner.indexOf(">", lt);
      const tm = /^<([\w-]+)/.exec(inner.slice(lt));
      if (depth === 0 && tm) {
        if (tm[1] !== "list-item") {
          out.push(issue({
            code: "HML_LIST_CHILD", level: "error", file: rel, line: lineOf(s, lm.index + lt), col: 1,
            title: "<list> 的直接子节点不是 <list-item>",
            message: "Lite 的 list 只接受 list-item 作为直接子节点，其余标签会被丢弃或构建失败。",
            hint: "把内容包进 <list-item>",
            source: (inner.slice(lt, Math.min(gt + 1, lt + 70))),
          }));
        }
      }
      if (!inner.slice(lt, gt + 1).endsWith("/>")) depth++;
      i = gt + 1;
    }
  }

  // A6 list-item 顶层子节点数必须为 1，事件应绑在该 div 上
  const liRe = /<list-item\b((?:[^>"]|"[^"]*")*)>([\s\S]*?)<\/list-item>/g;
  let im;
  while ((im = liRe.exec(s)) !== null) {
    const inner = im[2];
    let depth = 0, kids = 0, i = 0;
    while (i < inner.length) {
      const lt = inner.indexOf("<", i);
      if (lt < 0) break;
      if (inner.startsWith("</", lt)) { depth--; i = lt + 1; if (depth < 0) break; continue; }
      if (inner.startsWith("<!--", lt)) { i = inner.indexOf("-->", lt) + 3; continue; }
      const gt = inner.indexOf(">", lt);
      const tm = /^<([\w-]+)/.exec(inner.slice(lt));
      if (depth === 0 && tm) kids++;
      if (!inner.slice(lt, gt + 1).endsWith("/>")) depth++;
      i = gt + 1;
    }
    if (kids > 1) {
      out.push(issue({
        code: "HML_LIST_ITEM_MULTI_CHILD", level: "error", file: rel, line: lineOf(s, im.index), col: colOf(s, im.index),
        title: `<list-item> 顶层有 ${kids} 个子节点（必须 1 个）`,
        message: "Lite 的 list-item 顶层只允许一个子节点，多出的会被丢弃（表现：内容缺失）。",
        hint: "用一个 <div class=\"item-bg\"> 包住全部内容，事件也绑在这个 div 上",
        source: lineText(s, lineOf(s, im.index)),
      }));
    }
    // 事件应绑在子 div 上（skill 实测先例）
    const openAttrs = im[1] || "";
    if (/@longpress|onlongpress/.test(openAttrs) && kids === 1) {
      out.push(issue({
        code: "EVT_ON_ITEM_NOT_CHILD", level: "warn", file: rel, line: lineOf(s, im.index), col: colOf(s, im.index),
        title: "长按绑在 <list-item> 上",
        message: "实测先例是绑在 list-item 的唯一子 div 上（item-bg）。绑在 list-item 上部分固件不触发。",
        hint: "把 @longpress/onlongpress 移到子 <div> 上；若两处都绑会重复触发，需配防重入",
        source: lineText(s, lineOf(s, im.index)),
      }));
    }
  }

  // A9 裸中文（注释已剥离）
  const cnRe = /(?<!&#x)[\u4e00-\u9fa5]+/g;
  let xn;
  while ((xn = cnRe.exec(s)) !== null) {
    // i18n / string.json 路径允许
    if (rel.includes("i18n/") || rel.endsWith("string.json")) continue;
    out.push(issue({
      code: "HML_BARE_CN", level: "warn", file: rel, line: lineOf(s, xn.index), col: colOf(s, xn.index),
      title: "hml 中出现裸中文",
      message: "构建链要求 .hml 静态文案用 HTML 实体（&#xXXXX;）或 $t()，裸中文可能被截断/编码异常。",
      hint: "把中文转成 &#x5F85;&#x529E; 这类实体，动态串放 .js 里用 \\uXXXX",
      source: lineText(s, lineOf(s, xn.index)),
    }));
  }

  // A9b hml 表达式里的 ES6（hml 的 {{}} 只支持 ES5）
  const exprRe = /\{\{([\s\S]*?)\}\}/g;
  let em;
  while ((em = exprRe.exec(s)) !== null) {
    const ex = em[1];
    if (/`/.test(ex)) out.push(issue({
      code: "HML_TEMPLATE_STR", level: "error", file: rel, line: lineOf(s, em.index), col: colOf(s, em.index),
      title: "hml 表达式里使用了模板字符串",
      message: "HML 的 {{}} 明确不支持 ES6（模板字符串/箭头函数/let 等），会编译失败或静默不生效。",
      hint: "复杂逻辑移入 .js 方法，表达式里只做属性读取和简单运算",
      source: "{{ " + ex.trim().slice(0, 70) + " }}",
    }));
    if (/=>/.test(ex)) out.push(issue({
      code: "HML_ARROW_FN", level: "error", file: rel, line: lineOf(s, em.index), col: colOf(s, em.index),
      title: "hml 表达式里使用了箭头函数",
      message: "HML 表达式只支持 ES5，箭头函数会编译失败。",
      hint: "把函数定义移到 .js，表达式里只调用",
      source: "{{ " + ex.trim().slice(0, 70) + " }}",
    }));
  }

  // A10 事件绑定 handler 是否存在（配合 js）
  const bindRe = /(?:@(?:click|longpress|swipe|touchstart|touchend|change)|\son(?:click|longpress|swipe))\s*=\s*"([A-Za-z_$][\w$]*)\s*\(/g;
  const handlers = new Set();
  let bm;
  while ((bm = bindRe.exec(s)) !== null) handlers.add(bm[1]);
  return handlers;
}

// ---------------------------------------------------------------- 2. CSS 规则
function checkCss(rel, css, out) {
  // flex:1 → Lite 支持不稳定，写死像素
  let m = /flex\s*:\s*1\b/.exec(css);
  if (m) out.push(issue({
    code: "CSS_FLEX1", level: "warn", file: rel, line: lineOf(css, m.index), col: colOf(css, m.index),
    title: "使用了 flex:1",
    message: "Lite 对 flex-grow/flex:1 支持不稳定（多为 WARNING，部分固件不生效导致高度塌陷）。",
    hint: "写死像素高度（按 412x484 实测预算）",
    source: lineText(css, lineOf(css, m.index)),
  }));

  // 复合类选择器 .a .b
  const compRe = /^\s*\.([\w-]+)\s+\.([\w-]+)\s*\{/gm;
  let cm;
  while ((cm = compRe.exec(css)) !== null) out.push(issue({
    code: "CSS_DESCENDANT", level: "error", file: rel, line: lineOf(css, cm.index), col: colOf(css, cm.index),
    title: `复合类选择器 .${cm[1]} .${cm[2]}`,
    message: "Lite CSS 只支持单类选择器，后代选择器不生效（样式静默丢失）。",
    hint: `改成一个类名，或给子元素单独加 class`,
    source: lineText(css, lineOf(css, cm.index)),
  }));

  // font-family 非 HYQiHei-65S
  const ffRe = /font-family\s*:\s*([^;}\n]+)/g;
  let fm;
  while ((fm = ffRe.exec(css)) !== null) {
    const v = fm[1].trim();
    if (!/HYQiHei-65S/i.test(v)) out.push(issue({
      code: "CSS_FONT", level: "warn", file: rel, line: lineOf(css, fm.index), col: colOf(css, fm.index),
      title: `font-family: ${v} 可能不被 Lite 识别`,
      message: "Lite 只认 HYQiHei-65S；其他字体名（含 HarmonyOSCondensed-Regular）会触发构建告警或回退。",
      hint: "删掉 font-family 用默认字体，或写 HYQiHei-65S",
      source: lineText(css, lineOf(css, fm.index)),
    }));
  }

  // 宽高越界
  const dimRe = /(width|height)\s*:\s*(\d+)px/g;
  let dm;
  while ((dm = dimRe.exec(css)) !== null) {
    const n = parseInt(dm[2], 10);
    const limit = dm[1] === "width" ? 412 : 484;
    if (n > limit) out.push(issue({
      code: "CSS_OVERFLOW_DIM", level: "warn", file: rel, line: lineOf(css, dm.index), col: colOf(css, dm.index),
      title: `${dm[1]}: ${n}px 超出屏幕 ${limit}px`,
      message: "FIT3 屏 412x484（border-box，实测）。超出部分被裁。",
      hint: `改成 <= ${limit}px`,
      source: lineText(css, lineOf(css, dm.index)),
    }));
  }

  // 底部操作栏：容器需有 padding-bottom 把按钮推出圆角危险区（y>=420）
  const barRe = /\.(bottom-bar|nav-bar)\s*\{([^}]*)\}/g;
  let bm2;
  while ((bm2 = barRe.exec(css)) !== null) {
    const body = bm2[2];
    const pb = /padding-bottom\s*:\s*(\d+)px/.exec(body);
    if (!pb || parseInt(pb[1], 10) < 8) {
      out.push(issue({
        code: "CSS_BTN_IN_CORNER", level: "warn", file: rel, line: lineOf(css, bm2.index), col: colOf(css, bm2.index),
        title: `.${bm2[1]} 缺少 padding-bottom`,
        message: "FIT3 屏 y>=420 是圆角危险区（R≈105 实测），底部按钮不加 padding-bottom 会被圆角裁切。",
        hint: "给该容器加 padding-bottom: 12px，按钮底控制在 y<=410",
        source: "." + bm2[1] + " { ... }",
      }));
    }
  }
}

// ---------------------------------------------------------------- 3. JS 规则
function checkJs(rel, js, out, handlers) {
  // 单页体积（错误码34）
  const bytes = new TextEncoder().encode(js).length;
  if (bytes > 48 * 1024) out.push(issue({
    code: "JS_TOO_LARGE", level: "error", file: rel, line: 1, col: 1,
    title: `页面 JS ${Math.round(bytes / 1024)}KB 超过 48KB 上限`,
    message: "超限会导致装表时现场编译 → 撞错误码 34（分页加载失败）。",
    hint: "拆分模块到 common/，或精简数据表（大 JSON 放 rawfile 分块读）",
    source: `new TextEncoder().encode(js).length = ${bytes}`,
  }));

  // 正则字面量（JerryScript 构建 profile 关闭正则字面量支持）
  // 注意：必须先把字符串字面量挖成空串 —— 否则 `= 'a|/xxx/|b'` 这类
  // 字符串里的竖线+斜杠组合会被当成正则（nexuscheckin 的词典串实测误报）
  const jsNoStr = js.replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
                     .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
                     .replace(/`(?:[^`\\]|\\.)*`/g, "``");
  const regRe = /(^|[=(:,!&|?{}\[])\s*\/(?![/*])(?:[^/\\\n\[]|\\.|\[(?:[^\]\\]|\\.)*\])+\/[gimsuy]*/gm;
  let rm;
  while ((rm = regRe.exec(jsNoStr)) !== null) {
    const line = lineOf(js, rm.index);
    const text = lineText(js, line);
    if (/^\s*(\/\/|\*)/.test(text)) continue; // 注释里的
    out.push(issue({
      code: "JS_REGEX_LITERAL", level: "error", file: rel, line, col: colOf(js, rm.index),
      title: "正则字面量 /.../ 不受支持",
      message: "构建 profile 关闭了正则字面量支持，会阻断快照转换 → 缺 .bc → 错误码 34。",
      hint: "改用 new RegExp('...') 字符串构造，或用 indexOf/slice/manual 遍历替代",
      source: text.trim().slice(0, 110),
    }));
  }

  // ES6+ 禁用语法
  for (const f of ES6_FORBIDDEN) {
    f.re.lastIndex = 0;
    let m;
    while ((m = f.re.exec(js)) !== null) {
      const line = lineOf(js, m.index);
      const text = lineText(js, line);
      if (/^\s*(\/\/|\*|")/.test(text)) continue;
      out.push(issue({
        code: f.code, level: "error", file: rel, line, col: colOf(js, m.index),
        title: f.title, message: "Lite 的 JS 子集（JerryScript + 构建转译）不接受该语法，会在编译或运行时中断。",
        hint: f.hint, source: text.trim().slice(0, 110),
      }));
    }
  }

  // data 下划线名 / 保留名
  const dataM = /\bdata\s*:\s*\{/.exec(js);
  if (dataM) {
    let i = dataM.index + dataM[0].length, depth = 1, buf = "";
    while (i < js.length && depth > 0) {
      const c = js[i];
      if (c === "{") depth++; else if (c === "}") depth--;
      else if (depth === 1) buf += c;
      i++;
    }
    const keyRe = /(?:^|[\s,{])([A-Za-z_$][\w$]*)\s*:/g;
    let km;
    while ((km = keyRe.exec(buf)) !== null) {
      const name = km[1];
      const off = dataM.index + dataM[0].length + km.index;
      if (name.startsWith("_") || name.startsWith("$")) out.push(issue({
        code: "DATA_BAD_NAME", level: "error", file: rel, line: lineOf(js, off), col: colOf(js, off),
        title: `data 字段 "${name}" 以 _/$ 开头`,
        message: "Lite 禁止 data 属性名以 $ 或 _ 开头（框架内部保留），绑定会失效。",
        hint: "重命名（例：_k → fixKind），hml 同步改",
        source: name + ": ...",
      }));
      if (DATA_RESERVED.has(name)) out.push(issue({
        code: "DATA_RESERVED_NAME", level: "error", file: rel, line: lineOf(js, off), col: colOf(js, off),
        title: `data 字段 "${name}" 是保留名`,
        message: "for/if/show/tid 是 HML 指令保留字，不能用作 data 名。",
        hint: "重命名（例：for → listFor）",
        source: name + ": ...",
      }));
    }
  }

  // 大 JSON 常驻模块顶层（heap 风险）
  const bigJson = /(?:const|let|var)\s+\w+\s*=\s*[^;\n]*JSON\.parse\s*\(|(?:const|let|var)\s+\w+\s*=\s*[`'"]\{/g;
  let bj;
  while ((bj = bigJson.exec(js)) !== null) {
    const line = lineOf(js, bj.index);
    out.push(issue({
      code: "JS_BIG_LITERAL", level: "warn", file: rel, line, col: colOf(js, bj.index),
      title: "模块顶层出现大字面量/JSON.parse",
      message: "Lite JS 堆仅 64/256KB，JSON.parse 会同时占源串+对象树两份内存。",
      hint: "大字典放 rawfile，用 fs 分块读 + 按需解析（参照 inputMethod.ensureDict）",
      source: lineText(js, line).trim().slice(0, 110),
    }));
  }

  // 订阅类 API 无 onDestroy 清理
  const subRe = /\b(setInterval|setTimeout)\s*\(/g;
  const subs = [];
  let sm;
  while ((sm = subRe.exec(js)) !== null) subs.push(sm[1]);
  if (subs.length > 0 && rel.startsWith("pages/") && !/onDestroy\s*[:(]/.test(js)) out.push(issue({
    code: "LIFE_NO_CLEANUP", level: "error", file: rel, line: 1, col: 1,
    title: "使用了定时器但没有 onDestroy",
    message: "页面销毁不清定时器会持续泄漏，Lite 上几次进退页面就卡死。",
    hint: "onDestroy 里 clearInterval/clearTimeout（把 id 存到模块级变量）",
    source: subs.join(", "),
  }));

  // 事件 handler 是否在 js 中实现（用 checker 收集的绑定名）
  if (handlers && handlers.size) {
    for (const hn of handlers) {
      const re = new RegExp("(^|[\\s,{])" + hn.replace(/\$/g, "\\$") + "\\s*[:(]", "m");
      if (!re.test(js)) out.push(issue({
        code: "EVT_MISSING_HANDLER", level: "error", file: rel, line: 1, col: 1,
        title: `hml 绑定了 ${hn}() 但 js 里没有实现`,
        message: "运行时点击会抛 ReferenceError（真机上表现为无反应，模拟器会直接报错）。",
        hint: `在 export default 里补 ${hn}(arg) { ... }`,
        source: hn + " 未定义",
      }));
    }
  }
}

// ---------------------------------------------------------------- 4. 跨文件 / 生命周期
function checkProject(files, out) {
  const hmls = Object.keys(files).filter(f => f.endsWith(".hml"));
  if (!hmls.length) return;
  const jsCombined = Object.entries(files).filter(([f]) => f.endsWith(".js"))
    .map(([f, c]) => `// ${f}\n${c}`).join("\n");

  // 带 if 的容器必须有固定高度（否则整区不渲染）—— 需要 hml + css 配对
  const cssByPage = {};
  for (const [rel, src] of Object.entries(files)) {
    if (!rel.endsWith(".css")) continue;
    const page = rel.replace(/[^/]+$/, "");
    cssByPage[page] = (cssByPage[page] || "") + "\n" + src;
  }
  for (const rel of hmls) {
    const hml = files[rel];
    const css = cssByPage[rel.replace(/[^/]+$/, "")] || "";
    if (!css) continue;
    const s = stripComments(hml);
    eachOpenTag(hml, ({ tag, attrs, index }) => {
      if (!hasAttr(attrs, "if")) return;
      if (tag !== "div" && tag !== "stack" && tag !== "list-item") return;
      const cls = attr(attrs, "class");
      if (!cls) return;
      // 组合类（如 "box box-on"）：任一带 height 即可（基础类给尺寸）
      let hasH = false;
      for (const c of cls.split(/\s+/)) {
        const m = new RegExp("\\." + c + "\\s*\\{([^}]*)\\}").exec(css);
        if (m && /height\s*:/.test(m[1])) { hasH = true; break; }
      }
      if (!hasH) {
        out.push(issue({
          code: "CSS_IF_NO_HEIGHT", level: "error", file: rel, line: lineOf(s, index), col: colOf(s, index),
          title: `带 if 的 <${tag} class="${cls}"> 没有固定 height`,
          message: "Lite 中带 if 的容器若高度不定，整块区域不会渲染（真机表现为内容整段缺失）。",
          hint: `在 css 里给 .${cls} 写死 height`,
          source: lineText(s, lineOf(s, index)).trim().slice(0, 110),
        }));
      }
    });
  }

  // config.json 页面注册（若有）
  // 生命周期：订阅与取消配对
  if (/\bsetInterval\s*\(/.test(jsCombined) && !/clearInterval\s*\(/.test(jsCombined)) {
    out.push(issue({
      code: "LIFE_UNBALANCED_TIMER", level: "error", file: "—", line: 1, col: 1,
      title: "setInterval 没有对应的 clearInterval",
      message: "Lite 要求订阅类接口有一一对应的取消路径，否则内存持续增长。",
      hint: "onDestroy 中 clearInterval",
      source: "setInterval 无 clearInterval",
    }));
  }
}

// ---------------------------------------------------------------- 主入口
export function checkAll(files) {
  const out = [];
  let handlerUnion = new Set();
  for (const [rel, src] of Object.entries(files || {})) {
    try {
      if (rel.endsWith(".hml")) {
        const hs = checkHml(rel, src, out);
        if (hs) for (const h of hs) handlerUnion.add(h);
      } else if (rel.endsWith(".css")) {
        checkCss(rel, src, out);
      } else if (rel.endsWith(".js")) {
        checkJs(rel, src, out, null);
      }
    } catch (e) {
      out.push(issue({
        code: "CHECKER_CRASH", level: "warn", file: rel, line: 1, col: 1,
        title: "检查器在该文件上异常", message: String(e && e.message || e), hint: "该文件跳过检查", source: "",
      }));
    }
  }
  // 跨文件：事件绑定 vs 实现（每个 hml 与同名 js 配对）
  for (const [rel, src] of Object.entries(files)) {
    if (!rel.endsWith(".hml")) continue;
    const jsRel = rel.replace(/\.hml$/, ".js");
    if (!files[jsRel]) continue;
    const bound = checkHml(rel + "（复检事件）", src, []);
    if (bound && bound.size) checkJs(jsRel, files[jsRel], out, bound);
  }
  checkProject(files, out);

  // 去重（同一文件同一行同一码只留一条）
  const seen = new Set();
  return out.filter(it => {
    const k = [it.code, it.file, it.line].join("|");
    if (seen.has(k)) return false;
    seen.add(k);
    it.id = k;
    return true;
  }).sort((a, b) => (a.level === b.level ? 0 : a.level === "error" ? -1 : 1));
}

export const RULES = { LITE_TAGS, LITE_EVENTS, DATA_RESERVED, ES6_FORBIDDEN };
