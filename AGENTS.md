<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Crypto Radar 项目约定

产品北极星是**小白投资者的稳健型收益**：先风险、后机会，不预测价格。首页 `/` 是稳健驾驶舱，行情与 AI 研判在 `/radar`。
为什么这样取舍见 `docs/PRODUCT-STRATEGY.md`；分层、目录与设计决策见 `docs/ARCHITECTURE.md`；环境变量见 `.env.example`。

## 红线

- 不给买卖建议、不承诺收益；「稳健」不等于「保本」。驾驶舱只是用户自设规则的计算器。
- 首页不放方向性标签（看涨 / 看空）。方向类信号的回测都没跑赢基线，新增任何「提升预测能力」的功能要先过回测。
- 持仓与投资计划只在本机：`data/steady.json` 由用户手填，不连账户、不要 API Key；接口只允许本机访问（`STEADY_ALLOW_LAN=1` 才放开 Host 检查）。
- `data/` 是用户数据且已 gitignore：不要提交、不要清理。其中手填的 `steady.json` 丢了只能重填。

## 运行与验证

- `npm test`：离线、秒级；写文件的测试都用临时目录，不碰真实 `data/`。新增的 `scripts/test-*.mjs` 会被自动发现。
  类型检查与 lint 是 `npx tsc --noEmit`、`npx eslint`；CI 还会跑 `npm run build`。
- 常驻服务 `com.crypto-radar`（launchd，:3000）跑的就是**主工作区**的 `.next`：在主工作区 `npm run build` 会直接替换它，
  构建后要 `launchctl kickstart -k gui/$(id -u)/com.crypto-radar` 才生效。主工作区常有用户或其他 agent 的未提交改动，
  动手前先 `git status`，有改动就用 `git worktree`。
- 服务端出站请求走 `HTTPS_PROXY`（`NODE_USE_ENV_PROXY=1`），但币安镜像与 LLM 接口应直连（`NO_PROXY`），否则会超时；
  `node scripts/setup-launchd.mjs --install` 会自动写好，详见 `docs/DEPLOY.md`。
