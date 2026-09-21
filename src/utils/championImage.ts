import { champDict } from "@/resources/champList";

// 英雄图标地址统一生成：本地 champDict 有 alias 时走腾讯服 CDN；
// 没有 alias（新英雄 / 数据缺失）时回退到 communitydragon 图标。
// 所有需要展示英雄图标的入口（首页战绩列表、对局详情、对局面板、
// 最近对局、英雄详情等）都通过这一个函数，避免 CDN 路径散落多份。
const GTIMG_CHAMPION_BASE = "https://game.gtimg.cn/images/lol/act/img/champion";
const COMMUNITY_DRAGON_ICON =
    "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-icons";

export const getChampionImageUrl = (championId: number): string => {
    const alias = champDict[String(championId)]?.alias;
    if (alias) {
        return `${GTIMG_CHAMPION_BASE}/${alias}.png`;
    }
    return `${COMMUNITY_DRAGON_ICON}/${championId}.png`;
};