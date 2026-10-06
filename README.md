# lite-sim

Lite Wearable（华为 WATCH FIT3 等）**模拟器 + 规则体检 + 报错反馈 + MCP 服务**。

在手机浏览器里跑真实的 Lite 工程源码，把「装表 → 看现象 → 反推」换成
「看确切报错 → 改 → 装表确认」。纯网页、零依赖、不需要 DevEco。

```bash
python3 server/server.py 8787
# 手机浏览器打开 http://127.0.0.1:8787/
```

## 它解决什么

真机上拿日志很麻烦（没有 console，只能靠现象反推）。lite-sim 把可诊断的部分
搬到浏览器：

| 能在模拟器里查到 | 仍需真机 |
|---|---|
| JS 异常（undefined 读取、方法不存在、栈溢出） | 圆角裁切、字体、滚动的真实表现 |
| 事件没触发（`grab:`/`on:` 前缀静默失效、handler 缺失、重复绑定） | 64KB 堆 OOM、性能卡顿 |
| `@system.*` 调用与回调（含超时未触发、301） | 真实文件权限、蓝牙转发 |
| `data` 变更追踪（治"改了不显示"） | 传感器/振动等硬件 |
| 24 条 Lite 专属规则（编译期/运行时才会暴露的） | |

## 三个部分

**1. 规则体检**（`web/checker.js`，24 条规则，全部有真机实测依据）

事件前缀静默失效、非白名单标签、`class="{{}}"`、`if`+`for` 同元素、
`list-item` 顶层子节点数、复合选择器、`flex:1`、`font-family`、
宽高越界、if 容器无固定高、底部栏缺 `padding-bottom`（圆角危险区 y≥420）、
正则字面量、可选链/空值合并/展开、单页 48KB、`data` 下划线/保留名、
裸中文、hml 表达式 ES6、事件 handler 未实现、定时器无 `onDestroy`…

每条带 **code + 中文修复建议 + 文件:行号 + 源码行**。

**2. 运行时**（`web/runtime/`）

- HML 解析 → 渲染到 412×484 画布（圆角遮罩 + y=420 危险区红线 + 网格）
- 响应式 data（含嵌套 Proxy）→ 深度绑定追踪
- 事件绑定 + 重复触发计数（同 handler 第 3 次告警）
- 模块加载器：真实工程的 `import` 图 + `@system.*` 注入
- `@system.*` mock：router / storage / file / vibrator / brightness / app
  + `$app` 全局；`file` 分块读、`storage` 128B 红线、回调超时监督
- **页面跳转联动**：源码里的 `router.push/back` 会真的切页
- **系统返回键**：触发 `onBackPress`（编辑页就是靠它返回）

**3. 报错反馈**（`web/reporter.js`）

六类来源统一进一条总线：`rule / exception / event / api / data / lifecycle`。
每条必带 code、级别、标题、详情、**中文修复建议**、文件行号、触发上下文。

**自动批量上报服务端** → `logs/YYYY-MM-DD.jsonl`，AI 通过 MCP `log_tail` 直接读。

## MCP（与 lite-widget MCP 同协议）

```bash
POST http://127.0.0.1:8787/mcp
Authorization: Bearer <token>     # token 见 GET /health 或仓库 .token
Content-Type: application/json

{"jsonrpc":"2.0","id":1,"method":"tools/call",
 "params":{"name":"log_tail","arguments":{"lines":50}}}
```

| 工具 | 用途 |
|---|---|
| `fs_read` / `fs_write` / `fs_tree` / `fs_delete` | 管理被调试项目的文件 |
| `log_tail` | **直接拿报错/事件/API/数据日志** |
| `log_clear` | 清日志 |
| `sim_status` | 服务与日志状态 |
| `sim_report` | 写入一条日志 |

`tools/list` 查看全部；协议与 lite-widget MCP 一致（`method` 恒为 `tools/call`）。

## 测试

```bash
node scripts/test-checker.mjs        # 规则：30/30（坏样本全命中 + 真实项目 0 误报）
node scripts/test-moduleloader.mjs   # 模块加载：9/9（四页全部加载）
# 冒烟（需要 headless chromium）：
# 打开 http://127.0.0.1:8787/?smoke=1 → 6 步全过且 0 error
```

## 冒烟步骤

`?smoke=1` 自动执行：加载 → 体检 → 运行 index → 点「+ 添加」→ 断言跳转
edit → 渲染 → 系统返回 → 断言回 index → 断言运行期 0 error。
每步以 `SMOKE_OK` / `SMOKE_FAIL` 写进报错面板，可直接 dump 或复制。

## 目录

```
server/server.py        HTTP + MCP + 日志落盘（零第三方依赖）
web/index.html          界面（暗色，中文）
web/app.js              集成：拉源码/体检/运行/面板/冒烟
web/checker.js          规则体检
web/reporter.js         报错反馈总线 + 上报
web/runtime/engine.js   HML 解析/响应式/渲染/事件/@system mock
web/runtime/moduleloader.js  import 图求值 + @system 注入
scripts/                测试
logs/                   日志（JSON Lines）
```

## 已知边界

- 渲染是 DOM 近似（Lite 单类选择器降维为 inline style），布局细节以真机为准
- 不模拟 JS 堆上限与真实性能（渲染耗时会给提示，真机更慢）
- `file` 数据在内存里，刷新页面即清空（模拟冷启动）
- 支持的 import 形式：默认 / 命名 / 混合 / namespace；不支持 `export {a} from`
