<script setup lang="ts">
import { getItemImgUrl } from "@/lcu/utils";
import { NAvatar, NEllipsis, NPopover, NTag } from "naive-ui";
import { SummonerDetailInfo } from "@/queryMatch/utils/MatchDetail";
import type { PartyGroupAnalysis } from "@/recentMatch/utils/queryTypes";
import {
  formatRate,
  partyEvidenceTime,
  partyGroupKindLabel,
  partyGroupNames,
  partyGroupTeammates,
  winRateTagType,
} from "@/recentMatch/utils/partyDisplay";

const { summoner, summonerId, isOne, itemWidth, partyGroup, selfPuuid } = defineProps<{
    summoner: SummonerDetailInfo;
    summonerId?: number;
    isOne?: boolean;
    itemWidth: number;
    /** 该玩家所属的开黑组合（首页战绩查询面板传入；null/未传时不渲染 chip）。 */
    partyGroup?: PartyGroupAnalysis | null;
    /** 用于将 chip 上的自己替换为"我"。 */
    selfPuuid?: string;
}>();

const partyTagType = () =>
    partyGroup && partyGroup.highWinRateAlert
        ? "warning"
        : winRateTagType(partyGroup?.winRate ?? 0);

const partyTagText = () => {
    if (!partyGroup) return "";
    const members = partyGroupKindLabel(partyGroup);
    const games = partyGroup.historicalGames ?? partyGroup.games;
    return `${members} · ${games}场`;
};
</script>

<template>
    <div class="flex gap-x-3" :style="{ width: itemWidth + 'px' }">
        <!--      头像-->
        <div class="relative cursor-pointer">
            <n-avatar
                :bordered="false"
                :size="50"
                :src="summoner.champImgUrl"
                fallback-src="https://wegame.gtimg.com/g.26-r.c2d3c/helper/lol/assis/images/resources/usericon/4027.png"
                style="display: block"
            />
            <div
                :class="
                    isOne
                        ? 'champAvatarColorRed champLevel'
                        : 'champAvatarColorBlue champLevel'
                "
            >
                {{ summoner.champLevel }}
            </div>
        </div>

        <div class="grow flex flex-col justify-between">
            <!--        装备-->
            <div class="flex justify-between">
                <img
                    class="itemClass"
                    v-for="url in summoner.items"
                    :src="getItemImgUrl(url)"
                />
            </div>

            <div class="flex justify-between">
                <!--          召唤师昵称-->
                <text
                    class="nameDiv"
                    :class="
                        summonerId === summoner.accountId
                            ? 'nameDiv currentSumColor slideSum'
                            : 'nameDiv text-gray-400'
                    "
                    :bordered="false"
                >
                    <n-ellipsis style="max-width: 170px">
                        {{ summoner.name }}
                    </n-ellipsis>
                </text>
                <n-tag class="kdaDiv" size="tiny" :bordered="false">
                    {{ summoner.kills }}-{{ summoner.deaths }}-{{
                        summoner.assists
                    }}
                </n-tag>
            </div>
            <!-- 首页新增：开黑组合 chip。partyGroup 为空时不渲染。 -->
            <div v-if="partyGroup" class="party-chip-row">
                <n-popover
                    trigger="hover"
                    placement="top-start"
                    :show-arrow="false"
                    style="max-width: 320px"
                >
                    <template #trigger>
                        <n-tag
                            size="tiny"
                            :type="partyTagType()"
                            :bordered="false"
                            class="party-chip"
                        >
                            开黑 {{ partyTagText() }}
                        </n-tag>
                    </template>
                    <div class="party-chip-popover">
                        <div class="font-medium mb-1">
                            {{ partyGroupNames(partyGroup, selfPuuid) }}
                        </div>
                        <div class="text-xs text-gray-500">
                            同组 {{ partyGroupTeammates(partyGroup, summoner.puuid) }}
                        </div>
                        <div class="text-xs text-gray-500 mt-1">
                            胜率 {{ formatRate(partyGroup.winRate) }} ·
                            关系强度 {{ partyGroup.stabilityScore }}
                        </div>
                        <div
                            v-for="evidence in partyGroup.evidence.slice(0, 3)"
                            :key="evidence.gameId"
                            class="text-xs text-gray-400"
                        >
                            {{ partyEvidenceTime(evidence.gameCreation) }} ·
                            对局 {{ evidence.gameId }}
                        </div>
                    </div>
                </n-popover>
            </div>
        </div>
    </div>
</template>

<style scoped>
.party-chip-row {
    display: flex;
    align-items: center;
    margin-top: 2px;
}

.party-chip {
    font-size: 11px;
    line-height: 14px;
    cursor: default;
}

.party-chip-popover {
    color: #374151;
    line-height: 1.5;
    padding: 2px 4px;
}
</style>
<style scoped>
.currentSumColor {
    color: #f0a020;
}

.nameDiv {
    font-size: 13px;
    line-height: 16px;
}

.champLevel {
    position: absolute;
    display: flex;
    justify-content: center;
    align-items: center;
    font-size: 12px;
    width: 15px;
    height: 15px;
    bottom: 0px;
    right: 0px;
    color: #ffffff;
    border-radius: 2px;
}

.itemClass {
    width: 25px;
    height: 25px;
    border-radius: 3px;
}

.kdaDiv {
    width: 59px;
    justify-content: center;
}
.champAvatarColorBlue {
    background-color: #66b3ff;
}
.champAvatarColorRed {
    background-color: #ff6666;
}
</style>
