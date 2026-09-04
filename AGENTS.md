# AGENTS.md

Pi 扩展：在发送 prompt 前预检上下文（当前 usage + 新输入 token），超过阈值百分比就先压缩再发送，避免长输入中断工具链。压缩始终复用 Pi 内置 `ctx.compact()`。

## 常用命令

```bash
npm run typecheck        # tsc --noEmit
npm test                 # mock 冒烟（test/smoke.ts，Node 原生 TS，PI_CODING_AGENT_DIR 指向临时目录）
pi -e .                  # 本地加载扩展启动 pi（交互验证）
npm version minor/patch  # 发版；npm publish 后 pi install npm:pi-auto-compact
```

## 架构与约定

- 全部源码在 `extensions/auto-compact.ts`，`package.json` 的 `pi.extensions` 指向它。TS 直接由 pi 加载，无构建步骤。
- 压缩唯一入口是 `input` 事件里的 preflight（`compactAndWait`）。**禁止**在 `turn_end`/`agent_end` 里调 `ctx.compact()`——它会 abort 正在运行的工具链。
- 不要用 `ctx.sendUserMessage` 重发原 prompt（`input` 事件在 `prompt()` 内触发，会无限递归）；返回 `{action:"continue"}` 让原 prompt 走正常流程。
- 异步回调必须带 `sessionGeneration` 守护 + `notifySafe`/`clearStatus` 式 try/catch，session 切换后旧 ctx 访问 UI 会抛错。
- 已知取舍（用户裁决 1.2.2）：不做超时兜底——当前安装的扩展（pi-subagents/pi-goal 的 before_compact 均同步返回）不会挂住压缩，路径不可达；若未来某扩展异步挂住 before_compact，ctx.compact() 永不回调，-p 下 prompt 静默丢失、TUI 会话卡死，属接受的风险。软错误（Nothing to compact/Already compacted，includes 匹配）→ 放行；硬错误 → 拦下（↑键召回重发，Pi 压缩互斥锁在 compact() 挂住时不释放，重发进队列等后台落定）。
- 配置文件 `~/.pi/agent/pi-auto-compact.json`（`getAgentDir()` 解析，env `PI_CODING_AGENT_DIR` 可重定向——冒烟测试靠它隔离）。阈值合法区间 `[30, 99)`（下限依据：Pi 压缩保留 keepRecentTokens≈20000，过低只会落入"没东西可压"软失败循环；上限排除 99：压缩本身需要余量）；手改成越界值时回退上一有效值。preflight/turn_end 每次重读（热加载跨会话生效）；写入必须 temp+rename 原子写且与现有键合并（`compactTimeoutMs` 等），先落盘成功再更新内存。
- `peerDependencies` 锁 `@earendil-works/pi-coding-agent >=0.84.3`；升级 pi 后需复测 `ctx.compact()`/`input` 事件语义。

## 当前状态

- 1.2.2（当前）：1.2.0 消融实验（真实 pi 隔离环境，R0–R3 差分）后从 hardened-1.1.1 选择性移植：配置热加载/键合并 + 阈值 [30,98) + test/smoke.ts 入库；砍掉 abort 放行、编辑器回填（↑键可召回已实证）、compactSequence、inFlight 生命周期置空、超时兜底（1.2.2 最终裁决：当前环境触发不可达，属投机防护）。
- 已知边界：模型未上报 `contextWindow` 时预检跳过；steer/followUp 队列消息与 skill/template 展开后的膨胀不预检，由 Pi 内置压缩兜底。
- 验证方式：改动后跑 `npm run typecheck` + `npm test`（mock 冒烟入库，覆盖阈值/软硬失败/并发/守护/配置路径），再用 `pi -p`/`pi -c -p` 在**隔离 cwd + 隔离 PI_CODING_AGENT_DIR** 做端到端（`pi -c` 会接同 cwd 最新 session，勿在活跃会话项目里测）。
