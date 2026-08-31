# AGENTS.md

Pi 扩展：在发送 prompt 前预检上下文（当前 usage + 新输入 token），超过阈值百分比就先压缩再发送，避免长输入中断工具链。压缩始终复用 Pi 内置 `ctx.compact()`。

## 常用命令

```bash
npm run typecheck        # tsc --noEmit（含 extensions + test）
npm test                 # node test/smoke.ts，mock 冒烟（Node 原生 TS，PI_CODING_AGENT_DIR 指向临时目录，不碰真实配置）
pi -e .                  # 本地加载扩展启动 pi（交互验证）
npm version minor/patch  # 发版；npm publish 后 pi install npm:pi-auto-compact
```

## 架构与约定

- 全部源码在 `extensions/auto-compact.ts`，`package.json` 的 `pi.extensions` 指向它。TS 直接由 pi 加载，无构建步骤。
- 压缩唯一入口是 `input` 事件里的 preflight（`compactAndWait`）。**禁止**在 `turn_end`/`agent_end` 里调 `ctx.compact()`——它会 abort 正在运行的工具链。
- 不要用 `ctx.sendUserMessage` 重发原 prompt（`input` 事件在 `prompt()` 内触发，会无限递归）；返回 `{action:"continue"}` 让原 prompt 走正常流程。
- 异步回调必须带 `sessionGeneration` 守护 + `notifySafe`/`clearStatus` 式 try/catch，session 切换后旧 ctx 访问 UI 会抛错。UI 状态另用 `compactSequence` 保证只有最新一次压缩能写状态行。
- `ctx.compact()` 无取消句柄，且其内部 `await abort()` + 网络摘要调用可能永不回调（SDK 源码 0.84.4 已确认）——`compactAndWait` 的超时定时器是唯一落定手段，**不可 unref**（awaiting 方只靠它保活；`finish()` 里 clearTimeout 保证不拖延退出）。
- 失败分类 fail-open：软错误（`Nothing to compact`/`Already compacted`，SDK 实际文案含后缀、用 includes 匹配）、abort（AbortError/"Compaction cancelled"）、超时 → 放行 prompt；仅其它硬错误拦下并用 `setEditorText` 回填（编辑器已有新文本时不覆盖）。
- Pi 自己在 `prompt()` 入口有 `_compactionAbortController` 互斥（压缩中提交第二条约会被拒），本扩展的 `inFlight` 复用只兜程序性竞态；`session_start`/`session_shutdown` 必须把 `inFlight` 置 null，防旧会话永不落定的 promise 拖死新会话。
- 配置文件 `~/.pi/agent/pi-auto-compact.json`（`getAgentDir()` 解析，env `PI_CODING_AGENT_DIR` 可重定向——冒烟测试靠它隔离）。阈值合法区间 `[30, 99)`（下限依据：Pi 压缩保留 keepRecentTokens≈20000，过低阈值只会落入"没东西可压"软失败循环）；手改成越界值时回退上一有效值。preflight/turn_end 每次重读（热加载跨会话生效）；写入必须 temp+rename 原子写且与现有键合并（`compactTimeoutMs` 等），先落盘成功再更新内存。
- `peerDependencies` 锁 `@earendil-works/pi-coding-agent >=0.84.3`；升级 pi 后需复测 `ctx.compact()`/`input` 事件语义（devDep 已跟到 0.84.4，无扩展 API 破坏性变更）。

## 当前状态

- 1.1.0 已发布 npm 并安装到本机 pi（npm 来源）。工作区含未发布的硬化改动（超时兜底/fail-open/编辑器回填/配置热加载），发布前记得 `npm version patch`。README 与代码同步于 2026-08-31。
- 已知边界：模型未上报 `contextWindow` 时预检跳过（如 opencode-go 系）；steer/followUp 队列消息与 skill/template 展开后的膨胀不预检，由 Pi 内置压缩兜底。
- 验证方式：改动后跑 `npm run typecheck` + `npm test`（mock 冒烟已入库 `test/smoke.ts`，覆盖阈值/软硬失败/abort/超时/并发/守护/配置路径），再用 `pi -p`/`pi -c -p` 在**隔离 cwd**做端到端（`pi -c` 会接同 cwd 最新 session，勿在活跃会话项目里测）。
