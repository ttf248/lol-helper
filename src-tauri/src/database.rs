use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::{Mutex, RwLock};
use tokio_postgres::{Client, NoTls};

pub const DATABASE_URL: &str =
    "postgres://lol:helper@127.0.0.1/lol?sslmode=disable";

/// 始终只打印 puuid 末 8 位，避免完整 puuid 进入日志。
/// 开发环境不再调用此函数（直接打印 puuid 原值，便于排错）。
/// 函数保留以备生产环境回滚后复用。
#[allow(dead_code)]
fn mask_puuid(puuid: &str) -> String {
    if puuid.is_empty() {
        return String::new();
    }
    let len = puuid.chars().count();
    if len <= 8 {
        return puuid.to_string();
    }
    let tail: String = puuid
        .chars()
        .rev()
        .take(8)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    format!("…{tail}")
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS match_players (
    puuid TEXT PRIMARY KEY,
    summoner_id BIGINT,
    summoner_name TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS matches (
    game_id BIGINT PRIMARY KEY,
    queue_id INTEGER NOT NULL,
    mode_key TEXT NOT NULL,
    game_creation BIGINT NOT NULL,
    source TEXT NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS match_participants (
    game_id BIGINT NOT NULL REFERENCES matches(game_id) ON DELETE CASCADE,
    puuid TEXT NOT NULL,
    summoner_id BIGINT,
    summoner_name TEXT,
    team_id INTEGER NOT NULL,
    champion_id INTEGER NOT NULL,
    position TEXT NOT NULL,
    kills INTEGER NOT NULL DEFAULT 0,
    deaths INTEGER NOT NULL DEFAULT 0,
    assists INTEGER NOT NULL DEFAULT 0,
    win BOOLEAN NOT NULL,
    PRIMARY KEY (game_id, puuid)
);

CREATE INDEX IF NOT EXISTS idx_matches_mode_time
    ON matches(mode_key, game_creation DESC);
CREATE INDEX IF NOT EXISTS idx_matches_queue_time
    ON matches(queue_id, game_creation DESC);
CREATE INDEX IF NOT EXISTS idx_participants_puuid
    ON match_participants(puuid, game_id);
"#;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseStatus {
    pub available: bool,
    pub message: String,
    pub checked_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedParticipant {
    pub puuid: String,
    pub summoner_id: Option<i64>,
    pub summoner_name: Option<String>,
    pub team_id: i32,
    pub champion_id: i32,
    pub position: String,
    pub kills: i32,
    pub deaths: i32,
    pub assists: i32,
    pub win: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedMatchGame {
    pub game_id: i64,
    pub game_creation: i64,
    pub queue_id: i32,
    pub mode_key: String,
    pub source: String,
    pub participants: Vec<CachedParticipant>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheHistoryRequest {
    pub puuid: String,
    pub summoner_id: Option<i64>,
    pub summoner_name: Option<String>,
    pub mode_key: String,
    pub games: Vec<CachedMatchGame>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedHistoryQuery {
    pub puuid: String,
    pub queue_id: Option<i32>,
    pub mode_key: Option<String>,
    pub limit: i64,
    #[serde(default)]
    pub offset: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseModeSummary {
    pub mode_key: String,
    pub matches: i64,
    pub participants: i64,
    pub latest_game_creation: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSummary {
    pub total_matches: i64,
    pub total_participants: i64,
    pub total_players: i64,
    pub modes: Vec<DatabaseModeSummary>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedPlayerSummaryQuery {
    pub puuid: String,
    pub mode_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseSourceSummary {
    pub source: String,
    pub matches: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedPlayerSummary {
    pub puuid: String,
    pub mode_key: Option<String>,
    pub matches: i64,
    pub complete_matches: i64,
    pub wins: i64,
    pub latest_game_creation: Option<i64>,
    pub sources: Vec<DatabaseSourceSummary>,
}

pub struct DatabaseState {
    client: Arc<Mutex<Option<Client>>>,
    status: Arc<RwLock<DatabaseStatus>>,
}

impl DatabaseState {
    pub async fn initialize() -> Self {
        let status = Arc::new(RwLock::new(DatabaseStatus {
            available: false,
            message: "正在连接 PostgreSQL".to_string(),
            checked_at: now_unix(),
        }));
        let client_slot = Arc::new(tokio::sync::Mutex::new(None));
        let started = std::time::Instant::now();

        match tokio::time::timeout(
            std::time::Duration::from_secs(3),
            tokio_postgres::connect(DATABASE_URL, NoTls),
        )
        .await
        {
            Err(_) => {
                tracing::warn!(
                    target: "db.cache",
                    timeout_secs = 3,
                    duration_ms = started.elapsed().as_millis() as u64,
                    "数据库连接超时"
                );
                let mut current = status.write().await;
                current.message = "连接 PostgreSQL 超时（3 秒）".to_string();
                current.checked_at = now_unix();
            }
            Ok(Ok((client, connection))) => {
                let connection_status = Arc::clone(&status);
                tokio::spawn(async move {
                    if let Err(error) = connection.await {
                        tracing::warn!(
                            target: "db.cache",
                            error = %error,
                            "PostgreSQL 连接断开"
                        );
                        let mut status = connection_status.write().await;
                        status.available = false;
                        status.message = format!("PostgreSQL 连接断开: {error}");
                        status.checked_at = now_unix();
                    }
                });

                match client.batch_execute(SCHEMA).await {
                    Ok(()) => {
                        *client_slot.lock().await = Some(client);
                        tracing::info!(
                            target: "db.cache",
                            duration_ms = started.elapsed().as_millis() as u64,
                            notice_count = 0_u32,
                            "数据库连接成功，表结构已就绪"
                        );
                        let mut current = status.write().await;
                        current.available = true;
                        current.message = "PostgreSQL 已连接，缓存表已就绪".to_string();
                        current.checked_at = now_unix();
                    }
                    Err(error) => {
                        tracing::error!(
                            target: "db.cache",
                            duration_ms = started.elapsed().as_millis() as u64,
                            error = %error,
                            "数据库表结构初始化失败"
                        );
                        let mut current = status.write().await;
                        current.message = format!("数据库表结构初始化失败: {error}");
                        current.checked_at = now_unix();
                    }
                }
            }
            Ok(Err(error)) => {
                tracing::error!(
                    target: "db.cache",
                    duration_ms = started.elapsed().as_millis() as u64,
                    error = %error,
                    "数据库连接失败"
                );
                let mut current = status.write().await;
                current.message = format!("无法连接 PostgreSQL: {error}");
                current.checked_at = now_unix();
            }
        }

        Self {
            client: client_slot,
            status,
        }
    }

    pub async fn status(&self) -> DatabaseStatus {
        let mut current = self.status.read().await.clone();
        if current.available {
            let client = self.client.lock().await;
            if let Some(client) = client.as_ref() {
                if let Err(error) = client.query_one("SELECT 1", &[]).await {
                    tracing::warn!(
                        target: "db.cache",
                        error = %error,
                        "数据库健康探测失败"
                    );
                    current.available = false;
                    current.message = format!("PostgreSQL 查询失败: {error}");
                    current.checked_at = now_unix();
                    *self.status.write().await = current.clone();
                }
            }
        }
        current
    }

    async fn require_client(&self) -> Result<tokio::sync::MutexGuard<'_, Option<Client>>, String> {
        let guard = self.client.lock().await;
        if guard.is_none() {
            return Err(self.status.read().await.message.clone());
        }
        Ok(guard)
    }

    pub async fn cache_history(&self, request: CacheHistoryRequest) -> Result<usize, String> {
        let started = std::time::Instant::now();
        if request.puuid.trim().is_empty() || request.mode_key.trim().is_empty() {
            tracing::warn!(
                target: "db.cache",
                op = "cache_history",
                "缓存战绩请求被拒：缺少 puuid 或 modeKey"
            );
            return Err("缓存战绩缺少 puuid 或 modeKey".to_string());
        }

        tracing::info!(
            target: "db.cache",
            op = "cache_history",
            purpose = "将归一化后的历史写入 PostgreSQL 缓存",
            puuid = %request.puuid,
            mode_key = %request.mode_key,
            games_count = request.games.len(),
            "缓存历史写入发起"
        );

        let mut client_guard = self.require_client().await?;
        let client = client_guard
            .as_mut()
            .ok_or_else(|| "数据库连接不可用".to_string())?;
        let transaction = client
            .transaction()
            .await
            .map_err(|error| error.to_string())?;

        transaction
            .execute(
                "INSERT INTO match_players(puuid, summoner_id, summoner_name, updated_at)
                 VALUES($1, $2, $3, NOW())
                 ON CONFLICT(puuid) DO UPDATE SET
                   summoner_id = COALESCE(EXCLUDED.summoner_id, match_players.summoner_id),
                   summoner_name = COALESCE(EXCLUDED.summoner_name, match_players.summoner_name),
                   updated_at = NOW()",
                &[&request.puuid, &request.summoner_id, &request.summoner_name],
            )
            .await
            .map_err(|error| error.to_string())?;

        // 一次请求通常包含几十到上百场、数百名参与者。把整个 payload
        // 交给 PostgreSQL 展开，避免原先“每个对局 + 每个参与者一条 SQL”
        // 带来的上千次往返；仍然保留单事务，任何一步失败都不会留下半批数据。
        let games_json: Value = serde_json::to_value(&request.games)
            .map_err(|error| format!("战绩缓存序列化失败: {error}"))?;
        transaction
            .execute(
                r#"
                WITH game_rows AS (
                    SELECT DISTINCT ON (game."gameId")
                        game."gameId" AS game_id,
                        game."queueId" AS queue_id,
                        game."modeKey" AS mode_key,
                        game."gameCreation" AS game_creation,
                        game.source,
                        game.participants
                    FROM jsonb_to_recordset($1::jsonb) AS game(
                        "gameId" BIGINT,
                        "queueId" INTEGER,
                        "modeKey" TEXT,
                        "gameCreation" BIGINT,
                        source TEXT,
                        participants JSONB
                    )
                    ORDER BY game."gameId", game."gameCreation" DESC
                ), participant_rows AS (
                    SELECT DISTINCT ON (game_rows.game_id, participant.puuid)
                        game_rows.game_id,
                        participant.puuid,
                        participant."summonerId" AS summoner_id,
                        participant."summonerName" AS summoner_name,
                        participant."teamId" AS team_id,
                        participant."championId" AS champion_id,
                        participant.position,
                        participant.kills,
                        participant.deaths,
                        participant.assists,
                        participant.win
                    FROM game_rows
                    CROSS JOIN LATERAL jsonb_to_recordset(game_rows.participants)
                        AS participant(
                            puuid TEXT,
                            "summonerId" BIGINT,
                            "summonerName" TEXT,
                            "teamId" INTEGER,
                            "championId" INTEGER,
                            position TEXT,
                            kills INTEGER,
                            deaths INTEGER,
                            assists INTEGER,
                            win BOOLEAN
                        )
                    WHERE participant.puuid IS NOT NULL
                      AND participant.puuid <> ''
                    ORDER BY game_rows.game_id, participant.puuid
                ), upsert_players AS (
                    INSERT INTO match_players(
                        puuid, summoner_id, summoner_name, updated_at
                    )
                    SELECT DISTINCT ON (puuid)
                        puuid, summoner_id, summoner_name, NOW()
                    FROM participant_rows
                    ORDER BY puuid, summoner_id NULLS LAST
                    ON CONFLICT(puuid) DO UPDATE SET
                        summoner_id = COALESCE(EXCLUDED.summoner_id, match_players.summoner_id),
                        summoner_name = COALESCE(EXCLUDED.summoner_name, match_players.summoner_name),
                        updated_at = NOW()
                    RETURNING puuid
                ), upsert_matches AS (
                    INSERT INTO matches(
                        game_id, queue_id, mode_key, game_creation, source, fetched_at
                    )
                    SELECT
                        game_id, queue_id, mode_key, game_creation, source, NOW()
                    FROM game_rows
                    ON CONFLICT(game_id) DO UPDATE SET
                        queue_id = EXCLUDED.queue_id,
                        mode_key = EXCLUDED.mode_key,
                        game_creation = EXCLUDED.game_creation,
                        source = EXCLUDED.source,
                        fetched_at = NOW()
                    RETURNING game_id
                )
                INSERT INTO match_participants(
                    game_id, puuid, summoner_id, summoner_name, team_id,
                    champion_id, position, kills, deaths, assists, win
                )
                SELECT
                    participant_rows.game_id,
                    participant_rows.puuid,
                    participant_rows.summoner_id,
                    participant_rows.summoner_name,
                    participant_rows.team_id,
                    participant_rows.champion_id,
                    participant_rows.position,
                    participant_rows.kills,
                    participant_rows.deaths,
                    participant_rows.assists,
                    participant_rows.win
                FROM participant_rows
                JOIN upsert_players
                    ON upsert_players.puuid = participant_rows.puuid
                JOIN upsert_matches
                    ON upsert_matches.game_id = participant_rows.game_id
                ON CONFLICT(game_id, puuid) DO UPDATE SET
                    summoner_id = EXCLUDED.summoner_id,
                    summoner_name = EXCLUDED.summoner_name,
                    team_id = EXCLUDED.team_id,
                    champion_id = EXCLUDED.champion_id,
                    position = EXCLUDED.position,
                    kills = EXCLUDED.kills,
                    deaths = EXCLUDED.deaths,
                    assists = EXCLUDED.assists,
                    win = EXCLUDED.win
                "#,
                &[&games_json],
            )
            .await
            .map_err(|error| error.to_string())?;

        transaction.commit().await.map_err(|error| error.to_string())?;
        tracing::info!(
            target: "db.cache",
            op = "cache_history",
            purpose = "将归一化后的历史写入 PostgreSQL 缓存",
            puuid = %request.puuid,
            mode_key = %request.mode_key,
            cached_games = request.games.len(),
            duration_ms = started.elapsed().as_millis() as u64,
            "缓存历史已写入"
        );
        Ok(request.games.len())
    }

    pub async fn cached_history(
        &self,
        request: CachedHistoryQuery,
    ) -> Result<Vec<CachedMatchGame>, String> {
        let started = std::time::Instant::now();
        tracing::info!(
            target: "db.cache",
            op = "cached_history",
            purpose = "读取 PostgreSQL 缓存历史",
            puuid = %request.puuid,
            mode_key = ?request.mode_key,
            queue_id = ?request.queue_id,
            limit = request.limit,
            offset = request.offset,
            "读取缓存历史发起"
        );
        let client_guard = self.require_client().await?;
        let client = client_guard
            .as_ref()
            .ok_or_else(|| "数据库连接不可用".to_string())?;
        // 缓存读取上限：足够覆盖一个玩家跨赛季的全部历史；首页历史分析
        // 需要一次性读取该 puuid 在某 mode 下的全部缓存对局，避免多次翻页。
        let limit = request.limit.clamp(1, 5000);
        let offset = request.offset.max(0);
        let rows = client
            .query(
                "WITH selected_matches AS (
                     SELECT m.game_id, m.game_creation, m.queue_id, m.mode_key, m.source
                     FROM matches m
                     JOIN match_participants target
                       ON target.game_id = m.game_id
                      AND target.puuid = $1
                     WHERE ($2::TEXT IS NULL OR m.mode_key = $2)
                       AND ($3::INTEGER IS NULL OR m.queue_id = $3)
                     ORDER BY m.game_creation DESC
                     LIMIT $4 OFFSET $5
                 )
                 SELECT selected_matches.game_id, selected_matches.game_creation,
                        selected_matches.queue_id, selected_matches.mode_key,
                        selected_matches.source,
                        COALESCE(
                            jsonb_agg(
                                jsonb_build_object(
                                    'puuid', p.puuid,
                                    'summonerId', p.summoner_id,
                                    'summonerName', p.summoner_name,
                                    'teamId', p.team_id,
                                    'championId', p.champion_id,
                                    'position', p.position,
                                    'kills', p.kills,
                                    'deaths', p.deaths,
                                    'assists', p.assists,
                                    'win', p.win
                                ) ORDER BY p.puuid
                            ) FILTER (WHERE p.puuid IS NOT NULL),
                            '[]'::jsonb
                        ) AS participants
                 FROM selected_matches
                 JOIN match_participants p ON p.game_id = selected_matches.game_id
                 GROUP BY selected_matches.game_id, selected_matches.game_creation,
                          selected_matches.queue_id, selected_matches.mode_key,
                          selected_matches.source
                 ORDER BY selected_matches.game_creation DESC",
                &[
                    &request.puuid,
                    &request.mode_key,
                    &request.queue_id,
                    &limit,
                    &offset,
                ],
            )
            .await
            .map_err(|error| error.to_string())?;

        let result: Result<Vec<CachedMatchGame>, String> = rows
            .into_iter()
            .map(|row| {
                let participants_value: Value = row.get("participants");
                let participants = serde_json::from_value(participants_value)
                    .map_err(|error| format!("缓存参与者解析失败: {error}"))?;
                Ok(CachedMatchGame {
                    game_id: row.get("game_id"),
                    game_creation: row.get("game_creation"),
                    queue_id: row.get("queue_id"),
                    mode_key: row.get("mode_key"),
                    source: row.get("source"),
                    participants,
                })
            })
            .collect();

        match &result {
            Ok(games) => tracing::info!(
                target: "db.cache",
                op = "cached_history",
                purpose = "读取 PostgreSQL 缓存历史",
                puuid = %request.puuid,
                mode_key = ?request.mode_key,
                queue_id = ?request.queue_id,
                limit,
                offset,
                count = games.len(),
                duration_ms = started.elapsed().as_millis() as u64,
                raw_body = %serde_json::to_string(games).unwrap_or_default(),
                "读取缓存历史成功"
            ),
            Err(error) => tracing::warn!(
                target: "db.cache",
                op = "cached_history",
                purpose = "读取 PostgreSQL 缓存历史",
                puuid = %request.puuid,
                mode_key = ?request.mode_key,
                queue_id = ?request.queue_id,
                error = %error,
                duration_ms = started.elapsed().as_millis() as u64,
                "读取缓存历史失败"
            ),
        }
        result
    }

    pub async fn summary(&self) -> Result<DatabaseSummary, String> {
        let started = std::time::Instant::now();
        tracing::info!(
            target: "db.cache",
            op = "summary",
            purpose = "读取 PostgreSQL 全局汇总",
            "读取全局汇总发起"
        );
        let client_guard = self.require_client().await?;
        let client = client_guard
            .as_ref()
            .ok_or_else(|| "数据库连接不可用".to_string())?;
        let total_matches: i64 = client
            .query_one("SELECT COUNT(*) FROM matches", &[])
            .await
            .map_err(|error| error.to_string())?
            .get(0);
        let total_participants: i64 = client
            .query_one("SELECT COUNT(*) FROM match_participants", &[])
            .await
            .map_err(|error| error.to_string())?
            .get(0);
        let total_players: i64 = client
            .query_one("SELECT COUNT(DISTINCT puuid) FROM match_participants", &[])
            .await
            .map_err(|error| error.to_string())?
            .get(0);
        let rows = client
            .query(
                "SELECT m.mode_key, COUNT(DISTINCT m.game_id),
                        COUNT(p.puuid), MAX(m.game_creation)
                 FROM matches m
                 LEFT JOIN match_participants p ON p.game_id = m.game_id
                 GROUP BY m.mode_key
                 ORDER BY COUNT(DISTINCT m.game_id) DESC",
                &[],
            )
            .await
            .map_err(|error| error.to_string())?;
        let modes: Vec<DatabaseModeSummary> = rows
            .into_iter()
            .map(|row| DatabaseModeSummary {
                mode_key: row.get(0),
                matches: row.get(1),
                participants: row.get(2),
                latest_game_creation: row.get(3),
            })
            .collect();

        let result = DatabaseSummary {
            total_matches,
            total_participants,
            total_players,
            modes,
        };
        tracing::info!(
            target: "db.cache",
            op = "summary",
            purpose = "读取 PostgreSQL 全局汇总",
            total_matches = result.total_matches,
            total_participants = result.total_participants,
            total_players = result.total_players,
            modes = result.modes.len(),
            duration_ms = started.elapsed().as_millis() as u64,
            raw_body = %serde_json::to_string(&result).unwrap_or_default(),
            "读取全局汇总成功"
        );
        Ok(result)
    }

    pub async fn player_summary(
        &self,
        request: CachedPlayerSummaryQuery,
    ) -> Result<CachedPlayerSummary, String> {
        let started = std::time::Instant::now();
        if request.puuid.trim().is_empty() {
            tracing::warn!(
                target: "db.cache",
                op = "player_summary",
                "玩家汇总请求被拒：缺少 puuid"
            );
            return Err("查询缓存汇总缺少 puuid".to_string());
        }

        tracing::info!(
            target: "db.cache",
            op = "player_summary",
            purpose = "读取玩家级 PostgreSQL 缓存汇总",
            puuid = %request.puuid,
            mode_key = ?request.mode_key,
            "读取玩家汇总发起"
        );
        let client_guard = self.require_client().await?;
        let client = client_guard
            .as_ref()
            .ok_or_else(|| "数据库连接不可用".to_string())?;
        let summary_row = client
            .query_one(
                "WITH player_matches AS (
                     SELECT m.game_id, m.game_creation, target.win
                     FROM matches m
                     JOIN match_participants target
                       ON target.game_id = m.game_id
                      AND target.puuid = $1
                     WHERE ($2::TEXT IS NULL OR m.mode_key = $2)
                 ), roster_counts AS (
                     SELECT game_id, COUNT(*) AS participant_count
                     FROM match_participants
                     GROUP BY game_id
                 )
                 SELECT COUNT(*)::BIGINT,
                        COUNT(*) FILTER (
                            WHERE COALESCE(roster_counts.participant_count, 0) >= 5
                        )::BIGINT,
                        COALESCE(SUM(CASE WHEN player_matches.win THEN 1 ELSE 0 END), 0)::BIGINT,
                        MAX(player_matches.game_creation)
                 FROM player_matches
                 LEFT JOIN roster_counts
                   ON roster_counts.game_id = player_matches.game_id",
                &[&request.puuid, &request.mode_key],
            )
            .await
            .map_err(|error| error.to_string())?;
        let source_rows = client
            .query(
                "SELECT m.source, COUNT(DISTINCT m.game_id)::BIGINT
                 FROM matches m
                 JOIN match_participants target
                   ON target.game_id = m.game_id
                  AND target.puuid = $1
                 WHERE ($2::TEXT IS NULL OR m.mode_key = $2)
                 GROUP BY m.source
                 ORDER BY COUNT(DISTINCT m.game_id) DESC, m.source",
                &[&request.puuid, &request.mode_key],
            )
            .await
            .map_err(|error| error.to_string())?;

        let result = CachedPlayerSummary {
            puuid: request.puuid,
            mode_key: request.mode_key,
            matches: summary_row.get(0),
            complete_matches: summary_row.get(1),
            wins: summary_row.get(2),
            latest_game_creation: summary_row.get(3),
            sources: source_rows
                .into_iter()
                .map(|row| DatabaseSourceSummary {
                    source: row.get(0),
                    matches: row.get(1),
                })
                .collect(),
        };
        tracing::info!(
            target: "db.cache",
            op = "player_summary",
            purpose = "读取玩家级 PostgreSQL 缓存汇总",
            puuid = %result.puuid,
            mode_key = ?result.mode_key,
            matches = result.matches,
            complete_matches = result.complete_matches,
            wins = result.wins,
            sources = result.sources.len(),
            duration_ms = started.elapsed().as_millis() as u64,
            raw_body = %serde_json::to_string(&result).unwrap_or_default(),
            "读取玩家汇总成功"
        );
        Ok(result)
    }
}

/// 把 PostgreSQL NOTICE 翻译成中文（保留以便未来 NOTICE 来源接入时直接复用）。
/// 当前 tokio-postgres 0.7 未暴露 notice_handler，故通过 EnvFilter 直接压制
/// `tokio_postgres::connection` 的 info 级 NOTICE（仅英文 `relation X already exists`）。
#[allow(dead_code)]
fn translate_notice(msg: &str) -> String {
    if let Some(name) = extract_after(msg, "relation \"") {
        if msg.contains("already exists") {
            return format!("跳过建表 {}（已存在）", name.trim_end_matches('"'));
        }
    }
    if let Some(name) = extract_after(msg, "index \"") {
        if msg.contains("already exists") {
            return format!("跳过建索引 {}（已存在）", name.trim_end_matches('"'));
        }
    }
    msg.to_string()
}

#[allow(dead_code)]
fn extract_after<'a>(haystack: &'a str, prefix: &str) -> Option<&'a str> {
    let idx = haystack.find(prefix)?;
    Some(&haystack[idx + prefix.len()..])
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

#[tauri::command]
pub async fn database_status(
    state: tauri::State<'_, DatabaseState>,
) -> Result<DatabaseStatus, String> {
    Ok(state.status().await)
}

#[tauri::command]
pub async fn cache_match_history(
    state: tauri::State<'_, DatabaseState>,
    request: CacheHistoryRequest,
) -> Result<usize, String> {
    state.cache_history(request).await
}

#[tauri::command]
pub async fn get_cached_match_history(
    state: tauri::State<'_, DatabaseState>,
    request: CachedHistoryQuery,
) -> Result<Vec<CachedMatchGame>, String> {
    state.cached_history(request).await
}

#[tauri::command]
pub async fn database_summary(
    state: tauri::State<'_, DatabaseState>,
) -> Result<DatabaseSummary, String> {
    state.summary().await
}

#[tauri::command]
pub async fn get_cached_player_summary(
    state: tauri::State<'_, DatabaseState>,
    request: CachedPlayerSummaryQuery,
) -> Result<CachedPlayerSummary, String> {
    state.player_summary(request).await
}