// 对所有 Lite 项目跑：规则体检 + 模块加载 + 页面定义检查
import { checkAll } from "../web/checker.js";
import { ModuleLoader } from "../web/runtime/moduleloader.js";
import { createSysMocks } from "../web/runtime/engine.js";
import fs from "fs";
import path from "path";
import os from "os";

const ROOT = path.join(os.homedir(), "hw_watch");
const only = process.argv[2];   // 可选：只测某个项目

const projects = [];
for (const n of fs.readdirSync(ROOT).sort()) {
  const base = path.join(ROOT, n, "entry/src/main/js/MainAbility");
  if (fs.existsSync(base) && (!only || n === only)) projects.push({ name: n, base });
}

// 粗粒度 reporter（收集但不刷屏）
function makeRep() {
  const issues = [];
  const push = r => { issues.push(r); return r; };
  return {
    issues, push, batch: a => (a || []).forEach(push), rule: a => (a || []).forEach(push),
    exception: (e, c) => push({ level: "error", code: "JS_" + (e && e.name), title: String(e && e.message), kind: "exception", ctx: c }),
    event: () => {}, api: () => {}, dataChange: () => null, lifecycle: () => {},
    counts: { error: 0, warn: 0, info: 0 }, stats: () => ({ total: issues.length }),
  };
}
// 用真实 createSysMocks：它注入 $app 全局（common/router.js 顶层调 getCurrentUri）
// 与 6 个 @system.* mock，简陋 Proxy 会让 memo-todo 这类依赖 $app 的工程加载失败
function makeMocks() {
  return createSysMocks(makeRep());
}

function loadFiles(base) {
  const files = {};
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/\.(hml|css|js)$/.test(f)) files[path.relative(base, p)] = fs.readFileSync(p, "utf8");
    }
  })(base);
  return files;
}

const PAGES = [];
for (const p of projects) {
  const files = loadFiles(p.base);
  console.log("\n" + "=".repeat(64));
  console.log(`${p.name}  (${Object.keys(files).length} 文件)`);
  console.log("=".repeat(64));

  // ---------- 1) 规则体检 ----------
  const rep = makeRep();
  const issues = checkAll(files, rep);
  const errs = issues.filter(i => i.level === "error");
  const warns = issues.filter(i => i.level === "warn");
  console.log(`  规则体检: ${issues.length} 条 (error ${errs.length} / warn ${warns.length})`);
  const byKind = {};
  for (const i of issues) { byKind[i.code] = (byKind[i.code] || 0) + 1; }
  const top = Object.entries(byKind).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (top.length) console.log("    规则分布: " + top.map(([c, n]) => `${c}×${n}`).join(", "));
  for (const i of errs.slice(0, 5)) console.log(`    [E] ${i.code} ${i.file}:${i.line} ${(i.title || "").slice(0, 60)}`);

  // ---------- 2) 模块加载（每个页面）----------
  const hmls = Object.keys(files).filter(f => f.endsWith(".hml"));
  let okPages = 0, failPages = 0;
  const loadErrs = [];
  for (const h of hmls) {
    const js = h.replace(/\.hml$/, ".js");
    if (!files[js]) { console.log(`    ○ ${h} 无同名 js（跳过）`); continue; }
    try {
      const loader = new ModuleLoader(files, { reporter: makeRep(), mocks: makeMocks(), project: p.name });
      const def = loader.loadEntry(js);
      if (def && typeof def === "object" && def.data) {
        okPages++;
        const methods = Object.keys(def).filter(k => typeof def[k] === "function");
        console.log(`    ✓ ${h.replace(/\.hml$/, "")}  data字段 ${Object.keys(def.data).length} / 方法 ${methods.length}`);
      } else {
        failPages++;
        loadErrs.push(`${h}: export default 不是带 data 的对象`);
        console.log(`    ✗ ${h}  export default 结构异常`);
      }
    } catch (e) {
      failPages++;
      loadErrs.push(`${h}: ${e.message}`);
      console.log(`    ✗ ${h}  ${e.message.slice(0, 90)}`);
    }
  }
  console.log(`  模块加载: ${okPages} 页通过 / ${failPages} 页失败`);
  PAGES.push({ name: p.name, issues: issues.length, errs: errs.length, warns: warns.length, okPages, failPages, loadErrs, topRules: top });
}

// ---------- 汇总 ----------
console.log("\n" + "#".repeat(64));
console.log("汇总");
console.log("#".repeat(64));
console.log("项目                 体检  E  W   加载页");
for (const p of PAGES) {
  console.log(`${p.name.padEnd(20)} ${String(p.issues).padStart(4)} ${String(p.errs).padStart(2)} ${String(p.warns).padStart(3)}   ${p.okPages}✓/${p.failPages}✗`);
}
const totalLoadFail = PAGES.reduce((s, p) => s + p.failPages, 0);
console.log(`\n加载失败总数: ${totalLoadFail}`);
if (totalLoadFail) {
  console.log("\n=== 加载失败明细 ===");
  for (const p of PAGES) for (const e of p.loadErrs) console.log(`  [${p.name}] ${e}`);
}
