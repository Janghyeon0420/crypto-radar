# 数据源与网络可达性评估

> 本文档是这个项目最重要的设计依据。所有数据源选型都来自下面的实测，
> 而不是文档上写的"应该可以"。

## 背景约束

- 使用者的 VPN **只能走美国线路**
- 币安（Binance）**对美国 IP 做地理封锁**
- 使用者的实际交易在币安进行，因此行情数据最好与币安盘口一致

这个组合看起来是死结：需要币安的数据，但连不上币安。下面的实测给出了解法。

## 实测结果

测试时间：2026-08-19，出口 IP 为美国线路。

### 币安相关域名

| 域名 | 协议 | 结果 | 说明 |
|---|---|---|---|
| `api.binance.com` | REST | ❌ **HTTP 451** | 地理封锁，明确拒绝 |
| `api1.binance.com` | REST | ❌ HTTP 451 | 备用域名同样封锁 |
| `fapi.binance.com`（合约） | REST | ❌ HTTP 451 | 合约接口封锁 |
| `stream.binance.com:9443` | WebSocket | ❌ 连接超时 | 实时流封锁 |
| **`data-api.binance.vision`** | REST | ✅ **HTTP 200** | **可用** |
| **`data-stream.binance.vision`** | WebSocket | ✅ **成功收到实时推送** | **可用** |
| `api.binance.us` | REST | ✅ HTTP 200 | 可用但为独立交易所，币种/深度/价格与主站不同 |

### `*.binance.vision` 是什么

这是币安官方对外提供的**公开市场数据镜像**，不做地理封锁。它的数据来自与主站相同的撮合引擎，
因此 K 线、盘口、成交价与你在币安 App 上看到的完全一致。

已验证可用的端点：

```
GET /api/v3/klines        # K 线      ✅
GET /api/v3/ticker/24hr   # 24h 行情  ✅
GET /api/v3/depth         # 订单簿    ✅
GET /api/v3/aggTrades     # 逐笔成交  ✅
GET /api/v3/exchangeInfo  # 交易对    ✅ 484 个 USDT 交易对
WS  /stream?streams=...   # 实时推送  ✅
```

**边界（重要）**：

- ❌ **没有任何私有/签名端点**。`/api/v3/account` 返回 404。查余额、查持仓、下单一律不可能。
- ❌ **没有合约端点**。`/fapi/*` 返回 404，资金费率和持仓量必须另找数据源。

这两条边界直接决定了本项目的定位：**纯只读行情看板，不接账户、不下单**。

### 其它交易所与数据源

| 数据源 | 用途 | 结果 |
|---|---|---|
| **OKX** (`www.okx.com`) | 永续合约资金费率、持仓量 | ✅ HTTP 200 |
| Bybit (`api.bybit.com`) | 备选衍生品源 | ❌ HTTP 403，同样封锁美国 |
| Coinbase | 备选现货源 | ✅ HTTP 200 |
| Kraken | 备选现货源 | ✅ HTTP 200 |
| **alternative.me** | 恐惧贪婪指数 | ✅ HTTP 200 |
| **Cointelegraph RSS** | 资讯 | ✅ HTTP 200 |
| **Decrypt / CoinDesk RSS** | 资讯 | ✅ 可用 |
| **币安公告 RSS** | 上币/下架公告 | ✅ HTTP 202 |
| CoinGecko | 币种基本面、市值 | ⚠️ 间歇可用，免费额度限流严格 |
| CryptoPanic | 资讯聚合 | ❌ HTTP 403（需注册 token） |

### 美联储（宏观）

补测于 2026-08-20，**出口为中国大陆直连**（未走代理）。
这批源是本项目里少见的「大陆直连比走代理更顺」的一类：

| 数据源 | 用途 | 结果 |
|---|---|---|
| **federalreserve.gov** `/feeds/press_monetary.xml` | 货币政策新闻稿（FOMC 声明、纪要） | ✅ HTTP 200，1.25s |
| **federalreserve.gov** `/feeds/speeches.xml` | 官员讲话 | ✅ HTTP 200，1.50s |
| **federalreserve.gov** `/feeds/testimony.xml` | 国会证词 | ✅ HTTP 200 |
| **federalreserve.gov** `/monetarypolicy/fomccalendars.htm` | 议息日历（HTML，无结构化接口） | ✅ HTTP 200，1.85s |
| **markets.newyorkfed.org** `/api/rates/unsecured/effr/last/1.json` | EFFR + 当前目标区间 | ✅ HTTP 200，1.34s |

同一时刻同一条线路上 OKX 超时、币安主站超时——也就是说**宏观这条线和衍生品那条线
需要的网络路径正好相反**，和中转站与 OKX 的关系一样（见下文 NO_PROXY 一节）。
好在美联储的源全部免费无 Key，且都是低频数据，本项目对它们做了 10 分钟到 12 小时不等的缓存，
真的走了代理导致变慢也不至于影响使用。

两个选型说明：

- **不用 `press_all.xml`**（全部新闻稿）。里面大部分是银行监管处罚、支付系统公告，
  与市场无关，混进来只会稀释真正重要的利率决议与讲话。
- **议息日历只能抓 HTML**。美联储没有提供日历的结构化接口，
  FRED 有利率历史但需要注册 key、且不含未来会议日程。
  抓 HTML 的代价是页面改版即失效，所以解析失败时界面显示「日历不可用」，
  **不做硬编码兜底**——一个过期的日程比没有日程更危险。

## 最终选型

```
现货行情 + K 线 + 实时推送  →  data-api / data-stream.binance.vision   （与币安盘口一致）
永续合约资金费率 + 持仓量    →  OKX 公开接口                            （币安 fapi 不可达）
市场情绪                    →  alternative.me 恐惧贪婪指数
资讯                        →  Cointelegraph / Decrypt / CoinDesk / 币安公告 RSS
宏观（美联储）              →  federalreserve.gov RSS + 议息日历 / 纽约联储 EFFR 接口
```

**结论：在美国 VPN 下，这套方案不需要任何代理服务器、不需要非美国 VPS、不需要 API Key。**

AI 研判的供应商可自由选择（见 `.env.example`）。若选用 **DeepSeek**，
其 API 在中国大陆直连可达（实测 HTTP 401，即网络通、仅缺 key），
则整个项目**只有 OKX 衍生品一项需要代理**；若这项也可接受降级，
则全链路无需任何代理。

## ⚠️ 关键：Node.js 默认不走你的 VPN

这是本项目最容易踩、也最容易误判的一个坑，务必读完。

**现象**：看板的行情、K 线、资讯都正常，但 OKX 衍生品数据和 AI 研判一直失败。

**原因**：Node.js 的内置 `fetch` **默认不读取 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量**。
如果你的 VPN 客户端（Clash / Veee / 银河云等）是以本地代理端口的方式工作，
而不是系统级 TUN 全局接管，那么 Next.js 服务端发出的所有请求都会**绕过 VPN 直连**。

实测对比（同一台机器、同一时刻）：

| 出口路径 | 出口 IP | 归属 | OKX | 币安主站 |
|---|---|---|---|---|
| Node 默认（不读代理） | `（家宽 IP，已脱敏）` | 🇨🇳 中国（家宽直连） | ❌ 超时 | ❌ 超时 |
| `NODE_USE_ENV_PROXY=1` | `（VPN 节点 IP，已脱敏）` | 🇺🇸 美国（VPN 节点） | ✅ 200 | ❌ **451** |

注意两种失败的区别：直连时是**超时**（被 GFW 静默丢弃），走 VPN 时是**干净的 451**
（币安明确告知地理封锁）。这个差异本身就是判断"请求到底从哪出去"的可靠依据。

**解决**：`npm run dev` 和 `npm start` 已内置 `NODE_USE_ENV_PROXY=1`（Node 24+ 支持）。
你只需在启动时提供代理地址：

```bash
HTTPS_PROXY=http://127.0.0.1:7890 npm run dev
```

把 `7890` 换成你的 VPN 客户端实际监听的本地 HTTP/混合端口
（Clash 系默认 7890；Veee / 银河云的官方客户端请在设置里查看，
或用 `lsof -nP -iTCP -sTCP:LISTEN | grep -i -E "clash|veee|proxy"` 找）。

未设置 `HTTPS_PROXY` 时该开关无副作用，等同直连——所以这个默认值是安全的。

**如何确认生效**：看板顶部状态条会直接显示服务端出口国家。
状态条显示「出口 US · ⋯」说明走了 VPN；显示「出口 CN · ⋯ 未走代理」说明没走。
也可以命令行确认：

```bash
npm run netcheck          # 直连出口体检
npm run netcheck:proxy    # 经代理出口体检（需已设 HTTPS_PROXY）
```

### 一个反直觉但重要的发现

`data-api.binance.vision` **从中国大陆直连也可用**（实测 200，585ms，比走美国 VPN 还快）。
也就是说本看板最核心的行情数据其实**完全不依赖 VPN**。真正需要走代理的只有：

| 数据源 | 大陆直连 | 需要代理 |
|---|---|---|
| binance.vision 行情（核心） | ✅ 可用且更快 | 不需要 |
| 恐惧贪婪指数 | ✅ | 不需要 |
| Cointelegraph 资讯 | ✅ | 不需要 |
| OKX 衍生品 | ❌ 超时 | ✅ 需要 |
| **DeepSeek API** | ✅ 可用 | 不需要 |
| **OpenAI 格式中转站** | ✅ 可用且更快 | 视节点而定，见下节 |
| Anthropic API（官方） | ❌ 403 | ✅ 需要 |
| 币安主站（交易用） | ❌ | ✅ 且必须**非美国**节点 |

## 中转站与 OKX 的分流：NO_PROXY

中转站与 OKX 的网络需求方向相反，这决定了不能用一个全局 `HTTPS_PROXY` 打天下：

| 目标 | 直连 | 经美国节点代理 |
|---|---|---|
| OKX 衍生品 | ❌ 超时（GFW） | ✅ 200 |
| 中转站（LLM 研判） | ✅ 200，1.5 秒 | **因节点而异**，见下 |

关于中转站走代理，两次实测结果不同，值得记下来：

- 某美国节点：`CONNECT_TIMEOUT`，完全不通
- 另一美国节点：`200`，2.4 秒（比直连的 1.5 秒慢）

**结论：中转站经代理是否可用取决于具体节点，不是绝对不能走代理。**
但直连在两种情况下都可用且更快，所以仍建议用 `NO_PROXY` 把它排除出去——
这样既拿到更低延迟，也不会在换节点后突然失效。

Node 的 `NODE_USE_ENV_PROXY`（`npm run dev` 已内置）支持 `NO_PROXY` 做域名级排除：

```bash
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1,你的中转站域名 \
npm run dev
```

这样 OKX 走代理、中转站走直连，两者同时可用。

**DeepSeek 同理**，它直连可达且更快，也应加进 `NO_PROXY`。

> 代理端口会随客户端版本或重装而变。若某天全部数据源突然都不通，
> 先用 `lsof -nP -iTCP -sTCP:LISTEN | grep 127.0.0.1` 确认当前端口，
> 再用 `npm run netcheck` 与 `npm run netcheck:proxy` 对比排查。

## 双 VPN（美国 + 非美国）节点方案

如果你同时装了两个 VPN（如 Veee 与银河云），**不要试图同时运行两个客户端**——
它们会争抢系统默认路由和 TUN 接口，结果通常是后连上的那个覆盖前一个，或者路由直接错乱。
这是操作系统层面的限制，不是产品缺陷。

**正确做法：一个规则分流客户端 + 两份订阅。**

1. 用一个 Clash 系客户端统一管理（macOS 上推荐 Clash Verge Rev 或 Stash）
2. 把两家的订阅链接都导入，得到一个包含美国与非美国节点的总节点池
3. 建两个策略组：`美国节点` 和 `非美国节点`（日本/新加坡/香港）
4. 配置分流规则：

```yaml
rules:
  # 币安交易必须走非美国节点，否则 451
  - DOMAIN-SUFFIX,binance.com,非美国节点
  - DOMAIN-SUFFIX,binancezh.com,非美国节点
  # 本看板行情源直连最快，且不受地区限制
  - DOMAIN-SUFFIX,binance.vision,DIRECT
  # 这两个大陆直连不通，任意海外节点即可
  - DOMAIN-SUFFIX,okx.com,非美国节点
  - DOMAIN-SUFFIX,anthropic.com,美国节点
  # LLM 中转站与 DeepSeek 直连最快，走代理反而超时
  - DOMAIN-SUFFIX,deepseek.com,DIRECT
  # - DOMAIN-SUFFIX,你的中转站域名,DIRECT
  # 需要美国出口的服务放这里
  # - DOMAIN-SUFFIX,example-us-only.com,美国节点
  - GEOIP,CN,DIRECT
  - MATCH,非美国节点
```

这样美国与非美国出口是**按域名同时生效**的，不需要来回切换。

**前提**：两家服务都能导出订阅链接（Clash / v2ray 格式）。部分服务只提供封闭的官方客户端、
不给订阅链接，那就无法合并。请先在各自的用户后台确认是否有「订阅地址」或「导入到第三方客户端」选项。

**如果某一家确实不给订阅链接**，退而求其次：让那家的官方客户端跑在**非全局/分流模式**下
（只接管它自己需要的域名），另一家用 Clash 接管其余流量；
或者干脆让看板单独走其中一个代理——本项目的代理是通过 `HTTPS_PROXY` 传入的，
**与系统 VPN 相互独立**，你完全可以让浏览器走 A 节点、看板服务端走 B 节点。

**验证方法**：切到每个节点后各跑一次，用实测数据而不是推测来决定分流规则：

```bash
npm run netcheck:proxy
```

脚本会打印出口 IP、归属地，以及每个数据源的通断，并直接告诉你
「这是一个非美国节点，可用于币安交易」还是「这是一个受限（美国）节点」。

## 如果将来要接账户或下单

镜像域名做不到，必须自建代理，路径如下：

1. 在**非美国**地区租一台 VPS（日本、新加坡、韩国均可）
2. 在 VPS 上跑一个只转发币安签名请求的极简代理服务
3. 在币安 API Key 设置中**绑定该 VPS 的固定 IP 白名单**
4. 本项目的服务端通过该代理访问 `api.binance.com`
5. API Key 只存在于 VPS 与本项目服务端的环境变量中，**绝不下发到浏览器**

风险提示：这条路径涉及资金安全，请只授予实际需要的权限（能只读就不要开交易权限），
并确认这样使用符合币安的服务条款和你所在地的法规。
