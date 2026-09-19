/**
 * 历史战绩的统一查询边界。
 *
 * 服务器接口按 20 场分页。为了避免不同页面各自翻页导致请求失控，
 * 所有历史查询都只读取服务器最近三页；更久的数据由 PostgreSQL 缓存提供。
 */
export const HISTORY_SERVER_PAGE_SIZE = 20;
export const HISTORY_SERVER_PAGE_COUNT = 3;
export const HISTORY_SERVER_FETCH_LIMIT =
  HISTORY_SERVER_PAGE_SIZE * HISTORY_SERVER_PAGE_COUNT;

/** 分析窗口最多使用最近 100 场；数据库本身不删除更早的缓存。 */
export const HISTORY_ANALYSIS_LIMIT = 100;

/** 对局内首屏使用已有摘要快速展示，后台分析再补齐完整窗口。 */
export const HISTORY_FAST_WINDOW = 10;
