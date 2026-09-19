//! tracing 初始化 + NDJSON 落地层 + 前端日志桥接。

use std::sync::Arc;

use once_cell::sync::OnceCell;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Id, Record};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::{Context, SubscriberExt};
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

use crate::observability::sink::FileSink;

static FILE_SINK: OnceCell<Arc<FileSink>> = OnceCell::new();

/// 写入一条外部传入的日志（来自前端 WebView）。
#[tauri::command]
pub fn write_frontend_log(entry: LogEntry) -> Result<(), String> {
    if let Some(sink) = FILE_SINK.get() {
        match serde_json::to_string(&entry) {
            Ok(line) => {
                sink.append(line);
                Ok(())
            }
            Err(error) => Err(format!("日志序列化失败: {error}")),
        }
    } else {
        Err("日志系统尚未初始化".into())
    }
}

/// 启动 tracing subscriber，把所有事件转为 NDJSON 写入文件 sink。
/// 默认关闭 stdout/stderr 输出；可通过 `RUST_LOG` 调整等级。
pub fn init_logger() {
    // 默认 filter：业务层 info；高频 WS / ingame 事件流走自定义 target，
    // 用 target 名直接压制（比模块路径更准确，因为事件用 `target = "..."` 覆盖）。
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        EnvFilter::new("info,ingame.events=warn,observability=info")
    });

    let sink = FileSink::start();
    let _ = FILE_SINK.set(sink.clone());

    let ndjson_layer = NdjsonLayer::new(sink);

    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(ndjson_layer)
        .try_init();
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub ts: String,
    pub level: String,
    pub tag: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<Value>,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub span: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

// ---------- NDJSON Layer ----------

struct NdjsonLayer {
    sink: Arc<FileSink>,
}

impl NdjsonLayer {
    fn new(sink: Arc<FileSink>) -> Self {
        Self { sink }
    }
}

#[derive(Default)]
struct FieldVisitor {
    message: Option<String>,
    fields: Map<String, Value>,
}

impl Visit for FieldVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        let s = format!("{:?}", value);
        self.insert(field.name(), s);
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        self.insert(field.name(), value.to_string());
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.fields
            .insert(field.name().to_string(), Value::Number(value.into()));
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.fields
            .insert(field.name().to_string(), Value::Number(value.into()));
    }

    fn record_u128(&mut self, field: &Field, value: u128) {
        self.fields.insert(
            field.name().to_string(),
            Value::String(value.to_string()),
        );
    }

    fn record_i128(&mut self, field: &Field, value: i128) {
        self.fields.insert(
            field.name().to_string(),
            Value::String(value.to_string()),
        );
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.fields.insert(field.name().to_string(), Value::Bool(value));
    }

    fn record_f64(&mut self, field: &Field, value: f64) {
        if let Some(num) = serde_json::Number::from_f64(value) {
            self.fields
                .insert(field.name().to_string(), Value::Number(num));
        }
    }

    fn record_error(&mut self, field: &Field, value: &(dyn std::error::Error + 'static)) {
        self.fields.insert(
            field.name().to_string(),
            Value::String(value.to_string()),
        );
    }
}

impl FieldVisitor {
    fn insert(&mut self, name: &str, value: String) {
        if name == "message" {
            self.message = Some(value);
        } else {
            self.fields.insert(name.to_string(), Value::String(value));
        }
    }
}

struct SpanFields(Value);

impl<S> tracing_subscriber::Layer<S> for NdjsonLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_new_span(&self, attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
        let span = ctx.span(id).expect("span must exist");
        let mut visitor = FieldVisitor::default();
        attrs.record(&mut visitor);
        let mut fields = visitor.fields;
        if let Some(message) = visitor.message {
            fields.insert("message".to_string(), Value::String(message));
        }
        let mut ext = span.extensions_mut();
        ext.insert(SpanFields(Value::Object(fields)));
    }

    fn on_record(&self, id: &Id, values: &Record<'_>, ctx: Context<'_, S>) {
        let span = ctx.span(id).expect("span must exist");
        let mut ext = span.extensions_mut();
        if let Some(span_fields) = ext.get_mut::<SpanFields>() {
            if let Value::Object(map) = &mut span_fields.0 {
                let mut visitor = FieldVisitor::default();
                values.record(&mut visitor);
                for (k, v) in visitor.fields {
                    map.insert(k, v);
                }
                if let Some(m) = visitor.message {
                    map.insert("message".to_string(), Value::String(m));
                }
            }
        }
    }

    fn on_event(&self, event: &Event<'_>, ctx: Context<'_, S>) {
        let mut visitor = FieldVisitor::default();
        event.record(&mut visitor);

        let level = event.metadata().level().to_string().to_lowercase();
        let tag = event.metadata().target().to_string();
        let message = visitor.message.take().unwrap_or_default();

        let mut context = if visitor.fields.is_empty() {
            None
        } else {
            Some(Value::Object(visitor.fields))
        };

        // 收集 span 链。
        let mut span_chain: Vec<Value> = Vec::new();
        if let Some(scope) = ctx.event_scope(event) {
            for span in scope.from_root() {
                let ext = span.extensions();
                let fields = ext.get::<SpanFields>().map(|s| s.0.clone());
                span_chain.push(json!({
                    "name": span.metadata().name(),
                    "target": span.metadata().target(),
                    "fields": fields.unwrap_or(Value::Null),
                }));
            }
        }

        // 抽取顶层 duration_ms（如果存在）。
        let mut duration_ms = None;
        if let Some(Value::Object(map)) = context.as_mut() {
            if let Some(Value::Number(n)) = map.get("duration_ms") {
                duration_ms = n.as_u64().or_else(|| n.as_i64().map(|v| v as u64));
            }
        }

        let entry = LogEntry {
            ts: now_iso8601(),
            level,
            tag,
            message,
            context,
            source: "backend".into(),
            window: None,
            span: if span_chain.is_empty() {
                None
            } else {
                Some(Value::Array(span_chain))
            },
            duration_ms,
        };

        if let Ok(line) = serde_json::to_string(&entry) {
            self.sink.append(line);
        }
    }
}

// ---------- helpers ----------

fn now_iso8601() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);

    let days = (secs / 86_400) as i64;
    let (y, m, d) = days_to_ymd(days);
    let secs_today = secs % 86_400;
    let hh = secs_today / 3600;
    let mm = (secs_today % 3600) / 60;
    let ss = secs_today % 60;
    let ms = nanos / 1_000_000;

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y, m, d, hh, mm, ss, ms
    )
}

fn days_to_ymd(days_since_epoch: i64) -> (i64, u32, u32) {
    let mut year = 1970i64;
    let mut remaining = days_since_epoch;
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let year_days = if leap { 366 } else { 365 };
        if remaining < year_days {
            break;
        }
        remaining -= year_days;
        year += 1;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let month_days = if leap {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    let mut month = 1u32;
    for &md in &month_days {
        if remaining < md {
            return (year, month, (remaining as u32) + 1);
        }
        remaining -= md;
        month += 1;
    }
    (year, 12, 31)
}
