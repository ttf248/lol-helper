use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::{Mutex, RwLock};
use tokio_postgres::{Client, NoTls};

pub const DATABASE_URL: &str =
    "postgres://lol:helper@127.0.0.1/lol?sslmode=disable";

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
        let client_slot = Arc::new(Mutex::new(None));

        match tokio::time::timeout(
            std::time::Duration::from_secs(3),
            tokio_postgres::connect(DATABASE_URL, NoTls),
        )
        .await
        {
            Err(_) => {
                let mut current = status.write().await;
                current.message = "连接 PostgreSQL 超时（3 秒）".to_string();
                current.checked_at = now_unix();
            }
            Ok(Ok((client, connection))) => {
                let connection_status = Arc::clone(&status);
                tokio::spawn(async move {
                    if let Err(error) = connection.await {
                        let mut status = connection_status.write().await;
                        status.available = false;
                        status.message = format!("PostgreSQL 连接断开: {error}");
                        status.checked_at = now_unix();
                    }
                });

                match client.batch_execute(SCHEMA).await {
                    Ok(()) => {
                        *client_slot.lock().await = Some(client);
                        let mut current = status.write().await;
                        current.available = true;
                        current.message = "PostgreSQL 已连接，缓存表已就绪".to_string();
                        current.checked_at = now_unix();
                    }
                    Err(error) => {
                        let mut current = status.write().await;
                        current.message = format!("数据库表结构初始化失败: {error}");
                        current.checked_at = now_unix();
                    }
                }
            }
            Ok(Err(error)) => {
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
        if request.puuid.trim().is_empty() || request.mode_key.trim().is_empty() {
            return Err("缓存战绩缺少 puuid 或 modeKey".to_string());
        }

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
                   summoner_id = EXCLUDED.summoner_id,
                   summoner_name = EXCLUDED.summoner_name,
                   updated_at = NOW()",
                &[&request.puuid, &request.summoner_id, &request.summoner_name],
            )
            .await
            .map_err(|error| error.to_string())?;

        let mut cached = 0usize;
        for game in &request.games {
            transaction
                .execute(
                    "INSERT INTO matches(game_id, queue_id, mode_key, game_creation, source, fetched_at)
                     VALUES($1, $2, $3, $4, $5, NOW())
                     ON CONFLICT(game_id) DO UPDATE SET
                       queue_id = EXCLUDED.queue_id,
                       mode_key = EXCLUDED.mode_key,
                       game_creation = EXCLUDED.game_creation,
                       source = EXCLUDED.source,
                       fetched_at = NOW()",
                    &[
                        &game.game_id,
                        &game.queue_id,
                        &game.mode_key,
                        &game.game_creation,
                        &game.source,
                    ],
                )
                .await
                .map_err(|error| error.to_string())?;

            for participant in &game.participants {
                transaction
                    .execute(
                        "INSERT INTO match_players(puuid, summoner_id, summoner_name, updated_at)
                         VALUES($1, $2, $3, NOW())
                         ON CONFLICT(puuid) DO UPDATE SET
                           summoner_id = COALESCE(EXCLUDED.summoner_id, match_players.summoner_id),
                           summoner_name = COALESCE(EXCLUDED.summoner_name, match_players.summoner_name),
                           updated_at = NOW()",
                        &[
                            &participant.puuid,
                            &participant.summoner_id,
                            &participant.summoner_name,
                        ],
                    )
                    .await
                    .map_err(|error| error.to_string())?;
                transaction
                    .execute(
                        "INSERT INTO match_participants(
                           game_id, puuid, summoner_id, summoner_name, team_id,
                           champion_id, position, kills, deaths, assists, win
                         ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                         ON CONFLICT(game_id, puuid) DO UPDATE SET
                           summoner_id = EXCLUDED.summoner_id,
                           summoner_name = EXCLUDED.summoner_name,
                           team_id = EXCLUDED.team_id,
                           champion_id = EXCLUDED.champion_id,
                           position = EXCLUDED.position,
                           kills = EXCLUDED.kills,
                           deaths = EXCLUDED.deaths,
                           assists = EXCLUDED.assists,
                           win = EXCLUDED.win",
                        &[
                            &game.game_id,
                            &participant.puuid,
                            &participant.summoner_id,
                            &participant.summoner_name,
                            &participant.team_id,
                            &participant.champion_id,
                            &participant.position,
                            &participant.kills,
                            &participant.deaths,
                            &participant.assists,
                            &participant.win,
                        ],
                    )
                    .await
                    .map_err(|error| error.to_string())?;
            }
            cached += 1;
        }

        transaction.commit().await.map_err(|error| error.to_string())?;
        Ok(cached)
    }

    pub async fn cached_history(
        &self,
        request: CachedHistoryQuery,
    ) -> Result<Vec<CachedMatchGame>, String> {
        let client_guard = self.require_client().await?;
        let client = client_guard
            .as_ref()
            .ok_or_else(|| "数据库连接不可用".to_string())?;
        let limit = request.limit.clamp(1, 300);
        let offset = request.offset.max(0);
        let game_rows = client
            .query(
                "SELECT DISTINCT m.game_id, m.game_creation, m.queue_id, m.mode_key, m.source
                 FROM matches m
                 JOIN match_participants p ON p.game_id = m.game_id
                 WHERE p.puuid = $1
                   AND ($2::TEXT IS NULL OR m.mode_key = $2)
                   AND ($3::INTEGER IS NULL OR m.queue_id = $3)
                 ORDER BY m.game_creation DESC LIMIT $4 OFFSET $5",
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

        if game_rows.is_empty() {
            return Ok(Vec::new());
        }

        let game_ids: Vec<i64> = game_rows.iter().map(|row| row.get("game_id")).collect();
        let participant_rows = client
            .query(
                "SELECT game_id, puuid, summoner_id, summoner_name, team_id,
                        champion_id, position, kills, deaths, assists, win
                 FROM match_participants
                 WHERE game_id = ANY($1)",
                &[&game_ids],
            )
            .await
            .map_err(|error| error.to_string())?;

        let mut games = HashMap::<i64, CachedMatchGame>::new();
        for row in game_rows {
            let game_id = row.get("game_id");
            games.insert(
                game_id,
                CachedMatchGame {
                    game_id,
                    game_creation: row.get("game_creation"),
                    queue_id: row.get("queue_id"),
                    mode_key: row.get("mode_key"),
                    source: row.get("source"),
                    participants: Vec::new(),
                },
            );
        }
        for row in participant_rows {
            let game_id: i64 = row.get("game_id");
            if let Some(game) = games.get_mut(&game_id) {
                game.participants.push(CachedParticipant {
                    puuid: row.get("puuid"),
                    summoner_id: row.get("summoner_id"),
                    summoner_name: row.get("summoner_name"),
                    team_id: row.get("team_id"),
                    champion_id: row.get("champion_id"),
                    position: row.get("position"),
                    kills: row.get("kills"),
                    deaths: row.get("deaths"),
                    assists: row.get("assists"),
                    win: row.get("win"),
                });
            }
        }

        Ok(game_ids
            .into_iter()
            .filter_map(|game_id| games.remove(&game_id))
            .collect())
    }

    pub async fn summary(&self) -> Result<DatabaseSummary, String> {
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
        let modes = rows
            .into_iter()
            .map(|row| DatabaseModeSummary {
                mode_key: row.get(0),
                matches: row.get(1),
                participants: row.get(2),
                latest_game_creation: row.get(3),
            })
            .collect();

        Ok(DatabaseSummary {
            total_matches,
            total_participants,
            total_players,
            modes,
        })
    }
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
