//! 共享 span 工具：在 `tracing` 上登记命名 span。
//!
//! 这里只保留对调用方仍然有帮助的最小工具集；更复杂的场景
//! 请直接在调用处写 `tracing::info_span!`，避免宏参数展开与
//! tracing 内部 `keyword_meta!` 之间的解析冲突。