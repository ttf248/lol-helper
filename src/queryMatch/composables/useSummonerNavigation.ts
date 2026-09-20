import { useMessage } from "naive-ui";
import { querySummonerInfo } from "@/lcu/aboutSummoner";
import useMatchStore from "@/queryMatch/store";
import type { PartyMember } from "@/recentMatch/utils/queryTypes";

/**
 * 历史战绩面板里点击玩家 ID 后切换召唤师的统一入口。
 *
 * 优先复用正常对局详情页的路径：直接用 summonerId 调用
 * matchStore.init；只有历史数据缺少 ID 时才按昵称查询，再切回
 * "matches" 页签。
 *
 * 不在组件层处理 loading toast —— matchStore.init 自己已经驱动了
 * matchLoading / detailLoading 状态，UI 那边会显示加载动画。
 */
export const useSummonerNavigation = () => {
  const matchStore = useMatchStore();
  const message = useMessage();
  let navigating = false;

  const navigate = async (member: PartyMember | null | undefined) => {
    if (!member || navigating) return;

    // 已经是当前召唤师就直接退出，避免重载整个 store。
    const currentPuuid = matchStore.sumInfo?.info.puuid;
    const memberId = Number(member.summonerId);
    const hasMemberId = Number.isFinite(memberId) && memberId > 0;
    if (
      (member.puuid && currentPuuid && member.puuid === currentPuuid) ||
      (hasMemberId && memberId === matchStore.summonerId)
    ) {
      matchStore.setActiveTab("matches");
      return;
    }

    navigating = true;
    try {
      // 与正常对局详情页保持同一条路径：accountId → matchStore.init。
      // 历史分析的参与者来自 PG/SGP，通常已经带有 summonerId，避免
      // 通过昵称二次查询时被当前玩家的缓存身份误命中。
      if (hasMemberId) {
        await matchStore.init(memberId);
        matchStore.setActiveTab("matches");
        return;
      }

      const name = member.summonerName?.trim();
      if (!name) {
        message.error("玩家信息缺失，无法查询战绩");
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
    } finally {
      navigating = false;
    }
  };

  return { navigate };
};
