// 模块加载器测试：能否把真实 memo-todo 源码的 import 图跑起来
import { ModuleLoader } from "../web/runtime/moduleloader.js";
import { createSysMocks } from "../web/runtime/engine.js";
import fs from "fs";
import path from "path";
import os from "os";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "  OK   " : "  FAIL ") + m); };

const BASE = path.join(os.homedir(), "hw_watch/memo-todo/entry/src/main/js/MainAbility");
if (!fs.existsSync(BASE)) { console.log("跳过：memo-todo 不在"); process.exit(0); }

const files = {};
(function walk(d) {
  for (const fn of fs.readdirSync(d)) {
    const p = path.join(d, fn);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (/\.(hml|css|js)$/.test(fn)) files[path.relative(BASE, p)] = fs.readFileSync(p, "utf8");
  }
})(BASE);
console.log("载入文件:", Object.keys(files).length);

// 粗粒度 reporter（只收集）
const collected = [];
const reporter = {
  push: r => { collected.push(r); return r; },
  batch: a => { (a || []).forEach(x => collected.push(x)); },
  rule: a => { (a || []).forEach(x => collected.push(x)); },
  exception: (e, c) => collected.push({ code: "EXC", title: String(e && e.message), ctx: c }),
  event: () => {}, api: () => {}, dataChange: () => null, lifecycle: () => {},
  counts: { error: 0, warn: 0, info: 0 }, issues: [],
};

// 用真实的 createSysMocks（含 $app 全局、default 命名空间、路由/参数仓）
function makeMocks() {
  return createSysMocks(reporter);
}

// ---------------- 1) 页面模块能加载（默认导出是对象）
console.log("\n=== 1) 四个页面模块加载 ===");
const PAGES = ["pages/index/index", "pages/edit/edit", "pages/note/note", "pages/keyboard/keyboard"];
const defs = {};
for (const p of PAGES) {
  const loader = new ModuleLoader(files, { reporter, mocks: makeMocks(), project: "memo-todo" });
  try {
    const def = loader.loadEntry(p + ".js");
    const isObj = def && typeof def === "object";
    const hasData = isObj && def.data && typeof def.data === "object";
    const methods = isObj ? Object.keys(def).filter(k => typeof def[k] === "function") : [];
    ok(isObj && hasData, `${p}: export default 是对象且有 data（方法 ${methods.length} 个: ${methods.slice(0, 6).join(",")}${methods.length > 6 ? "…" : ""}）`);
    defs[p] = def;
  } catch (e) {
    ok(false, `${p}: 加载失败 → ${e.message}`);
  }
}

// ---------------- 2) 依赖是否被正确解析
console.log("\n=== 2) 依赖解析 ===");
{
  const loader = new ModuleLoader(files, { reporter, mocks: makeMocks() });
  const seen = new Set();
  const origLoad = loader.load.bind(loader);
  let cnt = 0;
  loader.load = (rel) => { cnt++; return origLoad(rel); };
  try { loader.loadEntry("pages/keyboard/keyboard.js"); } catch (e) { console.log("  err", e.message); }
  ok(cnt > 3, `keyboard.js 递归加载了 ${cnt} 个模块（含 common/* 与 @system.*）`);
}

// ---------------- 3) @system.* 注入生效
console.log("\n=== 3) @system mock 注入 ===");
{
  const mocks = makeMocks();
  let called = [];
  const rec = name => ({ router: { push: o => called.push("router.push"), back: () => called.push("router.back") },
    storage: {}, file: {}, vibrator: {}, brightness: {}, app: {}, sensor: {} });
  const loader = new ModuleLoader(files, { reporter, mocks: makeMocks() });
  try {
    const def = loader.loadEntry("pages/index/index.js");
    ok(typeof def.onAdd === "function", "index.js 的 onAdd 存在");
    // 直接调用 onAdd，应触发 router.push
    def.onAdd.call({ writeMultiParams: null });
    ok(true, "onAdd 可调用（不抛异常）");
  } catch (e) {
    ok(false, "注入失败: " + e.message);
  }
}

// ---------------- 4) 转换质量：不残留 import/export
console.log("\n=== 4) 源码转换残留检查 ===");
{
  const loader = new ModuleLoader(files, { reporter, mocks: makeMocks() });
  let allOk = true;
  for (const rel of Object.keys(files)) {
    if (!rel.endsWith(".js")) continue;
    let code;
    try {
      const { transform } = await import("../web/runtime/moduleloader.js");
      code = transform(files[rel], rel, loader).code;
    } catch (e) { ok(false, `${rel}: transform 抛错 ${e.message}`); allOk = false; continue; }
    const left = /^\s*(import|export)\s/m.test(code);
    if (left) { console.log(`   ✗ ${rel} 有残留 import/export`); allOk = false; }
  }
  ok(allOk, "所有 .js 转换后无 import/export 残留");
}

// ---------------- 5) 前面收集到的模块级报错
console.log("\n=== 5) 加载期报错 ===");
const errs = collected.filter(r => r.level === "error");
if (errs.length) for (const e of errs) console.log(`   [${e.code}] ${e.title} ${e.file || ""}`);
ok(errs.length === 0, `模块加载期无 error（实际 ${errs.length} 条）`);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
