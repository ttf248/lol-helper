use std::{
    task::Poll,
    time::{Duration, Instant},
};

use futures_util::Stream;
use tokio::{
    sync::mpsc::{unbounded_channel, UnboundedReceiver},
    sync::oneshot,
    sync::oneshot::Sender,
    task::JoinHandle,
};

use crate::shaco::{
    error::IngameClientError,
    model::ingame::*,
    utils::request::build_reqwest_client,
};

const PORT: u16 = 2999;

/// A client for the LoL-Ingame API
pub struct IngameClient(reqwest::Client);

impl IngameClient {
    /// Create a new connection to the ingame api. This will return an error if a game is not running
    pub fn new() -> Result<Self, IngameClientError> {
        tracing::info!(target: "ingame", port = PORT, "ingame client created");
        Ok(Self(build_reqwest_client(None)))
    }

    /// Checks if there is an active game \
    /// Returns true only after the loading screen
    pub async fn active_game(&self) -> bool {
        let started = Instant::now();
        let req = self
            .0
            .head(format!(
                "https://127.0.0.1:{}/GetLiveclientdataAllgamedata",
                PORT
            ))
            .timeout(Duration::from_millis(100))
            .send()
            .await;

        let result = if let Ok(req) = req {
            req.status().is_success()
        } else {
            false
        };
        tracing::debug!(
            target: "ingame",
            endpoint = "/GetLiveclientdataAllgamedata",
            duration_ms = started.elapsed().as_millis() as u64,
            result,
            "ingame.active_game result"
        );
        result
    }

    /// Checks if there is an active game \
    /// Returns true even in loading screen while other API calls still return Error
    pub async fn active_game_loadingscreen(&self) -> bool {
        let started = Instant::now();
        let req = self
            .0
            .head(format!("https://127.0.0.1:{}/Help", PORT))
            .timeout(Duration::from_millis(100))
            .send()
            .await;

        let result = if let Ok(req) = req {
            req.status().is_success()
        } else {
            false
        };
        tracing::debug!(
            target: "ingame",
            endpoint = "/Help",
            duration_ms = started.elapsed().as_millis() as u64,
            result,
            "ingame.active_game_loadingscreen result"
        );
        result
    }

    /// Checks if the game is a livegame or in spectatormode
    pub async fn is_spectator_mode(&self) -> Result<bool, IngameClientError> {
        let started = Instant::now();
        let req = self
            .0
            .head(format!(
                "https://127.0.0.1:{}/GetLiveclientdataActiveplayer",
                PORT
            ))
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(IngameClientError::from);

        let duration_ms = started.elapsed().as_millis() as u64;
        match req {
            Ok(_) => {
                tracing::debug!(
                    target: "ingame",
                    endpoint = "/GetLiveclientdataActiveplayer",
                    duration_ms,
                    spectator = false,
                    "ingame.is_spectator_mode result"
                );
                Ok(false)
            }
            Err(IngameClientError::ApiNotAvailableInSpectatorMode) => {
                tracing::debug!(
                    target: "ingame",
                    endpoint = "/GetLiveclientdataActiveplayer",
                    duration_ms,
                    spectator = true,
                    "ingame.is_spectator_mode result"
                );
                Ok(true)
            }
            Err(error) => {
                tracing::warn!(
                    target: "ingame",
                    endpoint = "/GetLiveclientdataActiveplayer",
                    duration_ms,
                    error = %error,
                    "ingame.is_spectator_mode failed"
                );
                Err(error)
            }
        }
    }

    /// Get all current game data
    pub async fn all_game_data(
        &self,
        event_id: Option<u32>,
    ) -> Result<AllGameData, IngameClientError> {
        let started = Instant::now();
        let resolved_event_id = event_id.unwrap_or(0);
        let res = self
            .0
            .get(format!(
                "https://127.0.0.1:{}/GetLiveclientdataAllgamedata?eventID={}",
                PORT, resolved_event_id
            ))
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(IngameClientError::from)?
            .json()
            .await
            .map_err(IngameClientError::from);
        tracing::debug!(
            target: "ingame",
            endpoint = "/GetLiveclientdataAllgamedata",
            event_id = resolved_event_id,
            duration_ms = started.elapsed().as_millis() as u64,
            ok = res.is_ok(),
            "ingame.all_game_data result"
        );
        res
    }

    /// Get event data for the active game
    pub async fn event_data(
        &self,
        event_id: Option<u32>,
    ) -> Result<Vec<GameEvent>, IngameClientError> {
        let started = Instant::now();
        let resolved_event_id = event_id.unwrap_or(0);
        let res = self
            .0
            .get(format!(
                "https://127.0.0.1:{}/GetLiveclientdataEventdata?eventID={}",
                PORT, resolved_event_id
            ))
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(IngameClientError::from)?
            .json::<IngameEvents>()
            .await
            .map_err(IngameClientError::from)
            .map(|ie| ie.events);
        let count: usize = res.as_ref().map(|v: &Vec<_>| v.len()).unwrap_or(0);
        tracing::trace!(
            target: "ingame",
            endpoint = "/GetLiveclientdataEventdata",
            event_id = resolved_event_id,
            duration_ms = started.elapsed().as_millis() as u64,
            count,
            ok = res.is_ok(),
            "ingame.event_data result"
        );
        res
    }

    /// Get the active games stats
    pub async fn game_stats(&self) -> Result<GameStats, IngameClientError> {
        let started = Instant::now();
        let res = self
            .0
            .get(format!(
                "https://127.0.0.1:{}/GetLiveclientdataGamestats",
                PORT
            ))
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(IngameClientError::from)?
            .json()
            .await
            .map_err(IngameClientError::from);
        tracing::debug!(
            target: "ingame",
            endpoint = "/GetLiveclientdataGamestats",
            duration_ms = started.elapsed().as_millis() as u64,
            ok = res.is_ok(),
            "ingame.game_stats result"
        );
        res
    }

    /// Get a specified players items
    pub async fn player_items<S: AsRef<str>>(
        &self,
        summoner_name: S,
    ) -> Result<Vec<PlayerItem>, IngameClientError> {
        let started = Instant::now();
        let summoner = summoner_name.as_ref();
        let res = self
            .0
            .get(format!(
                "https://127.0.0.1:{}/GetLiveclientdataPlayeritems?summonerName={}",
                PORT, summoner
            ))
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(IngameClientError::from)?
            .json()
            .await
            .map_err(IngameClientError::from);
        let count: usize = res.as_ref().map(|v: &Vec<_>| v.len()).unwrap_or(0);
        tracing::debug!(
            target: "ingame",
            endpoint = "/GetLiveclientdataPlayeritems",
            summoner = %summoner,
            duration_ms = started.elapsed().as_millis() as u64,
            count,
            ok = res.is_ok(),
            "ingame.player_items result"
        );
        res
    }

    /// Get a list of players in game
    pub async fn player_list(
        &self,
        team_id: Option<TeamId>,
    ) -> Result<Vec<Player>, IngameClientError> {
        let started = Instant::now();
        let team = team_id.unwrap_or(TeamId::All);
        let res = self
            .0
            .get(format!(
                "https://127.0.0.1:{}/GetLiveclientdataPlayerlist?teamID={}",
                PORT, team
            ))
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(IngameClientError::from)?
            .json()
            .await
            .map_err(IngameClientError::from);
        let count: usize = res.as_ref().map(|v: &Vec<_>| v.len()).unwrap_or(0);
        tracing::debug!(
            target: "ingame",
            endpoint = "/GetLiveclientdataPlayerlist",
            team_id = ?team,
            duration_ms = started.elapsed().as_millis() as u64,
            count,
            ok = res.is_ok(),
            "ingame.player_list result"
        );
        res
    }

    /// Get a specified players main runes
    pub async fn player_main_runes<S: AsRef<str>>(
        &self,
        summoner_name: S,
    ) -> Result<PlayerRunes, IngameClientError> {
        let started = Instant::now();
        let summoner = summoner_name.as_ref();
        let res = self
            .0
            .get(format!(
                "https://127.0.0.1:{}/GetLiveclientdataPlayermainrunes?summonerName={}",
                PORT, summoner
            ))
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(IngameClientError::from)?
            .json()
            .await
            .map_err(IngameClientError::from);
        tracing::debug!(
            target: "ingame",
            endpoint = "/GetLiveclientdataPlayermainrunes",
            summoner = %summoner,
            duration_ms = started.elapsed().as_millis() as u64,
            ok = res.is_ok(),
            "ingame.player_main_runes result"
        );
        res
    }

    /// Get a specified players score
    pub async fn player_scores<S: AsRef<str>>(
        &self,
        summoner_name: S,
    ) -> Result<PlayerScores, IngameClientError> {
        let started = Instant::now();
        let summoner = summoner_name.as_ref();
        let res = self
            .0
            .get(format!(
                "https://127.0.0.1:{}/GetLiveclientdataPlayerscores?summonerName={}",
                PORT, summoner
            ))
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(IngameClientError::from)?
            .json()
            .await
            .map_err(IngameClientError::from);
        tracing::debug!(
            target: "ingame",
            endpoint = "/GetLiveclientdataPlayerscores",
            summoner = %summoner,
            duration_ms = started.elapsed().as_millis() as u64,
            ok = res.is_ok(),
            "ingame.player_scores result"
        );
        res
    }

    /// Get specified players summoner spells
    pub async fn player_summoner_spells<S: AsRef<str>>(
        &self,
        summoner_name: S,
    ) -> Result<SummonerSpells, IngameClientError> {
        let started = Instant::now();
        let summoner = summoner_name.as_ref();
        let res = self
            .0
            .get(format!(
                "https://127.0.0.1:{}/GetLiveclientdataPlayersummonerspells?summonerName={}",
                PORT, summoner
            ))
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(IngameClientError::from)?
            .json()
            .await
            .map_err(IngameClientError::from);
        tracing::debug!(
            target: "ingame",
            endpoint = "/GetLiveclientdataPlayersummonerspells",
            summoner = %summoner,
            duration_ms = started.elapsed().as_millis() as u64,
            ok = res.is_ok(),
            "ingame.player_summoner_spells result"
        );
        res
    }

    /// Get active players data \
    /// Only available during livegame
    pub async fn active_player(&self) -> Result<ActivePlayer, IngameClientError> {
        let started = Instant::now();
        /// only available in live games - is Error when spectating
        #[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
        #[serde(untagged)]
        enum ActivePlayerInfo {
            ActivePlayer(Box<ActivePlayer>),
            Error { error: String },
        }

        let res = self
            .0
            .get(format!(
                "https://127.0.0.1:{}/GetLiveclientdataActiveplayer",
                PORT
            ))
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(IngameClientError::from)?
            .json::<ActivePlayerInfo>()
            .await
            .map_err(IngameClientError::from)
            .map(|i| match i {
                ActivePlayerInfo::ActivePlayer(i) => Ok(*i),
                ActivePlayerInfo::Error { error } => {
                    Err(IngameClientError::DeserializationError(error))
                }
            })?;
        tracing::debug!(
            target: "ingame",
            endpoint = "/GetLiveclientdataActiveplayer",
            duration_ms = started.elapsed().as_millis() as u64,
            ok = res.is_ok(),
            "ingame.active_player result"
        );
        res
    }

    /// Get the active players abilities \
    /// Only available during livegame
    pub async fn active_player_abilities(&self) -> Result<PlayerAbilities, IngameClientError> {
        let started = Instant::now();
        let res = self
            .0
            .get(format!(
                "https://127.0.0.1:{}/GetLiveclientdataActiveplayerabilities",
                PORT
            ))
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(IngameClientError::from)?
            .json()
            .await
            .map_err(IngameClientError::from);
        tracing::debug!(
            target: "ingame",
            endpoint = "/GetLiveclientdataActiveplayerabilities",
            duration_ms = started.elapsed().as_millis() as u64,
            ok = res.is_ok(),
            "ingame.active_player_abilities result"
        );
        res
    }

    /// Get the active players name \
    /// Only available during livegame
    pub async fn active_player_name(&self) -> Result<String, IngameClientError> {
        let started = Instant::now();
        let res = self
            .0
            .get(format!(
                "https://127.0.0.1:{}/GetLiveclientdataActiveplayername",
                PORT
            ))
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(IngameClientError::from)?
            .text()
            .await
            .map(|txt| {
                // remove the first and last character since the received text is wrapped in quotes (e.g. "playerName")
                let mut chars = txt.chars();
                chars.next();
                chars.next_back();
                chars.as_str().to_string()
            })
            .map_err(IngameClientError::from);
        tracing::debug!(
            target: "ingame",
            endpoint = "/GetLiveclientdataActiveplayername",
            duration_ms = started.elapsed().as_millis() as u64,
            ok = res.is_ok(),
            "ingame.active_player_name result"
        );
        res
    }

    /// Get the active players runes \
    /// Only available during livegames
    pub async fn active_player_runes(&self) -> Result<FullPlayerRunes, IngameClientError> {
        let started = Instant::now();
        let res = self
            .0
            .get(format!(
                "https://127.0.0.1:{}/GetLiveclientdataActiveplayerrunes",
                PORT
            ))
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(IngameClientError::from)?
            .json()
            .await
            .map_err(IngameClientError::from);
        tracing::debug!(
            target: "ingame",
            endpoint = "/GetLiveclientdataActiveplayerrunes",
            duration_ms = started.elapsed().as_millis() as u64,
            ok = res.is_ok(),
            "ingame.active_player_runes result"
        );
        res
    }
}

const DEFAULT_POLLING_RATE_MILLIS: u64 = 500;

/// A wrapper around a [IngameClient] that regularly polls the ingame events
pub struct EventStream {
    start_tx: Option<Sender<()>>,
    poll_task_handle: JoinHandle<()>,
    events_rx: UnboundedReceiver<GameEvent>,
}

impl EventStream {
    /// Create an [EventStream] from an [IngameClient] \
    /// Takes an [Option] that specifies the polling rate of the [IngameClient] that's being wrapped \
    /// The default [Duration] is 500ms
    pub fn from_ingame_client(ingame_client: IngameClient, polling_rate: Option<Duration>) -> Self {
        let (start_tx, start_rx) = oneshot::channel::<()>();
        let (events_tx, events_rx) = unbounded_channel();

        let poll_task_handle = tokio::spawn(async move {
            let polling_rate =
                polling_rate.unwrap_or(Duration::from_millis(DEFAULT_POLLING_RATE_MILLIS));
            let mut timer = tokio::time::interval(polling_rate);
            let mut current_event_id = 0;
            // 限速：1 秒内只 trace 一次汇总，避免高频 trace 日志撑爆文件。
            let mut last_event_log = Instant::now();
            let mut window_count: u64 = 0;

            // await start, but return on error (start_tx got dropped)
            if start_rx.await.is_err() {
                tracing::debug!(
                    target: "ingame.events",
                    "ingame events stream cancelled before start"
                );
                return;
            }
            tracing::info!(
                target: "ingame.events",
                polling_rate_ms = polling_rate.as_millis() as u64,
                "ingame events stream armed"
            );

            // wait for a game to start
            let wait_started = Instant::now();
            loop {
                timer.tick().await;
                if ingame_client.event_data(None).await.is_ok() {
                    tracing::info!(
                        target: "ingame.events",
                        wait_ms = wait_started.elapsed().as_millis() as u64,
                        "ingame events stream started"
                    );
                    break;
                };
            }

            // loop for as long as api calls are successful
            loop {
                timer.tick().await;
                match ingame_client.event_data(Some(current_event_id)).await {
                    Ok(mut events) => {
                        if let Some(last_event) = events.last() {
                            current_event_id = last_event.get_event_id() + 1;
                        }
                        let batch = events.len();
                        window_count = window_count.saturating_add(batch as u64);
                        let now = Instant::now();
                        let elapsed_ms = now.duration_since(last_event_log).as_millis();
                        if batch > 0 && elapsed_ms >= 1000 {
                            tracing::trace!(
                                target: "ingame.events",
                                count = window_count,
                                current_event_id,
                                window_ms = elapsed_ms as u64,
                                "ingame events batch"
                            );
                            last_event_log = now;
                            window_count = 0;
                        }
                        events.drain(..).for_each(|e| {
                            let _ = events_tx.send(e);
                        })
                    }
                    Err(error) => {
                        tracing::warn!(
                            target: "ingame.events",
                            error = %error,
                            "ingame events poll failed, stopping stream"
                        );
                        return;
                    }
                }
            }
        });

        Self {
            start_tx: Some(start_tx),
            poll_task_handle,
            events_rx,
        }
    }
}

impl Stream for EventStream {
    type Item = GameEvent;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> Poll<Option<Self::Item>> {
        if let Some(start_tx) = self.start_tx.take() {
            if start_tx.send(()).is_err() {
                return Poll::Ready(None);
            }
        }
        self.events_rx.poll_recv(cx)
    }
}

impl Drop for EventStream {
    fn drop(&mut self) {
        self.poll_task_handle.abort()
    }
}