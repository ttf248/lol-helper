use std::{
    pin::Pin,
    task::{Context, Poll},
};

use futures_util::{SinkExt, Stream, StreamExt};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    tungstenite, tungstenite::client::IntoClientRequest, tungstenite::http::HeaderValue,
    tungstenite::Message, Connector, MaybeTlsStream, WebSocketStream,
};

use crate::{
    shaco::error::LcuWebsocketError,
    shaco::model::ws::{LcuEvent, LcuSubscriptionType},
    shaco::utils::process_info,
    shaco::utils::process_info::AuthResponse,
};

/// A client for the League-Client(LCU) websocket API
#[derive(Debug)]
pub struct LcuWebsocketClient(WebSocketStream<MaybeTlsStream<TcpStream>>);

impl LcuWebsocketClient {
    /// Tries to establish a connection to the LCU Websocket API \
    /// Returns an [LcuWebsocketError] if the API is not reachable
    pub async fn connect() -> Result<Self, LcuWebsocketError> {
        let AuthResponse {
            token: auth_token,
            port,
            ..
        } = process_info::get_auth_info()
            .map_err(|e| LcuWebsocketError::LcuNotAvailable(e.to_string()))?;

        tracing::info!(target = "lcu.ws", port = %port, "lcu.ws connecting");

        let cert = native_tls::Certificate::from_pem(include_bytes!("./riotgames.pem")).unwrap();
        let tls = native_tls::TlsConnector::builder()
            .add_root_certificate(cert)
            .build()
            .unwrap();
        let connector = Connector::NativeTls(tls);

        let mut url = format!("wss://127.0.0.1:{port}")
            .into_client_request()
            .map_err(|e| {
                tracing::error!(target = "lcu.ws", error = %e, "lcu.ws url build failed");
                LcuWebsocketError::AuthError
            })?;
        url.headers_mut()
            .insert(
                "Authorization",
                HeaderValue::from_str(format!("Basic {auth_token}").as_str()).map_err(|e| {
                    tracing::error!(target = "lcu.ws", error = %e, "lcu.ws auth header failed");
                    LcuWebsocketError::AuthError
                })?,
            );

        let started = std::time::Instant::now();
        let (ws_stream, _response) =
            tokio_tungstenite::connect_async_tls_with_config(url, None, false, Some(connector))
                .await
                .map_err(|e| {
                    tracing::error!(
                        target = "lcu.ws",
                        duration_ms = started.elapsed().as_millis() as u64,
                        error = %e,
                        "lcu.ws connect failed"
                    );
                    LcuWebsocketError::Disconnected(e.to_string())
                })?;

        tracing::info!(
            target = "lcu.ws",
            duration_ms = started.elapsed().as_millis() as u64,
            "lcu.ws connected"
        );

        Ok(Self(ws_stream))
    }

    /// The Websocket events to subscribe to.
    /// Look at the in-official documentation for event strings to subscribe to.
    ///
    /// <https://www.mingweisamuel.com/lcu-schema/tool/#/>
    pub async fn subscribe(
        &mut self,
        subscription: LcuSubscriptionType,
    ) -> Result<(), LcuWebsocketError> {
        tracing::debug!(target = "lcu.ws", subscription = %subscription, "lcu.ws subscribe");
        self.0
            .send(Message::text(format!("[5, \"{subscription}\"]")))
            .await
            .map_err(|e| match e {
                tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed => {
                    tracing::warn!(
                        target = "lcu.ws",
                        subscription = %subscription,
                        error = %e,
                        "lcu.ws subscribe: connection closed"
                    );
                    LcuWebsocketError::Disconnected(e.to_string())
                }
                _ => {
                    tracing::warn!(
                        target = "lcu.ws",
                        subscription = %subscription,
                        error = %e,
                        "lcu.ws subscribe: send failed"
                    );
                    LcuWebsocketError::SendError
                }
            })
    }

    /// The Websocket events to subscribe to.
    /// Look at the in-official documentation for event strings to subscribe to.
    ///
    /// <https://www.mingweisamuel.com/lcu-schema/tool/#/>
    pub async fn unsubscribe(
        &mut self,
        subscription: LcuSubscriptionType,
    ) -> Result<(), LcuWebsocketError> {
        tracing::debug!(target = "lcu.ws", subscription = %subscription, "lcu.ws unsubscribe");
        self.0
            .send(Message::text(format!("[6, \"{subscription}\"]")))
            .await
            .map_err(|e| match e {
                tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed => {
                    tracing::warn!(
                        target = "lcu.ws",
                        subscription = %subscription,
                        error = %e,
                        "lcu.ws unsubscribe: connection closed"
                    );
                    LcuWebsocketError::Disconnected(e.to_string())
                }
                _ => {
                    tracing::warn!(
                        target = "lcu.ws",
                        subscription = %subscription,
                        error = %e,
                        "lcu.ws unsubscribe: send failed"
                    );
                    LcuWebsocketError::SendError
                }
            })
    }
}

impl Stream for LcuWebsocketClient {
    type Item = LcuEvent;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        loop {
            return match self.0.poll_next_unpin(cx) {
                Poll::Pending => Poll::Pending,
                Poll::Ready(Some(Ok(Message::Text(text)))) => {
                    let Ok(event) = serde_json::from_str::<LcuEvent>(&text) else {
                        tracing::warn!(
                            target = "lcu.ws",
                            text_len = text.len(),
                            "lcu.ws event deserialize failed"
                        );
                        continue;
                    };
                    tracing::trace!(
                        target = "lcu.ws",
                        event_type = %event.event_type,
                        subscription = %event.subscription_type,
                        "lcu.ws recv"
                    );
                    Poll::Ready(Some(event))
                }
                Poll::Ready(Some(Ok(Message::Close(_)))) => {
                    tracing::warn!(target = "lcu.ws", "lcu.ws closed by server");
                    Poll::Ready(None)
                }
                Poll::Ready(Some(Err(error))) => {
                    tracing::warn!(
                        target = "lcu.ws",
                        error = %error,
                        "lcu.ws stream error"
                    );
                    Poll::Ready(None)
                }
                Poll::Ready(None) => Poll::Ready(None),
                _ => continue,
            };
        }
    }
}
