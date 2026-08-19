# 架构说明

## 分层

```
浏览器
  ├── WebSocket ──────────────► data-stream.binance.vision   （实时价格，公开数据直连）
  └── HTTP ──► Next.js 服务端 ──► 各数据源                    （K线/指标/资讯/研判）
                    │
                    ├── lib/datasources/   数据源适配器：把各家 API 归一化成统一契约
                    ├── lib/indicators/    技术指标计算（确定性，无 LLM 参与）
                    └── lib/analysis/      LLM 研判（只在服务端，持有 API Key）
```

### 为什么实时行情让浏览器直连，K 线却走服务端

- **实时行情**是公开数据流，不涉及任何凭据。浏览器直连少一跳延迟，
  服务端也不必为每个用户维持一条上游 WebSocket。
- **K 线**要跟着算 20 多个技术指标。放服务端算有三个好处：
  不阻塞浏览器主线程；多个客户端共享缓存；
  最关键的是——图表、指标面板、LLM 研判用的是**同一份计算结果**，
  不会出现三个地方数字对不上的情况。

## 目录

```
src/
├── app/
│   ├── api/
│   │   ├── market/klines/     K线 + 技术面快照
│   │   ├── market/tickers/    自选列表 24h 行情
│   │   ├── market/symbols/    全部 USDT 交易对（供搜索）
│   │   ├── derivatives/       OKX 资金费率 / 持仓量
│   │   ├── sentiment/         恐惧贪婪指数
│   │   ├── news/              RSS 聚合（必须服务端拉，浏览器有 CORS）
│   │   ├── analysis/          LLM 综合研判（POST）
│   │   └── health/            数据源健康检查
│   └── page.tsx
├── components/                UI 组件
├── lib/
│   ├── datasources/
│   │   ├── types.ts           统一数据契约 ← 换数据源时上层不用动
│   │   ├── http.ts            超时 / 重试 / 缓存 / 地理封锁识别
│   │   ├── binance-vision.ts  现货行情（核心）
│   │   ├── okx.ts             衍生品
│   │   ├── sentiment.ts       情绪
│   │   └── news.ts            资讯
│   ├── indicators/
│   │   ├── index.ts           MA / EMA / RSI / MACD / BOLL / ATR / KDJ / VWAP / 支撑阻力
│   │   └── summary.ts         压缩成"当前技术面快照" + 透明的打分理由
│   ├── analysis/
│   │   ├── schema.ts          研判输出的 Zod 契约
│   │   ├── prompt.ts          prompt 构造
│   │   └── claude.ts          Claude 调用
│   ├── stores/watchlist.ts    自选（localStorage）
│   ├── ws/binance-stream.ts   WebSocket（自动重连）
│   └── hooks/
└── docs/
```

## 关键设计决策

### 1. 数据源适配器与统一契约

`lib/datasources/types.ts` 定义了 `Candle`、`Ticker`、`DerivativesSnapshot` 等类型，
每个 adapter 负责把自家 API 的原始响应翻译过来。上层只认这些类型。

**为什么重要**：在这个项目里数据源不是稳定的——今天 OKX 能用，
明天可能要换成别家；今天用 binance.vision，将来接了代理可能换回主站。
把差异关在 adapter 里，换源时改动不会扩散。

### 2. LLM 只解读，不计算

所有指标由 `lib/indicators/` 用确定性代码算好，再以格式化文本喂给模型。
Prompt 里明确要求"不要重新计算任何指标"。

**为什么**：模型算数会出错，而且出错时说得同样自信。
让它做自己擅长的事——把一堆事实串成有逻辑的判断、指出信号冲突——
比让它兼职当计算器可靠得多，还省 token。

### 3. 结构化输出

研判结果用 Zod schema（`lib/analysis/schema.ts`）+ structured outputs 强约束，
而不是让模型自由写一段话再解析。看板要把结论渲染成进度条、标签、情景卡片，
自由文本驱动不了 UI。

Schema 里刻意包含 `dataGaps`（数据缺口）和 `risks`（风险）两个必填字段，
逼模型说出它没看到什么、判断可能怎么错——避免只输出一段乐观叙事。

### 4. 规则引擎与 LLM 并存

`summary.ts` 里有一套透明的加权打分，输出 `bias` 和逐条 `reasons`。
它有两个作用：直接显示在指标面板上（不花钱、不延迟）；
作为 LLM 的输入之一，让模型有个可对照的基线。

用户能同时看到"规则怎么说"和"模型怎么说"，两者分歧时反而是有价值的信号。

### 5. 数据源健康检查是一等公民

`/api/health` 和顶部状态条不是运维摆设。在受地区限制的网络下，
"某个源今天通不通"是真实会变的状态。图表空白时用户需要立刻知道
是网络、上游还是代码的问题。

## 成本

除 LLM 研判外，全部数据源免费无 Key。研判为手动触发（不自动轮询），
单次调用输入约 2-4K token，按 Claude Opus 5 定价约 $0.02-0.05/次。
