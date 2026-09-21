import {BlacklistListTypes, Hater, UserInfos} from "@/main/views/record/blackListTypes";
import {fetch} from "@tauri-apps/plugin-http";
import { logger } from "@/utils/logger";

export interface BlacklistConfig {
  url: string;
  method: string;
  data?: unknown;
}

export interface BlacklistResponse<T> {
  code: number;
  data: T;
}

export const requestFetch = async <T>(url: string, method: string, body?: string,timeout?:number): Promise<T | null> => {
  const controller = new AbortController();
  const timer = timeout && timeout > 0
    ? setTimeout(() => controller.abort(), timeout)
    : undefined;
  const startedAt = Date.now();
  try {
    if (body && body.length > 0) {
      logger.info({
        tag: "main.http",
        message: "外部 HTTP 请求发起",
        context: {
          purpose: "黑名单举报服务外部 HTTP 请求",
          url,
          method,
          body_chars: body.length,
          timeout_ms: timeout ?? null,
        },
      }, body);
    } else {
      logger.info({
        tag: "main.http",
        message: "外部 HTTP 请求发起",
        context: {
          purpose: "黑名单举报服务外部 HTTP 请求",
          url,
          method,
          body_chars: 0,
          timeout_ms: timeout ?? null,
        },
      });
    }
    const res = await fetch(url, {
      method,
      body,
      connectTimeout: timeout,
      signal: controller.signal,
    });

    if (res.status === 200) {
      const text = await res.text();
      logger.info({
        tag: "main.http",
        message: "外部 HTTP 响应成功",
        context: {
          purpose: "黑名单举报服务外部 HTTP 请求",
          url,
          method,
          status: res.status,
          response_chars: text.length,
          duration_ms: Date.now() - startedAt,
        },
        durationMs: Date.now() - startedAt,
      }, text);
      try {
        return JSON.parse(text) as T;
      } catch (error) {
        logger.warn({
          tag: "main.http",
          message: "外部 HTTP 响应 JSON 解析失败",
          context: {
            url,
            method,
            status: res.status,
            error: String(error).slice(0, 500),
            response_chars: text.length,
            duration_ms: Date.now() - startedAt,
          },
        }, text);
        return null;
      }
    }
    const text = await res.text().catch(() => "");
    logger.warn({
      tag: "main.http",
      message: "外部 HTTP 状态码非 200",
      context: {
        url,
        method,
        status: res.status,
        response_chars: text.length,
        duration_ms: Date.now() - startedAt,
      },
    }, text);
    return null;
  } catch (error) {
    logger.warn({
      tag: "main.http",
      message: "外部 HTTP 请求失败",
      context: {
        url,
        method,
        duration_ms: Date.now() - startedAt,
        error: String(error).slice(0, 500),
      },
    });
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};


const BLACKLIST_TIMEOUT_MS = 2500;

const blacklistServe = <T>(
  config: BlacklistConfig,
): Promise<BlacklistResponse<T> | null> =>
  requestFetch<BlacklistResponse<T>>(
    "http://121.40.58.64:8412" + config.url,
    config.method,
    JSON.stringify(config?.data),
    BLACKLIST_TIMEOUT_MS,
  ).catch(() => null);


export const findPlayerByPlayerId = async (
  config: BlacklistConfig,
): Promise<null | UserInfos> => {
  const res = await blacklistServe<UserInfos>(config);
  if (res === null || res.code !== 0) {
    return null;
  }
  return res.data;
};

export const findHaterByHaterId = async (
  config: BlacklistConfig,
): Promise<null | Hater[]> => {
  const res = await blacklistServe<Hater[]>(config);
  if (res === null || res.code !== 0) {
    return null;
  }
  return res.data;
};

export const findBlacklistByHId = async (
  config: BlacklistConfig,
): Promise<null | BlacklistListTypes> => {
  const res = await blacklistServe<BlacklistListTypes>(config);
  if (res === null || res.code !== 0) {
    return null;
  }
  return res.data;
};

const handleRequest = <T>(res: BlacklistResponse<T> | null): boolean =>
  res !== null && res.code === 0;

export const reviseHaterContent = async (
  config: BlacklistConfig,
): Promise<boolean> => {
  const res = await blacklistServe<null>(config);
  return handleRequest(res);
};
export const deleteBlacklist = async (
  config: BlacklistConfig,
): Promise<boolean> => {
  const res = await blacklistServe<null>(config);
  return handleRequest(res);
};
export const deleteHater = async (
  config: BlacklistConfig,
): Promise<boolean> => {
  const res = await blacklistServe<null>(config);
  return handleRequest(res);
};
export const createHaterContent = async (
  config: BlacklistConfig,
): Promise<boolean> => {
  const res = await blacklistServe<null>(config);
  return handleRequest(res);
};
export const updatePlayerRecord = async (
  config: BlacklistConfig,
): Promise<boolean> => {
  const res = await blacklistServe<null>(config);
  return handleRequest(res);
};
