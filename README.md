# Crypto Radar

加密货币行情监控、技术面分析与 AI 走势研判看板。

**为在美国 VPN 环境下使用币安行情而设计** —— 币安主站对美国 IP 返回 HTTP 451，
本项目通过币安官方公开数据镜像 `*.binance.vision` 绕开该限制，
不需要代理服务器、不需要非美国 VPS、不需要 API Key。
完整实测见 [docs/DATA-SOURCES.md](docs/DATA-SOURCES.md)。

## 功能

- **实时行情** — WebSocket 推送自选币种价格，K 线随周期自动刷新
- **技术面分析** — MA / EMA / RSI / MACD / 布林带 / KDJ / ATR / VWAP / 自动识别支撑阻力，
  附带一套透明的加权打分和逐条依据
- **多周期视图** — 1m / 5m / 15m / 1h / 4h / 1d / 1w
- **基本面与情绪** — 永续合约资金费率、未平仓量、恐惧贪婪指数
- **资讯聚合** — Cointelegraph / Decrypt / CoinDesk / 币安公告，按币种过滤
- **AI 综合研判** — 由 Claude 结合以上全部维度，输出结构化的方向判断、
  置信度、因子拆解、情景推演（含概率）、关键价位与风险点
- **自选管理** — 484 个 USDT 交易对可搜索添加，保存在本地浏览器
- **数据源健康监控** — 顶部状态条实时显示每个数据源通断

## 快速开始

```bash
npm install
npm run dev
```

打开 http://localhost:3000 即可使用。**行情、图表、指标、资讯全部无需任何配置。**

启用 AI 研判（可选）：

```bash
cp .env.example .env.local
```

然后在 `.env.local` 中填入你的 `ANTHROPIC_API_KEY`。

## 验证数据源

```bash
curl -s http://localhost:3000/api/health | python3 -m json.tool
```

预期：`binance-vision`、`okx`、`fng`、`cointelegraph` 为 `ok: true`；
`binance-main`（币安主站）为 `ok: false` —— **这是正确结果**，
它是故意保留的对照探针，证明封锁真实存在且镜像方案确实绕过了它。

## 技术栈

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS 4 ·
lightweight-charts (TradingView) · Zustand · Zod · Anthropic SDK

## 文档

- [数据源与网络可达性评估](docs/DATA-SOURCES.md) —— 含完整实测数据，**建议先读**
- [架构说明](docs/ARCHITECTURE.md) —— 分层、目录、关键设计决策
- [后续规划](docs/ROADMAP.md)

## 已知边界

- 本项目**只读公开行情，不接账户、不下单**。`*.binance.vision` 镜像不提供任何签名端点。
  若将来需要账户功能，必须自建非美国出口的代理，路径见 DATA-SOURCES.md 末节。
- 币安合约数据（fapi）在美国 IP 下不可达，资金费率与持仓量取自 OKX，
  两家交易所的绝对数值不可直接比较，看趋势和方向即可。
- 恐惧贪婪指数是**全市场**情绪，非单一币种。

## 免责声明

本项目输出的一切内容均为基于公开数据的分析，**不构成投资建议**。
加密货币市场波动剧烈，任何预测都有很高的不确定性——
这也是为什么研判输出中强制包含「风险」与「数据缺口」字段。
请自行判断并承担全部风险。
