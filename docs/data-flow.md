# 数据获取总流程

> 适用版本：`local-test-lab` v3.27.1615（Tauri 2 + Vue 3，LCU 客户端）
> 涉及窗口：`background`（后端宿主）、`mainWindow`（个人战绩）、`recentMatchWindow`（对局内分析面板）
> 数据来源：LCU HTTP API（`https://127.0.0.1:{app-port}`）、SGP 区域服务、本地 PostgreSQL 缓存、Live Client Data（`https://127.0.0.1:2999`）

下面这张 Mermaid 图汇总了「怎么拿到召唤师身份」「怎么拿到对局历史」「怎么拿到单局详情/对局内玩家」「怎么落到 PostgreSQL」四条主链路。

```mermaid
flowchart TB
    %% ===================== 节点样式 =====================
    classDef proc fill:#eef,stroke:#557,color:#113
    classDef fe   fill:#fff7e6,stroke:#b76,color:#532
    classDef be   fill:#e6f4ff,stroke:#246,color:#024
    classDef lcu  fill:#d6f5d6,stroke:#2a7,color:#040
    classDef ext  fill:#fde2e2,stroke:#a33,color:#411
    classDef db   fill:#f0e6ff,stroke:#639,color:#213
    classDef store fill:#fff,stroke:#999,color:#222

    %% ===================== 1. 客户端探测 =====================
    subgraph Boot["① 客户端启动 & 探测（Rust 侧）"]
        B1["process_info::get_auth_info<br/>sysinfo 读取 LeagueClientUx.exe<br/>解析 --app-port / --remoting-auth-token / --rso_platform_id<br/>Token 走 Base64(riot:)"]:::proc
        B2["shaco::rest::RESTClient<br/>reqwest + https://127.0.0.1:{port}<br/>static REST_CLIENT（OnceCell）"]:::be
        B3["listen_for_client_start<br/>3s 轮询 get_auth_info<br/>连接成功后向 background 推送<br/>'ClientStarted'"]:::be
        B4["listener::listen_client<br/>LcuWebsocketClient 订阅<br/>/lol-gameflow/v1/gameflow-phase<br/>实时转发 client_status 事件"]:::be
    end

    %% ===================== 2. 前端入口 =====================
    subgraph Background["② 后台窗口（background.ts）"]
        BG1["listen('client_status')<br/>+ listen('recoverGameWindow')"]:::fe
        BG2["handleClientStatus:<br/>ClientStarted → initLocalTestLab<br/>GameStart → GameFlow.initGameInWindow<br/>PreEndOfGame → 关闭面板、TaskTracker.completeTask"]:::fe
        BG3["GameFlow.writeGameInfo<br/>invokeLcu GET /lol-gameflow/v1/session<br/>写入 gameInfo / 启动对局内面板"]:::fe
    end

    %% ===================== 3. LCU 命令桥 =====================
    subgraph Bridge["③ 前端 ↔ Rust 命令桥"]
        F1["lcu/index.ts :: invokeLcu<br/>invoke('invoke_lcu', {method,uri,body})"]:::fe
        F2["lcu.rs :: invoke_lcu<br/>分发 GET/PATCH/POST/DELETE<br/>REST_CLIENT.get/post/…<br/>tracing 记录 duration_ms"]:::be
        F3["其它 tauri 命令:<br/>is_game_start、get_ingame_players<br/>listen_for_client_start、start_listener<br/>launch_lol、init_keyboard"]:::be
    end

    %% ===================== 4. 召唤师身份 =====================
    subgraph Sum["④ 召唤师身份 / 当前玩家"]
        S1["aboutSummoner.ts :: querySummonerInfo<br/>选择端点:<br/>• /lol-summoner/v1/current-summoner（默认）<br/>• /lol-summoner/v1/summoners?name=…<br/>• /lol-summoner/v1/summoners/{id}"]:::fe
        S2["返回 lcuSummonerInfo → 归一化为 summonerInfo<br/>（privacy, puuid, tagLine, name, currentId, lv, xp, imgUrl）"]:::fe
        S3["写入 localStorage['sumInfo']<br/>name / summonerId / puuid / platformId / newPlatformId<br/>（get_lol_region 异步补全 region）"]:::fe
    end

    %% ===================== 5. 历史战绩主链路 =====================
    subgraph History["⑤ 历史战绩拉取（LCU → SGP → 本地缓存）"]
        H1["入口:<br/>• queryMatch.vue → useMatchStore.init<br/>  └─ BaseMatch.gerSummonerInfo + dealMatchHistoryWithSource<br/>• recentMatch.vue → QueryMatch.queryMatchHistory<br/>• RecentAnalysis → queryMatchHistoryFullWithSource"]:::fe
        H2["aboutMatch.ts :: fetchMatchHistory(puuid, beg, end, full)<br/>去重 inFlightHistoryRequests<br/>按需 splitRequests（步长 20）"]:::proc
        H3["① 是当前召唤师?<br/>fetchCurrentSummonerMatchHistory<br/>GET /lol-match-history/v1/products/lol/current-summoner/matches"]:::lcu
        H4["② fetchSummonerMatchHistoryFromLcu<br/>GET /lol-match-history/v1/products/lol/{puuid}/matches<br/>hasParticipantRoster 校验完整十人"]:::lcu
        H5["③ SgpMatchHistoryService<br/>getMatchHistory / getFullMatchHistory<br/>tokenFetcher → GET /entitlements/v1/token<br/>Bearer 走 match-history-query SGP 区域服<br/>10s 超时 + 401 重试 + 内存缓存"]:::ext
        H6["来源标签:<br/>lcu-current / lcu-puuid / sgp / mixed<br/>同时记录 endpoints 明细（接口路径）<br/>主页当前用户后台逐页回填，最多 20 页，命中缓存页停止"]:::proc
    end

    %% ===================== 6. PostgreSQL 缓存层 =====================
    subgraph Cache["⑥ PostgreSQL 本地缓存（tokio-postgres）"]
        C1["database.rs :: DatabaseState::initialize<br/>连接 postgres://lol:helper@127.0.0.1/lol<br/>建表 matches / match_participants / match_players<br/>超时 3s、记录 status（available/message）"]:::db
        C2["Tauri 命令:<br/>• cache_match_history(request)<br/>  单事务 + jsonb_to_recordset 展开<br/>• get_cached_match_history({puuid, modeKey?, queueId?, limit, offset})<br/>• database_summary / get_cached_player_summary<br/>• database_status"]:::db
        C3["databaseCache.ts<br/>invoke('cache_match_history' / 'get_cached_match_history')<br/>前端拿到 NormalizedHistoryGame[]<br/>mergeHistoryGames（recentAnalytics.ts）合并缓存 + 服务器"]:::fe
    end

    %% ===================== 7. 单局详情 / 对局内玩家 =====================
    subgraph Detail["⑦ 单局详情 & 对局内玩家"]
        D1["MatchDetails.queryGameDetail(gameId, sumId, sumPuuid)<br/>命中顺序:<br/>① SGP 内存缓存 getCachedSgpMatch<br/>② LCU 内存缓存 getCachedLcuMatch<br/>③ GET /lol-match-history/v1/games/{gameId}"]:::proc
        D2["getSgpParticipantsDetails / getParticipantsDetails<br/>拼装 5v5 ParticipantsInfo（KDA、装备、伤害、视野、MVP）<br/>斗魂竞技场 queueId=1700 走 getFighterParticipantsDetails"]:::proc
        D3["recentMatch.vue → QuerySummoner.fromLcuQuery<br/>循环 GET /lol-gameflow/v1/session<br/>• hydrateMissingTeam 用 playerChampionSelections 补齐<br/>• queryLiveTeams → invoke('get_ingame_players')<br/>  └─ IngameClient::player_list https://127.0.0.1:2999"]:::fe
        D4["is_game_start（IngameClient::active_game_loadingscreen）<br/>GameFlow 轮询至 true 再 RecentMatchWindow.ensure"]:::be
    end

    %% ===================== 8. 持久化与展示 =====================
    subgraph UI["⑧ 数据展示"]
        U1["mainWindow / queryMatch.vue<br/>tabs: matches（matchMain） / analytics（historyAnalyticsPanel）<br/>最近 20 场缓存 + 服务器前 60 场 + 分页"]:::fe
        U2["recentMatchWindow / recentMatch.vue<br/>Dashboard + friend/enemy 双列<br/>顶部 winCount 即时统计 + 开黑关系图"]:::fe
    end

    %% ===================== 关系连线 =====================
    B1 --> B2
    B1 --> B3
    B3 -- "ClientStarted 事件" --> BG1
    B4 -- "WebSocket gameflow-phase<br/>GameStart/PreEndOfGame/…" --> BG1
    BG1 --> BG2
    BG2 -- "GameStart" --> BG3
    BG3 -- "invokeLcu('get', '/lol-gameflow/v1/session')" --> F1
    BG3 -- "is_game_start" --> F4["is_game_start (Rust)"]:::be
    BG3 -- "get_ingame_players" --> F5["get_ingame_players (Rust)"]:::be
    F1 -- "invoke('invoke_lcu', …)" --> F2
    F2 -- "https://127.0.0.1:{port}" --> B2

    S1 --> F1
    F1 -- "raw lcuSummonerInfo" --> S2
    S2 --> S3

    H1 --> H2
    H2 --> H3
    H3 -- "未命中/非当前玩家" --> H4
    H4 -- "人数不足或失败" --> H5
    H3 -- "命中" --> H6
    H4 -- "命中" --> H6
    H5 -- "命中" --> H6

    H6 -- "来源 + games[]" --> C3
    C3 -- "cache_match_history" --> C2
    C2 --> C1
    C3 -- "get_cached_match_history" --> C2
    H6 -- "写入 RecentSumInfo.historyStatus" --> U2

    S3 -- "sumInfo.localStorage" --> H1
    S3 --> U1

        H6 -- "最近 20 场 + 服务器三页；当前用户后台最多补齐 20 页" --> U1
    H6 -- "玩家级 modeKey 数据" --> U2

    D3 -- "get_ingame_players" --> F5
    F5 -- "https://127.0.0.1:2999/playerlist" --> D4
    D3 --> U2
    U1 -- "点击单场 → queryMatchDetail(gameId)" --> D1
    U2 -- "点击单场 → MatchDetails.queryGameDetail" --> D1
    D1 --> D2
    D2 --> U1
    D2 --> U2

    %% ===================== 旁路：事件总线 =====================
    BG2 -. "emitTo('mainWindow', 'initHome' / 'clientStatus')" .-> U1
    BG2 -. "emitTo('background', 'recoverGameWindow')" .-> BG1
```

## 关键说明

1. **唯一真实数据源是本机 LCU**。所有调用最终都落到 `https://127.0.0.1:{app-port}`，由 `shaco/rest.rs` 里的 `RESTClient` 统一封装；`invoke_lcu` 是唯一的 Rust 命令桥，Vue 端任何 `invokeLcu(...)` 都通过它落地。
2. **SGP 是区域服务的备胎**。`sgpMatch.ts` 在 LCU 历史接口拿不到（外部召唤师或返回残缺）时启用，前置条件是 `GET /entitlements/v1/token` 取 entitlements token。SGP 同时承担「单局详情」的兜底——`MatchDetails` 优先复用 `matchCache`，避免再次请求。
3. **PostgreSQL 只做缓存，不做权威源**。`DatabaseState::initialize` 在 Tauri 启动期建表，前端常规分析用 `cacheHistory` 写入最近三页；主页当前用户的后台同步会逐页写入，最多扫描 20 页，命中已缓存整页后停止。`getCachedHistory` 按 `puuid + modeKey` 读回，再由 `mergeHistoryGames`（`recentAnalytics.ts`）按 `gameId` 与服务器结果合并去重。
4. **对局内玩家 = gameflow session ∪ Live Client Data**。`QuerySummoner` 先用 `/lol-gameflow/v1/session`，缺人时再用 `get_ingame_players`（`IngameClient::player_list`，端口 2999）补齐；面板打开前还会用 `is_game_start`（`/Help` HEAD 探测）确认已进入对局。
5. **WebSocket 只负责状态机**。`listener.rs` 订阅 `/lol-gameflow/v1/gameflow-phase`，把 `phase` 推到 `background`，由 `handleClientStatus` 决定开/关 `recentMatchWindow`、刷新主窗口 `clientStatus`、触发 `TaskTracker` 结算等动作，本身不返回任何业务数据。
