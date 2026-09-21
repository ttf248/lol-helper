/**
 * 把对局创建时间戳（毫秒）格式化成首页列表用的两段字符串：
 *   [0] = "HH : MM"（24 小时制，补零），列表里直接展示
 *   [1] = "M-D"（月份和日期，无补零），用于排行 / 趋势 / 旧列表展示
 * 月份不补零是有意为之 —— 旧逻辑生成的字符串已经混入页面 / 缓存，
 * 直接改成补零会让外部比对脚本（grep / 截图断言）失败。
 */
export const formatGameTimestamp = (
    timestamp: number,
): [string, string] => {
    const date = new Date(timestamp);
    const hours = date.getHours().toString().padStart(2, "0");
    const minutes = date.getMinutes().toString().padStart(2, "0");
    return [
        `${hours} : ${minutes}`,
        `${date.getMonth() + 1}-${date.getDate()}`,
    ];
};