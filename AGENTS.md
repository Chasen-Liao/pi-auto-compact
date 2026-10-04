# AGENTS.md

Pi 扩展：发 prompt 前按用量百分比预检，超阈值先 `ctx.compact()` 再发送；运行中只在 `tool_call` 上报压力，中途压缩交给 Pi。

源码只有 `extensions/auto-compact.ts`，无构建。peer `@earendil-works/pi-coding-agent >=0.99.0`（Node `>=22.19.0`）。类型基线 1.0.2；端到端基线仍是 0.99.1。

## 命令

```bash
npm run typecheck
npm test                 # test/smoke.ts，PI_CODING_AGENT_DIR 指临时目录，跑完自清理
pi -e .                  # 本地加载扩展
```

改 `peerDependencies` / `devDependencies` / `engines` 后必须 `npm install --package-lock-only`，否则 `npm ci` 会不同步。

## 发版

Agent 的 bash **不是 TTY**，不能代跑 `npm publish`。在本机真实终端做：

```bash
npm run typecheck && npm test
npm version patch|minor          # 会提交并打 tag
git push origin main --follow-tags
npm publish --otp=<验证器6位>    # 不要把 OTP/token 贴进对话或提交
npm view pi-auto-compact version
```

接着 `pi install npm:pi-auto-compact`。

要点（1.3.1 踩过）：

- `npm login` 只换会话，**不够发布**。开了 2FA 时 publish 会 EOTP。
- `--otp=123456` 是文档占位，必须用验证器当前 6 位。
- 非 TTY 下 npm 立刻抛 EOTP，不会打开浏览器；日志里的 auth UUID 会被打成 `***`，没法从输出里捞 URL。
- 要走网页授权：另开一个 cmd 窗口跑 `npm publish`（stdin/stdout 都得是 TTY），出现 URL 后回车开浏览器，完成 2FA。
- 不要用 `npm token create`（CLI 已不能建 granular token）。要免每次 OTP：npm 网站 Access Tokens → granular、Read and write、勾 Bypass 2FA，只写本机 `~/.npmrc`。

## 约定

- 压缩只允许在空闲 `input` 预检里走 `compactAndWait`。**禁止**在 `tool_call` / `turn_end` / `agent_end` 等运行中回调调 `ctx.compact()`：它先 `abort()`，整轮作废、prompt 丢失。
- 中途压缩是 Pi 的（工具批次之间 `shouldCompact` → 压完继续）。扩展不要重写。公式：`tokens > window - reserveTokens`（override → 全局 → 16384）。
- 对齐阈值：直接改 `~/.pi/agent/settings.json` 的 per-model `reserveTokens`（API 只读），必须 `/reload` 才生效。只动自己写过的键；用户自己的 reserve 跳过。副作用：reserve 变大，摘要上限 `min(0.8×reserve, model.maxTokens)` 也可能变长。
- `tool_call` 只读 usage、只报状态，不 block、不压缩。`turn_end` 必须返回 `undefined`，不要 `{continue:true}`（会凭空多一轮）。
- 不要 `sendUserMessage` 重发原 prompt（`input` 在 `prompt()` 内，会递归）；返回 `{action:"continue"}`。
- 异步回调：`sessionGeneration` 守护 + UI try/catch。软错误（Nothing to compact / Already compacted）放行；硬错误拦下，↑键召回重发。
- 不做压缩超时兜底（1.2.2 裁决：当前 before_compact 都同步返回，路径不可达）。
- 配置 `~/.pi/agent/pi-auto-compact.json`（`getAgentDir()` / `PI_CODING_AGENT_DIR`）：`threshold` 区间 `[30, 99)`，`alignPiThreshold` 默认 false，`alignedReserveTokens` 记账。越界回退上一有效值；读写热加载；`updateJsonFile` 原子合并写。

## 验证与边界

改动后：`npm run typecheck` + `npm test`（24 条 mock 冒烟）。端到端用**隔离 cwd + 隔离 `PI_CODING_AGENT_DIR`** 的 `pi -p`（`pi -c` 会接同目录最新 session）。升级 pi 后复测 `ctx.compact()` / `input` / `tool_call` / `shouldCompact`。

不预检：无 `contextWindow`、steer/followUp、skill/template 展开后的膨胀（Pi 兜底）。`tool_call` 不预测尚未产生的工具结果。

配方（隔离目录）：`reserveTokens=270000` + `keepRecentTokens=1000`，再跑一次超大 bash 输出，可复现「批次之间压缩且继续」。端到端用 `openai-codex/gpt-5.6-luna`（`deepseek` 已欠费）。

## 当前

1.3.1（2026-10-04，npm latest 已核）：核对 pi 1.0.2，压缩契约未变，只抬了 types；未重跑隔离端到端。
