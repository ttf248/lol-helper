# 日志规范

## 1. 文件落地

- 位置：`<data_dir>/logs/`
- 文件名：`app-YYYY-MM-DD.log`
- 滚动：单文件 ≥ 50 MB 滚动为 `.1.log`，仅保留 7 天。
- 编码：UTF-8（无 BOM），每行以 LF 结尾。
- 单行兜底上限：**64 KB**（开发环境要求请求 / 响应 body 完整落盘；超过 64 KB 截断并附 `…(剩余 N 字节已丢弃)`）。

## 2. 单行格式

绝大多数事件是单行：

```
[HH:mm:ss.SSS] [LEVEL] [tag] 中文消息 | key=value key=value ... | 耗时 Xms
```

- 时间戳：本地时区，毫秒精度。
- `LEVEL`：固定四字符 `TRCE / DEBG / INFO / WARN / ERRO`。
- `tag`：模块标签（见 §3）。
- 中文消息：动词短语，避免英文缩略词。
- 字段：`key=value`，按 `field=tab → span → duration_ms → body_bytes → status → 其它` 顺序排列。字符串包含空格时使用双引号包围，例如 `phase="GameStart"`。
- `耗时 Xms`：可选，INFO/WARN/ERRO 级别的请求类日志都应带。

### 示例

```
[21:08:14.532] [INFO ] [lcu.http] LCU HTTP 响应成功 | method=POST endpoint=/lol-chat/v1/sessions status=201 body_bytes=158 | 耗时 18ms
[21:09:02.117] [WARN ] [recent.history] 历史接口全部失败，无可用数据 | puuid=…ab12cd34 beg_index=0 count=20 full_participants=false resolved=none
[21:09:05.301] [DEBG ] [recent.history] fingerprint 跳过：服务器最近三页无新增 | puuid=…ab12cd34 queue_id=420 fingerprint=1715620800000:7788991122
```

## 3. 请求 / 响应 body 的多行扩展

请求类日志可继续追加 `↳ body:` 块（从下一行开始，4 空格缩进）。整体仍属于同一条事件。

```
[21:08:14.532] [INFO ] [lcu.http] LCU HTTP 响应成功 | method=POST endpoint=/lol-chat/v1/sessions status=201 body_bytes=158 | 耗时 18ms
    ↳ body:
      {"sessionId":"abc-123","state":"created"}
```

- **开发环境**：body 不截断，完整落盘；最大受单行 64 KB 兜底约束。
- **生产环境**：建议把单条 body 上限调到 2048 字节（外部 HTTP：1024 字符），并在标题行加 `body_truncated=true body_bytes=<原始>`。
- 4xx / 5xx 即使非 debug 也强制打 body，便于排错。

## 4. Tag 表

| Tag | 来源 | 用途 |
|---|---|---|
| `lcu.http` | 后端 `shaco::rest` | LCU REST 请求 / 响应 |
| `lcu.ws` | 后端 `lcu::listener` | LCU WebSocket 连接 / 订阅 / 事件 / 重连 |
| `lcu.cmd` | 后端 `lcu.rs` | Tauri 命令桥 |
| `lcu.auth` | 后端 `shaco::utils::process_info` | LCU 鉴权信息解析 |
| `lcu.keyboard` | 后端 `lcu::global_key` | 全局键盘监听 |
| `lcu.history` | 前端 `aboutMatch` | LCU 历史接口调用 |
| `lcu.sgp` | 前端 `sgpMatch` | SGP SUMMARY 历史接口 |
| `lcu.token` | 前端 `aboutMatch` | entitlements token 刷新 |
| `ingame.live` | 后端 `shaco::ingame` | Live Client Data 单次接口 |
| `ingame.events` | 后端 `shaco::ingame` | Live Client 事件流 |
| `db.cache` | 后端 `database` + 前端 `databaseCache` | PG 缓存读写 |
| `recent.analysis` | 前端 `recentAnalytics` | 玩家近期分析 |
| `recent.analysis.moderation` | 前端 `recentAnalytics` | 举报 / 黑名单加载 |
| `recent.history` | 前端 `queryMatch` | 对局内历史面板查询 |
| `recent.merge` | 前端 `historyData` | 历史合并冲突 |
| `match.detail` | 前端 `matchDetails` | 对局详情组装 |
| `home.history` | 前端 `baseMatch` | 首页战绩列表读取 / 冷启动同步 / 翻页增量 |
| `main.http` | 前端 `request.ts` | 外部 HTTP（举报服务等） |
| `background.bootstrap` | 前端 `background.ts` | 后台窗口就绪 |
| `background.client_status` | 前端 `background.ts` | client_status 事件 |
| `background.client_probe_timeout` | 前端 `background.ts` | LCU 客户端探测超时 |
| `background.listen_for_client_start` | 前端 `background.ts` | 启动监听失败 |
| `gameFlow.wait_for_game_start` | 前端 `gameFlow.ts` | 对局内接口等待超时 |
| `gameFlow.open_window` | 前端 `gameFlow.ts` | 对局内窗口打开失败 |
| `gameFlow.read_config` | 前端 `gameFlow.ts` | 配置读取失败 |
| `window.error` | 前端 `logger` | window.onerror 兜底 |
| `unhandled.promise` | 前端 `logger` | unhandledrejection 兜底 |

## 5. 字段命名

- **统一 snake_case**（后端默认；前端现状 camelCase 已逐步迁移）。
- `puuid`：**开发环境**直接打印原值；**生产环境**截尾 8 位（`…ab12cd34`）。每个调用入口必须明确写出 `purpose` 字段说明意图。
- `body_bytes` 统一用 `body_bytes`，不再用 `bytes` / `body_len`。
- `cmd=<name>` 不要与 message 中重复。
- `duration_ms` 只在最末尾的 `耗时 Xms` 出现，不再出现在 context 里。
- `mode_key` 取代 `modeKey` 作为缓存键字段。
- `purpose` 字段必须出现在所有请求 / 响应 INFO 日志中，用一句话说明"这次请求是要拿什么数据"。

## 6. 日志级别

| 级别 | 触发场景 |
|---|---|
| `TRCE` | 高频事件流（WS 事件帧、Live Client 事件汇总） |
| `DEBG` | 请求 body 预览、fingerprint 跳过、TTL 命中、merge conflicts |
| `INFO` | 业务主路径：HTTP 成功、阶段切换、监听就绪 |
| `WARN` | 业务降级：接口失败、参与者数异常、超时 |
| `ERRO` | 启动失败、命令桥异常、unhandled error |

通过 `RUST_LOG` 调整后端级别（逗号分隔，例如 `info,lcu.http=debug,ingame.events=warn`）。前端通过 `setLogLevel("debug")` 调整。

## 7. grep 用法

```bash
# 按 tag
grep '\[lcu.http\]' app-2026-09-20.log

# 按级别
grep -E '\[(WARN|ERRO)\]' app-2026-09-20.log

# 5xx 响应
grep 'status=5' app-2026-09-20.log

# 拉 body 块（行 + 后续 4 空格缩进）
grep -A 3 '↳ body:' app-2026-09-20.log

# 慢请求（耗时 ≥ 1000ms）
grep -E '耗时 [0-9]{4,}ms' app-2026-09-20.log

# LCU 客户端缺失
grep '\[lcu.auth\]' app-2026-09-20.log

# WS 重连事件
grep '\[lcu.ws\]' app-2026-09-20.log

# 数据库初始化
grep '\[db.cache\] 数据库连接成功' app-2026-09-20.log
```

## 8. CI / pre-commit lint

拦截英文日志：

```bash
# 前端 logger.message 必须中文
grep -RE 'logger\.\w+\(\s*\{[^}]*message:\s*"[A-Z][a-zA-Z]' src/ \
  && echo "前端日志 message 必须中文" && exit 1

# 后端 tracing! message 必须中文
grep -RE 'tracing::\w+!\([^)]*"\s*[a-z]' src-tauri/src/ \
  && echo "后端日志 message 必须中文" && exit 1
```

CI 上任意一条命中即失败。

## 9. 常见反模式

- ❌ 在 message 中混入变量：`"status code 404"` → 应改为 `"接口返回 404"` + `status=404` 字段。
- ❌ 重复打印 `duration_ms`：只在末尾 `耗时 Xms` 出现一次。
- ❌ 在两个层级各打一条同样的日志（HTTP 层 + 命令桥层），只保留底层。
- ❌ 把请求 / 响应 body 合并成一条日志 — 拆为请求 / 响应两条独立 INFO。
- ❌ 调用入口不打 `purpose`：排错时无法判断这次请求的意图。每个 fetch / invoke / queryMatch 调用点都应写明。
