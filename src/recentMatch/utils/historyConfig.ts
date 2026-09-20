/**
 * 历史战绩的统一查询边界。
 *
 * 服务器接口按 20 场分页。常规历史分析只读取服务器最近三页；主页当前
 * 用户另有独立的后台缓存同步任务，最多继续扫描 20 页并在缓存边界停止。
 */
export const HISTORY_SERVER_PAGE_SIZE = 20;
export const HISTORY_SERVER_PAGE_COUNT = 3;
export const HISTORY_SERVER_FETCH_LIMIT =
  HISTORY_SERVER_PAGE_SIZE * HISTORY_SERVER_PAGE_COUNT;

/** 分析窗口最多使用最近 100 场；数据库本身不删除更早的缓存。 */
export const HISTORY_ANALYSIS_LIMIT = 100;

/**
 * 主页当前用户的后台缓存同步边界。接口仍然按 20 场一页请求，
 * 最多向更早历史继续扫描 20 页；遇到已经写入数据库的整页就停止。
 */
export const HISTORY_CACHE_SYNC_MAX_PAGES = 20;
export const HISTORY_CACHE_SYNC_LIMIT =
  HISTORY_SERVER_PAGE_SIZE * HISTORY_CACHE_SYNC_MAX_PAGES;

/** 对局内首屏使用已有摘要快速展示，后台分析再补齐完整窗口。 */
export const HISTORY_FAST_WINDOW = 10;
