/**
 * 历史战绩的统一查询边界。
 *
 * 设计原则：
 * - 战绩分析以本地 PostgreSQL 缓存为唯一数据源；服务器只用于首屏、后台同步
 *   和"翻页遇本地未覆盖页时的一次性增量拉取"。
 * - 服务器接口按 20 场作为客户端分页步长；不同客户端可能忽略偏移，
 *   调用方必须校验响应索引后再切页。
 * - 服务端历史总量由接口实际返回决定；本项目单个玩家最多主动同步最近 500 场。
 */

// 客户端向 LCU / SGP 请求历史时使用的逻辑分页步长。
export const HISTORY_SERVER_PAGE_SIZE = 20;

/** 单个玩家在本项目中允许主动同步/展示的最近对局上限。 */
export const HISTORY_PLAYER_MAX_GAMES = 500;

/**
 * 冷启动同步上限：服务启动 / 登录后，后台最多主动缓存多少页。
 * 首屏仍然先交付，后续页在后台串行补齐；翻页仍会复用本地缓存。
 */
export const HISTORY_COLD_START_PAGES = Math.ceil(
  HISTORY_PLAYER_MAX_GAMES / HISTORY_SERVER_PAGE_SIZE,
);

/**
 * 后台缓存同步的硬上限（防极端情况下无界循环）。
 * 与单个玩家的主动同步上限保持一致。
 */
export const HISTORY_CACHE_SYNC_MAX_PAGES = HISTORY_COLD_START_PAGES;
export const HISTORY_CACHE_SYNC_LIMIT =
  Math.min(
    HISTORY_PLAYER_MAX_GAMES,
    HISTORY_SERVER_PAGE_SIZE * HISTORY_CACHE_SYNC_MAX_PAGES,
  );

/** 首页历史分析缓存分页大小：单次从本地 PG 读取的对局数上限。 */
export const HISTORY_CACHE_PAGE_SIZE = HISTORY_PLAYER_MAX_GAMES;

/**
 * 对局内队友面板：本地无缓存时的服务器兜底拉取页数（固定 1 页 = 20 场）。
 * 这是"shift tab 不查那么多历史"的边界：永远不为单次对局内面板查询超过 1 页。
 */
export const HISTORY_FRIEND_FALLBACK_PAGES = 1;
export const HISTORY_FRIEND_FALLBACK_LIMIT =
  HISTORY_SERVER_PAGE_SIZE * HISTORY_FRIEND_FALLBACK_PAGES;

/** 首页战绩每页展示场数。 */
export const HISTORY_HOMEPAGE_PAGE_SIZE = 9;

/** 对局面板首屏预览场数（前端展示层用，不影响缓存与分析窗口）。 */
export const HISTORY_PANEL_PREVIEW_COUNT = 10;
