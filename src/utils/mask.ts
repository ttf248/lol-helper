// 前端日志脱敏工具
// 用于在送入 emit / localStorage / 任何外部通道前，先把 puuid、召唤师名、token、响应体等
// 敏感字段收敛一遍，避免完整值落盘。

/**
 * 命中即视为敏感字段的 key 集合（不区分大小写）。
 * 调用方在写入日志前应先调用 `maskContext`，把所有 key 命中的字段替换为 `<redacted>`。
 */
export const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  "token",
  "accesstoken",
  "access_token",
  "refresh_token",
  "id_token",
  "authorization",
  "auth",
  "cookie",
  "set-cookie",
  "remoting-auth-token",
  "password",
  "riot",
  "secret",
  "auth_token",
  "bearer",
  "jwt",
]);

const PUUID_KEYS: ReadonlySet<string> = new Set([
  "puuid",
  "playerpuuid",
  "player_puuid",
  "targetpuuid",
  "target_puuid",
  "summonerpuuid",
  "summoner_puuid",
]);

const SUMMONER_NAME_KEYS: ReadonlySet<string> = new Set([
  "summoner",
  "summonername",
  "summoner_name",
  "summonerinternalname",
  "summoner_internal_name",
  "playername",
  "player_name",
  "gamename",
  "game_name",
]);

const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+\/=:-]{8,}/gi;
const BASIC_PATTERN = /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){1,2}\b/g;
const PUUID_PATH_PATTERN =
  /(\/match-history-query\/v1\/products\/lol\/player\/)([^/?#\s"']+)/gi;
const LCU_PUUID_PATH_PATTERN =
  /(\/lol-match-history\/v1\/products\/lol\/)(?!player(?:[/?#]|$))([^/?#\s"']+)/gi;
const PUUID_QUERY_PATTERN = /([?&](?:player)?puuid=)[^&#\s"']+/gi;
const SENSITIVE_TEXT_PATTERN =
  /((?:["']?(?:token|accessToken|access_token|refresh_token|id_token|authorization|auth|cookie|password|secret|auth_token|bearer|jwt)["']?\s*[:=]\s*["']))[^"']*(["'])/gi;
const SUMMONER_NAME_TEXT_PATTERN =
  /((?:["']?(?:summoner|summonerName|summoner_name|summonerInternalName|summoner_internal_name|playerName|player_name|gameName|game_name)["']?\s*[:=]\s*["']))[^"']*(["'])/gi;
// PUUID 通常是较长的 URL-safe 标识。它只用于兜底，字段名明确时仍优先使用
// maskPuuid，以便保留末 8 位供排查关联。
const LONG_IDENTIFIER_PATTERN = /\b[A-Za-z0-9_-]{32,}\b/g;

/** 对日志 message、URL 和错误文本做一次字符串级脱敏。 */
export function redactText(value: string): string {
  let result = value
    .replace(BEARER_PATTERN, "Bearer <redacted>")
    .replace(BASIC_PATTERN, "Basic <redacted>")
    .replace(JWT_PATTERN, "<redacted-jwt>")
    .replace(PUUID_PATH_PATTERN, "$1<puuid>")
    .replace(LCU_PUUID_PATH_PATTERN, "$1<puuid>")
    .replace(PUUID_QUERY_PATTERN, "$1<puuid>")
    .replace(SENSITIVE_TEXT_PATTERN, "$1<redacted>$2")
    .replace(SUMMONER_NAME_TEXT_PATTERN, "$1<redacted-name>$2");
  return result.replace(LONG_IDENTIFIER_PATTERN, "<redacted-puuid>");
}

/** 脱敏 URL 中的 PUUID、token 等路径/查询参数，同时保留接口定位信息。 */
export function maskUrl(url?: string | null): string {
  return url ? redactText(url) : "";
}

/**
 * PUUID 末尾 8 位。puuid 在 RIOT 服务端用作唯一身份标识，
 * 完整值落盘会增加被关联撞库的风险。
 */
export function maskPuuid(puuid?: string | null): string {
  if (!puuid) return "";
  if (puuid.startsWith("…")) return puuid;
  if (puuid.length <= 8) return puuid;
  return `…${puuid.slice(-8)}`;
}

/**
 * 召唤师名遮蔽：长度≤1 → `*`；长度=2 → `X*`；其他 → `X*YZ`。
 * 保留首字 + 末两字，方便在日志里肉眼区分，又不至于全名被还原。
 */
export function maskName(name?: string | null): string {
  if (!name) return "";
  if (name.length <= 1) return "*";
  if (name.length === 2) return `${name[0]}*`;
  return `${name[0]}*${name.slice(-2)}`;
}

/**
 * 永远返回 `<redacted>`，无论传入什么。调用方拿到的是元信息
 * （如长度、是否过期），而不是 token 原文。
 */
export function maskToken(_token?: string | null): string {
  return "<redacted>";
}

/**
 * 截断响应体：只保留前 100 字 + 总长度。
 * 整个 payload 经常含完整战绩 / 出招序列，落盘会显著放大日志。
 */
export function maskBody(body: unknown): { len: number; preview: string } {
  if (body == null) return { len: 0, preview: "" };
  let s: string;
  try {
    const serialized = typeof body === "string" ? body : JSON.stringify(body);
    s = serialized === undefined ? String(body) : serialized;
  } catch {
    s = String(body);
  }
  return { len: s.length, preview: redactText(s.slice(0, 100)) };
}

/**
 * 递归扫描对象/数组，把命中 `SENSITIVE_KEYS` 的字段值替换为 `<redacted>`，
 * 字符串长度 > 200 的字段自动 `maskBody`。其余字段递归处理。
 */
export function maskContext(value: unknown): unknown {
  return maskContextValue(value, new WeakSet<object>());
}

function maskContextValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value == null) return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) return "<circular>";
    seen.add(value);
    const result = value.map((item) => maskContextValue(item, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (seen.has(value)) return "<circular>";
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const normalizedKey = k.toLowerCase();
      if (SENSITIVE_KEYS.has(normalizedKey)) {
        out[k] = "<redacted>";
        continue;
      }
      if (PUUID_KEYS.has(normalizedKey)) {
        out[k] = maskPuuid(typeof v === "string" ? v : null);
        continue;
      }
      if (SUMMONER_NAME_KEYS.has(normalizedKey)) {
        out[k] = maskName(typeof v === "string" ? v : null);
        continue;
      }
      if (typeof v === "string" && v.length > 200) {
        out[k] = maskBody(v);
        continue;
      }
      out[k] = maskContextValue(v, seen);
    }
    seen.delete(value);
    return out;
  }
  if (typeof value === "string" && value.length > 200) {
    return maskBody(value);
  }
  return typeof value === "string" ? redactText(value) : value;
}
