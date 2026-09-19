<script setup lang="ts">
import { onMounted, reactive, ref, Ref } from "vue";
import QuerySummoner from "@/recentMatch/utils/querySummoner";
import Dashboard from "@/recentMatch/components/dashboard.vue";
import RecentMatchList from "@/recentMatch/components/recentMatchList.vue";
import {
    ChampInfoTypes,
    ChampTinyTypes,
    MatchItemTypes,
    RecentAllSumInfo,
    RecentNetworkAnalysis,
    RecentHistoryStatus,
    RecentSumInfo,
    RecentMatchLoadingState,
} from "@/recentMatch/utils/queryTypes";
import QueryMatch from "@/recentMatch/utils/queryMatch";
import MatchContent from "@/queryMatch/common/matchContent.vue";
import MatchDetails from "@/queryMatch/utils/matchDetails";
import { ParticipantsInfo } from "@/queryMatch/utils/MatchDetail";
import { NDrawer, NResult } from "naive-ui";
import NullPage from "@/recentMatch/components/nullPage.vue";
import { emitTo, once } from "@tauri-apps/api/event";
import { window } from "@tauri-apps/api";
import ChampInfo from "@/recentMatch/components/champInfo.vue";
import { requestFetch } from "@/main/utils/request.ts";
import {
    applyFastRecentAnalysis,
    clearRecentAnalysisCache,
    loadRecentTeamAnalysis,
    RecentAnalysisProgress,
} from "@/recentMatch/utils/recentAnalytics";
import {
    HISTORY_FAST_WINDOW,
    HISTORY_SERVER_FETCH_LIMIT,
    HISTORY_SERVER_PAGE_COUNT,
} from "@/recentMatch/utils/historyConfig";
import type { CurrentMatchProgress } from "@/recentMatch/utils/querySummoner";
import RecentNetworkGraph from "@/recentMatch/components/recentNetworkGraph.vue";

const querySummoner = new QuerySummoner();
const queryMatch = new QueryMatch();

const isLcuErr = ref(true);
const friendList: Ref<RecentSumInfo[]> = ref([]);
const enemyList: Ref<RecentSumInfo[]> = ref([]);
const queueId: Ref<number> = ref(0);
const winCount = ref({ friend: [0, 0], enemy: [0, 0] });
const isFriCount = ref(true);
const recentAnalysisLoading = ref(false);
const isNetworkModal = ref(false);
const networkAnalysis: Ref<RecentNetworkAnalysis | null> = ref(null);
const loadingState = reactive<RecentMatchLoadingState>({
    stage: "players",
    completed: 0,
    total: 10,
    message: "正在读取本局玩家",
    detail: "正在连接游戏数据接口…",
});

const setLoadingState = (next: Partial<RecentMatchLoadingState>) => {
    Object.assign(loadingState, next);
};

const currentId = ref(0);
const matchDetials = new MatchDetails();
const isDetailModal = ref(false);
const isDetailModalLeft = ref(true);
const participantsInfo: Ref<ParticipantsInfo | null> = ref(null);
const isChampInfo = ref(false);
const champInfo: Ref<{ info: null | ChampTinyTypes; list: ChampInfoTypes[] }> =
    ref({ info: null, list: [] });

once("matchListCache", () => {
    init();
});

onMounted(() => {
    window.Window.getByLabel("mainWindow").then((win) => {
        if (win !== null) {
            emitTo("mainWindow", "cacheMatchList", "getMatchList");
        }
    });
});

const queryAllSumInfo = async (): Promise<RecentAllSumInfo | null> =>
    querySummoner.fromLcuQuery((progress: CurrentMatchProgress) => {
        setLoadingState({
            stage: "players",
            completed: progress.loaded,
            total: progress.total,
            message: progress.message,
            detail: progress.loaded >= progress.total
                ? "正在准备读取最近战绩…"
                : "游戏加载阶段可能暂时缺少玩家，已识别的数据会先显示。",
        });
    });

const normalizeMatchList = (matches: MatchItemTypes[]): MatchItemTypes[] => {
    const unique = new Map<number, MatchItemTypes>();
    for (const match of matches) {
        if (!Number.isFinite(match.gameId)) continue;
        const previous = unique.get(match.gameId);
        const currentCreation = Number(match.gameCreation || 0);
        const previousCreation = Number(previous?.gameCreation || 0);
        if (!previous || currentCreation > previousCreation) {
            unique.set(match.gameId, match);
        }
    }

    return Array.from(unique.values()).sort(
        (left, right) =>
            Number(right.gameCreation || 0) - Number(left.gameCreation || 0),
    );
};

const commitHistoryResult = (
    summoner: RecentSumInfo,
    result: [RecentSumInfo["matchList"], number, RecentHistoryStatus],
    isFri: boolean,
    onComplete?: () => void,
) => {
    const targetList = isFri ? friendList.value : enemyList.value;
    const countList = isFri ? winCount.value.friend : winCount.value.enemy;
    const oldIndex = targetList.findIndex((item) => item.puuid === summoner.puuid);
    const matchList = normalizeMatchList(result[0]);

    // 胜场和总场次始终从去重后的最终列表重算，不能信任不同数据源
    // 合并前的数量，否则边界重复会污染顶部的队伍胜率。
    summoner.matchList = matchList;
    summoner.historyStatus = result[2];
    countList[0] += matchList.filter((match) => match.isWin).length;
    countList[1] += matchList.length;
    if (oldIndex >= 0) {
        targetList[oldIndex] = summoner;
    } else {
        targetList.push(summoner);
    }
    targetList.sort((left, right) => left.teamParticipantId - right.teamParticipantId);
    onComplete?.();
};

const init = () => {
    // 面板刷新时清理上一轮结果，避免胜场和进度重复累计。
    // 历史分析缓存也必须在新一局重新建立，避免复用上一局的玩家快照。
    clearRecentAnalysisCache();
    friendList.value = [];
    enemyList.value = [];
    winCount.value = { friend: [0, 0], enemy: [0, 0] };
    networkAnalysis.value = null;
    recentAnalysisLoading.value = false;
    setLoadingState({
        stage: "players",
        completed: 0,
        total: 10,
        message: "正在读取本局玩家",
        detail: "正在连接游戏数据接口…",
    });

    void (async () => {
        try {
            const allSumInfo = await queryAllSumInfo();
            if (allSumInfo === null) {
                isLcuErr.value = true;
                setLoadingState({
                    stage: "error",
                    message: "本局玩家读取失败",
                    detail: "未取得 LCU 对局数据，请确认游戏仍在加载或已进入对局。",
                });
                return;
            }

            isLcuErr.value = false;
            queueId.value = allSumInfo.queueId;
            // 先把当前已识别的玩家渲染出来，历史接口不再阻塞本局阵容显示。
            friendList.value = allSumInfo.friendList;
            enemyList.value = allSumInfo.enemyList;
            const playerTotal = friendList.value.length + enemyList.value.length;
            setLoadingState({
                stage: "history",
                completed: 0,
                total: Math.max(playerTotal, 10),
                message: "正在读取缓存并校验服务器最新战绩",
                detail: playerTotal < 10
                    ? `当前已识别 ${playerTotal}/10 人，先显示已有玩家。`
                    : `每名玩家只查询服务器最近 ${HISTORY_SERVER_PAGE_COUNT} 页（最多 ${HISTORY_SERVER_FETCH_LIMIT} 场），再合并本地缓存。`,
            });

            let completedHistory = 0;
            const onHistoryComplete = () => {
                completedHistory += 1;
                setLoadingState({
                    stage: "history",
                    completed: completedHistory,
                    total: Math.max(playerTotal, 10),
                    message: "正在读取缓存并校验服务器最新战绩",
                    detail: `${completedHistory}/${playerTotal} 名玩家的基础战绩已完成。`,
                });
            };

            // 每个玩家都必须按自己的 PUUID + 模式读取历史。旧的主面板
            // simpleMatchList 只有 summonerId 索引，无法证明记录属于当前
            // 队友，不能再作为队友历史的快捷数据源。
            await Promise.all([
                getCompleteSumInfo(
                    allSumInfo.friendList,
                    allSumInfo.queueId,
                    true,
                    onHistoryComplete,
                ),
                getCompleteSumInfo(
                    allSumInfo.enemyList,
                    allSumInfo.queueId,
                    false,
                    onHistoryComplete,
                ),
            ]);

            isFriCount.value =
                winCount.value.friend[0] >= winCount.value.enemy[0];
            applyFastRecentAnalysis([
                ...friendList.value,
                ...enemyList.value,
            ]);
            recentAnalysisLoading.value = true;
            void loadRecentTeamAnalysis(
                friendList.value,
                enemyList.value,
                allSumInfo.queueId,
                (progress: RecentAnalysisProgress) => {
                    setLoadingState({
                        stage: progress.stage === "cache" ? "history" : progress.stage,
                        completed: progress.completed,
                        total: progress.total,
                        message: progress.message,
                        detail: progress.stage === "full"
                            ? `${progress.completed}/${progress.total} 名玩家已完成三页服务器数据与本地缓存合并。`
                            : `最近 ${HISTORY_FAST_WINDOW} 场已可查看，后台继续合并服务器最近三页。`,
                    });
                },
            )
                .then((analysis) => {
                    networkAnalysis.value = analysis;
                })
                .catch((error) => {
                    console.error("Failed to load recent team analysis", error);
                    setLoadingState({
                        stage: "error",
                        message: "最近历史分析部分失败",
                        detail: `最近 ${HISTORY_FAST_WINDOW} 场仍可查看，服务器最近三页合并失败，可稍后重试。`,
                    });
                })
                .finally(() => {
                    recentAnalysisLoading.value = false;
                });
        } catch (error) {
            console.error("Failed to initialize recent-match panel", error);
            isLcuErr.value = true;
            setLoadingState({
                stage: "error",
                message: "对局数据加载失败",
                detail: "请确认 League 客户端和游戏进程正常运行后重试。",
            });
        }
    })();
};

const getCompleteSumInfo = async (
    sumInfos: RecentSumInfo[],
    queueId: number,
    isFri: boolean,
    onComplete?: () => void,
) => {
    await Promise.all(
        sumInfos.map(async (summoner) => {
            const result = await queryMatch.queryMatchHistory(
                summoner.puuid,
                queueId,
                summoner.summonerId,
            );
            commitHistoryResult(summoner, result, isFri, onComplete);
        }),
    );
};

const openDetailDrawer = async (
    gameId: number,
    summonerId: number,
    isFri: boolean,
    champId: number,
) => {
    isDetailModalLeft.value = isFri;
    if (gameId === 0 && summonerId === 0) {
        isChampInfo.value = true;
        isDetailModal.value = true;
        await getChampInfoList(champId);
        return;
    }

    const matchInfo = await matchDetials.queryGameDetail(gameId, summonerId);
    if (matchInfo !== null) {
        currentId.value = summonerId;
        participantsInfo.value = matchInfo;
    }
    isDetailModal.value = true;
};

const getChampInfoList = async (champId: number) => {
    try {
        const url = `https://game.gtimg.cn/images/lol/act/img/js/hero/${champId}.js?ts=2893692`;
        const res = await requestFetch<any>(url, "GET");
        if (res !== null && res?.spells) {
            const info: ChampTinyTypes = {
                name: res.hero.name + " " + res.hero.title,
                alias: `https://game.gtimg.cn/images/lol/act/img/champion/${res.hero.alias}.png`,
                roles: res.hero.roles,
            };
            champInfo.value.info = info;
            // 定义排序顺序
            const order = ["q", "w", "e", "r", "passive"];
            // 对数组进行排序
            champInfo.value.list = res.spells.sort((a: any, b: any) => {
                return order.indexOf(a.spellKey) - order.indexOf(b.spellKey);
            });
        }
    } catch (error) {
        console.error(error);
    }
};

</script>

<template>
    <div class="main recent-page bg-neutral-100 dark:bg-neutral-900">
        <dashboard
            class="recent-dashboard"
            @open-network="isNetworkModal = true"
            :win-count="winCount"
            :is-fri-count="isFriCount"
            :queue-id="queueId"
            :analysis-loading="recentAnalysisLoading"
            :loading-state="loadingState"
        />

        <null-page v-if="isLcuErr" />

        <div v-else class="team-columns">
            <recent-match-list
                @show-detail="openDetailDrawer"
                :sum-list="friendList"
                :queue-id="queueId"
                :is-fri="true"
                :analysis-loading="recentAnalysisLoading"
                :loading-state="loadingState"
            />
            <recent-match-list
                @show-detail="openDetailDrawer"
                :sum-list="enemyList"
                :queue-id="queueId"
                :is-fri="false"
                :analysis-loading="recentAnalysisLoading"
                :loading-state="loadingState"
            />
        </div>
    </div>

    <n-drawer
        style="border-radius: 0.5rem"
        v-model:show="isDetailModal"
        :placement="!isDetailModalLeft ? 'left' : 'right'"
        :auto-focus="false"
        :on-after-leave="
            () => {
                isChampInfo = false;
                champInfo = { info: null, list: [] };
            }
        "
        width="632px"
    >
        <div
            class="bg-white text-neutral-900 p-3 h-full box-border rounded-lg dark:bg-zinc-900 dark:text-neutral-200"
        >
            <champ-info
                v-if="isChampInfo"
                :champ-info-list="champInfo.list"
                :champ-tiny="champInfo.info"
            />

            <match-content
                v-else-if="participantsInfo !== null"
                :header-info="participantsInfo.headerInfo"
                :team-one="participantsInfo.teamOne"
                :team-two="participantsInfo.teamTwo"
                :queue-id="participantsInfo.queueId"
                :summoner-id="currentId"
                :is-game-in="true"
            />
            <div
                class="w-full h-full flex justify-center items-center"
                v-else-if="!isChampInfo && participantsInfo === null"
            >
                <n-result
                    size="large"
                    status="418"
                    title="获取当前战绩数据异常"
                    description="请切换其它战绩, 尝试再次获取数据..."
                >
                </n-result>
            </div>
        </div>
    </n-drawer>

    <n-drawer
        v-model:show="isNetworkModal"
        placement="bottom"
        height="420px"
        :auto-focus="false"
    >
        <div
            class="bg-white text-neutral-900 p-4 h-full box-border dark:bg-zinc-900 dark:text-neutral-200"
        >
            <recent-network-graph :analysis="networkAnalysis" />
        </div>
    </n-drawer>
</template>
