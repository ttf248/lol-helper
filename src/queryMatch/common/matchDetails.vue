<script setup lang="ts">
import { computed } from "vue";
import { NSpace, NTag, NPopover } from "naive-ui";
import { SummonerDetailInfo } from "@/queryMatch/utils/MatchDetail";
import { getspellImgUrl } from "@/lcu/utils";
import MatchSumDetails from "@/queryMatch/common/matchSumDetails.vue";
import { getIconImg } from "@/queryMatch/utils/tools";
import type { PartyGroupAnalysis } from "@/recentMatch/utils/queryTypes";
import { partyGroupStableKey } from "@/recentMatch/utils/partyDisplay";

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
 * 同组视觉联动调色板：6 色 Tailwind 默认色系，亮色背景对比度通过。
 * 用 stableKey 哈希取模，让同一组的所有成员行始终拿到同一种色。
 */
const PARTY_PALETTE = [
    "#f97316", // orange
    "#22c55e", // green
    "#06b6d4", // cyan
    "#a855f7", // purple
    "#ec4899", // pink
    "#eab308", // yellow
];

/** 简单字符串哈希（djb2），只用于取模到调色板，无需密码学强度。 */
const hashStableKey = (key: string): number => {
    let hash = 5381;
    for (let i = 0; i < key.length; i += 1) {
        hash = ((hash << 5) + hash + key.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
};

interface PartyMeta {
    group: PartyGroupAnalysis;
    ordinal: number;
    color: string;
}

/**
 * 把 `partyGroups` 摊平成 `Map<puuid, PartyMeta>`，按
 * `selectPrimaryPartyGroups` 的语义保证一个 puuid 最多出现在一个组里。
 * 每个组按数组下标派生 ordinal 与稳定颜色，让 chip 文本与左侧色条
 * 在整列保持一致。
 * 当 `partyGroups` 缺失或为空时返回空 Map。
 */
const partyMetaByPuuid = computed<Map<string, PartyMeta>>(() => {
    const map = new Map<string, PartyMeta>();
    if (!partyGroups || partyGroups.length === 0) return map;
    partyGroups.forEach((group, index) => {
        const ordinal = index + 1;
        const stableKey = partyGroupStableKey(group);
        const color = PARTY_PALETTE[hashStableKey(stableKey) % PARTY_PALETTE.length];
        for (const member of group.members) {
            if (!member.puuid) continue;
            // selectPrimaryPartyGroups 在主程侧已保证不重复；这里再做一次兜底
            // 防御，避免传入脏数据时同一个 puuid 出现在多个 chip 里。
            if (map.has(member.puuid)) continue;
            map.set(member.puuid, { group, ordinal, color });
        }
    });
    return map;
});

const partyMetaFor = (puuid: string): PartyMeta | null =>
    partyMetaByPuuid.value.get(puuid) ?? null;
</script>

<template>
    <div class="match-details-column">
        <!--    每一个英雄数据-->
        <n-space v-for="summoner in summonerList" vertical>
            <div
                class="party-row"
                :class="{ 'party-row--grouped': !!partyMetaFor(summoner.puuid) }"
                :style="
                    partyMetaFor(summoner.puuid)
                        ? { '--party-color': partyMetaFor(summoner.puuid)!.color }
                        : undefined
                "
            >
            <match-sum-details
                :item-width="290"
                @click="showSumDetails(summoner.accountId)"
                :summoner="summoner"
                :summoner-id="summonerId"
                :is-one="isOne"
                :party-group="partyMetaFor(summoner.puuid)?.group ?? null"
                :self-puuid="summoner.puuid"
                :party-color="partyMetaFor(summoner.puuid)?.color"
                :party-ordinal="partyMetaFor(summoner.puuid)?.ordinal"
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

/* 同组队视觉联动：被识别为开黑的玩家行加 4px 实心左侧 border + 8%
 * 透明度的同色背景，颜色由调用方通过 CSS 变量 --party-color 派生。
 * 同一组的成员行共享同一颜色，让"谁是同组"在整列一眼可见。 */
.party-row {
    border-left: 4px solid transparent;
    border-radius: 3px;
    padding-left: 6px;
    transition: background-color 120ms ease;
}

.party-row--grouped {
    border-left-color: var(--party-color);
    background-color: color-mix(in srgb, var(--party-color) 8%, transparent);
}

.itemClassSecond {
    width: 15px;
    height: 15px;
    border-radius: 2.5px;
}
</style>
