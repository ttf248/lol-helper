import {BlacklistListTypes, Hater, UserInfos} from "@/main/views/record/blackListTypes";
import {fetch} from "@tauri-apps/plugin-http";


export const requestFetch = async <T>(url: string, method: string, body?: string,timeout?:number): Promise<T | null> => {
  const controller = new AbortController();
  const timer = timeout && timeout > 0
    ? setTimeout(() => controller.abort(), timeout)
    : undefined;
  try {
    const res = await fetch(url, {
      method,
      body,
      connectTimeout: timeout,
      signal: controller.signal,
    });

    if (res.status === 200) {
      const data: T = await res.json();
      return data;
    }
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};


const BLACKLIST_TIMEOUT_MS = 2500;

const blacklistServe = (config: any): Promise<any | null> => {
  return  requestFetch<any>('http://121.40.58.64:8412' + config.url,
    config.method, JSON.stringify(config?.data), BLACKLIST_TIMEOUT_MS
  ).then((res) => {
    if (res === null) {return null}
    return res
  }).catch(() => null)
}


export const findPlayerByPlayerId = async (config: any): Promise<null | UserInfos> => {
  const res = await blacklistServe(config)

  if (res === null || res.code !== 0) {
    return null
  }
  return res.data
}

export const findHaterByHaterId = async (config: any): Promise<null | Hater[]> => {
  const res = await blacklistServe(config)
  if (res === null || res.code !== 0) {
    return null
  }
  return res.data
}
export const findBlacklistByHId = async (config: any): Promise<null | BlacklistListTypes> => {
  const res = await blacklistServe(config)
  if (res === null || res.code !== 0) {
    return null
  }
  return res.data
}

const handleRequest = (res:any)  => {
  if (res === null || res.code !== 0) {
    return false
  }
  return true
}

export const reviseHaterContent = async (config: any): Promise<boolean> => {
  const res = await blacklistServe(config)
  return handleRequest(res)
}
export const deleteBlacklist = async (config: any): Promise<boolean> => {
  const res = await blacklistServe(config)
  return handleRequest(res)
}
export const deleteHater = async (config: any): Promise<boolean> => {
  const res = await blacklistServe(config)
  return handleRequest(res)
}
export const createHaterContent = async (config: any): Promise<boolean> => {
  const res = await blacklistServe(config)
  return handleRequest(res)
}
export const updatePlayerRecord = async (config: any): Promise<boolean> => {
  const res = await blacklistServe(config)
  return handleRequest(res)
}
