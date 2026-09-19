<script setup lang="ts">
import QueryHeader from "./components/queryHeader.vue";
import SummonerInfoView from "./components/summonerInfoView.vue";
import MatchMain from "./components/matchMain.vue";
import useMatchStore from "@/queryMatch/store";
import {
    NCard,
    NResult,
    NDrawer,
    NDrawerContent,
    NButton,
    NTabs,
    NTabPane,
} from "naive-ui";
import MatchErr from "@/queryMatch/components/matchErr.vue";
import { computed, onBeforeMount, onBeforeUnmount, onMounted, Ref, ref } from "vue";
import { ParticipantsInfo } from "@/queryMatch/utils/MatchDetail";
import MatchContent from "@/queryMatch/common/matchContent.vue";
import LoadingAnime from "@/queryMatch/components/loadingAnime.vue";
import HistoryAnalyticsPanel from "@/queryMatch/components/historyAnalyticsPanel.vue";
import { RecentSumInfo } from "@/recentMatch/utils/queryTypes";
import { listen } from "@tauri-apps/api/event";

const matchStore = useMatchStore();
const blackMatchDrawer = ref(false);
const blackMatchDetails: Ref<[ParticipantsInfo, number] | null> = ref(null);
const activeTab = ref<"matches" | "analytics">("matches");
let stopInitHome: (() => void) | null = null;

const analysisPlayer = computed<RecentSumInfo | null>(() => {
    const info = matchStore.sumInfo?.info;
    if (!info) return null;
    return {
        summonerId: info.currentId,
        summonerName: info.name,
        puuid: info.puuid,
        championUrl: info.imgUrl,
        champId: 0,
        teamParticipantId: 0,
        matchList: [],
    };
});

onBeforeMount(() => {
    // 判断是否从其它窗口启动的此窗口
    const isQueryRecord = localStorage.getItem("queSumMatch");

    if (isQueryRecord === null) {
        matchStore.init();
    } else {
        handleBlackListMatch(isQueryRecord).then(() => {
            localStorage.removeItem("queSumMatch");
        });
    }
});

onMounted(async () => {
    stopInitHome = await listen("initHome", () => {
        if (localStorage.getItem("queSumMatch") === null) {
            void matchStore.init();
        }
    });
});

onBeforeUnmount(() => {
    stopInitHome?.();
});

const handleBlackListMatch = async (isQueryRecord: string) => {
    const localSumInfo = JSON.parse(
        localStorage.getItem("sumInfo") || "null",
    ) as { summonerId?: number } | null;
    const locSumId = Number(localSumInfo?.summonerId || 0);
    const queSumMatchInfo = isQueryRecord.split("-");
    if (queSumMatchInfo[1] !== "") {
        const participantsInfo = await matchStore.queryMatchDetail(
            Number(queSumMatchInfo[1]),
            Number(queSumMatchInfo[0]),
        );
        if (participantsInfo === null) {
            return;
        }
        blackMatchDetails.value = [
            participantsInfo,
            Number(queSumMatchInfo[0]),
        ];
        blackMatchDrawer.value = true;
    }
    await matchStore.init(Number(queSumMatchInfo[0]), locSumId);
};
const clearBlackMatch = () => {
    blackMatchDetails.value = null;
    blackMatchDrawer.value = false;
};
</script>

<template>
    <div class="main bg-neutral-100 dark:bg-neutral-900">
        <div data-tauri-drag-region class="dragDiv"></div>

        <query-header class="h-10 mb-2" />

        <div class="flex">
            <summoner-info-view
                v-if="matchStore.sumInfo"
                :key="matchStore.summonerId"
                :sum-info="matchStore.sumInfo"
            />
            <div style="width: 254px" v-else></div>
            <div class="ml-3 flex-grow">
                <n-card
                    v-if="!matchStore.matchLoading"
                    class="shadow h-full"
                    size="small"
                    style="height: 596px"
                    content-style="padding:0 0 0 12px"
                >
                    <n-tabs
                        v-model:value="activeTab"
                        class="match-tabs"
                        type="line"
                        size="small"
                    >
                        <n-tab-pane name="matches" tab="对局详情">
                            <match-err
                                v-if="matchStore.matchList === null"
                                :message="matchStore.matchError || undefined"
                            />
                            <match-main
                                v-else-if="matchStore.matchList.length !== 0"
                                :summoner-id="matchStore.summonerId"
                            />
                            <div
                                v-else-if="!matchStore.matchLoading"
                                class="w-full h-full flex justify-center items-center"
                            >
                                <n-result
                                    size="large"
                                    status="404"
                                    title="没有可展示的战绩"
                                    :description="
                                        matchStore.matchError ||
                                        '此页不存在数据，请返回前一页'
                                    "
                                >
                                    <template #footer>
                                        <n-button type="error">
                                            生活总归带点荒谬
                                        </n-button>
                                    </template>
                                </n-result>
                            </div>
                        </n-tab-pane>
                        <n-tab-pane name="analytics" tab="历史分析">
                            <history-analytics-panel
                                v-if="analysisPlayer"
                                :key="analysisPlayer.puuid"
                                :player="analysisPlayer"
                            />
                            <div
                                v-else
                                class="w-full h-full flex justify-center items-center"
                            >
                                <n-result
                                    status="info"
                                    title="正在读取当前玩家"
                                    description="查询到召唤师信息后即可开始历史分析"
                                />
                            </div>
                        </n-tab-pane>
                    </n-tabs>
                </n-card>
                <n-card
                    v-else
                    class="shadow h-full"
                    size="small"
                    style="height: 596px"
                    content-style="padding:0 0 0 12px"
                >
                    <loading-anime />
                </n-card>
            </div>
        </div>
    </div>

    <n-drawer
        v-model:show="blackMatchDrawer"
        @after-leave="clearBlackMatch"
        style="border-radius: 0.5rem"
        :width="658"
        placement="right"
    >
        <n-drawer-content
            body-content-style="padding:24px 12px"
            v-if="blackMatchDetails"
        >
            <match-content
                :queue-id="blackMatchDetails[0].queueId"
                :header-info="blackMatchDetails[0].headerInfo"
                :team-two="blackMatchDetails[0].teamTwo"
                :summoner-id="blackMatchDetails[1]"
                :is-game-in="true"
                :team-one="blackMatchDetails[0].teamOne"
            />
        </n-drawer-content>
    </n-drawer>
</template>

<style scoped>
.main {
    /* 主窗口现在直接承载战绩工作区，不再为旧的底部导航预留空白。 */
    padding-bottom: 0.5rem;
}

.match-tabs {
    height: 100%;
}

.match-tabs :deep(.n-tabs-pane-wrapper) {
    flex: 1;
    min-height: 0;
}

.match-tabs :deep(.n-tab-pane) {
    height: 100%;
    padding: 0;
}
</style>
