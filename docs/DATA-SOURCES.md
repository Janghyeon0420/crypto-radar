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

## 最终选型

```
现货行情 + K 线 + 实时推送  →  data-api / data-stream.binance.vision   （与币安盘口一致）
永续合约资金费率 + 持仓量    →  OKX 公开接口                            （币安 fapi 不可达）
市场情绪                    →  alternative.me 恐惧贪婪指数
资讯                        →  Cointelegraph / Decrypt / CoinDesk / 币安公告 RSS
```

**结论：在美国 VPN 下，这套方案不需要任何代理服务器、不需要非美国 VPS、不需要 API Key。**

## 一个已知的环境差异

开发环境的沙箱把出站流量强制走本地代理（`HTTP_PROXY=127.0.0.1:15236`）。
`curl` 会读取该环境变量，但 Node.js 的 `fetch`（undici）**默认不读代理环境变量**，
于是在沙箱内 Node 直连 `www.okx.com` 时 DNS 被解析到 `169.254.0.2` 而失败（`EHOSTUNREACH`）。

**这是开发沙箱的产物，不是你的网络问题。** 在你自己的终端直接跑 `npm run dev` 时，
Node 走正常 DNS，OKX 应当可达。启动后用这条命令确认：

```bash
curl -s http://localhost:3000/api/health | python3 -m json.tool
```

看板顶部的数据源状态条也会实时显示每个源的通断。其中「币安主站」是**故意保留的对照探针**，
显示为灰色「已封锁·符合预期」才是正确状态——它证明封锁真实存在，而镜像方案确实绕过了它。

## 如果将来要接账户或下单

镜像域名做不到，必须自建代理，路径如下：

1. 在**非美国**地区租一台 VPS（日本、新加坡、韩国均可）
2. 在 VPS 上跑一个只转发币安签名请求的极简代理服务
3. 在币安 API Key 设置中**绑定该 VPS 的固定 IP 白名单**
4. 本项目的服务端通过该代理访问 `api.binance.com`
5. API Key 只存在于 VPS 与本项目服务端的环境变量中，**绝不下发到浏览器**

风险提示：这条路径涉及资金安全，请只授予实际需要的权限（能只读就不要开交易权限），
并确认这样使用符合币安的服务条款和你所在地的法规。
