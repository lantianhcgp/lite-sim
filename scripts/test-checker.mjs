// lite-sim checker 自测
// 1) 坏样本：每条规则必须命中（防漏报）
// 2) 真实项目 memo-todo：假阳性要少（防误报）
import { checkAll } from "../web/checker.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = (c, msg) => { c ? pass++ : fail++; console.log((c ? "  OK   " : "  FAIL ") + msg); };

// ---------------- 1) 坏样本 ----------------
console.log("=== 1) 规则命中测试 ===");
const bad = {
  "pages/bad/bad.hml": `
<div class="a">
  <div grab:click="foo()"></div>
  <div on:longpress="bar()"></div>
  <button @click="ok1()">x</button>
  <text class="{{ dynamic }}">y</text>
  <list class="l">
    <div>不是 list-item</div>
    <list-item class="i" for="{{ a }}" if="{{ b }}"></list-item>
    <list-item class="j"><div>1</div><div>2</div></list-item>
  </list>
  <list-item class="k" @click="missingFn()"></list-item>
  <div if="{{ x }}" class="noheight"></div>
  <text>{{ \`tpl\` }}</text>
  <text>{{ a => b }}</text>
  裸中文文案
</div>`,
  "pages/bad/bad.css": `
.a { flex: 1; }
.parent .child { color: red; }
.f { font-family: HarmonyOSCondensed-Regular; }
.wide { width: 500px; }
.tall { height: 600px; }
.noh { }
`,
  "pages/bad/bad.js": `
export default {
  data: { _hidden: 1, for: [], ok: 2 },
  go() {
    const re = /abc/g;
    const q = a?.b;
    const z = a ?? b;
    const s = \`tpl\`;
    const arr = [...x];
    setInterval(() => {}, 1000);
    const raw = JSON.parse("{...huge...}");
  }
}
`,
};

let issues;
try {
  issues = checkAll(bad);
  ok(true, "坏样本未崩溃，产出 " + issues.length + " 条");
} catch (e) {
  ok(false, "坏样本崩溃: " + e.message);
  issues = [];
}
const codes = new Set(issues.map(i => i.code));
const expect = [
  ["EVT_INERT_PREFIX", "grab: 前缀"],
  ["HML_UNKNOWN_TAG", "button 白名单"],
  ["HML_CLASS_BINDING", "class 动态绑定"],
  ["HML_IF_FOR", "if+for 同元素"],
  ["HML_LIST_CHILD", "list 子节点"],
  ["HML_LIST_ITEM_MULTI_CHILD", "list-item 多子节点"],
  ["HML_BARE_CN", "裸中文"],
  ["CSS_FLEX1", "flex:1"],
  ["CSS_DESCENDANT", "复合选择器"],
  ["CSS_FONT", "font-family"],
  ["CSS_OVERFLOW_DIM", "宽高越界"],
  ["CSS_IF_NO_HEIGHT", "if 容器无高度"],
  ["JS_REGEX_LITERAL", "正则字面量"],
  ["JS_OPTIONAL_CHAIN", "可选链"],
  ["JS_NULLISH", "空值合并"],
  ["HML_TEMPLATE_STR", "hml 模板字符串"],
  ["HML_ARROW_FN", "hml 箭头函数"],
  ["JS_SPREAD", "展开语法"],
  ["JS_BIG_LITERAL", "大字面量"],
  ["LIFE_NO_CLEANUP", "定时器无 onDestroy"],
  ["DATA_BAD_NAME", "data 下划线名"],
  ["DATA_RESERVED_NAME", "data 保留名"],
  ["EVT_MISSING_HANDLER", "handler 未实现"],
];
for (const [code, name] of expect) ok(codes.has(code), `命中 ${code} (${name})`);

// 反向断言：.js 里合法的语法不得误报
const forbidden = new Set(["JS_CLASS", "JS_TEMPLATE_STR"]);
const falsePos = issues.filter(i => forbidden.has(i.code));
ok(falsePos.length === 0, ".js 的 class/模板字符串未误报（实际 " + falsePos.length + " 条）");

// 每条必须带修复建议 + 定位
const noHint = issues.filter(i => !i.hint || !i.title);
ok(noHint.length === 0, "每条问题都有 title+hint（缺 " + noHint.length + " 条）");
const noLoc = issues.filter(i => !i.file || !i.line);
ok(noLoc.length === 0, "每条问题都有 file+line（缺 " + noLoc.length + " 条）");

// ---------------- 2) 真实项目 ----------------
console.log("\n=== 2) memo-todo 假阳性测试 ===");
const BASE = path.join(process.env.HOME, "hw_watch/memo-todo/entry/src/main/js/MainAbility");
if (fs.existsSync(BASE)) {
  const files = {};
  const walk = (d) => {
    for (const fn of fs.readdirSync(d)) {
      const fp = path.join(d, fn);
      if (fs.statSync(fp).isDirectory()) walk(fp);
      else if (/\.(hml|css|js)$/.test(fn)) files[path.relative(BASE, fp)] = fs.readFileSync(fp, "utf8");
    }
  };
  walk(BASE);
  const real = checkAll(files);
  console.log("  文件数 " + Object.keys(files).length + "，问题 " + real.length + " 条");
  const byLevel = {};
  for (const i of real) byLevel[i.level] = (byLevel[i.level] || 0) + 1;
  console.log("  按级别: " + JSON.stringify(byLevel));
  for (const i of real) console.log(`   [${i.level}] ${i.code} ${i.file}:${i.line} — ${i.title}`);
  // 已修复的回归项不得再出现
  const regress = real.filter(i =>
    ["EVT_INERT_PREFIX", "JS_REGEX_LITERAL", "CSS_FLEX1", "HML_CLASS_BINDING", "DATA_BAD_NAME"].includes(i.code));
  ok(regress.length === 0, "已修复的历史问题未复现（" + regress.length + " 条）");
  // error 级别应为 0（我们修了 7 轮）
  const errs = real.filter(i => i.level === "error");
  if (errs.length) {
    console.log("  -- error 级问题明细 --");
    for (const i of errs) console.log(`   ${i.code} ${i.file}:${i.line} ${i.title}`);
  }
  // 已知误报码必须为 0（class/模板字符串/公共模块生命周期/list 误判）
  const knownFalse = errs.filter(i => ["JS_CLASS", "JS_TEMPLATE_STR", "HML_LIST_CHILD", "CSS_IF_NO_HEIGHT", "LIFE_NO_CLEANUP"].includes(i.code));
  ok(knownFalse.length === 0, "已知误报码为 0（实际 " + knownFalse.length + "）");
  ok(errs.length === 0, "error 级问题 0 条（实际 " + errs.length + "）");
} else {
  console.log("  (跳过：memo-todo 不在 " + BASE + ")");
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
