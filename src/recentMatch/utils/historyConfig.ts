/**
 * 历史战绩的统一查询边界。
 *
 * 设计原则：
 * - 战绩分析以本地 PostgreSQL 缓存为唯一数据源；服务器只用于"冷启动最小可用集"
 *   和"翻页遇本地未覆盖页时的一次性增量拉取"。
 * - 服务器接口始终按 20 场分页，超过 20 场由调用方按 pageIndex × pageSize 串行请求。
 * - 没有"服务器最多 N 场"的硬限制；翻页的无界语义由本地缓存上限决定。
 */

// 服务器接口固定 20 场分页（LCU / SGP 单次最大请求量）。
export const HISTORY_SERVER_PAGE_SIZE = 20;

/**
 * 冷启动最小可用集：服务启动 / 登录后，后台主动缓存到本地 PG 的页数。
 * 翻页时如果本地未覆盖，会触发单页增量拉取并写入缓存，因此这个值只需要
 * 满足"首屏立刻可用"即可。
 */
export const HISTORY_COLD_START_PAGES = 3;

/**
 * 后台缓存同步的硬上限（防极端情况下无界循环）。
 * 正常冷启动走 HISTORY_COLD_START_PAGES，HISTORY_CACHE_SYNC_MAX_PAGES 仅在
 * 后续手动全量同步等扩展场景中作为兜底。
 */
export const HISTORY_CACHE_SYNC_MAX_PAGES = 20;
export const HISTORY_CACHE_SYNC_LIMIT =
  HISTORY_SERVER_PAGE_SIZE * HISTORY_CACHE_SYNC_MAX_PAGES;

/** 分析窗口最多使用最近 100 场；数据库本身不删除更早的缓存。 */
export const HISTORY_ANALYSIS_LIMIT = 100;

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
