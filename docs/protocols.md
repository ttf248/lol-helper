# 项目使用的协议与接口

本文说明项目当前使用的英雄联盟相关接口、网络协议以及应用内部通信方式。

## 结论

- **LCU** 是 League Client 本机接口。它由官方 League Client 提供，但 Riot 不把它作为面向第三方开发者的稳定、正式支持 API。
- **SGP** 是 Riot 游戏服务使用的区域战绩服务接口。项目将它作为 LCU 战绩接口的补充和备用数据源；它不是 Riot Developer Portal 中的标准公共 API。
- **Live Client Data API** 是 Riot 官方文档化的本机游戏内数据接口，运行在 `127.0.0.1:2999`。
- 项目没有使用典型的 Riot Developer API，例如 `https://{region}.api.riotgames.com`，也没有使用 Riot API Key。
- HTTP/HTTPS、WebSocket、Tauri IPC 和 PostgreSQL 是承载项目功能的通信机制；它们不是 LCU 或 SGP 本身。

## 1. LCU

### 1.1 定义

LCU 通常指 **League Client Update API**，即 League Client 提供的本机接口。

项目启动后读取 `LeagueClientUx.exe` 的命令行参数，获取：

- `--app-port`：LCU 动态端口；
- `--remoting-auth-token`：LCU 认证 Token；
- `--rso_platform_id`：客户端平台/大区信息。

随后通过 HTTPS 请求本机地址：

```text
https://127.0.0.1:{app-port}
```

认证信息由 Rust 后端读取和封装，前端通过 Tauri command 调用 Rust 后端，不直接处理 LCU Token。

### 1.2 项目使用的 LCU REST 接口

项目中使用的主要路径包括：

```text
GET /lol-summoner/v1/current-summoner
GET /lol-summoner/v1/summoners
GET /lol-summoner/v1/summoners/{id}

GET /lol-match-history/v1/products/lol/current-summoner/matches
GET /lol-match-history/v1/products/lol/{puuid}/matches
GET /lol-match-history/v1/games/{gameId}

GET /lol-gameflow/v1/session
GET /entitlements/v1/token
```

其中：

- `lol-summoner` 用于召唤师身份和资料查询；
- `lol-match-history` 用于当前用户、指定 PUUID 的历史战绩和单局详情；
- `lol-gameflow` 用于获取当前游戏流程状态；
- `entitlements` 用于获取访问 SGP 所需的 Token。

代码位置：

- [src-tauri/src/shaco/rest.rs](../src-tauri/src/shaco/rest.rs)：LCU HTTPS REST 客户端；
- [src/lcu/aboutMatch.ts](../src/lcu/aboutMatch.ts)：战绩相关路径；
- [src/lcu/aboutSummoner.ts](../src/lcu/aboutSummoner.ts)：召唤师相关路径；
- [src-tauri/src/shaco/utils/process_info.rs](../src-tauri/src/shaco/utils/process_info.rs)：读取客户端进程参数。

### 1.3 LCU WebSocket

项目通过 LCU WebSocket 订阅：

```text
/lol-gameflow/v1/gameflow-phase
```

它主要用于监听客户端状态变化，例如游戏开始、游戏结束或流程阶段变化。WebSocket 本身只负责事件通知，业务数据仍通过 LCU REST 接口查询。

代码位置：

- [src-tauri/src/shaco/ws.rs](../src-tauri/src/shaco/ws.rs)：LCU WebSocket 客户端；
- [src-tauri/src/lcu/listener.rs](../src-tauri/src/lcu/listener.rs)：订阅和重连逻辑。

### 1.4 LCU 是否是官方开放 API？

准确说法是：

> LCU 是 Riot 官方客户端提供的本机接口，但不是面向第三方开发者正式承诺稳定性和支持的公共 API。

Riot 官方文档将 League Client API 描述为客户端本地使用的接口，并明确说明：

- 不提供完整文档保证；
- 不保证服务持续可用；
- 不保证变更通知；
- 不为第三方应用提供额外支持。

因此，项目依赖 LCU 时需要接受客户端升级导致接口路径、字段或行为变化的风险。

官方说明：[Riot League of Legends Developer Documentation](https://developer.riotgames.com/docs/lol)

## 2. SGP

### 2.1 定义

项目中的 SGP 指 Riot 游戏服务使用的区域战绩服务接口。它不是一种独立的传输协议；实际传输仍然是 HTTPS/HTTP，SGP 更准确地说是一个内部服务或接口体系。

项目使用的主要路径是：

```text
/match-history-query/v1/products/lol/player/{puuid}/SUMMARY
```

区域服务器配置在：

- [src/resources/areaList.ts](../src/resources/areaList.ts)

服务器形式包括：

```text
https://xxx-sgp.lol.qq.com:21019
https://xxx.sgp.pvp.net
```

完整请求地址由区域基础地址和上述路径组合得到。

### 2.2 SGP 的认证方式

项目先通过 LCU 请求：

```text
GET /entitlements/v1/token
```

随后使用返回的 Token 请求 SGP，并携带：

```http
Authorization: Bearer <token>
x-akari-token-type: entitlements
Accept: application/json
```

代码位置：

- [src/lcu/sgpMatch.ts](../src/lcu/sgpMatch.ts)：SGP 战绩请求、Token 缓存和 401 重试；
- [src-tauri/src/lcu.rs](../src-tauri/src/lcu.rs)：Rust 侧 SGP HTTPS 请求代理和域名/路径限制；
- [src/lcu/aboutMatch.ts](../src/lcu/aboutMatch.ts)：LCU 与 SGP 数据源选择。

### 2.3 SGP 在项目中的用途

SGP 是 LCU 战绩查询的补充数据源，主要用于：

- LCU 无法查询其他召唤师时的战绩查询；
- LCU 返回的对局参与者不完整时的补充；
- 获取完整的对局摘要和参与者信息；
- LCU 单局详情不可用时的备用查询。

项目中的数据源优先级和回退逻辑见：[docs/data-flow.md](data-flow.md)。

### 2.4 SGP 是否是官方开放 API？

SGP 确实属于 Riot 游戏服务体系，但当前项目调用的 `match-history-query` 接口：

- 不属于 Riot Developer Portal 的标准公共 API；
- 没有面向第三方开发者的稳定性承诺；
- 依赖本机 League Client 提供的 entitlements Token；
- 可能随着客户端或区域服务升级发生变化。

因此不应将 SGP 描述为“Riot 官方开放开发者 API”。更准确的描述是：

> 项目通过客户端已有的认证信息访问 Riot 区域战绩服务，将 SGP 作为 LCU 的内部/备用数据源。

## 3. Live Client Data API

### 3.1 定义

Live Client Data API 是游戏客户端提供的本机接口，固定运行在：

```text
https://127.0.0.1:2999
```

项目使用的路径包括：

```text
/GetLiveclientdataAllgamedata
/Help
/GetLiveclientdataActiveplayer
/GetLiveclientdataPlayerlist
/GetLiveclientdataGamestats
/GetLiveclientdataEventdata
/GetLiveclientdataPlayeritems
/GetLiveclientdataPlayermainrunes
/GetLiveclientdataPlayerscores
/GetLiveclientdataPlayersummonerspells
```

代码位置：

- [src-tauri/src/shaco/ingame.rs](../src-tauri/src/shaco/ingame.rs)

### 3.2 与 LCU 的区别

| 项目 | LCU | Live Client Data API |
| --- | --- | --- |
| 服务对象 | League Client | 正在运行的游戏客户端 |
| 地址 | `127.0.0.1:{动态端口}` | `127.0.0.1:2999` |
| 主要数据 | 召唤师、战绩、客户端状态 | 当前对局玩家、装备、符文、事件 |
| 使用时机 | 客户端已启动并登录 | 正在进行游戏或加载游戏 |
| 官方文档 | Riot 明确说明不对第三方正式支持 | Riot 提供 Live Client Data 文档 |

Riot 官方文档提供了 Live Client Data API 的用途、端点和本地 OpenAPI/Swagger 地址：[Game Client API / Live Client Data API](https://developer.riotgames.com/docs/lol)

## 4. 项目内部通信机制

### 4.1 Tauri IPC

Vue 页面和 Rust 后端之间使用 Tauri IPC：

```text
Vue 页面
  -> invoke("invoke_lcu", ...)
  -> Rust command
  -> LCU / SGP / Live Client Data
```

前端还通过 `emit`、`listen` 接收客户端启动、游戏流程和窗口状态事件。

Tauri IPC 不是英雄联盟协议，而是本项目桌面应用内部的前后端通信机制。

相关说明：[docs/architecture.md](architecture.md)

### 4.2 PostgreSQL 协议

项目使用本机 PostgreSQL 保存缓存数据：

```text
postgres://lol:helper@127.0.0.1/lol
```

缓存内容包括：

- 对局历史；
- 对局参与者；
- 召唤师信息；
- LCU/SGP 原始 JSON 数据；
- 英雄详情和对局内玩家快照。

PostgreSQL 只是本地缓存，不是权威数据源。权威数据仍来自 LCU、SGP 或 Live Client Data。

代码位置：[src-tauri/src/database.rs](../src-tauri/src/database.rs)

## 5. 其他外部 HTTP 服务和静态资源

项目还会访问以下外部资源：

| 地址或服务 | 用途 | 类型 |
| --- | --- | --- |
| `http://121.40.58.64:8412` | 黑名单/举报相关查询 | 外部 HTTP 服务 |
| `https://game.gtimg.cn` | 英雄、技能、装备等资源 | 静态资源/数据服务 |
| `https://wegame.gtimg.com` | 头像等资源 | 静态资源服务 |
| `https://raw.communitydragon.org` | 英雄图标等资源 | 社区静态资源服务 |

这些服务不属于 LCU 或 SGP，也不属于 Riot Developer API 的标准调用链。

主要代码位置：

- [src/main/utils/request.ts](../src/main/utils/request.ts)
- [src/lcu/utils.ts](../src/lcu/utils.ts)
- [src/recentMatch/recentMatch.vue](../src/recentMatch/recentMatch.vue)

## 6. 总体通信链路

```text
Vue / WebView
    |
    | Tauri IPC
    v
Rust 后端
    |
    +-- HTTPS REST --> LCU（127.0.0.1:动态端口）
    |
    +-- WebSocket ---> LCU gameflow 事件
    |
    +-- HTTPS REST --> SGP 区域战绩服务
    |
    +-- HTTPS REST --> Live Client Data（127.0.0.1:2999）
    |
    +-- PostgreSQL --> 本地缓存
    |
    +-- HTTP/HTTPS ---> 外部黑名单和静态资源服务
```

## 7. 维护和合规注意事项

1. LCU 和 SGP 都应视为客户端内部接口，不能假设版本兼容性。
2. 客户端更新后，应重点检查 LCU 端口参数、认证方式、接口路径和响应字段。
3. SGP Token 属于敏感认证信息，不应写入日志或暴露给前端页面以外的组件。
4. 项目如果面向其他玩家发布，需根据 Riot 当前 Developer Portal 政策登记和评估产品用途。
5. Riot 的公共开发者 API 与 LCU/SGP 是不同产品体系，不能因为 LCU/SGP 由 Riot 服务提供，就将它们描述为公共 API。

