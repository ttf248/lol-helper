//! 统一日志子模块。
//!
//! 负责 tracing-subscriber 初始化、文件落地、前端日志桥接。
//! 调用约定：业务代码只使用 `tracing::{debug,info,warn,error}`，
//! 日志文件用于本地诊断，保留业务上下文。

pub mod log;
pub mod sink;
pub mod spans;
