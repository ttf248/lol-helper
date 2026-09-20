<script setup lang="ts">
import { Ref, ref } from "vue";
import { NDrawer, NDrawerContent, NResult, NSpin } from "naive-ui";
import MatchDetails from "./matchDetails.vue";
import MatchConHeader from "./matchConHeader.vue";
import MatchDrawer from "@/queryMatch/common/matchDrawer.vue";
import MatchDetailsFighter from "@/queryMatch/common/matchDetailsFighter.vue";
import { SumDetail, SummonerDetailInfo } from "@/queryMatch/utils/MatchDetail";
import { logger } from "@/utils/logger";

const emits = defineEmits(["changeSum"]);
const { teamOne, teamTwo, headerInfo, summonerId, queueId, isGameIn } =
    defineProps<{
        teamOne: SummonerDetailInfo[];
        teamTwo: SummonerDetailInfo[];
        headerInfo: string[];
        queueId: number;
        summonerId: number;
        isGameIn: boolean;
    }>();

const rotatedIndex = ref(0);
const isMatchDra = ref(false);
const curMatchDraData: Ref<null | SumDetail> = ref(null);
const drawerLoading = ref(false);
const drawerError = ref<string | null>(null);
const titleArr = [
    ["totalDamageDealtToChampions", "输出伤害"],
    ["totalDamageTaken", "承受伤害"],
    ["goldEarned", "商店存款"],
    ["visionScore", "视野得分"],
    ["totalMinionsKilled", "击杀小兵"],
];

const changeShowMode = () => {
    rotatedIndex.value = (rotatedIndex.value += 1) % titleArr.length;
};

const openMatchDra = async (summonerId: number) => {
    if (isGameIn) {
        // 如果是游戏里面的窗口显示此页面，不让打开抽屉窗口
        return;
    }
    drawerLoading.value = true;
    drawerError.value = null;
    curMatchDraData.value = null;
    isMatchDra.value = true;
    try {
        const allTeam = teamOne.concat(teamTwo);
        const summonerInfo = allTeam.find((v) => v.accountId === summonerId);
        if (summonerInfo === undefined) {
            throw new Error("当前对局没有该玩家的完整身份数据");
        }
        curMatchDraData.value = await getDrawerData(summonerInfo);
    } catch (error) {
        logger.error({
            tag: "matchContent.drawer",
            message: "加载玩家对局详情失败",
            context: { summonerId, error: String(error).slice(0, 200) },
        });
        drawerError.value =
            "该玩家的对局数据没有返回完整信息，请稍后重试。";
    } finally {
        drawerLoading.value = false;
    }
};

const getDrawerData = async (
    summonerInfo: SummonerDetailInfo,
): Promise<SumDetail> => {
    const listItemData = [
        ["输出伤害", summonerInfo.totalDamageDealtToChampions],
        ["物理伤害", summonerInfo.physicalDamageDealtToChampions],
        ["魔法伤害", summonerInfo.magicDamageDealtToChampions],
        ["真实伤害", summonerInfo.trueDamageDealtToChampions],
        ["承受伤害", summonerInfo.totalDamageTaken],
        ["击杀野怪", summonerInfo.neutralMinionsKilled],
        ["击杀小兵", summonerInfo.totalMinionsKilled],
        ["获得金钱", summonerInfo.goldEarned],
        ["视野得分", summonerInfo.visionScore],
        ["放置守卫", summonerInfo.wardsPlaced],
    ];

    return {
        name: summonerInfo.name,
        champImgUrl: summonerInfo.champImgUrl,
        kda: `${summonerInfo.kills}-${summonerInfo.deaths}-${summonerInfo.assists}`,
        champLevel: summonerInfo.champLevel,
        listItemData: listItemData,
        runesList: summonerInfo.runesList,
        spell1Id: summonerInfo.spell1Id,
        spell2Id: summonerInfo.spell2Id,
        summonerId: summonerInfo.accountId,
    } as SumDetail;
};

const searchSummoner = () => {
    if (curMatchDraData.value === null) {
        drawerError.value = "当前没有可用的玩家数据，无法查询详细战绩。";
        return;
    }
    isMatchDra.value = false;
    emits("changeSum", curMatchDraData.value?.summonerId);
};
</script>

<template>
    <div class="match-content-standard" v-if="queueId !== 1700">
        <match-con-header
            :title="titleArr[rotatedIndex][1]"
            :title-list="headerInfo"
            :change-show="changeShowMode"
        />
        <div class="match-teams">
            <match-details
                @open-drawer="openMatchDra"
                :summoner-list="teamOne"
                :summoner-id="summonerId"
                :show-mode="titleArr[rotatedIndex][0]"
                :is-one="true"
            />
            <match-details
                @open-drawer="openMatchDra"
                :summoner-list="teamTwo"
                :summoner-id="summonerId"
                :show-mode="titleArr[rotatedIndex][0]"
                :is-one="false"
            />
        </div>
    </div>

    <match-details-fighter
        v-else
        :header-info="headerInfo"
        :team-one="teamOne"
        :summoner-id="summonerId"
        @open-drawer="openMatchDra"
    />

    <n-drawer
        v-if="!isGameIn"
        v-model:show="isMatchDra"
        style="
            border-top-right-radius: 0.45rem;
            border-bottom-right-radius: 0.45rem;
        "
        @after-leave="curMatchDraData = null"
        :auto-focus="false"
        :width="265"
        placement="left"
    >
        <n-drawer-content v-if="drawerLoading" body-content-style="padding: 24px 12px">
            <div class="h-full flex flex-col justify-center items-center gap-3">
                <n-spin size="large" />
                <span>正在查询玩家数据...</span>
            </div>
        </n-drawer-content>
        <n-drawer-content v-else-if="drawerError" body-content-style="padding: 12px">
            <n-result
                status="warning"
                title="玩家数据不可用"
                :description="drawerError"
            />
        </n-drawer-content>
        <match-drawer
            v-else-if="curMatchDraData !== null"
            :search-summoner="searchSummoner"
            :personal-details="curMatchDraData"
        />
    </n-drawer>
</template>

<style scoped>
.match-content-standard {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
}

.match-teams {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    justify-content: space-between;
    gap: 24px;
}

.match-teams :deep(.match-details-column) {
    flex: 1 1 0;
    min-width: 0;
}
</style>
