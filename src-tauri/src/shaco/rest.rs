use std::time::Instant;

use serde::Serialize;

use crate::shaco::utils::request::build_reqwest_client;

/// A client for the League-Client(LCU) REST API
pub struct RESTClient {
    port: String,
    reqwest_client: reqwest::Client,
}

type Error = Box<dyn std::error::Error>;

impl RESTClient {
    /// Create a new instance of the LCU REST wrapper
    pub fn new(auth_token: String, port: String) -> Result<Self, Error> {
        let token_len = auth_token.len();
        let reqwest_client = build_reqwest_client(Some(auth_token));
        // 仅记录 token 长度与端口，绝不打 token 原文。
        tracing::info!(
            target = "lcu.rest",
            port = %port,
            token_len,
            "lcu.rest client init"
        );
        Ok(Self {
            port,
            reqwest_client,
        })
    }

    /// Make a get request to the specified endpoint
    pub async fn get(&self, endpoint: &str) -> Result<serde_json::Value, reqwest::Error> {
        let span = tracing::info_span!(target: "lcu.rest", "lcu.rest GET");
        let started = Instant::now();
        let result = {
            let _entered = span.enter();
            self.reqwest_client
                .get(format!("https://127.0.0.1:{}{}", self.port, endpoint))
                .send()
                .await
        };
        drop(span);
        self.log_result("GET", endpoint, started, result).await
    }

    /// Make a post request to the specified endpoint
    pub async fn post<T: Serialize>(
        &self,
        endpoint: &str,
        body: T,
    ) -> Result<serde_json::Value, reqwest::Error> {
        let span = tracing::info_span!(target: "lcu.rest", "lcu.rest POST");
        let started = Instant::now();
        let body_len = serde_json::to_string(&body).map(|s| s.len()).unwrap_or(0);
        let result = {
            let _entered = span.enter();
            self.reqwest_client
                .post(format!("https://127.0.0.1:{}{}", self.port, endpoint))
                .json(&body)
                .send()
                .await
        };
        drop(span);
        self.log_result("POST", endpoint, started, result)
            .await
            .map(|value| {
                tracing::debug!(
                    target = "lcu.rest",
                    body_len,
                    "lcu.rest body sent"
                );
                value
            })
    }

    /// Make a put request to the specified endpoint
    pub async fn put<T: Serialize>(
        &self,
        endpoint: &str,
        body: T,
    ) -> Result<serde_json::Value, reqwest::Error> {
        let span = tracing::info_span!(target: "lcu.rest", "lcu.rest PUT");
        let started = Instant::now();
        let result = {
            let _entered = span.enter();
            self.reqwest_client
                .put(format!("https://127.0.0.1:{}{}", self.port, endpoint))
                .json(&body)
                .send()
                .await
        };
        drop(span);
        self.log_result("PUT", endpoint, started, result).await
    }

    /// Make a delete request to the specified endpoint
    pub async fn delete(&self, endpoint: &str) -> Result<serde_json::Value, reqwest::Error> {
        let span = tracing::info_span!(target: "lcu.rest", "lcu.rest DELETE");
        let started = Instant::now();
        let result = {
            let _entered = span.enter();
            self.reqwest_client
                .delete(format!("https://127.0.0.1:{}{}", self.port, endpoint))
                .send()
                .await
        };
        drop(span);
        self.log_result("DELETE", endpoint, started, result).await
    }

    /// Make a patch request to the specified endpoint
    pub async fn patch<T: Serialize>(
        &self,
        endpoint: &str,
        body: T,
    ) -> Result<serde_json::Value, reqwest::Error> {
        let span = tracing::info_span!(target: "lcu.rest", "lcu.rest PATCH");
        let started = Instant::now();
        let body_len = serde_json::to_string(&body).map(|s| s.len()).unwrap_or(0);
        let result = {
            let _entered = span.enter();
            self.reqwest_client
                .patch(format!("https://127.0.0.1:{}{}", self.port, endpoint))
                .json(&body)
                .send()
                .await
        };
        drop(span);
        self.log_result("PATCH", endpoint, started, result)
            .await
            .map(|value| {
                tracing::debug!(
                    target = "lcu.rest",
                    body_len,
                    "lcu.rest body sent"
                );
                value
            })
    }

    /// 统一记录 HTTP 调用结果：成功 INFO、失败 WARN，不打 URL/响应体原文。
    async fn log_result(
        &self,
        method: &str,
        endpoint: &str,
        started: Instant,
        result: Result<reqwest::Response, reqwest::Error>,
    ) -> Result<serde_json::Value, reqwest::Error> {
        let duration_ms = started.elapsed().as_millis() as u64;
        match result {
            Ok(resp) => {
                let status = resp.status();
                tracing::info!(
                    target = "lcu.rest",
                    method,
                    endpoint = %endpoint,
                    status = status.as_u16(),
                    duration_ms,
                    "lcu.rest ok"
                );
                resp.json().await.or_else(|_| Ok(serde_json::Value::Null))
            }
            Err(error) => {
                tracing::warn!(
                    target = "lcu.rest",
                    method,
                    endpoint = %endpoint,
                    duration_ms,
                    error = %error,
                    "lcu.rest failed"
                );
                Err(error)
            }
        }
    }
}
