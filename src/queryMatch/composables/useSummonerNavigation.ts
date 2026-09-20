import { useMessage } from "naive-ui";
import { querySummonerInfo } from "@/lcu/aboutSummoner";
import useMatchStore from "@/queryMatch/store";
import type { PartyMember } from "@/recentMatch/utils/queryTypes";

/**
 * 历史战绩面板里点击玩家 ID 后切换召唤师的统一入口。
 *
 * 复用 queryHeader.vue 的搜索行为：先按名字查到 currentId，再
 * matchStore.init(summonerId) 触发整页重载，并切回 "matches" 页签。
 *
 * 不在组件层处理 loading toast —— matchStore.init 自己已经驱动了
 * matchLoading / detailLoading 状态，UI 那边会显示加载动画。
 */
export const useSummonerNavigation = () => {
  const matchStore = useMatchStore();
  const message = useMessage();

  const navigate = async (member: PartyMember | null | undefined) => {
    if (!member) return;
    const name = member.summonerName?.trim();
    if (!name) {
      message.error("玩家信息缺失，无法查询战绩");
      return;
    }

    // 已经是当前召唤师就直接退出，避免重载整个 store。
    const currentPuuid = matchStore.sumInfo?.info.puuid;
    if (member.puuid && currentPuuid && member.puuid === currentPuuid) {
      return;
    }

    const sumInfo = await querySummonerInfo(undefined, name);
    if (sumInfo === null) {
      message.error(
        `未找到召唤师 ${name}，请确认 Riot ID（name#tag）正确且同大区`,
      );
      return;
    }

    await matchStore.init(sumInfo.currentId);
    matchStore.setActiveTab("matches");
  };

  return { navigate };
};
