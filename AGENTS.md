# AGENTS.md

Pi 扩展：在发送 prompt 前预检上下文（当前 usage + 新输入 token），超过阈值百分比就先压缩再发送，避免长输入中断工具链。压缩始终复用 Pi 内置 `ctx.compact()`。

## 常用命令

```bash
npm run typecheck        # tsc --noEmit（唯一门禁，无测试框架）
pi -e .                  # 本地加载扩展启动 pi（交互验证）
npm version minor/patch  # 发版；npm publish 后 pi install npm:pi-auto-compact
```

## 架构与约定

- 全部源码在 `extensions/auto-compact.ts`，`package.json` 的 `pi.extensions` 指向它。TS 直接由 pi 加载，无构建步骤。
- 压缩唯一入口是 `input` 事件里的 preflight（`compactAndWait`）。**禁止**在 `turn_end`/`agent_end` 里调 `ctx.compact()`——它会 abort 正在运行的工具链。
- 不要用 `ctx.sendUserMessage` 重发原 prompt（`input` 事件在 `prompt()` 内触发，会无限递归）；返回 `{action:"continue"}` 让原 prompt 走正常流程。
- 异步回调必须带 `sessionGeneration` 守护 + `notifySafe`/`clearStatus` 式 try/catch，session 切换后旧 ctx 访问 UI 会抛错。
- 配置文件 `~/.pi/agent/pi-auto-compact.json`（`getAgentDir()` 解析），写入必须 temp+rename 原子写，先落盘成功再更新内存。
- `peerDependencies` 锁 `@earendil-works/pi-coding-agent >=0.84.3`；升级 pi 后需复测 `ctx.compact()`/`input` 事件语义。

## 当前状态

- 1.1.1 已发布 npm 并安装到本机 pi（阈值收紧为 30–99）。README 与代码同步。
- 已知边界：模型未上报 `contextWindow` 时预检跳过（如 opencode-go 系）；steer/followUp 队列消息与 skill/template 展开后的膨胀不预检，由 Pi 内置压缩兜底。
- 验证方式：无测试框架。改动后跑 `npm run typecheck` + mock 冒烟脚本（mock `ExtensionAPI`，覆盖阈值/软硬失败/并发/守护路径），再用 `pi -p`/`pi -c -p` 在**隔离 cwd**做端到端（`pi -c` 会接同 cwd 最新 session，勿在活跃会话项目里测）。
