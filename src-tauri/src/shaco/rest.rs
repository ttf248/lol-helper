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
        // 开发环境：直接打印 token 原文，方便排错；生产环境请按需脱敏。
        tracing::info!(
            target = "lcu.http",
            port = %port,
            token_len,
            auth_token = %auth_token,
            "LCU REST 客户端初始化"
        );
        let reqwest_client = build_reqwest_client(Some(auth_token));
        Ok(Self {
            port,
            reqwest_client,
        })
    }

    /// Make a get request to the specified endpoint
    pub async fn get(&self, endpoint: &str) -> Result<serde_json::Value, reqwest::Error> {
        let started = Instant::now();
        log_request_start("GET", endpoint, 0, "");
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
        log_request_start("POST", endpoint, body_bytes, &body_text);
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
        log_request_start("PUT", endpoint, body_bytes, &body_text);
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
        log_request_start("DELETE", endpoint, 0, "");
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
        log_request_start("PATCH", endpoint, body_bytes, &body_text);
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
    /// 响应体走 `↳ raw_body:` 多行块完整落盘，不截断（受单行 64KB 兜底约束）。
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
                let text = resp.text().await.unwrap_or_default();
                tracing::info!(
                    target = "lcu.http",
                    method,
                    endpoint = %endpoint,
                    status = status.as_u16(),
                    body_bytes,
                    response_bytes,
                    duration_ms,
                    raw_body = %text,
                    "LCU HTTP 响应成功"
                );
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

/// 请求开始日志：INFO 级预打，含完整 method / endpoint / body。
/// 单行写入受 sink.rs 64KB 兜底限制。
fn log_request_start(method: &str, endpoint: &str, body_bytes: u64, body_text: &str) {
    if body_bytes == 0 {
        tracing::info!(
            target = "lcu.http",
            method,
            endpoint = %endpoint,
            purpose = endpoint_summary(endpoint),
            "LCU HTTP 请求发起"
        );
        return;
    }
    tracing::info!(
        target = "lcu.http",
        method,
        endpoint = %endpoint,
        purpose = endpoint_summary(endpoint),
        body_bytes,
        raw_body = %body_text,
        "LCU HTTP 请求发起"
    );
}

/// 简短的目的说明。把 endpoint 转成可读的"这次请求是要拿什么数据"。
/// 解析失败时降级返回 endpoint 原文。
fn endpoint_summary(endpoint: &str) -> String {
    let path = endpoint.split('?').next().unwrap_or(endpoint);
    if path.contains("/lol-summoner/v1/current-summoner") {
        return "查询当前召唤师信息".to_string();
    }
    if path.contains("/lol-summoner/v1/summoners/") {
        return "按 summonerId 查询召唤师信息".to_string();
    }
    if path.contains("/lol-match-history/v1/products/lol/current-summoner/matches") {
        return "查询当前召唤师最近 N 场历史战绩".to_string();
    }
    if path.contains("/lol-match-history/v1/products/lol/") && path.contains("/matches") {
        return "按 PUUID 查询最近 N 场历史战绩".to_string();
    }
    if path.contains("/lol-match-history/v1/games/") {
        return "查询对局详情".to_string();
    }
    if path.contains("/lol-chat/v1/sessions") {
        return "聊天会话管理".to_string();
    }
    if path.contains("/lol-gameflow/v1/session") {
        return "查询游戏流程 session".to_string();
    }
    if path.contains("/lol-gameflow/v1/availability") {
        return "查询游戏流程可用性".to_string();
    }
    if path.contains("/lol-ranked/v5/") {
        return "查询排位信息".to_string();
    }
    if path.contains("/lol-summoner/v1/") {
        return "召唤师相关查询".to_string();
    }
    if path.contains("/lol-collections/v1/") {
        return "藏品/英雄数据查询".to_string();
    }
    if path.contains("/entitlements/v1/token") {
        return "刷新 entitlements token".to_string();
    }
    format!("LCU REST {}", path)
}