# AGENTS.md

Pi 扩展：发送 prompt 前预检上下文（当前 usage + 新输入 token），超过阈值百分比就先压缩再发送，避免长输入中断工具链；运行中在每次工具调用前报告还有哪次压缩待发生。发 prompt 前的压缩复用 Pi 内置 `ctx.compact()`，中途压缩交给 Pi 自己在工具批次之间做（见下）。

## 常用命令

```bash
npm run typecheck        # tsc --noEmit
npm test                 # mock 冒烟（test/smoke.ts，Node 原生 TS，PI_CODING_AGENT_DIR 指向临时目录，跑完自清理）
pi -e .                  # 本地加载扩展启动 pi（交互验证）
npm version minor/patch  # 发版；npm publish 后 pi install npm:pi-auto-compact
```

改动 `peerDependencies`/`devDependencies`/`engines` 后要跑 `npm install --package-lock-only`，否则 `npm ci` 会报 lock 与 package.json 不同步。

`npm publish` 需要 npm 账号 2FA（会话 token 会报 EOTP）；想免掉每次网页确认就在本机跑一次下面这条（会提示账号密码，令牌直接写回 `~/.npmrc`，不要把它贴进对话或提交）：

```bash
npm token create --name "pi-auto-compact publish" --packages pi-auto-compact --packages-and-scopes-permission read-write --expires 365
```

## 架构与约定

- 全部源码在 `extensions/auto-compact.ts`，`package.json` 的 `pi.extensions` 指向它。TS 直接由 pi 加载，无构建步骤。
- 压缩唯一入口是 `input` 事件里的 preflight（`compactAndWait`）。**禁止**在任何运行中回调里调 `ctx.compact()`——它走 `AgentSession.compact()`，第一件事就是 `await this.abort()`；0.99.1 实测：在 `tool_call` 里调会把整轮 abort 掉（输出 `This operation was aborted`，prompt 丢失），`turn_end`/`agent_end` 同理。
- **Pi 自己会中途压缩（0.86+）**：`AgentSession._installAgentNextTurnRefresh` 包住 `prepareNextTurnWithContext` → `_compactBeforeNextAssistantResponse` → `shouldCompact()` → `_runAutoCompaction("threshold", false)`，压缩后重建 projection，agent loop 继续下一轮（0.99.1 隔离环境实测：单轮内 toolResult(52KB) → compaction → 继续 → 正常收尾）。所以"中途压缩且能继续"是 Pi 的能力，扩展层不要重写。
- 阈值公式只有一个旋钮：`shouldCompact(tokens, window, settings) = tokens > window - reserveTokens`（`compaction.modelOverrides[key].reserveTokens` → `compaction.reserveTokens` → 16384）。扩展 API 无写设置的方法（`pi.getSettings()` 只读且 0.99.0 才有），所以对齐是**直接改写 `~/.pi/agent/settings.json`**（原子合并写），且**必须 `/reload` 才生效**（`AgentSession.reload()` 才 `settingsManager.reload()`）。
- 对齐只写自己写过的键：`pi-auto-compact.json` 的 `alignedReserveTokens` 记账，用户自己设的 `compaction.reserveTokens` / 同名 `modelOverrides` 一律跳过（`owned-by-user`），被用户改过的值会被 `forgetManaged` 除名。副作用：reserve 变大 → 摘要输出上限变成 `min(0.8×reserve, model.maxTokens)`，摘要可能更长。
- `tool_call` 处理器只读 usage + 报状态，永不 block、永不压缩（block 只会白白烧一轮）。`setStatusOnce` 去重，避免每次工具调用重写同一行。
- 0.87 起 `turn_end`/`agent_before_settle` 是可写边界（返回 `{entries, continue}`）。本扩展的 `turn_end` 处理器只返回 `undefined`（纯状态），**不要**误返回 `{continue:true}`，否则会凭空多跑一轮。
- 不要用 `ctx.sendUserMessage` 重发原 prompt（`input` 事件在 `prompt()` 内触发，会无限递归）；返回 `{action:"continue"}` 让原 prompt 走正常流程。
- 异步回调必须带 `sessionGeneration` 守护 + `notifySafe`/`setStatus` 式 try/catch，session 切换后旧 ctx 访问 UI 会抛错。
- 已知取舍（用户裁决 1.2.2）：不做超时兜底——当前安装的扩展（pi-subagents/pi-goal 的 before_compact 均同步返回）不会挂住压缩，路径不可达；若未来某扩展异步挂住 before_compact，ctx.compact() 永不回调，-p 下 prompt 静默丢失、TUI 会话卡死，属接受的风险。软错误（Nothing to compact/Already compacted，includes 匹配）→ 放行；硬错误 → 拦下（↑键召回重发，Pi 压缩互斥锁在 compact() 挂住时不释放，重发进队列等后台落定）。
- 配置文件 `~/.pi/agent/pi-auto-compact.json`（`getAgentDir()` 解析，env `PI_CODING_AGENT_DIR` 可重定向——冒烟测试靠它隔离）。键：`threshold`（合法区间 `[30, 99)`，下限依据：Pi 压缩保留 keepRecentTokens≈20000，过低只会落入"没东西可压"软失败循环；上限排除 99：压缩本身需要余量）、`alignPiThreshold`（默认 false）、`alignedReserveTokens`（记账）。手改成越界值时回退上一有效值。`input`/`turn_end`/对齐前每次重读（热加载跨会话生效）；写入走 `updateJsonFile`（temp+rename 原子写 + 合并现有键，如 `compactTimeoutMs`），先落盘成功再更新内存。
- `peerDependencies` 锁 `@earendil-works/pi-coding-agent >=0.99.0`（`pi.getSettings()`、`DEFAULT_COMPACTION_SETTINGS` 的最低版本；0.85–0.98 没有 `getSettings`）；实测基线 0.99.1；升级 pi 后需复测 `ctx.compact()`/`input`/`tool_call` 事件语义与 `shouldCompact` 公式。

## 当前状态

- 1.3.0（已发布 2026-10-01，tag v1.3.0）：适配 pi 0.99.1 + 工具调用前的上下文检查。审计 0.85→0.99.1 的 changelog 与 dist 源码后确认：既有 preflight 语义（`input.streamingBehavior`、`getContextUsage`、`ctx.compact` 回调、soft/hard 分类）完全兼容，无需改动；新增 `tool_call` 处理器（只报状态、不压缩不 block）与 opt-in 阈值对齐（`/compact-threshold align on|off` 改写 pi 的 `compaction.modelOverrides`，需 `/reload` 生效）；配置层从单 `threshold` 扩为 `{threshold, alignPiThreshold, alignedReserveTokens}`；peer 抬到 `>=0.99.0`（唯一硬依赖是 `pi.getSettings()`），`engines.node` 同步到 `>=22.19.0`。发版前 review 修掉三处：命令入口不热加载 config、`alignedReserveTokens` 接受非对象、对齐写盘失败会抛到 `session_start`。冒烟 24 条（自清理临时 agent 目录）。
- 1.2.3：ponytail 审计裁剪（净 -50 行，行为/文案不变）：node:test runner 取代手写 runner、compactAndWait 直接 resolve `Error | null`（删 settled 守卫与死字段 CompactionOutcome.ok）、clearStatus 并入 setStatus、删恒真 inFlight 守卫与 mock editor/mode 残留；冒烟扩到 12 条（补 images 投影分支，SDK 每图计 4800 字符）。
- 1.2.2：1.2.0 消融实验（真实 pi 隔离环境，R0–R3 差分）后从 hardened-1.1.1 选择性移植：配置热加载/键合并 + 阈值 [30,99) + test/smoke.ts 入库；砍掉 abort 放行、编辑器回填（↑键可召回已实证）、compactSequence、inFlight 生命周期置空、超时兜底（1.2.2 最终裁决：当前环境触发不可达，属投机防护）。
- 已知边界：模型未上报 `contextWindow` 时预检跳过；steer/followUp 队列消息与 skill/template 展开后的膨胀不预检，由 Pi 内置压缩兜底；`tool_call` 检查用当前 usage，不预测尚未产生的工具结果（结果才是上下文大头）；对齐后的 reserve 同时抬高摘要输出上限。
- 验证方式：改动后跑 `npm run typecheck` + `npm test`（mock 冒烟入库，覆盖阈值/软硬失败/并发/守护/配置热加载/images 投影/tool_call 检查/对齐写入与清理），再用 `pi -p` 在**隔离 cwd + 隔离 PI_CODING_AGENT_DIR** 做端到端（`pi -c` 会接同 cwd 最新 session，勿在活跃会话项目里测）。
- 已做过的端到端取证（可复用配方）：隔离 agent 目录里设 `compaction.reserveTokens = 270000`（272k 窗口 → 阈值 2000 token）+ `keepRecentTokens = 1000`，再让模型跑一次 `for i in $(seq 1 1500); do echo ...; done`，即可稳定复现"工具批次之间压缩且继续"；把 `modelOverrides` 写成 260000 而全局留 270000，可从 `session_before_compact` 的 `preparation.settings.reserveTokens` 断言"per-model override 覆盖全局"。注意 `deepseek` key 已欠费，端到端用 `openai-codex/gpt-5.6-luna`（auth.json 拷进隔离目录）。
