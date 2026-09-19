use crate::shaco::{model::ws::LcuSubscriptionType, ws};
use futures_util::stream::StreamExt;
use tauri::{AppHandle, Emitter, EventTarget};

pub async fn listen_client(app: AppHandle) {
    let mut client = ws::LcuWebsocketClient::connect().await.unwrap();
    client
        .subscribe(LcuSubscriptionType::JsonApiEvent(
            "/lol-gameflow/v1/gameflow-phase".to_string(),
        ))
        .await
        .unwrap();

    while let Some(event) = client.next().await {
        // println!("Event: {:?}", event);
        app.emit_to(
            EventTarget::labeled("background"),
            "client_status",
            event.data,
        )
            .unwrap();
    }
}
