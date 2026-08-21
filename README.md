# Crypto Radar

加密货币行情监控、技术面分析与 AI 走势研判看板。

**为在美国 VPN 环境下使用币安行情而设计** —— 币安主站对美国 IP 返回 HTTP 451，
本项目通过币安官方公开数据镜像 `*.binance.vision` 绕开该限制，
不需要代理服务器、不需要非美国 VPS、不需要 API Key。
完整实测见 [docs/DATA-SOURCES.md](docs/DATA-SOURCES.md)。

## 功能

- **实时行情** — WebSocket 推送自选币种价格，K 线随周期自动刷新。
  币安没有的币种（如 HYPE）自动走 OKX，上层无感知；
  秒级盘口只覆盖币安，界面会明确标注而不是假装在连接
- **技术面分析** — MA / EMA / RSI / MACD / 布林带 / KDJ / ATR / VWAP / 自动识别支撑阻力，
  附带一套透明的加权打分和逐条依据
- **多周期视图** — 1m / 5m / 15m / 1h / 4h / 1d / 1w，
  外加 1h/4h/1d 的共振一致性评分（含长短周期背离提示）
- **多币种对比** — 1h / 24h / 7d 三个窗口的涨跌与**相对 BTC 的超额收益**。
  加密同涨同跌，涨多少不重要，跑赢没跑赢才是信息
- **研判价位上图** — 最近一次研判给出的支撑 / 阻力 / 失效价直接画在 K 线上
- **基本面与情绪** — 永续合约资金费率、未平仓量、恐惧贪婪指数
- **资讯聚合** — Cointelegraph / Decrypt / CoinDesk / 币安公告，按币种过滤
- **链上** — 稳定币总供应（场内流动性，与美联储净流动性成对看）、
  BTC 算力 / 拥堵 / 费率。已回测：稳定币供应变化**无预测力**，仅作水位参考
- **宏观与政策** — 三层数据源：FRED 的净流动性（美联储总资产 − 逆回购 − 财政部账户）、
  利率/通胀/美元指数序列、CPI 与非农的发布日历；FOMC 议息倒计时；
  以及**基于官方声明原文的鹰鸽判断**——词典打分 + 投票分歧，
  附逐条依据（命中哪句话、加减多少分）与对加密的传导说明。
  回测过 41 次会议：鹰派声明之后从未降息，鸽派之后从未加息。
  全部免费，实测中国大陆直连可达。详见 [docs/DATA-FRAMEWORK.md](docs/DATA-FRAMEWORK.md)
- **AI 综合研判** — 结合以上全部维度（含美联储政策环境），输出结构化的方向判断、置信度、
  因子拆解、情景推演（含概率）、关键价位与风险点。
  支持 DeepSeek / 中转站 / Anthropic 官方，可自由切换。
  内置成本控制：价格未明显变动时自动复用上次结论，界面明确提示并可强制重算
- **告警** — 价格、RSI、MACD 交叉、布林挤压结束、放量等规则，
  **在服务端求值**：只要服务在跑，关掉浏览器也持续监控，
  可一条命令装成开机自启的常驻服务（[docs/DEPLOY.md](docs/DEPLOY.md)），
  可推送到企业微信 / 钉钉 / 飞书群机器人或 Telegram；
  页面打开时同时发桌面通知
- **研判准确率回测** — 每次研判自动存档，到期后拉取真实行情自动检验。
  提供置信度校准表与「无脑猜同一方向」的基线对比 —— 跑不赢基线的模型没有价值。
  校准结果会回填到研判结论旁（「历史校准后约 X%」），
  样本不足时明说还差几条而不是硬给一个数
- **自选管理** — 484 个 USDT 交易对可搜索添加，保存在本地浏览器
- **数据源健康监控** — 顶部状态条显示每个数据源通断及服务端出口国家

## 快速开始

```bash
npm install
npm run dev
```

打开 http://localhost:3000 即可使用。

**要让告警真正 7×24（关掉终端也继续监控），用常驻方式启动：**

```bash
npm run build && node scripts/setup-launchd.mjs --install
```

macOS 用 launchd、Linux VPS 用 pm2，两者的完整说明与坑见
[docs/DEPLOY.md](docs/DEPLOY.md)。`npm run dev` 只适合改代码时用——
关掉终端告警就停，且不会有任何提示。**行情、图表、指标、资讯全部无需任何配置**——
核心行情源 `binance.vision` 从中国大陆直连即可访问，实测比走 VPN 更快。

### 如果你在中国大陆或使用 VPN（重要）

Node.js 的 `fetch` **默认不读取代理环境变量**，服务端会绕过你的 VPN 直连，
导致 OKX 衍生品和 AI 研判失败。启动时带上代理地址即可（`NODE_USE_ENV_PROXY=1` 已内置）：

```bash
HTTPS_PROXY=http://127.0.0.1:7890 npm run dev
```

端口换成你的 VPN 客户端实际监听的本地代理端口。看板顶部会显示服务端出口国家，
一眼可确认是否生效。详见 [docs/DATA-SOURCES.md](docs/DATA-SOURCES.md)。

启用 AI 研判（可选）：

```bash
cp .env.example .env.local
```

支持三类供应商，三选一即可，`.env.example` 里每一种都有完整注释：

| 方案 | 国内直连 | 实测单次研判耗时 | 配置 |
|---|---|---|---|
| **OpenAI 格式中转站** | ✅ 需直连 | **约 23s**（claude-opus-5） | `OPENAI_BASE_URL` |
| **DeepSeek** | ✅ 无需代理 | 约 50s（v4-flash）/ 95s（v4-pro） | `DEEPSEEK_API_KEY` |
| **Anthropic 官方** | ❌ 需代理 | — | `ANTHROPIC_API_KEY` |

⚠️ 中转站与 DeepSeek 都需要**直连**，而 OKX 衍生品数据需要**走代理**。
若两者同时使用，必须用 `NO_PROXY` 排除：

```bash
HTTPS_PROXY=http://127.0.0.1:7890 NO_PROXY=localhost,127.0.0.1,你的中转站域名 npm run dev
```

未显式设置 `LLM_PROVIDER` 时会按 DeepSeek → Anthropic → OpenAI 的顺序自动选用已配置的那个。
看板顶部状态条会显示当前生效的供应商与模型。

由于只有 Anthropic 原生支持 structured outputs，其余供应商走 `json_object` 模式时
本项目会自动注入 JSON Schema 说明、剥离代码块围栏、用 Zod 校验，
并在校验失败时带着具体字段错误重试一次——这些你不需要关心，配好 key 即可。

## 网络体检

切换 VPN 节点后跑一次，用实测数据决定分流规则：

```bash
npm run netcheck:proxy
```

输出包含出口 IP 与归属地、每个数据源的通断，并直接判定该节点是
「非美国节点，可用于币安交易」还是「受限（美国）节点」。

其中 `binance-main`（币安主站）显示为失败是**正确结果**——
它是故意保留的对照探针，证明封锁真实存在且镜像方案确实绕过了它。
注意区分两种失败：**451** 表示请求确实从 VPN 出去并被币安地理封锁；
**超时** 则表示请求根本没走代理（被 GFW 静默丢弃）。

## 规则引擎回测

技术指标的加权打分容易让人想当然。这里可以直接量：

```bash
npm run backtest             # 在历史 K 线上逐根重放规则引擎，测每个信号的信息量
npm run backtest:resonance   # 测多周期共振判定
npm run backtest:hawkdove    # 用历史 FOMC 声明与真实利率路径检验鹰鸽词典
npm run backtest:flow        # 测主动成交方向
npm run backtest:stablecoin  # 测稳定币供应变化
```

两个脚本都按时间 7:3 切分（推权重的数据不参与验证），
都把命中率减去基线后才叫「信息量」，
并会主动报告样本的方向偏斜与有效独立样本量。

**实测结论已经写进 `docs/ROADMAP.md` 第 6、7 项**：
规则引擎目前跑不赢「无脑全猜震荡」，所以它在界面和 prompt 里
被明确标注为「技术面状态的描述」而非方向判断依据。

## 数据备份

`data/analyses.json` 是这个项目最有价值的资产——校准与回测全靠它一条条攒出来。
常驻服务每天自动快照一份（保留 14 份），也可手动：

```bash
npm run backup
```

默认存到 `data/backups`，**与源文件同一块盘**——只防误删和写坏。
要防硬盘故障，把 `DATA_BACKUP_DIR` 指到外接盘或同步盘。

## 测试

```bash
npm test
```

每次 push 与 PR 都会在 GitHub Actions 上跑一遍类型检查、lint、离线测试与生产构建
（[.github/workflows/ci.yml](.github/workflows/ci.yml)）。
联网测试是单独一个 job 且不阻塞——它依赖美联储官网的页面结构，
上游改版会让它失败，那是真实信息但不该拦住代码合并。

秒级返回，覆盖三处「错了不会立刻被发现」的逻辑：研判复用判定的边界、
群机器人加签（写错是静默失败——HTTP 200 但消息不出现）、FOMC 日历解析。

依赖真实网络的那部分默认跳过，需要时单独跑：

```bash
npm run test:live
```

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
- OKX 在中国大陆直连不可达，需配置 `HTTPS_PROXY`（见上）。Anthropic 官方 API 同样如此，
  但改用 DeepSeek 或中转站即可完全避开。
  同时运行两个 VPN 客户端不可行，正确做法是单客户端 + 规则分流，方案见 DATA-SOURCES.md。

## 免责声明

本项目输出的一切内容均为基于公开数据的分析，**不构成投资建议**。
加密货币市场波动剧烈，任何预测都有很高的不确定性——
这也是为什么研判输出中强制包含「风险」与「数据缺口」字段。
请自行判断并承担全部风险。
