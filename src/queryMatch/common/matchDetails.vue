<script setup lang="ts">
import { computed } from "vue";
import { NSpace, NTag, NPopover } from "naive-ui";
import { SummonerDetailInfo } from "@/queryMatch/utils/MatchDetail";
import { getspellImgUrl } from "@/lcu/utils";
import MatchSumDetails from "@/queryMatch/common/matchSumDetails.vue";
import { getIconImg } from "@/queryMatch/utils/tools";
import type { PartyGroupAnalysis } from "@/recentMatch/utils/queryTypes";

const { summonerList, summonerId, isOne, showMode, partyGroups } = defineProps<{
    summonerList: SummonerDetailInfo[];
    summonerId: number;
    isOne: boolean;
    showMode: string;
    /** 当前对局涉及的开黑组合（首页战绩查询面板传入；undefined/空数组时无 chip）。 */
    partyGroups?: PartyGroupAnalysis[];
}>();

const emits = defineEmits(["openDrawer"]);

const showSumDetails = (summonerId: number) => {
    emits("openDrawer", summonerId);
};

const getMetric = (summoner: SummonerDetailInfo, key: string) =>
    (summoner as unknown as Record<string, unknown>)[key] ?? "";

const getMetricWidth = (summoner: SummonerDetailInfo, key: string) =>
    (summoner.showDataDict as unknown as Record<string, string>)[key] ?? "0%";

/**
 * 把 `partyGroups` 摊平成 `Map<puuid, PartyGroupAnalysis>`，按
 * `selectPrimaryPartyGroups` 的语义保证一个 puuid 最多出现在一个组里。
 * 当 `partyGroups` 缺失或为空时返回空 Map。
 */
const partyGroupByPuuid = computed<Map<string, PartyGroupAnalysis>>(() => {
    const map = new Map<string, PartyGroupAnalysis>();
    if (!partyGroups || partyGroups.length === 0) return map;
    for (const group of partyGroups) {
        for (const member of group.members) {
            if (!member.puuid) continue;
            // selectPrimaryPartyGroups 在主程侧已保证不重复；这里再做一次兜底
            // 防御，避免传入脏数据时同一个 puuid 出现在多个 chip 里。
            if (map.has(member.puuid)) continue;
            map.set(member.puuid, group);
        }
    }
    return map;
});
</script>

<template>
    <div class="match-details-column">
        <!--    每一个英雄数据-->
        <n-space v-for="summoner in summonerList" vertical>
            <match-sum-details
                :item-width="290"
                @click="showSumDetails(summoner.accountId)"
                :summoner="summoner"
                :summoner-id="summonerId"
                :is-one="isOne"
                :party-group="partyGroupByPuuid.get(summoner.puuid) ?? null"
                :self-puuid="summoner.puuid"
            />
            <!--        数据显示-->
            <div class="progressDivP">
                <n-tag
                    style="height: 26px; width: 50px; justify-content: center"
                    size="small"
                    :bordered="false"
                    class="text-gray-400"
                >
                    {{ getMetric(summoner, showMode) }}
                </n-tag>
                <div class="flex-grow flex flex-col h-full justify-between">
                    <div class="matchIconImgDiv">
                        <!--        召唤师技能等-->
                        <img
                            class="itemClassSecond"
                            :src="getspellImgUrl(summoner.spell1Id)"
                        />
                        <img
                            class="itemClassSecond"
                            style="margin-right: 5px"
                            :src="getspellImgUrl(summoner.spell2Id)"
                        />
                        <n-popover
                            v-for="icon in getIconImg(
                                summoner.iconList,
                                summoner.isMvp,
                                summoner.isWin,
                            )"
                            :show-arrow="false"
                            style="padding: 2px 6px; font-size: 13px"
                            trigger="hover"
                        >
                            <template #trigger>
                                <img class="matchIconImg" :src="icon[1]" />
                            </template>
                            <span>{{ icon[0] }}</span>
                        </n-popover>
                    </div>
                    <p
                        :style="'width:' + getMetricWidth(summoner, showMode)"
                        :key="showMode"
                        :class="
                            isOne
                                ? 'scale-in-hor-left champAvatarColorRed progressP'
                                : 'scale-in-hor-left champAvatarColorBlue progressP'
                        "
                    />
                </div>
            </div>
        </n-space>
    </div>
</template>

<style scoped>
.match-details-column {
    display: flex;
    flex: 1 1 0;
    flex-direction: column;
    justify-content: space-between;
    min-width: 0;
    padding-top: 17px;
}

.matchIconImg {
    height: 12px;
    padding-bottom: 1px;
}
.matchIconImgDiv {
    display: flex;
    align-items: flex-end;
    gap: 5px;
}

.progressP {
    height: 6px;
    border-radius: 1px;
    margin: 0px;
}

.progressDivP {
    width: min(290px, 100%);
    height: 26px;
    border-radius: 2px;
    display: flex;
    align-items: center;
    gap: 12px;
    align-items: flex-end;
    position: relative;
}

.itemClassSecond {
    width: 15px;
    height: 15px;
    border-radius: 2.5px;
}
</style>
