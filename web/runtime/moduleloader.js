// lite-sim 模块加载器 —— 把真实的 Lite 工程源码跑进浏览器
// 处理两件事：
//   1) 相对 import（common/utils 等）→ 递归求值，构造模块图
//   2) import x from '@system.storage' → 注入 mock
// 用 new Function 执行转换后的源码（本地调试工具，非不可信输入）。

const SYSTEM_APIS = new Set(["router", "storage", "file", "vibrator", "brightness", "app", "sensor", "prompt", "routerReplace"]);

export class ModuleLoader {
  /** @param files  { "pages/index/index.js": "...", "common/data.js": "..." } */
  constructor(files, opts = {}) {
    this.files = {};
    for (const k of Object.keys(files)) this.files[norm(k)] = files[k];
    this.cache = new Map();
    this.reporter = opts.reporter || null;
    this.mocks = opts.mocks || null;      // { router, storage, file, ... }
    this.project = opts.project || "";
    this.log = [];                        // 加载过程日志
  }

  _note(msg) { this.log.push(msg); }

  _resolve(fromRel, spec) {
    if (spec.startsWith("@system.")) return spec;
    const base = fromRel.includes("/") ? fromRel.replace(/[^/]+$/, "") : "";
    const parts = (base + spec).split("/");
    const out = [];
    for (const p of parts) {
      if (p === "" || p === ".") continue;
      if (p === "..") out.pop();
      else out.push(p);
    }
    return out.join("/");
  }

  _find(rel) {
    if (this.files[rel] !== undefined) return rel;
    // 可能省略 .js
    if (this.files[rel + ".js"] !== undefined) return rel + ".js";
    // index.js 目录形式
    if (this.files[rel + "/index.js"] !== undefined) return rel + "/index.js";
    return null;
  }

  load(relIn) {
    const rel = this._find(this._resolve("", relIn)) || this._find(norm(relIn));
    if (!rel) throw new Error(`模块不存在: ${relIn}`);
    if (this.cache.has(rel)) return this.cache.get(rel).exports;

    const src = this.files[rel];
    const exportsObj = {};
    const mod = { exports: exportsObj, rel };
    this.cache.set(rel, mod);

    const { code, deps } = transform(src, rel, this);
    this._note(`${rel}: ${deps.length} 个依赖`);

    // 求值
    const factory = new Function(
      "__load", "__d", "__sys", "__exports", "__mod", "__report", "__filename",
      `"use strict";\n${code}\n//# sourceURL=litesim:///${rel}`
    );
    // 默认导出解包：{default: X} → X；@system.* mock 的 .default 指向自身，同样正确
    const unwrapDefault = (m) => (m && typeof m === "object" && m.default !== undefined && Object.keys(m).length <= 2) ? m.default : m;
    const loadFn = (spec) => {
      const target = this._resolve(rel, spec);
      // @ohos.* 是另一套系统导入写法（clan / elcton-repo / lite-watch-starter 在用），
      // 语义与 @system.* 相同：router → mock.router、file → mock.file …
      if (spec.startsWith("@ohos.")) {
        const name = spec.slice(6);
        if (name === "router") return this.mocks.router || { default: {} };
        if (this.mocks && this.mocks[name]) return this.mocks[name];
        throw new Error(`@ohos.${name} 未提供 mock（模拟器不支持该 API）`);
      }
      if (spec.startsWith("@system.")) {
        const name = spec.slice(8);
        if (!this.mocks || !this.mocks[name]) {
          throw new Error(`@system.${name} 未提供 mock（模拟器不支持该 API）`);
        }
        const api = this.mocks[name];
        // 兼容 import * as x ... x.default.y （真机模块是 {default: API}）
        if (api && typeof api === "object" && !("default" in api)) {
          try { api.default = api; } catch (e) { return Object.assign({}, api, { default: api }); }
        }
        return api;
      }
      return this.load(target);
    };
    try {
      factory(loadFn, unwrapDefault, this.mocks, exportsObj, mod, this.reporter, rel);
    } catch (e) {
      this.cache.delete(rel);   // 失败不污染缓存
      this.reporter && this.reporter.push({
        kind: "exception", level: "error", code: "MODULE_EVAL",
        title: `模块求值失败: ${rel}`,
        message: String(e && e.message || e),
        hint: "通常是 import 路径错误、顶层访问未定义变量，或用了 Lite 不支持的语法",
        file: rel, line: (e && e.stack ? (/\(.*?:(\d+):/.exec(e.stack) || [])[1] : 0) | 0,
        context: { stack: String(e && e.stack || "").slice(0, 600) },
      });
      throw e;
    }
    return mod.exports;
  }

  // 页面模块用 export default {...} —— 直接把默认导出交给调用方
  loadEntry(rel) {
    const ex = this.load(rel);
    if (ex && typeof ex === "object" && ex.default !== undefined) return ex.default;
    return ex;
  }
}

function norm(p) { return String(p).replace(/^\.\//, "").replace(/\\/g, "/").replace(/\.js$/, "") + (String(p).endsWith(".js") ? "" : ""); }

// 把 Lite 源码改写成可被 new Function 执行的形态
function transform(src, rel, loader) {
  const deps = [];
  let code = src;

  // 1) import 默认导入: import X from 'spec' → 取 .default（模块导出对象的默认项）
  code = code.replace(/^\s*import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"];?\s*$/gm, (m, name, spec) => {
    deps.push(spec);
    return `const ${name} = __d(__load(${JSON.stringify(spec)}));`;
  });

  // 2) import 命名导入: import { a, b as c } from 'spec'
  code = code.replace(/^\s*import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"];?\s*$/gm, (m, names, spec) => {
    deps.push(spec);
    return `const {${names}} = __load(${JSON.stringify(spec)});`;
  });

  // 3) 混合: import X, { y } from 'spec'
  code = code.replace(/^\s*import\s+([A-Za-z_$][\w$]*)\s*,\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"];?\s*$/gm, (m, name, names, spec) => {
    deps.push(spec);
    return `const ${name} = __d(__load(${JSON.stringify(spec)})); const {${names}} = __load(${JSON.stringify(spec)});`;
  });

  // 4) namespace: import * as X from 'spec'
  code = code.replace(/^\s*import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"];?\s*$/gm, (m, name, spec) => {
    deps.push(spec);
    return `const ${name} = __load(${JSON.stringify(spec)});`;
  });

  // 残留的 import 说明转换没覆盖（必须报出来，否则运行时才炸）
  const leftImport = /^\s*import\s.+$/m.exec(code);
  if (leftImport) {
    loader.reporter && loader.reporter.push({
      kind: "rule", level: "warn", code: "MODULE_IMPORT_UNSUPPORTED",
      title: "存在未被识别的 import 写法",
      message: leftImport[0].trim().slice(0, 120),
      hint: "模拟器支持: import x from '…' / import { a } from '…' / import * as x from '…'",
      file: rel, line: leftImport[0] ? src.slice(0, leftImport.index).split("\n").length : 0,
    });
  }

  // 5) export default → __exports.default
  code = code.replace(/(^|\n)(\s*)export\s+default\s+/g, "$1$2__exports.default = ");

  // 6) export const/let/var
  code = code.replace(/(^|\n)(\s*)export\s+(const|let|var)\s+/g, (m, nl, ind, kw) => {
    return `${nl}${ind}${kw} `;
  });
  // 为第 6 类把声明的名字挂到 exports（保守：处理 `export const a = 1, b = 2`）
  // 简化：在文件末尾追加导出扫描
  const exportNames = [];
  const reCN = /(?:^|\n)\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  let m; const src2 = src;
  while ((m = reCN.exec(src2)) !== null) exportNames.push(m[1]);
  const reFN = /(?:^|\n)\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g;
  while ((m = reFN.exec(src2)) !== null) exportNames.push(m[1]);
  const reCL = /(?:^|\n)\s*export\s+class\s+([A-Za-z_$][\w$]*)/g;
  while ((m = reCL.exec(src2)) !== null) exportNames.push(m[1]);

  // 7) export function / class → 普通声明
  code = code.replace(/(^|\n)(\s*)export\s+(async\s+function|function|class)\s+/g, "$1$2$3 ");

  // 8) 末尾把收集到的名字挂出去
  if (exportNames.length) {
    const tail = "\n;" + exportNames.map(n => `if (typeof ${n} !== "undefined") __exports.${n} = ${n};`).join("\n");
    code += tail;
  }

  // 9) 兜底：完全没有 export default → 供页面使用时报错
  if (!/__exports\.default\b/.test(code) && !exportNames.length) {
    loader.reporter && loader.reporter.push({
      kind: "rule", level: "warn", code: "MODULE_NO_EXPORT",
      title: `模块没有导出: ${rel}`,
      message: "页面模块需要 export default { data, ... }",
      hint: "补 export default", file: rel, line: 1,
    });
  }

  return { code, deps };
}

export { SYSTEM_APIS, transform };
