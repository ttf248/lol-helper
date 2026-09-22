use chrono::{DateTime, Utc};
use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::{Mutex, RwLock};
use tokio_postgres::{NoTls, Row};

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
-- ── 模糊搜索扩展（pg_trgm 提供 % / <%> / similarity 操作符） ─────────────
CREATE EXTENSION IF NOT EXISTS pg_trgm;

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

-- ── 对局详情（单局） ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS game_details (
    game_id BIGINT PRIMARY KEY REFERENCES matches(game_id) ON DELETE CASCADE,
    game_creation BIGINT,
    game_creation_date TIMESTAMPTZ,
    game_duration INTEGER,
    game_mode TEXT,
    game_type TEXT,
    game_version TEXT,
    map_id INTEGER,
    platform_id TEXT,
    season_id INTEGER,
    raw_payload JSONB NOT NULL,
    raw_payload_sgp JSONB,
    source TEXT NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_game_details_fetched_at
    ON game_details(fetched_at);
CREATE INDEX IF NOT EXISTS idx_game_details_game_creation
    ON game_details(game_creation DESC);

-- ── 对局详情（每位玩家） ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS game_detail_participants (
    game_id BIGINT NOT NULL REFERENCES game_details(game_id) ON DELETE CASCADE,
    participant_id INTEGER NOT NULL,
    puuid TEXT NOT NULL,
    team_id INTEGER NOT NULL,
    champion_id INTEGER NOT NULL,
    spell1_id INTEGER,
    spell2_id INTEGER,
    champ_level INTEGER,
    kills INTEGER,
    deaths INTEGER,
    assists INTEGER,
    win TEXT,
    item0 INTEGER,
    item1 INTEGER,
    item2 INTEGER,
    item3 INTEGER,
    item4 INTEGER,
    item5 INTEGER,
    item6 INTEGER,
    gold_earned INTEGER,
    gold_spent INTEGER,
    physical_damage_dealt_to_champions INTEGER,
    magic_damage_dealt_to_champions INTEGER,
    true_damage_dealt_to_champions INTEGER,
    total_damage_dealt_to_champions INTEGER,
    total_damage_taken INTEGER,
    total_minions_killed INTEGER,
    neutral_minions_killed INTEGER,
    vision_score INTEGER,
    wards_placed INTEGER,
    perk0 INTEGER,
    perk1 INTEGER,
    perk2 INTEGER,
    perk3 INTEGER,
    perk4 INTEGER,
    perk5 INTEGER,
    perk_primary_style INTEGER,
    perk_sub_style INTEGER,
    first_blood_kill BOOLEAN,
    first_blood_assist BOOLEAN,
    double_kills INTEGER,
    triple_kills INTEGER,
    quadra_kills INTEGER,
    penta_kills INTEGER,
    largest_killing_spree INTEGER,
    turret_kills INTEGER,
    account_id BIGINT,
    summoner_id BIGINT,
    summoner_name TEXT,
    profile_icon_id INTEGER,
    game_name TEXT,
    tag_line TEXT,
    raw_stats JSONB NOT NULL,
    raw_timeline JSONB,
    raw_identity JSONB NOT NULL,
    PRIMARY KEY (game_id, participant_id)
);

CREATE INDEX IF NOT EXISTS idx_detail_participants_puuid
    ON game_detail_participants(puuid);

CREATE INDEX IF NOT EXISTS idx_detail_participants_summoner_id
    ON game_detail_participants(summoner_id);
CREATE INDEX IF NOT EXISTS idx_detail_participants_game_id
    ON game_detail_participants(game_id);

-- ── 对局详情（双方队伍） ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS game_detail_teams (
    game_id BIGINT NOT NULL REFERENCES game_details(game_id) ON DELETE CASCADE,
    team_id INTEGER NOT NULL,
    win BOOLEAN,
    baron_kills INTEGER,
    dragon_kills INTEGER,
    tower_kills INTEGER,
    inhibitor_kills INTEGER,
    rift_herald_kills INTEGER,
    first_baron BOOLEAN,
    first_blood BOOLEAN,
    first_inhibitor BOOLEAN,
    first_tower BOOLEAN,
    horde_kills INTEGER,
    vilemaw_kills INTEGER,
    bans JSONB,
    objectives JSONB,
    feats JSONB,
    PRIMARY KEY (game_id, team_id)
);

-- ── 召唤师信息（主键 = puuid） ─────────────────────────────────
CREATE TABLE IF NOT EXISTS summoners (
    puuid TEXT PRIMARY KEY,
    summoner_id BIGINT NOT NULL UNIQUE,
    account_id BIGINT,
    display_name TEXT,
    internal_name TEXT,
    game_name TEXT,
    tag_line TEXT,
    summoner_name TEXT,
    profile_icon_id INTEGER,
    summoner_level BIGINT,
    xp_since_last_level BIGINT,
    xp_until_next_level BIGINT,
    percent_complete_for_next_level INTEGER,
    privacy TEXT,
    name_change_flag BOOLEAN,
    reroll_points JSONB,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 对局内 10 人阵容快照（仅 PreEndOfGame 后落盘） ───────────────
CREATE TABLE IF NOT EXISTS game_sessions (
    game_id BIGINT PRIMARY KEY,
    queue_id INTEGER NOT NULL,
    map_id INTEGER,
    game_mode TEXT,
    platform_id TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_queue_started
    ON game_sessions(queue_id, started_at DESC);

CREATE TABLE IF NOT EXISTS session_player_picks (
    game_id BIGINT NOT NULL REFERENCES game_sessions(game_id) ON DELETE CASCADE,
    puuid TEXT NOT NULL,
    summoner_id BIGINT,
    summoner_name TEXT,
    game_name TEXT,
    tag_line TEXT,
    profile_icon_id INTEGER,
    champion_id INTEGER,
    spell1_id INTEGER,
    spell2_id INTEGER,
    team_id INTEGER,
    PRIMARY KEY (game_id, puuid)
);

CREATE INDEX IF NOT EXISTS idx_session_picks_puuid
    ON session_player_picks(puuid);

CREATE INDEX IF NOT EXISTS idx_session_picks_summoner
    ON session_player_picks(summoner_id);

-- ── 英雄详情（gtimg.com JSON） ─────────────────────────────────
CREATE TABLE IF NOT EXISTS champion_details (
    champion_id INTEGER PRIMARY KEY,
    payload JSONB NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"#;

/// 可重复执行的增量迁移。SCHEMA 负责新库建表，这里负责旧版本表结构补齐。
/// 不能只依赖 CREATE TABLE IF NOT EXISTS：该语句不会给已经存在的表增加新列。
const MIGRATIONS: &str = r#"
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE game_details
    ADD COLUMN IF NOT EXISTS raw_payload_sgp JSONB;

ALTER TABLE game_details
    ALTER COLUMN game_duration DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_game_details_game_creation
    ON game_details(game_creation DESC);
CREATE INDEX IF NOT EXISTS idx_detail_participants_game_id
    ON game_detail_participants(game_id);

-- SGP 只返回 gameCreation（Unix 毫秒），历史详情已经有主时间戳时，
-- 也要补齐冗余的 TIMESTAMPTZ 字段，避免旧数据永久为空。
UPDATE game_details
SET game_creation_date = to_timestamp(game_creation / 1000.0)
WHERE game_creation_date IS NULL
  AND game_creation > 0;

INSERT INTO schema_migrations(version)
VALUES (2), (3)
ON CONFLICT(version) DO NOTHING;

-- ── v4：召唤师模糊搜索索引 ────────────────────────────────────────
-- 搜索只读取 summoners 表；不再为了候选排序统计 match_participants。
-- pg_trgm GIN 索引支持 % (相似度阈值) 操作符下的 WHERE 子句索引命中。
CREATE INDEX IF NOT EXISTS idx_summoners_game_name_trgm
    ON summoners USING GIN (game_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_summoners_tag_line_trgm
    ON summoners USING GIN (tag_line gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_summoners_summoner_name_trgm
    ON summoners USING GIN (summoner_name gin_trgm_ops);

INSERT INTO schema_migrations(version)
VALUES (4)
ON CONFLICT(version) DO NOTHING;
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

/// 当前一支队伍的统一历史证据查询。一次从本地 PG 读取所有成员出现过的
/// 对局，避免前端把逐玩家历史拼接后产生来源顺序或展示上的歧义。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedTeamHistoryQuery {
    pub puuids: Vec<String>,
    pub mode_key: Option<String>,
    pub limit: i64,
}

/// 历史分析快照请求。分析窗口只允许读取有限数量的最近对局，避免把
/// PostgreSQL 中的长期缓存一次性搬到前端。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryAnalysisQuery {
    pub puuid: String,
    #[serde(default)]
    pub mode_key: Option<String>,
    pub window_size: i64,
    #[serde(default)]
    pub result: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMetricStat {
    pub average: Option<f64>,
    pub win_average: Option<f64>,
    pub loss_average: Option<f64>,
    pub delta: Option<f64>,
    pub coverage: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMetricSummary {
    pub kda: HistoryMetricStat,
    pub damage_per_minute: HistoryMetricStat,
    pub gold_per_minute: HistoryMetricStat,
    pub cs_per_minute: HistoryMetricStat,
    pub vision_per_minute: HistoryMetricStat,
    pub team_damage_share: HistoryMetricStat,
    pub damage_taken_per_minute: HistoryMetricStat,
    pub team_objective_score: HistoryMetricStat,
    pub first_blood_rate: HistoryMetricStat,
    pub first_tower_rate: HistoryMetricStat,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryChampionStat {
    pub champion_id: i32,
    pub games: i64,
    pub wins: i64,
    pub win_rate: Option<f64>,
    pub average_kda: Option<f64>,
    pub damage_per_minute: Option<f64>,
    pub cs_per_minute: Option<f64>,
    pub vision_per_minute: Option<f64>,
    pub detail_games: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPositionStat {
    pub position: String,
    pub games: i64,
    pub wins: i64,
    pub win_rate: Option<f64>,
    pub average_kda: Option<f64>,
    pub damage_per_minute: Option<f64>,
    pub cs_per_minute: Option<f64>,
    pub vision_per_minute: Option<f64>,
    pub detail_games: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryTrendPoint {
    pub game_id: i64,
    pub game_creation: i64,
    pub champion_id: i32,
    pub position: String,
    pub win: bool,
    pub kda: f64,
    pub damage_per_minute: Option<f64>,
    pub cs_per_minute: Option<f64>,
    pub detail_available: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryAnalysisInsight {
    pub kind: String,
    pub title: String,
    pub detail: String,
    pub metric: Option<String>,
    pub delta: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryAnalysisQuality {
    pub total_games: i64,
    pub detail_games: i64,
    pub complete_games: i64,
    pub base_coverage: f64,
    pub detail_coverage: f64,
    pub metric_coverage: HashMap<String, i64>,
    pub sources: Vec<String>,
    pub latest_game_creation: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryAnalysisSnapshot {
    pub puuid: String,
    pub mode_key: Option<String>,
    pub window_size: i64,
    pub actual_games: i64,
    pub wins: i64,
    pub losses: i64,
    pub win_rate: Option<f64>,
    pub recent_wins: i64,
    pub recent_games: i64,
    pub previous_wins: i64,
    pub previous_games: i64,
    pub streak_type: String,
    pub streak_count: i64,
    pub trend: Vec<HistoryTrendPoint>,
    pub metrics: HistoryMetricSummary,
    pub champions: Vec<HistoryChampionStat>,
    pub positions: Vec<HistoryPositionStat>,
    pub insights: Vec<HistoryAnalysisInsight>,
    pub quality: HistoryAnalysisQuality,
    pub source: String,
}

#[derive(Debug, Clone)]
struct SelectedHistoryGame {
    game_id: i64,
    game_creation: i64,
    source: String,
    game_duration: Option<i32>,
    champion_id: i32,
    position: String,
    kills: i32,
    deaths: i32,
    assists: i32,
    win: bool,
}

#[derive(Debug, Clone)]
struct DetailHistoryParticipant {
    puuid: String,
    team_id: i32,
    champion_id: i32,
    position: String,
    kills: Option<i32>,
    deaths: Option<i32>,
    assists: Option<i32>,
    win: bool,
    gold_earned: Option<i32>,
    total_damage_to_champions: Option<i32>,
    total_damage_taken: Option<i32>,
    total_minions: Option<i32>,
    neutral_minions: Option<i32>,
    vision_score: Option<i32>,
    first_blood_kill: Option<bool>,
}

#[derive(Debug, Clone)]
struct DetailHistoryTeam {
    team_id: i32,
    dragon_kills: Option<i32>,
    baron_kills: Option<i32>,
    tower_kills: Option<i32>,
    rift_herald_kills: Option<i32>,
    first_tower: Option<bool>,
}

#[derive(Debug, Clone, Default)]
struct MetricAccumulator {
    total: f64,
    count: i64,
    win_total: f64,
    win_count: i64,
    loss_total: f64,
    loss_count: i64,
}

impl MetricAccumulator {
    fn add(&mut self, value: Option<f64>, win: bool) {
        let Some(value) = value.filter(|value| value.is_finite()) else {
            return;
        };
        self.total += value;
        self.count += 1;
        if win {
            self.win_total += value;
            self.win_count += 1;
        } else {
            self.loss_total += value;
            self.loss_count += 1;
        }
    }

    fn average(total: f64, count: i64) -> Option<f64> {
        (count > 0).then(|| total / count as f64)
    }

    fn finish(&self) -> HistoryMetricStat {
        let average = Self::average(self.total, self.count);
        let win_average = Self::average(self.win_total, self.win_count);
        let loss_average = Self::average(self.loss_total, self.loss_count);
        HistoryMetricStat {
            average,
            win_average,
            loss_average,
            delta: win_average.zip(loss_average).map(|(win, loss)| win - loss),
            coverage: self.count,
        }
    }
}

#[derive(Debug, Clone, Default)]
struct HistoryDimensionAccumulator {
    games: i64,
    wins: i64,
    kda: MetricAccumulator,
    damage_per_minute: MetricAccumulator,
    cs_per_minute: MetricAccumulator,
    vision_per_minute: MetricAccumulator,
    detail_games: i64,
}

impl HistoryDimensionAccumulator {
    fn add(&mut self, win: bool, metrics: &HistoryGameMetrics) {
        self.games += 1;
        self.wins += i64::from(win);
        self.kda.add(Some(metrics.kda), win);
        self.damage_per_minute.add(metrics.damage_per_minute, win);
        self.cs_per_minute.add(metrics.cs_per_minute, win);
        self.vision_per_minute.add(metrics.vision_per_minute, win);
        if metrics.detail_available {
            self.detail_games += 1;
        }
    }

    fn finish_champion(&self, champion_id: i32) -> HistoryChampionStat {
        HistoryChampionStat {
            champion_id,
            games: self.games,
            wins: self.wins,
            win_rate: rate(self.wins, self.games),
            average_kda: self.kda.finish().average,
            damage_per_minute: self.damage_per_minute.finish().average,
            cs_per_minute: self.cs_per_minute.finish().average,
            vision_per_minute: self.vision_per_minute.finish().average,
            detail_games: self.detail_games,
        }
    }

    fn finish_position(&self, position: String) -> HistoryPositionStat {
        HistoryPositionStat {
            position,
            games: self.games,
            wins: self.wins,
            win_rate: rate(self.wins, self.games),
            average_kda: self.kda.finish().average,
            damage_per_minute: self.damage_per_minute.finish().average,
            cs_per_minute: self.cs_per_minute.finish().average,
            vision_per_minute: self.vision_per_minute.finish().average,
            detail_games: self.detail_games,
        }
    }
}

#[derive(Debug, Clone, Default)]
struct HistoryGameMetrics {
    kda: f64,
    damage_per_minute: Option<f64>,
    gold_per_minute: Option<f64>,
    cs_per_minute: Option<f64>,
    vision_per_minute: Option<f64>,
    team_damage_share: Option<f64>,
    damage_taken_per_minute: Option<f64>,
    team_objective_score: Option<f64>,
    first_blood_rate: Option<f64>,
    first_tower_rate: Option<f64>,
    detail_available: bool,
}

fn rate(wins: i64, games: i64) -> Option<f64> {
    (games > 0).then(|| (wins as f64 / games as f64) * 100.0)
}

fn row_opt_i32(row: &Row, column: &str) -> Option<i32> {
    row.try_get::<_, Option<i32>>(column).ok().flatten()
}

fn row_opt_bool(row: &Row, column: &str) -> Option<bool> {
    row.try_get::<_, Option<bool>>(column).ok().flatten()
}

fn parse_detail_win(value: Option<&str>) -> bool {
    matches!(
        value.map(|value| value.trim().to_ascii_lowercase()).as_deref(),
        Some("true") | Some("win") | Some("success")
    )
}

fn round_metric(value: Option<f64>) -> Option<f64> {
    value.map(|value| (value * 10.0).round() / 10.0)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LcuSummonerInfo {
    pub account_id: i64,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub game_name: String,
    #[serde(default)]
    pub internal_name: String,
    #[serde(default)]
    pub name_change_flag: bool,
    #[serde(default)]
    pub percent_complete_for_next_level: i32,
    #[serde(default)]
    pub privacy: String,
    pub profile_icon_id: i32,
    pub puuid: String,
    #[serde(default)]
    pub reroll_points: serde_json::Value,
    pub summoner_id: i64,
    pub summoner_level: i64,
    #[serde(default)]
    pub unnamed: bool,
    #[serde(default)]
    pub xp_since_last_level: i64,
    #[serde(default)]
    pub xp_until_next_level: i64,
    #[serde(default)]
    pub tag_line: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheSummonerRequest {
    pub summoners: Vec<LcuSummonerInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedSummonerRow {
    pub puuid: String,
    pub summoner_id: i64,
    pub account_id: Option<i64>,
    pub display_name: Option<String>,
    pub internal_name: Option<String>,
    pub game_name: Option<String>,
    pub tag_line: Option<String>,
    pub summoner_name: Option<String>,
    pub profile_icon_id: Option<i32>,
    pub summoner_level: Option<i64>,
    pub xp_since_last_level: Option<i64>,
    pub xp_until_next_level: Option<i64>,
    pub percent_complete_for_next_level: Option<i32>,
    pub privacy: Option<String>,
    pub name_change_flag: Option<bool>,
    pub reroll_points: Option<serde_json::Value>,
    pub updated_at: i64,
}

/// 搜索框建议列表的入参。query 已在前端 trim + 小写归一化，
/// limit 默认 20，封顶 50 防止 IPC 单次回包过大。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchCachedSummonersQuery {
    pub query: String,
    #[serde(default)]
    pub limit: Option<i64>,
}

/// 搜索框建议列表的单条结果。similarity 仅用于数据库内排序，避免把
/// match_participants 的战绩统计带入每次搜索。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedSummonerSearchRow {
    pub puuid: String,
    pub summoner_id: i64,
    pub game_name: Option<String>,
    pub tag_line: Option<String>,
    pub display_name: Option<String>,
    pub summoner_name: Option<String>,
    pub summoner_level: Option<i64>,
    pub profile_icon_id: Option<i32>,
    pub similarity: f32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheGameDetailRequest {
    /// LCU /games/{gameId} 的完整响应；作为 raw_payload 落库。
    /// SGP-only 写入时也用作 raw_payload（NOT NULL 约束），同时把 sgp_detail
    /// 同步写入 raw_payload_sgp，使读取路径直接命中 SGP 分支。
    pub detail: serde_json::Value,
    /// 可选：SGP 摘要响应；存在时作为 raw_payload_sgp 落库。
    #[serde(default)]
    pub sgp_detail: Option<serde_json::Value>,
    /// 写入来源标签。`'lcu-game-detail'`（默认）/ `'sgp-summary-full'` /
    /// `'sgp-summary'` 等。默认 `'lcu-game-detail'`。
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedGameDetail {
    pub game_id: i64,
    pub game_creation: Option<i64>,
    pub game_duration: Option<i32>,
    pub game_mode: Option<String>,
    pub game_type: Option<String>,
    pub game_version: Option<String>,
    pub map_id: Option<i32>,
    pub platform_id: Option<String>,
    pub season_id: Option<i32>,
    /// LCU /games/{gameId} 完整响应（始终存在）。
    pub raw_payload: serde_json::Value,
    /// SGP 摘要响应（仅当调用方传入时存在）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_payload_sgp: Option<serde_json::Value>,
    pub source: String,
    pub fetched_at: i64,
}

/// 单局对局内 10 人阵容快照请求。**只在 phase ∈ {PreEndOfGame, EndOfGame}
/// 时调用**，避免游戏中的 gameData.gameId 在切换阶段被改写导致 key 冲突。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheGameSessionRequest {
    pub game_id: i64,
    pub queue_id: i32,
    pub map_id: Option<i32>,
    pub platform_id: Option<String>,
    pub phase: String,
    pub picks: Vec<SessionPlayerPick>,
}

/// session_player_picks 单行。puuid 必填，其余字段允许 LCU 在加载阶段缺省。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPlayerPick {
    pub puuid: String,
    #[serde(default)]
    pub summoner_id: Option<i64>,
    #[serde(default)]
    pub summoner_name: Option<String>,
    #[serde(default)]
    pub game_name: Option<String>,
    #[serde(default)]
    pub tag_line: Option<String>,
    #[serde(default)]
    pub profile_icon_id: Option<i32>,
    #[serde(default)]
    pub champion_id: Option<i32>,
    #[serde(default)]
    pub spell1_id: Option<i32>,
    #[serde(default)]
    pub spell2_id: Option<i32>,
    #[serde(default)]
    pub team_id: Option<i32>,
}

/// 读取端返回的单局对局内阵容快照。前端按 teamOne / teamTwo 直接对接
/// SessionTypes.gameData（保持顺序：先 ORDER 后 CHAOS，与 LCU 一致）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedGameSession {
    pub game_id: i64,
    pub queue_id: i32,
    pub map_id: Option<i32>,
    pub platform_id: Option<String>,
    pub phase: String,
    pub started_at: i64,
    pub picks: Vec<SessionPlayerPickRow>,
}

/// session_player_picks 行的读出形态。team_id 用于前端分边。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPlayerPickRow {
    pub puuid: String,
    pub summoner_id: Option<i64>,
    pub summoner_name: Option<String>,
    pub game_name: Option<String>,
    pub tag_line: Option<String>,
    pub profile_icon_id: Option<i32>,
    pub champion_id: Option<i32>,
    pub spell1_id: Option<i32>,
    pub spell2_id: Option<i32>,
    pub team_id: Option<i32>,
}

/// 英雄详情请求：来自 `https://game.gtimg.cn/.../hero/{id}.js` 的整包 JSON。
/// `payload` 是网页 JS 响应 `{ hero: {...}, spells: [...] }` 的 JSON 形式。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheChampionDetailRequest {
    pub champion_id: i32,
    pub payload: serde_json::Value,
}

/// 英雄详情读取返回。`payload` 始终存在（NOT NULL）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedChampionDetail {
    pub champion_id: i32,
    pub payload: serde_json::Value,
    pub fetched_at: i64,
}

fn number_value(object: &Value, key: &str) -> Option<i64> {
    object.get(key).and_then(|value| {
        value
            .as_i64()
            .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
    })
}

fn string_value(object: &Value, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn game_creation_date_value(
    detail: &Value,
    sgp_detail: Option<&Value>,
    game_creation: Option<i64>,
) -> Option<String> {
    string_value(detail, "gameCreationDate")
        .or_else(|| sgp_detail.and_then(|value| string_value(value, "gameCreationDate")))
        .or_else(|| {
            game_creation.and_then(|milliseconds| {
                DateTime::<Utc>::from_timestamp_millis(milliseconds)
                    .map(|date| date.to_rfc3339())
            })
        })
}

fn bool_value(object: &Value, key: &str) -> Option<bool> {
    object.get(key).and_then(|value| {
        value.as_bool().or_else(|| {
            value.as_str().and_then(|text| match text.trim().to_ascii_lowercase().as_str() {
                "true" | "win" | "success" => Some(true),
                "false" | "fail" | "failure" => Some(false),
                _ => None,
            })
        })
    })
}

fn nested_number(object: &Value, parent: &str, key: &str) -> Option<i64> {
    object.get(parent).and_then(|value| number_value(value, key))
}

fn nested_bool(object: &Value, parent: &str, key: &str) -> Option<bool> {
    object.get(parent).and_then(|value| bool_value(value, key))
}

fn nested_nested_number(
    object: &Value,
    parent: &str,
    child: &str,
    key: &str,
) -> Option<i64> {
    object
        .get(parent)
        .and_then(|value| value.get(child))
        .and_then(|value| number_value(value, key))
}

fn nested_nested_bool(
    object: &Value,
    parent: &str,
    child: &str,
    key: &str,
) -> Option<bool> {
    object
        .get(parent)
        .and_then(|value| value.get(child))
        .and_then(|value| bool_value(value, key))
}

fn number_json(value: Option<i64>) -> Value {
    value.map(Value::from).unwrap_or(Value::Null)
}

fn string_json(value: Option<String>) -> Value {
    value.map(Value::String).unwrap_or(Value::Null)
}

fn bool_json(value: Option<bool>) -> Value {
    value.map(Value::Bool).unwrap_or(Value::Null)
}

fn participant_number(participant: &Value, stats: &Value, key: &str) -> Value {
    number_json(number_value(participant, key).or_else(|| number_value(stats, key)))
}

fn participant_bool(participant: &Value, stats: &Value, key: &str) -> Option<bool> {
    bool_value(stats, key).or_else(|| bool_value(participant, key))
}

fn participant_rows(detail: &Value, sgp_detail: Option<&Value>) -> Vec<Value> {
    let payload = sgp_detail.unwrap_or(detail);
    let participants = payload
        .get("participants")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let identity_map: HashMap<i64, &Value> = payload
        .get("participantIdentities")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|identity| {
            number_value(identity, "participantId").map(|id| (id, identity))
        })
        .collect();

    participants
        .iter()
        .enumerate()
        .filter_map(|(index, participant)| {
            let stats = participant.get("stats").unwrap_or(participant);
            let participant_id = number_value(participant, "participantId")
                .or_else(|| number_value(stats, "participantId"))
                .unwrap_or((index + 1) as i64);
            let identity = identity_map.get(&participant_id).copied();
            let identity_player = identity
                .and_then(|value| value.get("player"))
                .unwrap_or(&Value::Null);
            let puuid = string_value(participant, "puuid")
                .or_else(|| string_value(identity_player, "puuid"))?;
            let team_id = number_value(participant, "teamId")
                .or_else(|| number_value(stats, "teamId"))?;
            let champion_id = number_value(participant, "championId")
                .or_else(|| number_value(stats, "championId"))?;
            let summoner_id = number_value(participant, "summonerId")
                .or_else(|| number_value(identity_player, "summonerId"));
            let account_id = number_value(participant, "accountId")
                .or_else(|| number_value(identity_player, "accountId"));
            let profile_icon_id = number_value(participant, "profileIcon")
                .or_else(|| number_value(participant, "profileIconId"))
                .or_else(|| number_value(identity_player, "profileIcon"));
            let game_name = string_value(participant, "riotIdGameName")
                .or_else(|| string_value(participant, "gameName"))
                .or_else(|| string_value(identity_player, "gameName"));
            let tag_line = string_value(participant, "riotIdTagline")
                .or_else(|| string_value(participant, "tagLine"))
                .or_else(|| string_value(identity_player, "tagLine"));
            let legacy_name = string_value(participant, "summonerName")
                .or_else(|| string_value(identity_player, "summonerName"));
            let summoner_name = game_name
                .as_ref()
                .map(|name| match tag_line.as_ref() {
                    Some(tag) if !name.to_ascii_lowercase().ends_with(
                        &format!("#{}", tag.to_ascii_lowercase()),
                    ) => format!("{name}#{tag}"),
                    _ => name.clone(),
                })
                .or(legacy_name);
            let position = string_value(participant, "teamPosition")
                .or_else(|| string_value(participant, "individualPosition"))
                .or_else(|| string_value(participant, "role"))
                .or_else(|| {
                    participant
                        .get("timeline")
                        .and_then(|timeline| string_value(timeline, "role"))
                })
                .unwrap_or_else(|| "UNKNOWN".to_string());
            let win_bool = participant_bool(participant, stats, "win").unwrap_or(false);
            let puuid_for_identity = puuid.clone();
            let summoner_name_for_identity = summoner_name.clone();

            let mut row = Map::new();
            row.insert("participantId".to_string(), Value::from(participant_id));
            row.insert("puuid".to_string(), Value::String(puuid));
            row.insert("teamId".to_string(), Value::from(team_id));
            row.insert("championId".to_string(), Value::from(champion_id));
            row.insert(
                "spell1Id".to_string(),
                participant_number(participant, stats, "spell1Id"),
            );
            row.insert(
                "spell2Id".to_string(),
                participant_number(participant, stats, "spell2Id"),
            );
            row.insert("accountId".to_string(), number_json(account_id));
            row.insert("summonerId".to_string(), number_json(summoner_id));
            row.insert("profileIconId".to_string(), number_json(profile_icon_id));
            row.insert("summonerName".to_string(), string_json(summoner_name));
            row.insert("gameName".to_string(), string_json(game_name));
            row.insert("tagLine".to_string(), string_json(tag_line));
            row.insert("position".to_string(), Value::String(position));
            row.insert("win".to_string(), Value::String(if win_bool {
                "Win".to_string()
            } else {
                "Fail".to_string()
            }));
            row.insert("winBool".to_string(), Value::Bool(win_bool));

            for key in [
                "champLevel",
                "kills",
                "deaths",
                "assists",
                "item0",
                "item1",
                "item2",
                "item3",
                "item4",
                "item5",
                "item6",
                "goldEarned",
                "goldSpent",
                "physicalDamageDealtToChampions",
                "magicDamageDealtToChampions",
                "trueDamageDealtToChampions",
                "totalDamageDealtToChampions",
                "totalDamageTaken",
                "totalMinionsKilled",
                "neutralMinionsKilled",
                "visionScore",
                "wardsPlaced",
                "perk0",
                "perk1",
                "perk2",
                "perk3",
                "perk4",
                "perk5",
                "perkPrimaryStyle",
                "perkSubStyle",
                "doubleKills",
                "tripleKills",
                "quadraKills",
                "pentaKills",
                "largestKillingSpree",
                "turretKills",
            ] {
                row.insert(key.to_string(), participant_number(participant, stats, key));
            }
            for key in ["firstBloodKill", "firstBloodAssist"] {
                row.insert(
                    key.to_string(),
                    bool_json(participant_bool(participant, stats, key)),
                );
            }

            row.insert(
                "rawStats".to_string(),
                if stats.is_object() {
                    stats.clone()
                } else {
                    Value::Object(Map::new())
                },
            );
            row.insert(
                "rawTimeline".to_string(),
                participant.get("timeline").cloned().unwrap_or(Value::Null),
            );
            row.insert(
                "rawIdentity".to_string(),
                if identity_player.is_object() {
                    identity_player.clone()
                } else {
                    let mut identity_row = Map::new();
                    identity_row.insert(
                        "puuid".to_string(),
                        Value::String(puuid_for_identity),
                    );
                    if let Some(id) = summoner_id {
                        identity_row.insert("summonerId".to_string(), Value::from(id));
                    }
                    if let Some(name) = summoner_name_for_identity {
                        identity_row.insert("summonerName".to_string(), Value::String(name));
                    }
                    Value::Object(identity_row)
                },
            );
            Some(Value::Object(row))
        })
        .collect()
}

fn team_rows(detail: &Value, sgp_detail: Option<&Value>) -> Vec<Value> {
    let payload = sgp_detail.unwrap_or(detail);
    payload
        .get("teams")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|team| {
            let team_id = number_value(team, "teamId")?;
            let mut row = Map::new();
            row.insert("teamId".to_string(), Value::from(team_id));
            row.insert(
                "win".to_string(),
                bool_json(bool_value(team, "win")),
            );
            for (key, objective, objective_key) in [
                ("baronKills", "baron", "kills"),
                ("dragonKills", "dragon", "kills"),
                ("towerKills", "tower", "kills"),
                ("inhibitorKills", "inhibitor", "kills"),
                ("riftHeraldKills", "riftHerald", "kills"),
                ("hordeKills", "horde", "kills"),
                ("vilemawKills", "vilemaw", "kills"),
            ] {
                row.insert(
                    key.to_string(),
                    number_json(number_value(team, key).or_else(|| {
                        nested_nested_number(team, "objectives", objective, objective_key)
                            .or_else(|| nested_number(team, objective, objective_key))
                    })),
                );
            }
            for (key, objective) in [
                ("firstBaron", "baron"),
                ("firstBlood", "champion"),
                ("firstInhibitor", "inhibitor"),
                ("firstTower", "tower"),
            ] {
                row.insert(
                    key.to_string(),
                    bool_json(bool_value(team, key).or_else(|| {
                        nested_nested_bool(team, "objectives", objective, "first")
                            .or_else(|| nested_bool(team, objective, "first"))
                    })),
                );
            }
            row.insert(
                "bans".to_string(),
                team.get("bans")
                    .cloned()
                    .unwrap_or_else(|| Value::Array(Vec::new())),
            );
            row.insert(
                "objectives".to_string(),
                team.get("objectives")
                    .cloned()
                    .unwrap_or_else(|| Value::Object(Map::new())),
            );
            row.insert(
                "feats".to_string(),
                team.get("feats")
                    .cloned()
                    .unwrap_or_else(|| Value::Object(Map::new())),
            );
            Some(Value::Object(row))
        })
        .collect()
}

pub struct DatabaseState {
    /// 死号状态标：初始化失败时为 None，请求层短路返回错误。
    pool: Option<Arc<Pool>>,
    status: Arc<RwLock<DatabaseStatus>>,
    /// 建表失败时允许后续 IPC 请求自动重试，而不是永久处于不可用状态。
    schema_ready: Arc<AtomicBool>,
    schema_lock: Arc<Mutex<()>>,
}

impl DatabaseState {
    pub async fn initialize() -> Self {
        let status = Arc::new(RwLock::new(DatabaseStatus {
            available: false,
            message: "正在连接 PostgreSQL".to_string(),
            checked_at: now_unix(),
        }));
        let schema_ready = Arc::new(AtomicBool::new(false));
        let schema_lock = Arc::new(Mutex::new(()));
        let started = std::time::Instant::now();

        // 解析 DATABASE_URL；死号配置立刻短路，不创建池。
        let pg_config = match DATABASE_URL.parse::<tokio_postgres::Config>() {
            Ok(config) => config,
            Err(error) => {
                tracing::error!(
                    target: "db.cache",
                    duration_ms = started.elapsed().as_millis() as u64,
                    error = %error,
                    "DATABASE_URL 解析失败"
                );
                let mut current = status.write().await;
                current.message = format!("DATABASE_URL 解析失败: {error}");
                current.checked_at = now_unix();
                return Self {
                    pool: None,
                    status: status.clone(),
                    schema_ready: schema_ready.clone(),
                    schema_lock: schema_lock.clone(),
                };
            }
        };

        let mgr_config = ManagerConfig {
            recycling_method: RecyclingMethod::Fast,
        };
        let manager = Manager::from_config(pg_config, NoTls, mgr_config);
        // 16 个连接足以应对单窗口内同时拉 10 名玩家历史的峰值。
        // deadpool 内部 lazy-create，到上限后再 acquire 会等待空闲连接。
        let pool = match Pool::builder(manager).max_size(16).build() {
            Ok(pool) => Arc::new(pool),
            Err(error) => {
                tracing::error!(
                    target: "db.cache",
                    duration_ms = started.elapsed().as_millis() as u64,
                    error = %error,
                    "数据库连接池构建失败"
                );
                let mut current = status.write().await;
                current.message = format!("数据库连接池构建失败: {error}");
                current.checked_at = now_unix();
                return Self {
                    pool: None,
                    status: status.clone(),
                    schema_ready: schema_ready.clone(),
                    schema_lock: schema_lock.clone(),
                };
            }
        };

        // 启动期跑一次 SCHEMA + 增量迁移，确保新库、删空后的库和旧版本库
        // 都能得到同一套表结构。失败仍保留 pool，后续第一次业务请求会重试。
        match tokio::time::timeout(
            std::time::Duration::from_secs(15),
            Self::apply_schema(&pool),
        )
        .await
        {
            Err(_) => {
                tracing::warn!(
                    target: "db.cache",
                    timeout_secs = 15,
                    duration_ms = started.elapsed().as_millis() as u64,
                    "数据库连接超时"
                );
                let mut current = status.write().await;
                current.message = "连接 PostgreSQL 超时（15 秒），后续请求将自动重试".to_string();
                current.checked_at = now_unix();
            }
            Ok(Ok(())) => {
                tracing::info!(
                    target: "db.cache",
                    duration_ms = started.elapsed().as_millis() as u64,
                    "数据库连接池就绪，表结构已就绪"
                );
                schema_ready.store(true, Ordering::Release);
                let mut current = status.write().await;
                current.available = true;
                current.message = "PostgreSQL 已连接，缓存表已就绪".to_string();
                current.checked_at = now_unix();
            }
            Ok(Err(error)) => {
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

        Self {
            pool: Some(pool),
            status,
            schema_ready,
            schema_lock,
        }
    }

    async fn apply_schema(pool: &Arc<Pool>) -> Result<(), String> {
        let mut client = pool.get().await.map_err(|error| error.to_string())?;
        let transaction = client
            .transaction()
            .await
            .map_err(|error| error.to_string())?;
        transaction
            .batch_execute(SCHEMA)
            .await
            .map_err(|error| error.to_string())?;
        transaction
            .batch_execute(MIGRATIONS)
            .await
            .map_err(|error| error.to_string())?;
        transaction.commit().await.map_err(|error| error.to_string())?;
        Ok(())
    }

    async fn ensure_schema(&self) -> Result<(), String> {
        if self.schema_ready.load(Ordering::Acquire) {
            return Ok(());
        }

        let _guard = self.schema_lock.lock().await;
        if self.schema_ready.load(Ordering::Acquire) {
            return Ok(());
        }

        let pool = self
            .pool
            .as_ref()
            .ok_or_else(|| "数据库连接池未初始化".to_string())?;
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            Self::apply_schema(pool),
        )
        .await
        .map_err(|_| "数据库表结构初始化超时（15 秒）".to_string())?
        .map_err(|error| format!("数据库表结构初始化失败: {error}"));

        match result {
            Ok(()) => {
                self.schema_ready.store(true, Ordering::Release);
                let mut current = self.status.write().await;
                current.available = true;
                current.message = "PostgreSQL 已连接，缓存表已就绪".to_string();
                current.checked_at = now_unix();
                Ok(())
            }
            Err(error) => {
                let mut current = self.status.write().await;
                current.available = false;
                current.message = error.clone();
                current.checked_at = now_unix();
                tracing::error!(target: "db.cache", error = %error, "数据库表结构自动重试失败");
                Err(error)
            }
        }
    }

    pub async fn status(&self) -> DatabaseStatus {
        if !self.schema_ready.load(Ordering::Acquire) {
            let _ = self.ensure_schema().await;
        }
        let mut current = self.status.read().await.clone();
        if current.available {
            if let Some(pool) = self.pool.as_ref() {
                match pool.get().await {
                    Ok(client) => {
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
                    Err(error) => {
                        tracing::warn!(
                            target: "db.cache",
                            error = %error,
                            "数据库连接获取失败"
                        );
                        current.available = false;
                        current.message = format!("PostgreSQL 连接池耗尽: {error}");
                        current.checked_at = now_unix();
                        *self.status.write().await = current.clone();
                    }
                }
            } else {
                current.available = false;
                current.message = "数据库连接池未初始化".to_string();
                current.checked_at = now_unix();
                *self.status.write().await = current.clone();
            }
        }
        current
    }

    /// 从 deadpool_postgres::Pool 借出一条连接。失败时把最近一次
    /// status 文本带回调用方，便于在 IPC 层还原错误。
    async fn require_client(&self) -> Result<deadpool_postgres::Object, String> {
        self.ensure_schema().await?;
        let pool = self.pool.as_ref().ok_or_else(|| {
            // 这里不在 async 上下文里，需要先读出 status 文本再返回。
            // try_read 在写入锁持有时立即失败（不阻塞）—— 这里我们只读
            // 已有的 message，不会与初始化路径产生竞态。
            self.status
                .try_read()
                .ok()
                .map(|guard| guard.message.clone())
                .unwrap_or_else(|| "数据库连接池未初始化".to_string())
        })?;
        pool.get().await.map_err(|error| {
            tracing::warn!(
                target: "db.cache",
                error = %error,
                "数据库连接池获取连接失败"
            );
            format!("PostgreSQL 连接不可用: {error}")
        })
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

        let mut client = self.require_client().await?;
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
        let client = self.require_client().await?;
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
                     WHERE (
                            $2::TEXT IS NULL
                         OR m.mode_key = $2
                         OR ($2 = 'match' AND m.queue_id IN (400, 430, 490))
                         OR ($2 = 'ranked' AND m.queue_id IN (420, 440))
                         OR ($2 = 'aram' AND m.queue_id IN (450))
                         OR ($2 = 'hex-aram' AND m.queue_id IN (2400, 2401))
                         OR ($2 = 'other' AND m.queue_id NOT IN (400, 430, 490, 420, 440, 450, 2400, 2401))
                     )
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

    pub async fn cached_team_history(
        &self,
        request: CachedTeamHistoryQuery,
    ) -> Result<Vec<CachedMatchGame>, String> {
        let puuids: Vec<String> = request
            .puuids
            .into_iter()
            .filter(|puuid| !puuid.trim().is_empty())
            .collect();
        if puuids.len() < 2 {
            return Ok(Vec::new());
        }
        let limit = request.limit.clamp(1, 500);
        let client = self.require_client().await?;
        let rows = client
            .query(
                "WITH selected_matches AS (
                     SELECT m.game_id, m.game_creation, m.queue_id, m.mode_key, m.source
                       FROM matches m
                      WHERE EXISTS (
                            SELECT 1 FROM match_participants target
                             WHERE target.game_id = m.game_id
                               AND target.puuid = ANY($1::TEXT[])
                      )
                        AND (
                               $2::TEXT IS NULL
                            OR m.mode_key = $2
                            OR ($2 = 'match' AND m.queue_id IN (400, 430, 490))
                            OR ($2 = 'ranked' AND m.queue_id IN (420, 440))
                            OR ($2 = 'aram' AND m.queue_id IN (450))
                            OR ($2 = 'hex-aram' AND m.queue_id IN (2400, 2401))
                            OR ($2 = 'other' AND m.queue_id NOT IN (400, 430, 490, 420, 440, 450, 2400, 2401))
                        )
                      ORDER BY m.game_creation DESC
                      LIMIT $3
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
                &[&puuids, &request.mode_key, &limit],
            )
            .await
            .map_err(|error| error.to_string())?;

        rows.into_iter()
            .map(|row| {
                let participants_value: Value = row.get("participants");
                Ok(CachedMatchGame {
                    game_id: row.get("game_id"),
                    game_creation: row.get("game_creation"),
                    queue_id: row.get("queue_id"),
                    mode_key: row.get("mode_key"),
                    source: row.get("source"),
                    participants: serde_json::from_value(participants_value)
                        .map_err(|error| format!("团队缓存参与者解析失败: {error}"))?,
                })
            })
            .collect()
    }

    pub async fn summary(&self) -> Result<DatabaseSummary, String> {
        let started = std::time::Instant::now();
        tracing::info!(
            target: "db.cache",
            op = "summary",
            purpose = "读取 PostgreSQL 全局汇总",
            "读取全局汇总发起"
        );
        let client = self.require_client().await?;
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
        let client = self.require_client().await?;
        let summary_row = client
            .query_one(
                "WITH player_matches AS (
                     SELECT m.game_id, m.game_creation, target.win
                     FROM matches m
                     JOIN match_participants target
                       ON target.game_id = m.game_id
                      AND target.puuid = $1
                     WHERE (
                            $2::TEXT IS NULL
                         OR m.mode_key = $2
                         OR ($2 = 'match' AND m.queue_id IN (400, 430, 490))
                         OR ($2 = 'ranked' AND m.queue_id IN (420, 440))
                         OR ($2 = 'aram' AND m.queue_id IN (450))
                         OR ($2 = 'hex-aram' AND m.queue_id IN (2400, 2401))
                         OR ($2 = 'other' AND m.queue_id NOT IN (400, 430, 490, 420, 440, 450, 2400, 2401))
                     )
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
                 WHERE (
                        $2::TEXT IS NULL
                     OR m.mode_key = $2
                     OR ($2 = 'match' AND m.queue_id IN (400, 430, 490))
                     OR ($2 = 'ranked' AND m.queue_id IN (420, 440))
                     OR ($2 = 'aram' AND m.queue_id IN (450))
                     OR ($2 = 'hex-aram' AND m.queue_id IN (2400, 2401))
                     OR ($2 = 'other' AND m.queue_id NOT IN (400, 430, 490, 420, 440, 450, 2400, 2401))
                 )
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

    /// 从基础历史缓存和字段化详情缓存生成一个可复现的历史分析快照。
    ///
    /// 基础表保证即使详情尚未缓存也能显示胜率、英雄、位置和 KDA；
    /// 深度指标只使用 game_detail_participants / game_detail_teams 中真实存在
    /// 的字段，绝不把缺失值当成 0。
    pub async fn history_analysis_snapshot(
        &self,
        request: HistoryAnalysisQuery,
    ) -> Result<HistoryAnalysisSnapshot, String> {
        let started = std::time::Instant::now();
        let puuid = request.puuid.trim().to_string();
        if puuid.is_empty() {
            return Err("历史分析请求缺少 puuid".to_string());
        }
        let window_size = request.window_size.clamp(1, 500);
        let client = self.require_client().await?;

        let selected_rows = client
            .query(
                r#"
                SELECT m.game_id, m.game_creation, m.source,
                       gd.game_duration,
                       target.champion_id AS target_champion_id,
                       target.position AS target_position,
                       target.kills AS target_kills,
                       target.deaths AS target_deaths,
                       target.assists AS target_assists,
                       target.win AS target_win
                  FROM matches m
                  JOIN match_participants target
                    ON target.game_id = m.game_id
                   AND target.puuid = $1
             LEFT JOIN game_details gd
                    ON gd.game_id = m.game_id
                 WHERE (
                        $2::TEXT IS NULL
                     OR m.mode_key = $2
                     OR ($2 = 'match' AND m.queue_id IN (400, 430, 490))
                     OR ($2 = 'ranked' AND m.queue_id IN (420, 440))
                     OR ($2 = 'aram' AND m.queue_id IN (450))
                     OR ($2 = 'hex-aram' AND m.queue_id IN (2400, 2401))
                     OR ($2 = 'other' AND m.queue_id NOT IN (400, 430, 490, 420, 440, 450, 2400, 2401))
                 )
                   AND (
                        $3::TEXT IS NULL
                     OR $3 = 'all'
                     OR ($3 = 'win' AND target.win)
                     OR ($3 = 'loss' AND NOT target.win)
                   )
              ORDER BY m.game_creation DESC, m.game_id DESC
                 LIMIT $4
                "#,
                &[
                    &puuid,
                    &request.mode_key,
                    &request.result,
                    &window_size,
                ],
            )
            .await
            .map_err(|error| format!("读取历史分析基础数据失败: {error}"))?;

        let selected: Vec<SelectedHistoryGame> = selected_rows
            .into_iter()
            .map(|row| SelectedHistoryGame {
                game_id: row.get("game_id"),
                game_creation: row.get("game_creation"),
                source: row.get("source"),
                game_duration: row.try_get("game_duration").ok(),
                champion_id: row.get("target_champion_id"),
                position: row.get("target_position"),
                kills: row.get("target_kills"),
                deaths: row.get("target_deaths"),
                assists: row.get("target_assists"),
                win: row.get("target_win"),
            })
            .collect();

        let game_ids: Vec<i64> = selected.iter().map(|game| game.game_id).collect();
        let mut detail_by_game: HashMap<i64, Vec<DetailHistoryParticipant>> = HashMap::new();
        let mut team_by_game: HashMap<i64, Vec<DetailHistoryTeam>> = HashMap::new();

        if !game_ids.is_empty() {
            let detail_rows = client
                .query(
                    r#"
                    SELECT dp.game_id, dp.puuid, dp.team_id, dp.champion_id,
                           COALESCE(mp.position, 'UNKNOWN') AS position,
                           dp.kills, dp.deaths, dp.assists, dp.win,
                           dp.gold_earned, dp.total_damage_dealt_to_champions,
                           dp.total_damage_taken, dp.total_minions_killed,
                           dp.neutral_minions_killed, dp.vision_score,
                           dp.first_blood_kill
                      FROM game_detail_participants dp
                 LEFT JOIN match_participants mp
                        ON mp.game_id = dp.game_id
                       AND mp.puuid = dp.puuid
                     WHERE dp.game_id = ANY($1)
                    "#,
                    &[&game_ids],
                )
                .await
                .map_err(|error| format!("读取历史分析详情参与者失败: {error}"))?;

            for row in detail_rows {
                let win_text: Option<String> = row.try_get("win").ok().flatten();
                detail_by_game
                    .entry(row.get("game_id"))
                    .or_default()
                    .push(DetailHistoryParticipant {
                        puuid: row.get("puuid"),
                        team_id: row.get("team_id"),
                        champion_id: row.get("champion_id"),
                        position: row.get("position"),
                        kills: row_opt_i32(&row, "kills"),
                        deaths: row_opt_i32(&row, "deaths"),
                        assists: row_opt_i32(&row, "assists"),
                        win: parse_detail_win(win_text.as_deref()),
                        gold_earned: row_opt_i32(&row, "gold_earned"),
                        total_damage_to_champions:
                            row_opt_i32(&row, "total_damage_dealt_to_champions"),
                        total_damage_taken: row_opt_i32(&row, "total_damage_taken"),
                        total_minions: row_opt_i32(&row, "total_minions_killed"),
                        neutral_minions: row_opt_i32(&row, "neutral_minions_killed"),
                        vision_score: row_opt_i32(&row, "vision_score"),
                        first_blood_kill: row_opt_bool(&row, "first_blood_kill"),
                    });
            }

            let team_rows = client
                .query(
                    r#"
                    SELECT game_id, team_id, dragon_kills, baron_kills,
                           tower_kills, rift_herald_kills, first_tower
                      FROM game_detail_teams
                     WHERE game_id = ANY($1)
                    "#,
                    &[&game_ids],
                )
                .await
                .map_err(|error| format!("读取历史分析队伍目标数据失败: {error}"))?;
            for row in team_rows {
                team_by_game
                    .entry(row.get("game_id"))
                    .or_default()
                    .push(DetailHistoryTeam {
                        team_id: row.get("team_id"),
                        dragon_kills: row_opt_i32(&row, "dragon_kills"),
                        baron_kills: row_opt_i32(&row, "baron_kills"),
                        tower_kills: row_opt_i32(&row, "tower_kills"),
                        rift_herald_kills: row_opt_i32(&row, "rift_herald_kills"),
                        first_tower: row_opt_bool(&row, "first_tower"),
                    });
            }
        }

        let mut total_wins = 0_i64;
        let mut recent_wins = 0_i64;
        let mut previous_wins = 0_i64;
        let mut detail_games = 0_i64;
        let mut complete_games = 0_i64;
        let mut sources = HashSet::new();
        let mut metric_coverage = HashMap::new();
        let mut trend = Vec::with_capacity(selected.len());
        let mut by_champion: HashMap<i32, HistoryDimensionAccumulator> = HashMap::new();
        let mut by_position: HashMap<String, HistoryDimensionAccumulator> = HashMap::new();
        let mut kda = MetricAccumulator::default();
        let mut damage_per_minute = MetricAccumulator::default();
        let mut gold_per_minute = MetricAccumulator::default();
        let mut cs_per_minute = MetricAccumulator::default();
        let mut vision_per_minute = MetricAccumulator::default();
        let mut team_damage_share = MetricAccumulator::default();
        let mut damage_taken_per_minute = MetricAccumulator::default();
        let mut team_objective_score = MetricAccumulator::default();
        let mut first_blood_rate = MetricAccumulator::default();
        let mut first_tower_rate = MetricAccumulator::default();
        let mut streak_type = "none".to_string();
        let mut streak_count = 0_i64;

        for (index, game) in selected.iter().enumerate() {
            sources.insert(game.source.clone());
            let detail_rows = detail_by_game.get(&game.game_id);
            let target_detail = detail_rows
                .and_then(|rows| rows.iter().find(|participant| participant.puuid == puuid));
            let target_win = target_detail.map(|participant| participant.win).unwrap_or(game.win);
            let champion_id = target_detail
                .map(|participant| participant.champion_id)
                .unwrap_or(game.champion_id);
            let position = target_detail
                .map(|participant| participant.position.clone())
                .unwrap_or_else(|| game.position.clone());
            let kills = target_detail
                .and_then(|participant| participant.kills)
                .unwrap_or(game.kills);
            let deaths = target_detail
                .and_then(|participant| participant.deaths)
                .unwrap_or(game.deaths);
            let assists = target_detail
                .and_then(|participant| participant.assists)
                .unwrap_or(game.assists);
            let kda_value = (kills.max(0) + assists.max(0)) as f64
                / deaths.max(1) as f64;

            if target_win {
                total_wins += 1;
            }
            if index < 10 && target_win {
                recent_wins += 1;
            } else if (10..20).contains(&index) && target_win {
                previous_wins += 1;
            }
            if index == 0 {
                streak_type = if target_win { "win" } else { "loss" }.to_string();
                streak_count = 1;
            } else if (target_win && streak_type == "win") || (!target_win && streak_type == "loss") {
                streak_count += 1;
            }

            let duration_minutes = game
                .game_duration
                .filter(|duration| *duration > 0)
                .map(|duration| duration as f64 / 60.0);
            let detail_available = target_detail.is_some();
            if detail_available {
                detail_games += 1;
            }
            if detail_rows.map(|rows| rows.len()).unwrap_or_default() >= 10 {
                complete_games += 1;
            }

            let metrics = if let Some(target) = target_detail {
                let team_damage: i64 = detail_rows
                    .into_iter()
                    .flat_map(|rows| rows.iter())
                    .filter(|participant| participant.team_id == target.team_id)
                    .filter_map(|participant| participant.total_damage_to_champions)
                    .map(i64::from)
                    .sum();
                let target_damage = target.total_damage_to_champions.map(i64::from);
                let team_summary = team_by_game.get(&game.game_id).map(|rows| {
                    rows.iter()
                        .filter(|row| row.team_id == target.team_id)
                        .fold(None, |summary: Option<(i64, Option<bool>)>, row| {
                            let (score, first_tower) = summary.unwrap_or((0, None));
                            Some((
                                score
                                    + i64::from(row.dragon_kills.unwrap_or_default())
                                    + i64::from(row.baron_kills.unwrap_or_default())
                                    + i64::from(row.tower_kills.unwrap_or_default())
                                    + i64::from(row.rift_herald_kills.unwrap_or_default()),
                                row.first_tower.or(first_tower),
                            ))
                        })
                });
                let objective_score = team_summary
                    .as_ref()
                    .and_then(|summary| summary.as_ref())
                    .map(|(score, _)| *score as f64);
                let first_tower = team_summary
                    .and_then(|summary| summary.and_then(|(_, first_tower)| first_tower));
                let duration = duration_minutes;
                HistoryGameMetrics {
                    kda: kda_value,
                    damage_per_minute: duration.and_then(|minutes| {
                        target_damage.map(|damage| damage as f64 / minutes)
                    }),
                    gold_per_minute: duration.and_then(|minutes| {
                        target.gold_earned.map(|gold| gold as f64 / minutes)
                    }),
                    cs_per_minute: duration.and_then(|minutes| {
                        target
                            .total_minions
                            .zip(target.neutral_minions)
                            .map(|(minions, neutral)| (minions + neutral) as f64 / minutes)
                    }),
                    vision_per_minute: duration.and_then(|minutes| {
                        target.vision_score.map(|vision| vision as f64 / minutes)
                    }),
                    team_damage_share: target_damage
                        .filter(|_| team_damage > 0)
                        .map(|damage| damage as f64 / team_damage as f64 * 100.0),
                    damage_taken_per_minute: duration.and_then(|minutes| {
                        target
                            .total_damage_taken
                            .map(|damage| damage as f64 / minutes)
                    }),
                    team_objective_score: objective_score,
                    first_blood_rate: target
                        .first_blood_kill
                        .map(|first_blood| if first_blood { 100.0 } else { 0.0 }),
                    first_tower_rate: first_tower
                        .map(|first_tower| if first_tower { 100.0 } else { 0.0 }),
                    detail_available: true,
                }
            } else {
                HistoryGameMetrics {
                    kda: kda_value,
                    ..HistoryGameMetrics::default()
                }
            };

            kda.add(Some(metrics.kda), target_win);
            damage_per_minute.add(metrics.damage_per_minute, target_win);
            gold_per_minute.add(metrics.gold_per_minute, target_win);
            cs_per_minute.add(metrics.cs_per_minute, target_win);
            vision_per_minute.add(metrics.vision_per_minute, target_win);
            team_damage_share.add(metrics.team_damage_share, target_win);
            damage_taken_per_minute.add(metrics.damage_taken_per_minute, target_win);
            team_objective_score.add(metrics.team_objective_score, target_win);
            first_blood_rate.add(metrics.first_blood_rate, target_win);
            first_tower_rate.add(metrics.first_tower_rate, target_win);

            by_champion
                .entry(champion_id)
                .or_default()
                .add(target_win, &metrics);
            by_position
                .entry(position.clone())
                .or_default()
                .add(target_win, &metrics);

            trend.push(HistoryTrendPoint {
                game_id: game.game_id,
                game_creation: game.game_creation,
                champion_id,
                position,
                win: target_win,
                kda: round_metric(Some(kda_value)).unwrap_or_default(),
                damage_per_minute: round_metric(metrics.damage_per_minute),
                cs_per_minute: round_metric(metrics.cs_per_minute),
                detail_available,
            });
        }

        let total_games = selected.len() as i64;
        let losses = total_games.saturating_sub(total_wins);
        let recent_games = total_games.min(10);
        let previous_games = total_games.saturating_sub(10).min(10);
        let metric_summary = HistoryMetricSummary {
            kda: kda.finish(),
            damage_per_minute: damage_per_minute.finish(),
            gold_per_minute: gold_per_minute.finish(),
            cs_per_minute: cs_per_minute.finish(),
            vision_per_minute: vision_per_minute.finish(),
            team_damage_share: team_damage_share.finish(),
            damage_taken_per_minute: damage_taken_per_minute.finish(),
            team_objective_score: team_objective_score.finish(),
            first_blood_rate: first_blood_rate.finish(),
            first_tower_rate: first_tower_rate.finish(),
        };

        metric_coverage.insert("kda".to_string(), metric_summary.kda.coverage);
        metric_coverage.insert(
            "damagePerMinute".to_string(),
            metric_summary.damage_per_minute.coverage,
        );
        metric_coverage.insert(
            "goldPerMinute".to_string(),
            metric_summary.gold_per_minute.coverage,
        );
        metric_coverage.insert(
            "csPerMinute".to_string(),
            metric_summary.cs_per_minute.coverage,
        );
        metric_coverage.insert(
            "visionPerMinute".to_string(),
            metric_summary.vision_per_minute.coverage,
        );
        metric_coverage.insert(
            "teamDamageShare".to_string(),
            metric_summary.team_damage_share.coverage,
        );
        metric_coverage.insert(
            "teamObjectiveScore".to_string(),
            metric_summary.team_objective_score.coverage,
        );

        let mut champions: Vec<HistoryChampionStat> = by_champion
            .into_iter()
            .map(|(champion_id, accumulator)| accumulator.finish_champion(champion_id))
            .collect();
        champions.sort_by(|left, right| {
            right
                .games
                .cmp(&left.games)
                .then_with(|| right.win_rate.partial_cmp(&left.win_rate).unwrap_or(std::cmp::Ordering::Equal))
        });
        let mut positions: Vec<HistoryPositionStat> = by_position
            .into_iter()
            .map(|(position, accumulator)| accumulator.finish_position(position))
            .collect();
        positions.sort_by(|left, right| {
            right
                .games
                .cmp(&left.games)
                .then_with(|| right.win_rate.partial_cmp(&left.win_rate).unwrap_or(std::cmp::Ordering::Equal))
        });

        let mut insights = Vec::new();
        let insight_metrics = [
            (
                "damagePerMinute",
                "输出",
                &metric_summary.damage_per_minute,
                100.0,
            ),
            (
                "goldPerMinute",
                "经济",
                &metric_summary.gold_per_minute,
                50.0,
            ),
            (
                "csPerMinute",
                "补刀",
                &metric_summary.cs_per_minute,
                0.5,
            ),
            (
                "visionPerMinute",
                "视野",
                &metric_summary.vision_per_minute,
                1.0,
            ),
            (
                "teamDamageShare",
                "团队输出占比",
                &metric_summary.team_damage_share,
                5.0,
            ),
        ];
        for (metric, label, stat, threshold) in insight_metrics {
            if let Some(delta) = stat.delta.filter(|delta| *delta >= threshold) {
                insights.push(HistoryAnalysisInsight {
                    kind: "difference".to_string(),
                    title: format!("胜局{label}明显更高"),
                    detail: format!(
                        "胜局平均比败局高 {:.1}，建议优先复盘败局的前期资源和团战参与。",
                        delta
                    ),
                    metric: Some(metric.to_string()),
                    delta: Some(round_metric(Some(delta)).unwrap_or(delta)),
                });
            }
        }
        if let Some(champion) = champions
            .iter()
            .find(|champion| champion.games >= 3 && champion.win_rate.unwrap_or(0.0) < 50.0)
        {
            insights.push(HistoryAnalysisInsight {
                kind: "champion".to_string(),
                title: "存在低胜率英雄".to_string(),
                detail: format!(
                    "该英雄近 {} 场胜率 {:.1}%，建议结合具体败局确认是否是阵容或熟练度问题。",
                    champion.games,
                    champion.win_rate.unwrap_or_default()
                ),
                metric: None,
                delta: None,
            });
        }
        if let Some(position) = positions
            .iter()
            .find(|position| position.games >= 3 && position.win_rate.unwrap_or(0.0) < 50.0)
        {
            insights.push(HistoryAnalysisInsight {
                kind: "position".to_string(),
                title: "某个位置表现偏弱".to_string(),
                detail: format!(
                    "{} 近 {} 场胜率 {:.1}%，可对照该位置的败局指标。",
                    position.position,
                    position.games,
                    position.win_rate.unwrap_or_default()
                ),
                metric: None,
                delta: None,
            });
        }
        if insights.is_empty() && total_games > 0 {
            insights.push(HistoryAnalysisInsight {
                kind: "quality".to_string(),
                title: "暂未发现明显短板".to_string(),
                detail: if detail_games < total_games {
                    "当前详情覆盖不足，先展示基础胜率与 KDA；继续完成更多对局详情缓存后可获得更准确的复盘建议。".to_string()
                } else {
                    "胜负差异暂未达到明显阈值，可继续查看单局证据和最近趋势。".to_string()
                },
                metric: None,
                delta: None,
            });
        }

        let mut source_list: Vec<String> = sources.into_iter().collect();
        source_list.sort();
        let quality = HistoryAnalysisQuality {
            total_games,
            detail_games,
            complete_games,
            base_coverage: if total_games > 0 { 100.0 } else { 0.0 },
            detail_coverage: if total_games > 0 {
                detail_games as f64 / total_games as f64 * 100.0
            } else {
                0.0
            },
            metric_coverage,
            sources: source_list,
            latest_game_creation: selected.first().map(|game| game.game_creation),
        };
        let result = HistoryAnalysisSnapshot {
            puuid,
            mode_key: request.mode_key,
            window_size,
            actual_games: total_games,
            wins: total_wins,
            losses,
            win_rate: rate(total_wins, total_games),
            recent_wins,
            recent_games,
            previous_wins,
            previous_games,
            streak_type,
            streak_count,
            trend,
            metrics: metric_summary,
            champions,
            positions,
            insights,
            quality,
            source: if detail_games > 0 {
                "PostgreSQL 基础缓存 + 对局详情".to_string()
            } else {
                "PostgreSQL 基础缓存".to_string()
            },
        };
        tracing::info!(
            target: "db.cache",
            op = "history_analysis_snapshot",
            purpose = "生成 PostgreSQL 历史分析快照",
            puuid = %result.puuid,
            mode_key = ?result.mode_key,
            window_size = result.window_size,
            actual_games = result.actual_games,
            detail_games = result.quality.detail_games,
            complete_games = result.quality.complete_games,
            duration_ms = started.elapsed().as_millis() as u64,
            "历史分析快照生成完成"
        );
        Ok(result)
    }

    /// 召唤师模糊搜索：只查询 summoners 表，通过 pg_trgm 的 similarity
    /// 操作符匹配 game_name / tag_line / Riot ID 组合 / summoner_name /
    /// display_name。搜索候选不读取 match_participants，也不计算战绩场数。
    pub async fn search_cached_summoners(
        &self,
        request: SearchCachedSummonersQuery,
    ) -> Result<Vec<CachedSummonerSearchRow>, String> {
        let started = std::time::Instant::now();
        let query = request.query.trim();
        let limit = request.limit.unwrap_or(20).clamp(1, 50);

        tracing::info!(
            target: "db.cache",
            op = "search_cached_summoners",
            purpose = "召唤师模糊搜索",
            query = %query,
            limit,
            "召唤师模糊搜索发起"
        );

        let client = self.require_client().await?;
        let rows = client
            .query(
                r#"
                SELECT summoner.puuid,
                       summoner.summoner_id,
                       summoner.game_name,
                       summoner.tag_line,
                       summoner.display_name,
                       summoner.summoner_name,
                       summoner.summoner_level,
                       summoner.profile_icon_id,
                       GREATEST(
                           similarity(COALESCE(summoner.game_name, ''),     $1),
                           similarity(COALESCE(summoner.tag_line, ''),      $1),
                           similarity(
                               COALESCE(summoner.game_name, '') ||
                               CASE WHEN COALESCE(summoner.tag_line, '') = ''
                                    THEN '' ELSE '#' || summoner.tag_line END,
                               $1
                           ),
                           similarity(COALESCE(summoner.summoner_name, ''), $1),
                           similarity(COALESCE(summoner.display_name, ''),  $1)
                       )::REAL AS sim
                  FROM summoners AS summoner
                 WHERE (
                       $1 = ''
                    OR summoner.game_name         % $1
                    OR summoner.tag_line          % $1
                   OR (
                       COALESCE(summoner.game_name, '') ||
                       CASE WHEN COALESCE(summoner.tag_line, '') = ''
                            THEN '' ELSE '#' || summoner.tag_line END
                   ) % $1
                   OR summoner.summoner_name     % $1
                   OR summoner.display_name      % $1
                   OR summoner.game_name         ILIKE '%' || $1 || '%'
                   OR summoner.tag_line          ILIKE '%' || $1 || '%'
                   OR (
                       COALESCE(summoner.game_name, '') ||
                       CASE WHEN COALESCE(summoner.tag_line, '') = ''
                            THEN '' ELSE '#' || summoner.tag_line END
                   ) ILIKE '%' || $1 || '%'
                   OR summoner.summoner_name     ILIKE '%' || $1 || '%'
                   OR summoner.display_name      ILIKE '%' || $1 || '%'
                   )
                 ORDER BY sim DESC,
                          summoner.updated_at DESC NULLS LAST
                 LIMIT $2
                "#,
                &[&query, &limit],
            )
            .await
            .map_err(|error| error.to_string())?;

        let result: Vec<CachedSummonerSearchRow> = rows
            .into_iter()
            .map(|row| CachedSummonerSearchRow {
                puuid: row.get("puuid"),
                summoner_id: row.get("summoner_id"),
                game_name: row.try_get("game_name").ok().flatten(),
                tag_line: row.try_get("tag_line").ok().flatten(),
                display_name: row.try_get("display_name").ok().flatten(),
                summoner_name: row.try_get("summoner_name").ok().flatten(),
                summoner_level: row.try_get("summoner_level").ok().flatten(),
                profile_icon_id: row.try_get("profile_icon_id").ok().flatten(),
                similarity: row.get("sim"),
            })
            .collect();

        tracing::info!(
            target: "db.cache",
            op = "search_cached_summoners",
            purpose = "召唤师模糊搜索",
            query = %query,
            limit,
            count = result.len(),
            duration_ms = started.elapsed().as_millis() as u64,
            "召唤师模糊搜索完成"
        );
        Ok(result)
    }

    pub async fn cache_summoners(
        &self,
        request: CacheSummonerRequest,
    ) -> Result<usize, String> {
        let started = std::time::Instant::now();
        if request.summoners.is_empty() {
            return Ok(0);
        }
        tracing::info!(
            target: "db.cache",
            op = "cache_summoners",
            purpose = "将 LCU 召唤师信息写入 PostgreSQL 缓存",
            count = request.summoners.len(),
            "缓存召唤师写入发起"
        );

        let mut client = self.require_client().await?;
        let transaction = client
            .transaction()
            .await
            .map_err(|error| error.to_string())?;

        let payload: Value = serde_json::to_value(&request.summoners)
            .map_err(|error| format!("召唤师缓存序列化失败: {error}"))?;
        transaction
            .execute(
                r#"
                INSERT INTO summoners(
                    puuid, summoner_id, account_id, display_name, internal_name,
                    game_name, tag_line, summoner_name, profile_icon_id,
                    summoner_level, xp_since_last_level, xp_until_next_level,
                    percent_complete_for_next_level, privacy, name_change_flag,
                    reroll_points, updated_at
                )
                SELECT
                    s."puuid",
                    s."summonerId",
                    s."accountId",
                    NULLIF(s."displayName", ''),
                    NULLIF(s."internalName", ''),
                    NULLIF(s."gameName", ''),
                    NULLIF(s."tagLine", ''),
                    COALESCE(NULLIF(s."gameName", ''), NULLIF(s."displayName", ''), NULLIF(s."internalName", '')),
                    s."profileIconId",
                    s."summonerLevel",
                    s."xpSinceLastLevel",
                    s."xpUntilNextLevel",
                    s."percentCompleteForNextLevel",
                    NULLIF(s."privacy", ''),
                    s."nameChangeFlag",
                    s."rerollPoints",
                    NOW()
                FROM jsonb_to_recordset($1::jsonb) AS s(
                    "puuid" TEXT,
                    "summonerId" BIGINT,
                    "accountId" BIGINT,
                    "displayName" TEXT,
                    "internalName" TEXT,
                    "gameName" TEXT,
                    "tagLine" TEXT,
                    "profileIconId" INTEGER,
                    "summonerLevel" BIGINT,
                    "xpSinceLastLevel" BIGINT,
                    "xpUntilNextLevel" BIGINT,
                    "percentCompleteForNextLevel" INTEGER,
                    "privacy" TEXT,
                    "nameChangeFlag" BOOLEAN,
                    "rerollPoints" JSONB
                )
                ON CONFLICT(puuid) DO UPDATE SET
                    summoner_id = EXCLUDED.summoner_id,
                    account_id = EXCLUDED.account_id,
                    display_name = EXCLUDED.display_name,
                    internal_name = EXCLUDED.internal_name,
                    game_name = EXCLUDED.game_name,
                    tag_line = EXCLUDED.tag_line,
                    summoner_name = EXCLUDED.summoner_name,
                    profile_icon_id = EXCLUDED.profile_icon_id,
                    summoner_level = EXCLUDED.summoner_level,
                    xp_since_last_level = EXCLUDED.xp_since_last_level,
                    xp_until_next_level = EXCLUDED.xp_until_next_level,
                    percent_complete_for_next_level = EXCLUDED.percent_complete_for_next_level,
                    privacy = EXCLUDED.privacy,
                    name_change_flag = EXCLUDED.name_change_flag,
                    reroll_points = EXCLUDED.reroll_points,
                    updated_at = NOW()
                "#,
                &[&payload],
            )
            .await
            .map_err(|error| error.to_string())?;

        transaction.commit().await.map_err(|error| error.to_string())?;
        tracing::info!(
            target: "db.cache",
            op = "cache_summoners",
            purpose = "将 LCU 召唤师信息写入 PostgreSQL 缓存",
            count = request.summoners.len(),
            duration_ms = started.elapsed().as_millis() as u64,
            "缓存召唤师已写入"
        );
        Ok(request.summoners.len())
    }

    fn parse_cached_summoner(row: &tokio_postgres::Row) -> Result<CachedSummonerRow, String> {
        Ok(CachedSummonerRow {
            puuid: row.get("puuid"),
            summoner_id: row.get("summoner_id"),
            account_id: row.try_get("account_id").ok(),
            display_name: row.try_get("display_name").ok(),
            internal_name: row.try_get("internal_name").ok(),
            game_name: row.try_get("game_name").ok(),
            tag_line: row.try_get("tag_line").ok(),
            summoner_name: row.try_get("summoner_name").ok(),
            profile_icon_id: row.try_get("profile_icon_id").ok(),
            summoner_level: row.try_get("summoner_level").ok(),
            xp_since_last_level: row.try_get("xp_since_last_level").ok(),
            xp_until_next_level: row.try_get("xp_until_next_level").ok(),
            percent_complete_for_next_level: row
                .try_get("percent_complete_for_next_level")
                .ok(),
            privacy: row.try_get("privacy").ok(),
            name_change_flag: row.try_get("name_change_flag").ok(),
            reroll_points: row.try_get("reroll_points").ok(),
            updated_at: row.get("updated_at_epoch"),
        })
    }

    pub async fn get_cached_summoner_by_puuid(
        &self,
        puuid: String,
    ) -> Result<Option<CachedSummonerRow>, String> {
        if puuid.trim().is_empty() {
            return Ok(None);
        }
        let started = std::time::Instant::now();
        tracing::info!(
            target: "db.cache",
            op = "cached_summoner_by_puuid",
            purpose = "读取 PostgreSQL 召唤师缓存",
            puuid = %puuid,
            "读取召唤师缓存发起"
        );
        let client = self.require_client().await?;
        let row = client
            .query_opt(
                "SELECT puuid, summoner_id, account_id, display_name, internal_name,
                        game_name, tag_line, summoner_name, profile_icon_id,
                        summoner_level, xp_since_last_level, xp_until_next_level,
                        percent_complete_for_next_level, privacy, name_change_flag,
                        reroll_points,
                        EXTRACT(EPOCH FROM updated_at)::BIGINT AS updated_at_epoch
                 FROM summoners WHERE puuid = $1",
                &[&puuid],
            )
            .await
            .map_err(|error| error.to_string())?;
        let result = row
            .as_ref()
            .map(Self::parse_cached_summoner)
            .transpose()?;
        match &result {
            Some(row) => tracing::info!(
                target: "db.cache",
                op = "cached_summoner_by_puuid",
                purpose = "读取 PostgreSQL 召唤师缓存",
                puuid = %puuid,
                found = true,
                updated_at = row.updated_at,
                duration_ms = started.elapsed().as_millis() as u64,
                raw_body = %serde_json::to_string(row).unwrap_or_default(),
                "读取召唤师缓存命中"
            ),
            None => tracing::info!(
                target: "db.cache",
                op = "cached_summoner_by_puuid",
                purpose = "读取 PostgreSQL 召唤师缓存",
                puuid = %puuid,
                found = false,
                duration_ms = started.elapsed().as_millis() as u64,
                "读取召唤师缓存未命中"
            ),
        }
        Ok(result)
    }

    pub async fn get_cached_summoner_by_id(
        &self,
        summoner_id: i64,
    ) -> Result<Option<CachedSummonerRow>, String> {
        if summoner_id <= 0 {
            return Ok(None);
        }
        let started = std::time::Instant::now();
        tracing::info!(
            target: "db.cache",
            op = "cached_summoner_by_id",
            purpose = "读取 PostgreSQL 召唤师缓存",
            summoner_id,
            "读取召唤师缓存发起"
        );
        let client = self.require_client().await?;
        let row = client
            .query_opt(
                "SELECT puuid, summoner_id, account_id, display_name, internal_name,
                        game_name, tag_line, summoner_name, profile_icon_id,
                        summoner_level, xp_since_last_level, xp_until_next_level,
                        percent_complete_for_next_level, privacy, name_change_flag,
                        reroll_points,
                        EXTRACT(EPOCH FROM updated_at)::BIGINT AS updated_at_epoch
                 FROM summoners WHERE summoner_id = $1",
                &[&summoner_id],
            )
            .await
            .map_err(|error| error.to_string())?;
        let result = row
            .as_ref()
            .map(Self::parse_cached_summoner)
            .transpose()?;
        match &result {
            Some(row) => tracing::info!(
                target: "db.cache",
                op = "cached_summoner_by_id",
                purpose = "读取 PostgreSQL 召唤师缓存",
                summoner_id,
                found = true,
                puuid = %row.puuid,
                updated_at = row.updated_at,
                duration_ms = started.elapsed().as_millis() as u64,
                raw_body = %serde_json::to_string(row).unwrap_or_default(),
                "读取召唤师缓存命中"
            ),
            None => tracing::info!(
                target: "db.cache",
                op = "cached_summoner_by_id",
                purpose = "读取 PostgreSQL 召唤师缓存",
                summoner_id,
                found = false,
                duration_ms = started.elapsed().as_millis() as u64,
                "读取召唤师缓存未命中"
            ),
        }
        Ok(result)
    }

    pub async fn cache_game_detail(
        &self,
        request: CacheGameDetailRequest,
    ) -> Result<i64, String> {
        let started = std::time::Instant::now();
        let game_id = number_value(&request.detail, "gameId")
            .or_else(|| {
                request
                    .sgp_detail
                    .as_ref()
                    .and_then(|detail| number_value(detail, "gameId"))
            })
            .ok_or_else(|| "缓存对局详情缺少 gameId".to_string())?;
        let has_sgp = request.sgp_detail.is_some();
        let source_label = request
            .source
            .clone()
            .unwrap_or_else(|| "lcu-game-detail".to_string());

        tracing::info!(
            target: "db.cache",
            op = "cache_game_detail",
            purpose = "将对局详情（LCU + 可选 SGP）写入 PostgreSQL 缓存",
            game_id,
            has_sgp,
            "缓存对局详情写入发起"
        );

        // SGP-only 请求把 detail 作为 raw_payload 的兼容载荷，同时把它写入
        // raw_payload_sgp；LCU + SGP 请求则保留两份原始响应。
        let detail = &request.detail;
        let sgp_detail = request.sgp_detail.as_ref();
        let game_creation = number_value(detail, "gameCreation")
            .or_else(|| sgp_detail.and_then(|value| number_value(value, "gameCreation")));
        let game_creation_date = game_creation_date_value(detail, sgp_detail, game_creation);
        let game_duration = number_value(detail, "gameDuration")
            .or_else(|| sgp_detail.and_then(|value| number_value(value, "gameDuration")))
            .and_then(|value| i32::try_from(value).ok());
        let game_mode = string_value(detail, "gameMode")
            .or_else(|| sgp_detail.and_then(|value| string_value(value, "gameMode")));
        let game_type = string_value(detail, "gameType")
            .or_else(|| sgp_detail.and_then(|value| string_value(value, "gameType")));
        let game_version = string_value(detail, "gameVersion")
            .or_else(|| sgp_detail.and_then(|value| string_value(value, "gameVersion")));
        let map_id = number_value(detail, "mapId")
            .or_else(|| sgp_detail.and_then(|value| number_value(value, "mapId")))
            .and_then(|value| i32::try_from(value).ok());
        let platform_id = string_value(detail, "platformId")
            .or_else(|| sgp_detail.and_then(|value| string_value(value, "platformId")));
        let season_id = number_value(detail, "seasonId")
            .or_else(|| sgp_detail.and_then(|value| number_value(value, "seasonId")))
            .and_then(|value| i32::try_from(value).ok());
        let queue_id = number_value(detail, "queueId")
            .or_else(|| sgp_detail.and_then(|value| number_value(value, "queueId")))
            .and_then(|value| i32::try_from(value).ok())
            .unwrap_or_default();
        let game_creation_value = game_creation.unwrap_or_default();
        // gameCreationDate 是接口返回的普通字符串，不能直接按
        // TIMESTAMPTZ 参数绑定；先按 TEXT 绑定，再在 SQL 内转换，才能避免
        // 日志里反复出现的 “error serializing parameter 2”（驱动的 0-based
        // 参数索引对应这里的第三个 SQL 参数）。JSONB 则统一使用 Json 包装器。
        let raw_payload = tokio_postgres::types::Json(detail);
        let raw_payload_sgp = sgp_detail.map(tokio_postgres::types::Json);
        let participant_rows = participant_rows(detail, sgp_detail);
        let team_rows = team_rows(detail, sgp_detail);
        let participant_payload = tokio_postgres::types::Json(&participant_rows);
        let team_payload = tokio_postgres::types::Json(&team_rows);

        // 详情可能先于历史列表落库。先补一个最小 matches 父行，后续
        // cache_history 会用真实 mode_key/source/up-to-date participants 覆盖它。
        // 这样 game_details 不会因为外键竞态而整批失败。
        let mut client = self.require_client().await?;
        let transaction = client
            .transaction()
            .await
            .map_err(|error| error.to_string())?;

        // 与 cache_history 保持同样的锁顺序：先锁定/更新玩家，再写 matches。
        // 否则历史批量写入（玩家 -> 对局）与详情写入（对局 -> 玩家）
        // 并发时可能互相等待形成 PostgreSQL deadlock。
        if !participant_rows.is_empty() {
            transaction
                .execute(
                    r#"
                    INSERT INTO match_players(puuid, summoner_id, summoner_name, updated_at)
                    SELECT DISTINCT ON (p.puuid)
                        p.puuid, p."summonerId", p."summonerName", NOW()
                    FROM jsonb_to_recordset($1::jsonb) AS p(
                        puuid TEXT, "summonerId" BIGINT, "summonerName" TEXT
                    )
                    WHERE p.puuid IS NOT NULL AND p.puuid <> ''
                    ORDER BY p.puuid, p."summonerId" NULLS LAST
                    ON CONFLICT(puuid) DO UPDATE SET
                        summoner_id = COALESCE(EXCLUDED.summoner_id, match_players.summoner_id),
                        summoner_name = COALESCE(EXCLUDED.summoner_name, match_players.summoner_name),
                        updated_at = NOW()
                    "#,
                    &[&participant_payload],
                )
                .await
                .map_err(|error| format!("详情玩家缓存写入失败: {error}"))?;
        }

        transaction
            .execute(
                r#"
                INSERT INTO matches(
                    game_id, queue_id, mode_key, game_creation, source, fetched_at
                )
                VALUES($1, $2, 'unknown', $3, $4, NOW())
                ON CONFLICT(game_id) DO UPDATE SET
                    queue_id = CASE
                        WHEN matches.queue_id = 0 THEN EXCLUDED.queue_id
                        ELSE matches.queue_id
                    END,
                    game_creation = CASE
                        WHEN matches.game_creation = 0 THEN EXCLUDED.game_creation
                        ELSE matches.game_creation
                    END,
                    source = CASE
                        WHEN matches.source = 'unknown' THEN EXCLUDED.source
                        ELSE matches.source
                    END,
                    fetched_at = NOW()
                "#,
                &[
                    &game_id,
                    &queue_id,
                    &game_creation_value,
                    &source_label,
                ],
            )
            .await
            .map_err(|error| format!("详情父表 matches 写入失败: {error}"))?;

        // 原始载荷和字段化元数据必须在同一个事务中写入。此前详情写入
        // 与 SGP 载荷更新拆成两个事务，任意一步失败都会留下不完整缓存。
        transaction
            .execute(
                r#"
                INSERT INTO game_details(
                    game_id, game_creation, game_creation_date, game_duration,
                    game_mode, game_type, game_version, map_id, platform_id,
                    season_id, raw_payload, raw_payload_sgp, source, fetched_at
                )
                VALUES(
                    $1, $2, NULLIF($3::TEXT, '')::timestamptz, $4, $5, $6, $7, $8, $9, $10,
                    $11, $12, $13, NOW()
                )
                ON CONFLICT(game_id) DO UPDATE SET
                    game_creation = EXCLUDED.game_creation,
                    game_creation_date = EXCLUDED.game_creation_date,
                    game_duration = EXCLUDED.game_duration,
                    game_mode = EXCLUDED.game_mode,
                    game_type = EXCLUDED.game_type,
                    game_version = EXCLUDED.game_version,
                    map_id = EXCLUDED.map_id,
                    platform_id = EXCLUDED.platform_id,
                    season_id = EXCLUDED.season_id,
                    raw_payload = EXCLUDED.raw_payload,
                    raw_payload_sgp = COALESCE(
                        EXCLUDED.raw_payload_sgp,
                        game_details.raw_payload_sgp
                    ),
                    source = CASE
                        WHEN game_details.source LIKE 'sgp%'
                             AND EXCLUDED.source LIKE 'lcu%' THEN 'mixed'
                        ELSE EXCLUDED.source
                    END,
                    fetched_at = NOW()
                "#,
                &[
                    &game_id,
                    &game_creation_value,
                    &game_creation_date,
                    &game_duration,
                    &game_mode,
                    &game_type,
                    &game_version,
                    &map_id,
                    &platform_id,
                    &season_id,
                    &raw_payload,
                    &raw_payload_sgp,
                    &source_label,
                ],
            )
            .await
            .map_err(|error| format!("详情主表 game_details 写入失败: {error}"))?;

        transaction
            .execute(
                "DELETE FROM game_detail_participants WHERE game_id = $1",
                &[&game_id],
            )
            .await
            .map_err(|error| error.to_string())?;
        if !participant_rows.is_empty() {
            transaction
                .execute(
                    r#"
                    INSERT INTO game_detail_participants(
                        game_id, participant_id, puuid, team_id, champion_id,
                        spell1_id, spell2_id, champ_level, kills, deaths, assists,
                        win, item0, item1, item2, item3, item4, item5, item6,
                        gold_earned, gold_spent,
                        physical_damage_dealt_to_champions,
                        magic_damage_dealt_to_champions,
                        true_damage_dealt_to_champions,
                        total_damage_dealt_to_champions, total_damage_taken,
                        total_minions_killed, neutral_minions_killed, vision_score,
                        wards_placed, perk0, perk1, perk2, perk3, perk4, perk5,
                        perk_primary_style, perk_sub_style, first_blood_kill,
                        first_blood_assist, double_kills, triple_kills, quadra_kills,
                        penta_kills, largest_killing_spree, turret_kills, account_id,
                        summoner_id, summoner_name, profile_icon_id, game_name,
                        tag_line, raw_stats, raw_timeline, raw_identity
                    )
                    SELECT
                        $1, p."participantId", p.puuid, p."teamId", p."championId",
                        p."spell1Id", p."spell2Id", p."champLevel", p.kills,
                        p.deaths, p.assists, p.win, p.item0, p.item1, p.item2,
                        p.item3, p.item4, p.item5, p.item6, p."goldEarned",
                        p."goldSpent", p."physicalDamageDealtToChampions",
                        p."magicDamageDealtToChampions", p."trueDamageDealtToChampions",
                        p."totalDamageDealtToChampions", p."totalDamageTaken",
                        p."totalMinionsKilled", p."neutralMinionsKilled",
                        p."visionScore", p."wardsPlaced", p.perk0, p.perk1,
                        p.perk2, p.perk3, p.perk4, p.perk5, p."perkPrimaryStyle",
                        p."perkSubStyle", p."firstBloodKill", p."firstBloodAssist",
                        p."doubleKills", p."tripleKills", p."quadraKills",
                        p."pentaKills", p."largestKillingSpree", p."turretKills",
                        p."accountId", p."summonerId", p."summonerName",
                        p."profileIconId", p."gameName", p."tagLine", p."rawStats",
                        p."rawTimeline", p."rawIdentity"
                    FROM jsonb_to_recordset($2::jsonb) AS p(
                        "participantId" INTEGER, puuid TEXT, "teamId" INTEGER,
                        "championId" INTEGER, "spell1Id" INTEGER, "spell2Id" INTEGER,
                        "champLevel" INTEGER, kills INTEGER, deaths INTEGER,
                        assists INTEGER, win TEXT, item0 INTEGER, item1 INTEGER,
                        item2 INTEGER, item3 INTEGER, item4 INTEGER, item5 INTEGER,
                        item6 INTEGER, "goldEarned" INTEGER, "goldSpent" INTEGER,
                        "physicalDamageDealtToChampions" INTEGER,
                        "magicDamageDealtToChampions" INTEGER,
                        "trueDamageDealtToChampions" INTEGER,
                        "totalDamageDealtToChampions" INTEGER,
                        "totalDamageTaken" INTEGER, "totalMinionsKilled" INTEGER,
                        "neutralMinionsKilled" INTEGER, "visionScore" INTEGER,
                        "wardsPlaced" INTEGER, perk0 INTEGER, perk1 INTEGER,
                        perk2 INTEGER, perk3 INTEGER, perk4 INTEGER, perk5 INTEGER,
                        "perkPrimaryStyle" INTEGER, "perkSubStyle" INTEGER,
                        "firstBloodKill" BOOLEAN, "firstBloodAssist" BOOLEAN,
                        "doubleKills" INTEGER, "tripleKills" INTEGER,
                        "quadraKills" INTEGER, "pentaKills" INTEGER,
                        "largestKillingSpree" INTEGER, "turretKills" INTEGER,
                        "accountId" BIGINT, "summonerId" BIGINT,
                        "summonerName" TEXT, "profileIconId" INTEGER,
                        "gameName" TEXT, "tagLine" TEXT, "rawStats" JSONB,
                        "rawTimeline" JSONB, "rawIdentity" JSONB
                    )
                    "#,
                    &[&game_id, &participant_payload],
                )
                .await
                .map_err(|error| format!("详情参与者明细写入失败: {error}"))?;

            transaction
                .execute(
                    r#"
                    INSERT INTO match_participants(
                        game_id, puuid, summoner_id, summoner_name, team_id,
                        champion_id, position, kills, deaths, assists, win
                    )
                    SELECT
                        $1, p.puuid, p."summonerId", p."summonerName", p."teamId",
                        p."championId", p.position, COALESCE(p.kills, 0),
                        COALESCE(p.deaths, 0), COALESCE(p.assists, 0),
                        COALESCE(p."winBool", false)
                    FROM jsonb_to_recordset($2::jsonb) AS p(
                        puuid TEXT, "summonerId" BIGINT, "summonerName" TEXT,
                        "teamId" INTEGER, "championId" INTEGER, position TEXT,
                        kills INTEGER, deaths INTEGER, assists INTEGER,
                        "winBool" BOOLEAN
                    )
                    WHERE p.puuid IS NOT NULL AND p.puuid <> ''
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
                    &[&game_id, &participant_payload],
                )
                .await
                .map_err(|error| format!("详情历史参与者写入失败: {error}"))?;
        }

        transaction
            .execute(
                "DELETE FROM game_detail_teams WHERE game_id = $1",
                &[&game_id],
            )
            .await
            .map_err(|error| format!("详情队伍旧明细清理失败: {error}"))?;
        if !team_rows.is_empty() {
            transaction
                .execute(
                    r#"
                    INSERT INTO game_detail_teams(
                        game_id, team_id, win, baron_kills, dragon_kills,
                        tower_kills, inhibitor_kills, rift_herald_kills,
                        first_baron, first_blood, first_inhibitor, first_tower,
                        horde_kills, vilemaw_kills, bans, objectives, feats
                    )
                    SELECT
                        $1, t."teamId", t.win, t."baronKills", t."dragonKills",
                        t."towerKills", t."inhibitorKills", t."riftHeraldKills",
                        t."firstBaron", t."firstBlood", t."firstInhibitor",
                        t."firstTower", t."hordeKills", t."vilemawKills",
                        t.bans, t.objectives, t.feats
                    FROM jsonb_to_recordset($2::jsonb) AS t(
                        "teamId" INTEGER, win BOOLEAN, "baronKills" INTEGER,
                        "dragonKills" INTEGER, "towerKills" INTEGER,
                        "inhibitorKills" INTEGER, "riftHeraldKills" INTEGER,
                        "firstBaron" BOOLEAN, "firstBlood" BOOLEAN,
                        "firstInhibitor" BOOLEAN, "firstTower" BOOLEAN,
                        "hordeKills" INTEGER, "vilemawKills" INTEGER,
                        bans JSONB, objectives JSONB, feats JSONB
                    )
                    "#,
                    &[&game_id, &team_payload],
                )
                .await
                .map_err(|error| format!("详情队伍明细写入失败: {error}"))?;
        }

        transaction.commit().await.map_err(|error| error.to_string())?;

        tracing::info!(
            target: "db.cache",
            op = "cache_game_detail",
            purpose = "将对局详情（LCU + 可选 SGP）写入 PostgreSQL 缓存",
            game_id,
            has_sgp,
            participants = participant_rows.len(),
            teams = team_rows.len(),
            source = %source_label,
            duration_ms = started.elapsed().as_millis() as u64,
            "缓存对局详情已写入"
        );
        Ok(game_id)
    }

    pub async fn get_cached_game_detail(
        &self,
        game_id: i64,
    ) -> Result<Option<CachedGameDetail>, String> {
        if game_id <= 0 {
            return Ok(None);
        }
        let started = std::time::Instant::now();
        tracing::info!(
            target: "db.cache",
            op = "cached_game_detail",
            purpose = "读取 PostgreSQL 对局详情缓存",
            game_id,
            "读取对局详情缓存发起"
        );
        let client = self.require_client().await?;
        let row = client
            .query_opt(
                "SELECT game_id, game_creation, game_duration, game_mode, game_type,
                        game_version, map_id, platform_id, season_id,
                        raw_payload, raw_payload_sgp, source,
                        EXTRACT(EPOCH FROM fetched_at)::BIGINT AS fetched_at_epoch
                 FROM game_details WHERE game_id = $1",
                &[&game_id],
            )
            .await
            .map_err(|error| error.to_string())?;
        let result = match row {
            Some(row) => Some(CachedGameDetail {
                game_id: row.get("game_id"),
                game_creation: row.try_get("game_creation").ok(),
                game_duration: row.try_get("game_duration").ok(),
                game_mode: row.try_get("game_mode").ok(),
                game_type: row.try_get("game_type").ok(),
                game_version: row.try_get("game_version").ok(),
                map_id: row.try_get("map_id").ok(),
                platform_id: row.try_get("platform_id").ok(),
                season_id: row.try_get("season_id").ok(),
                raw_payload: row.get("raw_payload"),
                raw_payload_sgp: row.try_get("raw_payload_sgp").ok(),
                source: row.get("source"),
                fetched_at: row.get("fetched_at_epoch"),
            }),
            None => None,
        };
        match &result {
            Some(detail) => {
                let payload_size = serde_json::to_string(&detail.raw_payload)
                    .map(|s| s.len())
                    .unwrap_or_default();
                tracing::info!(
                    target: "db.cache",
                    op = "cached_game_detail",
                    purpose = "读取 PostgreSQL 对局详情缓存",
                    game_id,
                    found = true,
                    source = %detail.source,
                    has_sgp = detail.raw_payload_sgp.is_some(),
                    payload_bytes = payload_size as i64,
                    fetched_at = detail.fetched_at,
                    duration_ms = started.elapsed().as_millis() as u64,
                    "读取对局详情缓存命中"
                );
            }
            None => tracing::info!(
                target: "db.cache",
                op = "cached_game_detail",
                purpose = "读取 PostgreSQL 对局详情缓存",
                game_id,
                found = false,
                duration_ms = started.elapsed().as_millis() as u64,
                "读取对局详情缓存未命中"
            ),
        }
        Ok(result)
    }

    pub async fn cache_game_session(
        &self,
        request: CacheGameSessionRequest,
    ) -> Result<i64, String> {
        let started = std::time::Instant::now();
        let game_id = request.game_id;
        if game_id <= 0 {
            return Err("缓存对局内阵容缺少合法 gameId".to_string());
        }

        tracing::info!(
            target: "db.cache",
            op = "cache_game_session",
            purpose = "将对局内 10 人阵容（PreEndOfGame 快照）写入 PostgreSQL",
            game_id,
            queue_id = request.queue_id,
            picks = request.picks.len(),
            phase = %request.phase,
            "缓存对局内阵容写入发起"
        );

        let mut client = self.require_client().await?;
        let transaction = client
            .transaction()
            .await
            .map_err(|error| error.to_string())?;

        transaction
            .execute(
                r#"
                INSERT INTO game_sessions(
                    game_id, queue_id, map_id, platform_id, phase, started_at
                )
                VALUES($1, $2, $3, $4, $5, NOW())
                ON CONFLICT(game_id) DO UPDATE SET
                    queue_id = EXCLUDED.queue_id,
                    map_id = EXCLUDED.map_id,
                    platform_id = EXCLUDED.platform_id,
                    phase = EXCLUDED.phase,
                    started_at = NOW()
                "#,
                &[
                    &game_id,
                    &request.queue_id,
                    &request.map_id,
                    &request.platform_id,
                    &request.phase,
                ],
            )
            .await
            .map_err(|error| error.to_string())?;

        // 阵容级 upsert：先清后插，避免 pk 相同 puuid 跨多局的旧记录残留。
        transaction
            .execute(
                "DELETE FROM session_player_picks WHERE game_id = $1",
                &[&game_id],
            )
            .await
            .map_err(|error| error.to_string())?;

        if !request.picks.is_empty() {
            let payload: Value = serde_json::to_value(&request.picks)
                .map_err(|error| format!("阵容缓存序列化失败: {error}"))?;
            transaction
                .execute(
                    r#"
                    INSERT INTO session_player_picks(
                        game_id, puuid, summoner_id, summoner_name, game_name,
                        tag_line, profile_icon_id, champion_id, spell1_id, spell2_id,
                        team_id
                    )
                    SELECT
                        $1,
                        p."puuid",
                        p."summonerId",
                        NULLIF(p."summonerName", ''),
                        NULLIF(p."gameName", ''),
                        NULLIF(p."tagLine", ''),
                        p."profileIconId",
                        p."championId",
                        p."spell1Id",
                        p."spell2Id",
                        p."teamId"
                    FROM jsonb_to_recordset($2::jsonb) AS p(
                        "puuid" TEXT,
                        "summonerId" BIGINT,
                        "summonerName" TEXT,
                        "gameName" TEXT,
                        "tagLine" TEXT,
                        "profileIconId" INTEGER,
                        "championId" INTEGER,
                        "spell1Id" INTEGER,
                        "spell2Id" INTEGER,
                        "teamId" INTEGER
                    )
                    "#,
                    &[&game_id, &payload],
                )
                .await
                .map_err(|error| error.to_string())?;
        }

        transaction.commit().await.map_err(|error| error.to_string())?;

        tracing::info!(
            target: "db.cache",
            op = "cache_game_session",
            purpose = "将对局内 10 人阵容（PreEndOfGame 快照）写入 PostgreSQL",
            game_id,
            queue_id = request.queue_id,
            picks = request.picks.len(),
            phase = %request.phase,
            duration_ms = started.elapsed().as_millis() as u64,
            "缓存对局内阵容已写入"
        );
        Ok(game_id)
    }

    pub async fn get_cached_session_for_lcu_game_id(
        &self,
        game_id: i64,
    ) -> Result<Option<CachedGameSession>, String> {
        if game_id <= 0 {
            return Ok(None);
        }
        let started = std::time::Instant::now();
        tracing::info!(
            target: "db.cache",
            op = "cached_game_session",
            purpose = "读取 PostgreSQL 对局内阵容缓存",
            game_id,
            "读取对局内阵容缓存发起"
        );
        let client = self.require_client().await?;

        let header = client
            .query_opt(
                "SELECT queue_id, map_id, platform_id, phase,
                        EXTRACT(EPOCH FROM started_at)::BIGINT AS started_at_epoch
                   FROM game_sessions WHERE game_id = $1",
                &[&game_id],
            )
            .await
            .map_err(|error| error.to_string())?;
        let header = match header {
            Some(row) => row,
            None => {
                tracing::info!(
                    target: "db.cache",
                    op = "cached_game_session",
                    purpose = "读取 PostgreSQL 对局内阵容缓存",
                    game_id,
                    found = false,
                    duration_ms = started.elapsed().as_millis() as u64,
                    "读取对局内阵容缓存完成（未命中）"
                );
                return Ok(None);
            }
        };

        // 顺序：先 team_id（ORDER 优先）后 puuid，保证 teamOne / teamTwo 顺序稳定。
        let pick_rows = client
            .query(
                "SELECT puuid, summoner_id, summoner_name, game_name, tag_line,
                        profile_icon_id, champion_id, spell1_id, spell2_id, team_id
                   FROM session_player_picks
                  WHERE game_id = $1
                  ORDER BY team_id NULLS LAST, puuid",
                &[&game_id],
            )
            .await
            .map_err(|error| error.to_string())?;
        let picks: Vec<SessionPlayerPickRow> = pick_rows
            .iter()
            .map(|row| SessionPlayerPickRow {
                puuid: row.get("puuid"),
                summoner_id: row.try_get("summoner_id").ok(),
                summoner_name: row.try_get("summoner_name").ok(),
                game_name: row.try_get("game_name").ok(),
                tag_line: row.try_get("tag_line").ok(),
                profile_icon_id: row.try_get("profile_icon_id").ok(),
                champion_id: row.try_get("champion_id").ok(),
                spell1_id: row.try_get("spell1_id").ok(),
                spell2_id: row.try_get("spell2_id").ok(),
                team_id: row.try_get("team_id").ok(),
            })
            .collect();

        tracing::info!(
            target: "db.cache",
            op = "cached_game_session",
            purpose = "读取 PostgreSQL 对局内阵容缓存",
            game_id,
            found = true,
            picks = picks.len() as i64,
            duration_ms = started.elapsed().as_millis() as u64,
            "读取对局内阵容缓存完成"
        );
        Ok(Some(CachedGameSession {
            game_id,
            queue_id: header.get("queue_id"),
            map_id: header.try_get("map_id").ok(),
            platform_id: header.try_get("platform_id").ok(),
            phase: header.get("phase"),
            started_at: header.get("started_at_epoch"),
            picks,
        }))
    }

    pub async fn cache_champion_detail(
        &self,
        request: CacheChampionDetailRequest,
    ) -> Result<i32, String> {
        let started = std::time::Instant::now();
        let champion_id = request.champion_id;
        if champion_id <= 0 {
            return Err("缓存英雄详情缺少合法 championId".to_string());
        }

        tracing::info!(
            target: "db.cache",
            op = "cache_champion_detail",
            purpose = "将 gtimg.com 英雄详情写入 PostgreSQL 缓存",
            champion_id,
            "缓存英雄详情写入发起"
        );

        let client = self.require_client().await?;
        client
            .execute(
                r#"
                INSERT INTO champion_details(champion_id, payload, fetched_at)
                VALUES($1, $2, NOW())
                ON CONFLICT(champion_id) DO UPDATE SET
                    payload = EXCLUDED.payload,
                    fetched_at = NOW()
                "#,
                &[&champion_id, &request.payload],
            )
            .await
            .map_err(|error| error.to_string())?;

        tracing::info!(
            target: "db.cache",
            op = "cache_champion_detail",
            purpose = "将 gtimg.com 英雄详情写入 PostgreSQL 缓存",
            champion_id,
            duration_ms = started.elapsed().as_millis() as u64,
            "缓存英雄详情已写入"
        );
        Ok(champion_id)
    }

    pub async fn get_cached_champion_detail(
        &self,
        champion_id: i32,
    ) -> Result<Option<CachedChampionDetail>, String> {
        if champion_id <= 0 {
            return Ok(None);
        }
        let started = std::time::Instant::now();
        tracing::info!(
            target: "db.cache",
            op = "cached_champion_detail",
            purpose = "读取 PostgreSQL 英雄详情缓存",
            champion_id,
            "读取英雄详情缓存发起"
        );
        let client = self.require_client().await?;
        let row = client
            .query_opt(
                "SELECT payload,
                        EXTRACT(EPOCH FROM fetched_at)::BIGINT AS fetched_at_epoch
                   FROM champion_details WHERE champion_id = $1",
                &[&champion_id],
            )
            .await
            .map_err(|error| error.to_string())?;
        let result = match row {
            Some(row) => Some(CachedChampionDetail {
                champion_id,
                payload: row.get("payload"),
                fetched_at: row.get("fetched_at_epoch"),
            }),
            None => None,
        };
        match &result {
            Some(detail) => {
                let payload_bytes = serde_json::to_string(&detail.payload)
                    .map(|s| s.len())
                    .unwrap_or_default();
                tracing::info!(
                    target: "db.cache",
                    op = "cached_champion_detail",
                    purpose = "读取 PostgreSQL 英雄详情缓存",
                    champion_id,
                    found = true,
                    payload_bytes = payload_bytes as i64,
                    duration_ms = started.elapsed().as_millis() as u64,
                    "读取英雄详情缓存完成"
                );
            }
            None => {
                tracing::info!(
                    target: "db.cache",
                    op = "cached_champion_detail",
                    purpose = "读取 PostgreSQL 英雄详情缓存",
                    champion_id,
                    found = false,
                    duration_ms = started.elapsed().as_millis() as u64,
                    "读取英雄详情缓存完成（未命中）"
                );
            }
        }
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
pub async fn get_cached_team_match_history(
    state: tauri::State<'_, DatabaseState>,
    request: CachedTeamHistoryQuery,
) -> Result<Vec<CachedMatchGame>, String> {
    state.cached_team_history(request).await
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

#[tauri::command]
pub async fn get_history_analysis_snapshot(
    state: tauri::State<'_, DatabaseState>,
    request: HistoryAnalysisQuery,
) -> Result<HistoryAnalysisSnapshot, String> {
    state.history_analysis_snapshot(request).await
}

#[tauri::command]
pub async fn cache_summoners(
    state: tauri::State<'_, DatabaseState>,
    request: CacheSummonerRequest,
) -> Result<usize, String> {
    state.cache_summoners(request).await
}

#[tauri::command]
pub async fn get_cached_summoner_by_puuid(
    state: tauri::State<'_, DatabaseState>,
    puuid: String,
) -> Result<Option<CachedSummonerRow>, String> {
    state.get_cached_summoner_by_puuid(puuid).await
}

#[tauri::command]
pub async fn get_cached_summoner_by_id(
    state: tauri::State<'_, DatabaseState>,
    summoner_id: i64,
) -> Result<Option<CachedSummonerRow>, String> {
    state.get_cached_summoner_by_id(summoner_id).await
}

#[tauri::command]
pub async fn cache_game_detail(
    state: tauri::State<'_, DatabaseState>,
    request: CacheGameDetailRequest,
) -> Result<i64, String> {
    state.cache_game_detail(request).await
}

#[tauri::command]
pub async fn get_cached_game_detail(
    state: tauri::State<'_, DatabaseState>,
    game_id: i64,
) -> Result<Option<CachedGameDetail>, String> {
    state.get_cached_game_detail(game_id).await
}

#[tauri::command]
pub async fn cache_game_session(
    state: tauri::State<'_, DatabaseState>,
    request: CacheGameSessionRequest,
) -> Result<i64, String> {
    state.cache_game_session(request).await
}

#[tauri::command]
pub async fn get_cached_session_for_lcu_game_id(
    state: tauri::State<'_, DatabaseState>,
    game_id: i64,
) -> Result<Option<CachedGameSession>, String> {
    state.get_cached_session_for_lcu_game_id(game_id).await
}

#[tauri::command]
pub async fn cache_champion_detail(
    state: tauri::State<'_, DatabaseState>,
    request: CacheChampionDetailRequest,
) -> Result<i32, String> {
    state.cache_champion_detail(request).await
}

#[tauri::command]
pub async fn get_cached_champion_detail(
    state: tauri::State<'_, DatabaseState>,
    champion_id: i32,
) -> Result<Option<CachedChampionDetail>, String> {
    state.get_cached_champion_detail(champion_id).await
}

#[tauri::command]
pub async fn search_cached_summoners(
    state: tauri::State<'_, DatabaseState>,
    request: SearchCachedSummonersQuery,
) -> Result<Vec<CachedSummonerSearchRow>, String> {
    state.search_cached_summoners(request).await
}
