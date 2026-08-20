# 架构说明

## 分层

```
浏览器
  ├── WebSocket ──────────────► data-stream.binance.vision   （实时价格，公开数据直连）
  └── HTTP ──► Next.js 服务端 ──► 各数据源                    （K线/指标/资讯/研判）
                    │
                    ├── lib/datasources/   数据源适配器：把各家 API 归一化成统一契约
                    ├── lib/indicators/    技术指标计算（确定性，无 LLM 参与）
                    ├── lib/analysis/      LLM 研判（只在服务端，持有 API Key）
                    ├── lib/alerts/        告警：规则求值 + 常驻轮询 + 通知分发
                    └── lib/history/       研判存档、结果复用判定、准确率回测
```

服务端还有一条不由浏览器触发的路径：`instrumentation.ts` 在服务启动时拉起
`lib/alerts/worker.ts` 的轮询循环，它自行取数、求值、推送通知，
不依赖任何页面处于打开状态。

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
│   │   ├── news/              加密资讯 RSS 聚合（必须服务端拉，浏览器有 CORS）
│   │   ├── macro/             美联储：政策利率 + 下次议息 + 官方资讯
│   │   ├── analysis/          LLM 综合研判（POST）
│   │   ├── analysis/history/  研判存档 + 准确率统计（顺带评估到期记录）
│   │   ├── alerts/rules/      告警规则增删改查
│   │   ├── alerts/events/     已触发事件（浏览器轮询它来弹桌面通知）
│   │   ├── alerts/status/     轮询进程状态与已启用的通知通道
│   │   ├── alerts/test/       发一条测试通知，验证 webhook 配得对不对
│   │   └── health/            数据源健康检查 + 服务端出口探测
│   ├── layout.tsx
│   └── page.tsx
├── instrumentation.ts         服务启动钩子：拉起告警轮询
├── components/                UI 组件（Dashboard 为三栏容器，其余为面板）
└── lib/
    ├── datasources/
    │   ├── types.ts           统一数据契约 ← 换数据源时上层不用动
    │   ├── http.ts            超时 / 重试 / 缓存 / 地理封锁识别
    │   ├── binance-vision.ts  现货行情（核心）
    │   ├── okx.ts             衍生品
    │   ├── sentiment.ts       情绪
    │   ├── rss.ts             极简 RSS 解析（news 与 macro 共用）
    │   ├── news.ts            加密行业资讯
    │   └── macro.ts           美联储：RSS + EFFR 接口 + FOMC 日历
    ├── indicators/
    │   ├── index.ts           MA / EMA / RSI / MACD / BOLL / ATR / KDJ / VWAP / 支撑阻力
    │   └── summary.ts         压缩成「当前技术面快照」+ 透明的打分理由
    ├── analysis/
    │   ├── schema.ts          研判输出的 Zod 契约
    │   ├── prompt.ts          prompt 构造
    │   ├── runner.ts          研判入口，供应商无关
    │   └── providers/
    │       ├── index.ts             按配置选供应商（显式 > 自动推断）
    │       ├── types.ts             供应商统一接口
    │       ├── anthropic.ts         Anthropic 格式，structured outputs
    │       ├── openai-compatible.ts DeepSeek 与 OpenAI 格式中转站
    │       ├── schema-prompt.ts     Zod schema → 给模型看的格式说明
    │       └── json-repair.ts       提取 JSON、剥代码块围栏、Zod 校验
    ├── alerts/
    │   ├── types.ts           规则与事件结构
    │   ├── engine.ts          求值纯函数（含冷却期去抖）
    │   ├── worker.ts          常驻轮询：调度、取数、持久化、通知
    │   ├── store.ts           规则与事件落盘（data/alert-*.json，写串行化）
    │   └── notify/            通道可插拔：群机器人 / Telegram / 消息格式化
    ├── history/
    │   ├── types.ts           研判存档结构与各时间尺度的检验周期
    │   ├── store.ts           存档落盘（data/analyses.json，写串行化）
    │   ├── cache.ts           研判结果复用判定（省钱，见决策 7）
    │   └── evaluate.ts        到期评估、置信度校准、无脑基线对比
    ├── stores/watchlist.ts    自选（localStorage）
    ├── ws/binance-stream.ts   WebSocket（自动重连）
    └── hooks/
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

### 4. 供应商抽象：把"能不能连上"和"支不支持强校验"两件事分开

`providers/` 下每家供应商实现同一个接口，`runner.ts` 完全不知道背后是谁。
这层抽象不是为了好看，是被两个现实问题逼出来的：

- **网络可达性因地而异**：Anthropic 官方在中国大陆需要代理，
  DeepSeek 直连可达，中转站则因节点而异。用户必须能换。
- **只有 Anthropic 原生支持 structured outputs**。其余供应商走 `json_object` 模式，
  只保证"是合法 JSON"，字段对不对全靠 prompt 引导。
  所以有 `schema-prompt.ts`（注入格式说明）与 `json-repair.ts`
  （剥代码块围栏、抽出 JSON、Zod 校验，失败时带着具体字段错误重试一次）。

上层看到的始终是一个已经通过 Zod 校验的 `Analysis` 对象。

### 5. 规则引擎与 LLM 并存

`summary.ts` 里有一套透明的加权打分，输出 `bias` 和逐条 `reasons`。
它有两个作用：直接显示在指标面板上（不花钱、不延迟）；
作为 LLM 的输入之一，让模型有个可对照的基线。

用户能同时看到"规则怎么说"和"模型怎么说"，两者分歧时反而是有价值的信号。

**注意**：这套权重目前是凭经验拍的，没有数据支撑（见 `docs/ROADMAP.md` 第 7 项）。

### 6. 告警在服务端求值，浏览器只订阅

`engine.ts` 是一组纯函数（输入快照，输出事件），`worker.ts` 负责调度它。
两者分开，使得同一套判定逻辑既能被常驻进程调用，也能被单元测试直接喂数据。

三个容易踩的点，都已经踩过：

- **浏览器端求值必须彻底移除**。两边同时求值会重复触发、通知发两遍。
- **规则必须存服务端文件**。存 localStorage 的话常驻进程根本读不到——
  那这个功能就白做了。旧规则做了一次性自动迁移。
- **worker 状态挂 `globalThis`**。Next.js 把 instrumentation 与 API 路由
  编译进不同模块图，模块级变量在两边是各自独立的副本，
  会导致 `/api/alerts/status` 永远读到初始值、界面误报"未运行"。

代价：告警随服务进程存活，关掉终端就停。要 7×24 需用 pm2 常驻或部署到服务器。

### 7. 研判结果按波动率复用，而不是按固定时长

每次研判是一次真实付费调用（实测 23-95 秒）。`history/cache.ts` 按
(距上次研判时长 + 价格漂移 / 上次 ATR%) 判定是否复用上次结论。

两个关键点：

- 漂移阈值必须**相对标的自身波动率**换算。固定百分比会让低波动币几乎永远命中缓存、
  高波动币几乎永远不命中。
- 缓存判定放在拉 K 线**之前**，命中时把 3 次 K 线请求和 1 次 LLM 调用一并省掉；
  且**命中不写新存档**——同一次研判被计入准确率两次会污染回测数据。

### 8. 每次研判都存档，并自动回头检验

`history/` 把每次研判连同当时的价格与 ATR% 存下来，到期后拉真实行情自动评估。
设计上有两处刻意为之：

- **有效波动阈值由标的自身 ATR 推导**，不是固定百分比。
  否则高波动币会被判成"总是判断正确"（它总在大涨大跌）。
- **永远并排显示"无脑猜同一方向"的基线**。跑不赢基线的模型没有价值，
  这个对比必须自动摆在眼前，而不是等人想起来算。

置信度校准表（"模型说 80 分时实际对多少"）是这里最有价值的产出。

### 9. 宏观资讯与行业资讯分开存放

美联储数据（`datasources/macro.ts`）没有并进 `news.ts`，两者的 `NewsItem`
带 `category` 字段区分，接口也是分开的。原因是**更新频率差两个数量级**：
加密资讯每小时几十条，美联储讲话几周一条。合并成一个按时间倒序的列表后，
宏观信息会被永久挤到列表末尾并被 `slice` 截掉——接了等于没接。

界面上同理：宏观独立成一个标签页（"查"），行业资讯留在技术面下方（"刷"）；
只有政策利率与议息倒计时被提到图表下方的环境条，因为那是看盘时应该一直在余光里的东西。

**唯一一处 HTML 抓取**也在这个模块：美联储没有提供议息日历的结构化接口。
解析失败时返回空、界面显示"日历不可用"，不做硬编码兜底——
一个过期的议息日程比没有日程更危险。`scripts/test-fomc-parse.live.mjs` 拉真实页面校验解析结果
（`npm run test:live`）。

### 10. 数据源健康检查是一等公民

`/api/health` 和顶部状态条不是运维摆设。在受地区限制的网络下，
"某个源今天通不通"是真实会变的状态。图表空白时用户需要立刻知道
是网络、上游还是代码的问题。同一接口还会探测**服务端出口 IP 与国家**——
Node 的 fetch 默认不读 `HTTP_PROXY`，服务端很可能在用户毫不知情的情况下绕过 VPN 直连。

## 测试

```bash
npm test          # 离线，秒级返回
npm run test:live # 额外跑依赖真实网络的（拉美联储页面校验 HTML 解析）
```

`scripts/test-*.mjs` 会被 `scripts/test.mjs` 自动发现，无需登记；
文件名带 `.live.mjs` 的依赖外部网络，默认跳过但会在结果里列出来——
静默跳过的测试等于不存在的测试。失败以退出码非 0 表示。

没有引入 vitest/jest：这几个脚本各自只有几十行断言，装一整套框架属于过度设计。
但 tsx 是必需的——测试直接 import `src/` 下的 .ts 源码，
而源码内部用无扩展名的相对导入（`./http`），Node 原生的类型剥离处理不了这种解析。

覆盖的是三处「错了不会立刻被发现」的逻辑，而不是追求覆盖率：

| 脚本 | 覆盖什么 | 为什么值得测 |
|---|---|---|
| `test-cache.mjs` | 研判复用判定的 14 个边界 | 判错的后果是多花钱或用过期结论，两边都不会报错 |
| `test-webhook-sign.mjs` | 三家群机器人的加签与载荷 | 签名写错是静默失败：HTTP 200 但消息不出现 |
| `test-fomc-parse.live.mjs` | FOMC 日历 HTML 解析 | 页面改版后解析返回空，界面只会显示"暂无"，不会报错 |

加签那个测试刻意**按官方文档独立重写了一遍签名算法**去比对，
而不是调用被测代码自证——三家的 key/data、毫秒/秒、签名放 URL 还是放请求体
各不相同，正是最容易写反的地方。

## 数据存储

全部是 `data/` 下的 JSON 文件，不入库（`.gitignore` 已排除）：

| 文件 | 内容 | 写入方 |
|---|---|---|
| `analyses.json` | 研判存档与评估结果 | 研判接口、历史接口 |
| `alert-rules.json` | 告警规则 | 规则接口、worker（更新触发时间） |
| `alert-events.json` | 已触发事件 | worker |

单人本地工具，文件足够；上数据库属于过度设计。三个文件的写入都做了串行化——
Next.js 路由并发处理，worker 也在并发写，两边同时 read-modify-write 会丢数据。

## 成本

除 LLM 研判外，全部数据源免费无 Key。研判为手动触发（不自动轮询），
单次调用输入约 2-4K token，按 Claude Opus 5 定价约 $0.02-0.05/次；
命中缓存则为 0。
