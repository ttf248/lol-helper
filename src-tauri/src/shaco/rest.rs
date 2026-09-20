use std::time::Instant;

use serde::Serialize;

use crate::shaco::utils::request::build_reqwest_client;

/// 单条日志中 body 字段的截断阈值（UTF-8 字节），超过则截断并打 truncated 标记。
const BODY_PREVIEW_BYTES: usize = 2048;

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
            target = "lcu.http",
            port = %port,
            token_len,
            "LCU REST 客户端初始化"
        );
        Ok(Self {
            port,
            reqwest_client,
        })
    }

    /// Make a get request to the specified endpoint
    pub async fn get(&self, endpoint: &str) -> Result<serde_json::Value, reqwest::Error> {
        let started = Instant::now();
        let result = self
            .reqwest_client
            .get(format!("https://127.0.0.1:{}{}", self.port, endpoint))
            .send()
            .await;
        self.log_result("GET", endpoint, 0, started, result).await
    }

    /// Make a post request to the specified endpoint
    pub async fn post<T: Serialize>(
        &self,
        endpoint: &str,
        body: T,
    ) -> Result<serde_json::Value, reqwest::Error> {
        let started = Instant::now();
        let body_bytes = serde_json::to_string(&body).map(|s| s.len() as u64).unwrap_or(0);
        let body_text = serde_json::to_string(&body).unwrap_or_default();
        log_request_body("POST", endpoint, body_bytes, &body_text);
        let result = self
            .reqwest_client
            .post(format!("https://127.0.0.1:{}{}", self.port, endpoint))
            .json(&body)
            .send()
            .await;
        self.log_result("POST", endpoint, body_bytes, started, result)
            .await
    }

    /// Make a put request to the specified endpoint
    pub async fn put<T: Serialize>(
        &self,
        endpoint: &str,
        body: T,
    ) -> Result<serde_json::Value, reqwest::Error> {
        let started = Instant::now();
        let body_bytes = serde_json::to_string(&body).map(|s| s.len() as u64).unwrap_or(0);
        let body_text = serde_json::to_string(&body).unwrap_or_default();
        log_request_body("PUT", endpoint, body_bytes, &body_text);
        let result = self
            .reqwest_client
            .put(format!("https://127.0.0.1:{}{}", self.port, endpoint))
            .json(&body)
            .send()
            .await;
        self.log_result("PUT", endpoint, body_bytes, started, result)
            .await
    }

    /// Make a delete request to the specified endpoint
    pub async fn delete(&self, endpoint: &str) -> Result<serde_json::Value, reqwest::Error> {
        let started = Instant::now();
        let result = self
            .reqwest_client
            .delete(format!("https://127.0.0.1:{}{}", self.port, endpoint))
            .send()
            .await;
        self.log_result("DELETE", endpoint, 0, started, result).await
    }

    /// Make a patch request to the specified endpoint
    pub async fn patch<T: Serialize>(
        &self,
        endpoint: &str,
        body: T,
    ) -> Result<serde_json::Value, reqwest::Error> {
        let started = Instant::now();
        let body_bytes = serde_json::to_string(&body).map(|s| s.len() as u64).unwrap_or(0);
        let body_text = serde_json::to_string(&body).unwrap_or_default();
        log_request_body("PATCH", endpoint, body_bytes, &body_text);
        let result = self
            .reqwest_client
            .patch(format!("https://127.0.0.1:{}{}", self.port, endpoint))
            .json(&body)
            .send()
            .await;
        self.log_result("PATCH", endpoint, body_bytes, started, result)
            .await
    }

    /// 统一记录 HTTP 调用结果：成功 INFO、失败 WARN。
    /// 响应体走 debug 级单独输出（含截断），避免 info 级别被撑爆。
    async fn log_result(
        &self,
        method: &str,
        endpoint: &str,
        body_bytes: u64,
        started: Instant,
        result: Result<reqwest::Response, reqwest::Error>,
    ) -> Result<serde_json::Value, reqwest::Error> {
        let duration_ms = started.elapsed().as_millis() as u64;
        match result {
            Ok(resp) => {
                let status = resp.status();
                let response_bytes = resp.content_length().unwrap_or(0);
                tracing::info!(
                    target = "lcu.http",
                    method,
                    endpoint = %endpoint,
                    status = status.as_u16(),
                    body_bytes,
                    response_bytes,
                    duration_ms,
                    "LCU HTTP 响应成功"
                );
                let text = resp.text().await.unwrap_or_default();
                log_response_body(method, endpoint, status.as_u16(), &text);
                match serde_json::from_str(&text) {
                    Ok(value) => Ok(value),
                    Err(_) => Ok(serde_json::Value::Null),
                }
            }
            Err(error) => {
                tracing::warn!(
                    target = "lcu.http",
                    method,
                    endpoint = %endpoint,
                    body_bytes,
                    duration_ms,
                    error = %error,
                    "LCU HTTP 请求失败"
                );
                Err(error)
            }
        }
    }
}

/// 请求体日志（debug 级）。默认 `RUST_LOG` 关闭，临时调试时打开。
fn log_request_body(method: &str, endpoint: &str, body_bytes: u64, body_text: &str) {
    if body_bytes == 0 {
        return;
    }
    if body_text.len() <= BODY_PREVIEW_BYTES {
        tracing::debug!(
            target = "lcu.http",
            method,
            endpoint = %endpoint,
            body_bytes,
            "LCU HTTP 请求体 | body={}",
            body_text,
        );
    } else {
        let preview = truncate_on_char_boundary(body_text, BODY_PREVIEW_BYTES);
        tracing::debug!(
            target = "lcu.http",
            method,
            endpoint = %endpoint,
            body_bytes,
            body_truncated = true,
            "LCU HTTP 请求体（已截断） | body_preview={}",
            preview,
        );
    }
}

/// 响应体日志（debug 级）。status ≥ 400 时即使非 debug 也打印一行 warn 摘要，
/// 方便排错 4xx/5xx 时不用开 debug。
fn log_response_body(method: &str, endpoint: &str, status: u16, text: &str) {
    let bytes = text.len();
    if status >= 400 {
        // 错误响应单独走 warn：标题里给出 status，body 截断后给出。
        if bytes <= BODY_PREVIEW_BYTES {
            tracing::warn!(
                target = "lcu.http",
                method,
                endpoint = %endpoint,
                status,
                body_bytes = bytes,
                "LCU HTTP 错误响应体 | body={}",
                text,
            );
        } else {
            let preview = truncate_on_char_boundary(text, BODY_PREVIEW_BYTES);
            tracing::warn!(
                target = "lcu.http",
                method,
                endpoint = %endpoint,
                status,
                body_bytes = bytes,
                body_truncated = true,
                "LCU HTTP 错误响应体（已截断） | body_preview={}",
                preview,
            );
        }
        return;
    }
    if bytes == 0 {
        return;
    }
    if bytes <= BODY_PREVIEW_BYTES {
        tracing::debug!(
            target = "lcu.http",
            method,
            endpoint = %endpoint,
            status,
            body_bytes = bytes,
            "LCU HTTP 响应体 | body={}",
            text,
        );
    } else {
        let preview = truncate_on_char_boundary(text, BODY_PREVIEW_BYTES);
        tracing::debug!(
            target = "lcu.http",
            method,
            endpoint = %endpoint,
            status,
            body_bytes = bytes,
            body_truncated = true,
            "LCU HTTP 响应体（已截断） | body_preview={}",
            preview,
        );
    }
}

fn truncate_on_char_boundary(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut cut = max_bytes;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    &s[..cut]
}