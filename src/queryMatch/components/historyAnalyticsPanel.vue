<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import {
  NAvatar,
  NButton,
  NButtonGroup,
  NCard,
  NEmpty,
  NProgress,
  NSpin,
  NTag,
} from "naive-ui";
import {
  CachedPlayerSummary,
  getHistoryAnalysisSnapshot,
  getCachedPlayerSummary,
  getDatabaseStatus,
} from "@/recentMatch/utils/databaseCache";
import {
  MATCH_MODES,
  MatchModeKey,
  modeLabel,
} from "@/recentMatch/utils/matchMode";
import { loadPlayerCacheAnalysis } from "@/recentMatch/utils/recentAnalytics";
import {
  PlayerRecentAnalysis,
  PlayerAnalysisProgress,
  PartyGroupAnalysis,
  RecentSumInfo,
  TeammateSynergyStats,
  HistoryAnalysisSnapshot,
  HistoryResultFilter,
} from "@/recentMatch/utils/queryTypes";
import RecentNetworkGraph from "@/recentMatch/components/recentNetworkGraph.vue";
import DuoGroupCard from "@/recentMatch/components/DuoGroupCard.vue";
import {
  confidenceLabel,
  formatRate,
} from "@/recentMatch/utils/partyDisplay";
import { championName as championNameShared } from "@/recentMatch/utils/display";
import { positionLabel } from "@/lcu/utils";
import { getChampionImageUrl } from "@/utils/championImage";
import { useSummonerNavigation } from "@/queryMatch/composables/useSummonerNavigation";
import type { PartyMember, RecentNetworkNode } from "@/recentMatch/utils/queryTypes";

type PartyRankingMode = "frequency" | "winRate";
type HistoryWindowSize = 20 | 50 | 100 | 500;

const HISTORY_WINDOW_SIZES: readonly HistoryWindowSize[] = [20, 50, 100, 500];

const POSITION_LABEL_CACHE = new Map<string, string>();
const positionName = (position: string) => {
    const cached = POSITION_LABEL_CACHE.get(position);
    if (cached !== undefined) return cached;
    const label = positionLabel(position);
    POSITION_LABEL_CACHE.set(position, label);
    return label;
};

const CHAMPION_IMAGE_CACHE = new Map<number, string>();
const championImage = (championId: number) => {
    const cached = CHAMPION_IMAGE_CACHE.get(championId);
    if (cached !== undefined) return cached;
    const url = getChampionImageUrl(championId);
    CHAMPION_IMAGE_CACHE.set(championId, url);
    return url;
};

const props = defineProps<{ player: RecentSumInfo }>();
const selectedMode = ref<MatchModeKey>("match");
const partyRankingMode = ref<PartyRankingMode>("frequency");
const analysis = ref<PlayerRecentAnalysis | null>(null);
const snapshot = ref<HistoryAnalysisSnapshot | null>(null);
const windowSize = ref<HistoryWindowSize>(50);
const selectedResult = ref<HistoryResultFilter>("all");
const snapshotLoading = ref(false);
const analysisProgress = ref<PlayerAnalysisProgress | null>(null);
const loading = ref(false);
const errorMessage = ref("");
let requestId = 0;
const databaseStatus = ref({
  available: false,
  message: "正在检查 PostgreSQL",
  checkedAt: 0,
});
const cachedPlayerSummary = ref<CachedPlayerSummary>({
  puuid: "",
  modeKey: selectedMode.value,
  matches: 0,
  completeMatches: 0,
  wins: 0,
  latestGameCreation: null,
  sources: [],
});
let databaseRequestId = 0;
let snapshotRequestId = 0;

const availableHistoryGames = computed<number | null>(() => {
  if (
    cachedPlayerSummary.value.modeKey === selectedMode.value &&
    cachedPlayerSummary.value.matches > 0
  ) {
    return cachedPlayerSummary.value.matches;
  }
  const analysisGames = analysis.value?.actualGames || 0;
  return analysisGames > 0 ? analysisGames : null;
});

const windowOptionLabel = (size: HistoryWindowSize) => {
  if (size !== 500) return `${size} 场`;
  const available = availableHistoryGames.value;
  return available !== null && available < size
    ? `500 场（实际 ${available} 场）`
    : "500 场";
};

const selectedWindowHint = computed(() => {
  if (windowSize.value !== 500) return "";
  const currentSnapshot = snapshot.value;
  const actualGames =
    currentSnapshot?.windowSize === 500
      ? currentSnapshot.actualGames
      : availableHistoryGames.value;
  if (actualGames === null || actualGames === undefined) {
    return "将读取最多 500 场";
  }
  return actualGames < 500
    ? `当前条件实际 ${actualGames} 场`
    : "当前条件将读取最近 500 场";
});

const { navigate } = useSummonerNavigation();
// 关系图节点保留了与 PartyMember 相同的玩家身份字段，直接复用跳转入口。
const navigateToNetworkNode = (node: RecentNetworkNode) =>
  navigate(node as PartyMember);

const partyAnalysisGames = computed(
  () => snapshot.value?.actualGames || analysis.value?.actualGames || 0,
);

const coverageRate = computed(() => {
  if (snapshot.value) return snapshot.value.quality.detailCoverage;
  const coverage = analysis.value?.dataCoverage;
  if (!coverage || coverage.mergedGames === 0) return null;
  return Math.round((coverage.completeGames / coverage.mergedGames) * 1000) / 10;
});

const snapshotTrend = computed(() =>
  snapshot.value ? [...snapshot.value.trend].reverse() : [],
);

const snapshotMetricRows = computed(() => {
  const metrics = snapshot.value?.metrics;
  if (!metrics) return [];
  return [
    { key: "kda", label: "KDA", metric: metrics.kda, suffix: "" },
    {
      key: "damagePerMinute",
      label: "输出/分钟",
      metric: metrics.damagePerMinute,
      suffix: "",
    },
    {
      key: "goldPerMinute",
      label: "金币/分钟",
      metric: metrics.goldPerMinute,
      suffix: "",
    },
    {
      key: "csPerMinute",
      label: "补刀/分钟",
      metric: metrics.csPerMinute,
      suffix: "",
    },
    {
      key: "visionPerMinute",
      label: "视野/分钟",
      metric: metrics.visionPerMinute,
      suffix: "",
    },
    {
      key: "teamDamageShare",
      label: "团队输出占比",
      metric: metrics.teamDamageShare,
      suffix: "%",
    },
    {
      key: "teamObjectiveScore",
      label: "团队目标物",
      metric: metrics.teamObjectiveScore,
      suffix: "",
    },
    {
      key: "damageTakenPerMinute",
      label: "承伤/分钟",
      metric: metrics.damageTakenPerMinute,
      suffix: "",
    },
    {
      key: "firstTowerRate",
      label: "一塔率",
      metric: metrics.firstTowerRate,
      suffix: "%",
    },
  ];
});

const formatMetric = (value: number | null | undefined, suffix = "") =>
  value === null || value === undefined || !Number.isFinite(value)
    ? "--"
    : `${value.toFixed(1)}${suffix}`;

const formatMetricDelta = (value: number | null | undefined) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return "暂无胜负差异";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}`;
};

const streakLabel = computed(() => {
  const current = snapshot.value;
  if (selectedResult.value !== "all") return "筛选结果不计算连续场次";
  if (!current || current.streakType === "none" || current.streakCount <= 0) {
    return "暂无连续结果";
  }
  return `${current.streakCount} 场${current.streakType === "win" ? "连胜" : "连败"}`;
});

const insightTagType = (kind: string) => {
  if (kind === "quality") return "info";
  if (kind === "champion" || kind === "position") return "warning";
  return "success";
};

const trendClass = (win: boolean) => (win ? "trend-point--win" : "trend-point--loss");
const trendTitle = (point: HistoryAnalysisSnapshot["trend"][number]) =>
  `${point.win ? "胜" : "负"} · ${championName(point.championId)} · ${positionName(point.position)}`;
const selectWindow = (size: number) => {
  if (size === 20 || size === 50 || size === 100 || size === 500) {
    windowSize.value = size;
  }
};
const displayWindowSize = (current: HistoryAnalysisSnapshot) =>
  current.actualGames < current.windowSize
    ? current.actualGames
    : current.windowSize;
const selectResult = (result: string) => {
  if (result === "all" || result === "win" || result === "loss") {
    selectedResult.value = result;
  }
};

// 把排序 + 切片缩到 top 5，再交给模板用 v-memo 守住子节点重渲染。
const partyRankingSections = computed(() => {
  const groups = analysis.value?.partyGroups || [];
  const byFrequency = partyRankingMode.value === "frequency";
  return [2, 3, 4, 5].map((size) => {
    const matched = groups.filter(
      (group) =>
        group.members.length === size &&
        (byFrequency || group.games >= 5),
    );
    matched.sort(
      (left, right) =>
        byFrequency
          ? right.games - left.games ||
            right.stabilityScore - left.stabilityScore ||
            right.winRate - left.winRate
          : right.winRate - left.winRate ||
            right.games - left.games ||
            right.stabilityScore - left.stabilityScore,
    );
    return {
      size,
      label: `${size}人组合`,
      total: matched.length,
      items: matched.slice(0, 5) as PartyGroupAnalysis[],
    };
  });
});

const championName = (championId: number) => championNameShared(championId);

const synergyChampionSummary = (item: TeammateSynergyStats) => {
  const champion = item.champions[0];
  return champion
    ? `${championName(champion.championId)} ${formatRate(champion.winRate)}`
    : "暂无英雄数据";
};

const synergyPositionSummary = (item: TeammateSynergyStats) => {
  const position = item.positions[0];
  return position
    ? `${positionName(position.position)} ${formatRate(position.winRate)}`
    : "暂无位置数据";
};

// 同一个 (puuid, mode) 触发的 loadAnalysis / loadDatabaseInfo 复用同一个 Promise，
// 避免 onMounted + watch(puuid) + watch(mode) 几乎同时触发造成的 PG 重复请求。
const analysisInFlight = new Map<string, Promise<PlayerRecentAnalysis>>();
const databaseInFlight = new Map<
  string,
  Promise<{
    status: typeof databaseStatus.value;
    playerSummary: CachedPlayerSummary;
  }>
>();
const analysisKey = (puuid: string, modeKey: MatchModeKey) =>
  `${puuid}::${modeKey}`;
const databaseKey = (puuid: string, modeKey: MatchModeKey) =>
  `${puuid}::${modeKey}`;

const loadSnapshot = async () => {
  const currentRequest = ++snapshotRequestId;
  snapshotLoading.value = true;
  try {
    const result = await getHistoryAnalysisSnapshot(
      props.player.puuid,
      selectedMode.value,
      windowSize.value,
      selectedResult.value,
    );
    if (currentRequest === snapshotRequestId) snapshot.value = result;
  } finally {
    if (currentRequest === snapshotRequestId) snapshotLoading.value = false;
  }
};

const loadAnalysis = () => {
  const player = props.player;
  const modeKey = selectedMode.value;
  const key = analysisKey(player.puuid, modeKey);
  const currentRequest = ++requestId;
  loading.value = true;
  analysis.value = null;
  snapshot.value = null;
  analysisProgress.value = {
    stage: "cache",
    completed: 0,
    total: 1,
    percentage: 0,
    message: "准备读取本地缓存",
  };
  errorMessage.value = "";

  let request = analysisInFlight.get(key);
  if (!request) {
    request = loadPlayerCacheAnalysis(player, modeKey, (progress) => {
      if (currentRequest !== requestId) return;
      analysisProgress.value = progress;
      if (progress.analysis) {
        analysis.value = progress.analysis;
      }
    });
    analysisInFlight.set(key, request);
    const cleanup = () => {
      if (analysisInFlight.get(key) === request) {
        analysisInFlight.delete(key);
      }
    };
    // 用双分支 then 清理，避免对 rejected promise 产生额外未处理拒绝。
    void request.then(cleanup, cleanup);
  }

  return request
    .then(async (result) => {
      if (currentRequest === requestId) {
        analysis.value = result;
        await loadSnapshot();
      }
    })
    .catch((error) => {
      if (currentRequest !== requestId) return;
      analysis.value = null;
      analysisProgress.value = null;
      errorMessage.value = `历史战绩分析失败：${String(error)}`;
    })
    .finally(() => {
      if (currentRequest === requestId) loading.value = false;
    });
};

const loadDatabaseInfo = () => {
  const puuid = props.player.puuid;
  const modeKey = selectedMode.value;
  const key = databaseKey(puuid, modeKey);
  const currentRequest = ++databaseRequestId;
  let request = databaseInFlight.get(key);
  if (!request) {
    request = Promise.all([
      getDatabaseStatus(),
      getCachedPlayerSummary(puuid, modeKey),
    ]).then(([status, playerSummary]) => ({ status, playerSummary }));
    databaseInFlight.set(key, request);
    const cleanup = () => {
      if (databaseInFlight.get(key) === request) {
        databaseInFlight.delete(key);
      }
    };
    void request.then(cleanup, cleanup);
  }

  return request.then(({ status, playerSummary }) => {
    if (currentRequest !== databaseRequestId) return;
    databaseStatus.value = status;
    cachedPlayerSummary.value = playerSummary;
  });
};

const refresh = async () => {
  await Promise.all([loadDatabaseInfo(), loadAnalysis(), loadSnapshot()]);
};

const historyQueryPlan =
  "优先读取 PostgreSQL 全部缓存；发现摘要参与者不完整时，补拉最近 500 场完整队伍并回写缓存。";

watch(selectedMode, () => {
  void loadAnalysis();
  if (selectedMode.value !== cachedPlayerSummary.value.modeKey) {
    void loadDatabaseInfo();
  }
});

watch(windowSize, () => {
  void loadSnapshot();
});

watch(selectedResult, () => {
  void loadSnapshot();
});

watch(
  // 最近窗口通常始终是 20 场，仅监听 length 会漏掉“旧局被新局
  // 替换”的刷新；对局 ID 序列变化才代表分析输入真的变了。
  () => [
    props.player.puuid,
    props.player.matchList.map((match) => match.gameId).join(","),
  ],
  () => {
    analysis.value = null;
    snapshot.value = null;
    void loadAnalysis();
    void loadDatabaseInfo();
  },
);

onMounted(() => {
  void loadDatabaseInfo();
  void loadAnalysis();
});
</script>

<template>
  <div class="analytics-panel">
    <div class="analytics-heading">
      <div>
        <div class="font-medium">历史战绩分析</div>
        <div class="text-xs text-gray-500">
          {{ props.player.summonerName }} · 历史数据 · {{ modeLabel(selectedMode) }} · 已加载 {{ partyAnalysisGames }} 场
        </div>
      </div>
      <div class="flex items-center gap-2">
        <n-tag size="small" :type="databaseStatus.available ? 'success' : 'warning'" :bordered="false">
          {{ databaseStatus.available ? "PostgreSQL 已连接" : "实时数据模式" }}
        </n-tag>
        <n-button size="small" secondary @click="refresh">刷新</n-button>
      </div>
    </div>

    <div class="analytics-controls">
      <span class="control-label">模式</span>
      <n-button-group size="small">
        <n-button
          v-for="mode in MATCH_MODES"
          :key="mode.key"
          :type="selectedMode === mode.key ? 'primary' : 'default'"
          @click="selectedMode = mode.key"
        >
          {{ mode.label }}
        </n-button>
      </n-button-group>
      <span class="control-label window-label">窗口</span>
      <n-button-group size="small">
        <n-button
          v-for="size in HISTORY_WINDOW_SIZES"
          :key="size"
          :type="windowSize === size ? 'primary' : 'default'"
          @click="selectWindow(size)"
        >
          {{ windowOptionLabel(size) }}
        </n-button>
      </n-button-group>
      <span v-if="selectedWindowHint" class="window-hint">
        {{ selectedWindowHint }}
      </span>
      <span class="control-label window-label">结果</span>
      <n-button-group size="small">
        <n-button
          v-for="result in [
            { key: 'all', label: '全部' },
            { key: 'win', label: '胜局' },
            { key: 'loss', label: '败局' },
          ]"
          :key="result.key"
          :type="selectedResult === result.key ? 'primary' : 'default'"
          @click="selectResult(result.key)"
        >
          {{ result.label }}
        </n-button>
      </n-button-group>
      <n-tag v-if="snapshotLoading" size="small" :bordered="false" type="info">
        正在更新复盘快照
      </n-tag>
    </div>

    <div class="history-query-plan">
      <span class="history-query-plan-label">数据策略</span>
      <span>{{ historyQueryPlan }}</span>
    </div>

    <div v-if="errorMessage" class="error-strip">
      {{ errorMessage }}
      <n-button size="tiny" text type="primary" @click="loadAnalysis">重试</n-button>
    </div>

    <div
      v-if="analysisProgress"
      class="analysis-progress"
      :class="analysisProgress.stage === 'done' ? 'analysis-progress-done' : ''"
    >
      <div class="analysis-progress-heading">
        <span>{{ analysisProgress.message }}</span>
        <span>{{ analysisProgress.percentage }}%</span>
      </div>
      <n-progress
        type="line"
        :percentage="analysisProgress.percentage"
        :show-indicator="false"
        :status="analysisProgress.stage === 'done' ? 'success' : 'default'"
        :height="6"
      />
      <div class="analysis-progress-text">
        <span v-if="analysisProgress.stage === 'cache'">正在按 gameCreation DESC 读取 PostgreSQL 本地缓存，按 500 场分页拉取。</span>
        <span v-else-if="analysisProgress.stage === 'personal'">正在汇总个人胜率、英雄与位置表现。</span>
        <span v-else-if="analysisProgress.stage === 'full'">正在补齐逐局参与者并刷新开黑组合。</span>
        <span v-else-if="analysisProgress.stage === 'relations'">正在计算共同对局、交手胜率和黑名单关联。</span>
        <span v-else>分析完成。</span>
      </div>
    </div>

    <n-spin :show="loading">
      <template #description>{{ analysisProgress?.message || "正在读取历史数据" }}</template>

      <div v-if="analysis || snapshot" class="analysis-content">
        <div v-if="snapshot" class="decision-dashboard">
          <div class="dashboard-summary">
            <div class="summary-main">
              <div class="summary-eyebrow">复盘结论 · 最近 {{ displayWindowSize(snapshot) }} 场</div>
              <div class="summary-title">
                {{ snapshot.winRate === null ? "暂无有效样本" : `胜率 ${formatRate(snapshot.winRate)}` }}
              </div>
              <div class="summary-subtitle">
                {{ snapshot.wins }} 胜 {{ snapshot.losses }} 负 · {{ streakLabel }} · {{ snapshot.source }}
              </div>
            </div>
            <div class="summary-status">
              <n-tag size="small" :type="snapshot.quality.detailCoverage >= 70 ? 'success' : 'warning'">
                详情 {{ snapshot.quality.detailGames }}/{{ snapshot.actualGames }} 场
              </n-tag>
              <span>最近 10 场 {{ snapshot.recentWins }}/{{ snapshot.recentGames }}</span>
              <span v-if="snapshot.previousGames">前 10 场 {{ snapshot.previousWins }}/{{ snapshot.previousGames }}</span>
            </div>
          </div>

          <div class="decision-cards">
            <n-card size="small" :bordered="false">
              <div class="metric-label">近期状态</div>
              <div class="decision-value" :class="snapshot.recentWins >= snapshot.recentGames / 2 ? 'value-positive' : 'value-negative'">
                {{ snapshot.recentGames ? formatRate((snapshot.recentWins / snapshot.recentGames) * 100) : "--" }}
              </div>
              <div class="metric-sub">最近 10 场胜率</div>
            </n-card>
            <n-card size="small" :bordered="false">
              <div class="metric-label">最常用英雄</div>
              <div class="decision-value decision-value--text">
                {{ snapshot.champions[0] ? championName(snapshot.champions[0].championId) : "--" }}
              </div>
              <div class="metric-sub" v-if="snapshot.champions[0]">
                {{ snapshot.champions[0].games }} 场 · {{ formatRate(snapshot.champions[0].winRate) }}
              </div>
            </n-card>
            <n-card size="small" :bordered="false">
              <div class="metric-label">最佳位置</div>
              <div class="decision-value decision-value--text">
                {{ snapshot.positions[0] ? positionName(snapshot.positions[0].position) : "--" }}
              </div>
              <div class="metric-sub" v-if="snapshot.positions[0]">
                {{ snapshot.positions[0].games }} 场 · {{ formatRate(snapshot.positions[0].winRate) }}
              </div>
            </n-card>
            <n-card size="small" :bordered="false">
              <div class="metric-label">样本可信度</div>
              <div class="decision-value">{{ Math.round(snapshot.quality.detailCoverage) }}%</div>
              <div class="metric-sub">详情字段覆盖率</div>
            </n-card>
          </div>

          <div class="dashboard-grid">
            <n-card size="small" title="最近战绩趋势" :bordered="false">
              <div v-if="snapshotTrend.length" class="trend-strip">
                <div
                  v-for="point in snapshotTrend"
                  :key="point.gameId"
                  class="trend-point"
                  :class="trendClass(point.win)"
                  :title="trendTitle(point)"
                >
                  <span class="trend-dot">{{ point.win ? "胜" : "负" }}</span>
                  <span class="trend-champion">{{ championName(point.championId) }}</span>
                  <span v-if="point.detailAvailable" class="trend-detail">详情</span>
                </div>
              </div>
              <n-empty v-else size="small" description="暂无趋势数据" />
              <div class="trend-caption">从左到右为较早到最近；绿色为胜局，红色为败局。</div>
            </n-card>

            <n-card size="small" title="复盘提示" :bordered="false">
              <div v-if="snapshot.insights.length" class="insight-list">
                <div v-for="insight in snapshot.insights.slice(0, 4)" :key="`${insight.kind}-${insight.title}`" class="insight-row">
                  <n-tag size="tiny" :type="insightTagType(insight.kind)">{{ insight.title }}</n-tag>
                  <span>{{ insight.detail }}</span>
                </div>
              </div>
              <n-empty v-else size="small" description="暂无复盘提示" />
            </n-card>
          </div>

          <div class="dashboard-grid">
            <n-card size="small" title="胜局 / 败局关键差异" :bordered="false">
              <div class="metric-comparison-list">
                <div v-for="item in snapshotMetricRows" :key="item.key" class="metric-comparison-row">
                  <span class="comparison-label">{{ item.label }}</span>
                  <span class="comparison-value">胜 {{ formatMetric(item.metric.winAverage, item.suffix) }}</span>
                  <span class="comparison-value comparison-value--loss">负 {{ formatMetric(item.metric.lossAverage, item.suffix) }}</span>
                  <span class="comparison-delta">{{ formatMetricDelta(item.metric.delta) }}</span>
                </div>
              </div>
              <div class="coverage-caption">数值只统计有详情的对局；差值 = 胜局平均 − 败局平均。</div>
            </n-card>

            <n-card size="small" title="数据质量" :bordered="false">
              <div class="quality-grid">
                <div><span>基础样本</span><strong>{{ snapshot.quality.totalGames }} 场</strong></div>
                <div><span>详情样本</span><strong>{{ snapshot.quality.detailGames }} 场</strong></div>
                <div><span>完整 10 人</span><strong>{{ snapshot.quality.completeGames }} 场</strong></div>
                <div><span>详情覆盖</span><strong>{{ snapshot.quality.detailCoverage.toFixed(1) }}%</strong></div>
              </div>
              <div class="coverage-caption">缺少详情的对局仍计入基础胜率，但不会参与伤害、经济、补刀和视野指标。</div>
            </n-card>
          </div>

          <div class="dashboard-grid">
            <n-card size="small" title="英雄表现" :bordered="false">
              <div v-if="snapshot.champions.length" class="analysis-table">
                <div class="analysis-table-head"><span>英雄</span><span>场次</span><span>胜率</span><span>KDA</span><span>输出/分</span></div>
                <div v-for="hero in snapshot.champions.slice(0, 8)" :key="hero.championId" class="analysis-table-row">
                  <span class="table-hero"><n-avatar :size="25" :src="championImage(hero.championId)" />{{ championName(hero.championId) }}</span>
                  <span>{{ hero.games }}</span>
                  <span :class="hero.winRate !== null && hero.winRate >= 50 ? 'value-positive' : 'value-negative'">{{ formatRate(hero.winRate) }}</span>
                  <span>{{ formatMetric(hero.averageKda) }}</span>
                  <span>{{ formatMetric(hero.damagePerMinute) }}</span>
                </div>
              </div>
              <n-empty v-else size="small" description="暂无英雄数据" />
            </n-card>

            <n-card size="small" title="位置表现" :bordered="false">
              <div v-if="snapshot.positions.length" class="analysis-table">
                <div class="analysis-table-head"><span>位置</span><span>场次</span><span>胜率</span><span>KDA</span><span>视野/分</span></div>
                <div v-for="item in snapshot.positions" :key="item.position" class="analysis-table-row">
                  <span>{{ positionName(item.position) }}</span>
                  <span>{{ item.games }}</span>
                  <span :class="item.winRate !== null && item.winRate >= 50 ? 'value-positive' : 'value-negative'">{{ formatRate(item.winRate) }}</span>
                  <span>{{ formatMetric(item.averageKda) }}</span>
                  <span>{{ formatMetric(item.visionPerMinute) }}</span>
                </div>
              </div>
              <n-empty v-else size="small" description="暂无位置数据" />
            </n-card>
          </div>
        </div>

        <div v-if="!snapshot" class="metric-grid">
          <n-card size="small" :bordered="false">
            <div class="metric-label">整体胜率</div>
            <div class="metric-value">{{ formatRate(analysis?.winRate) }}</div>
            <div class="metric-sub">
              {{ analysis?.wins || 0 }} 胜 / {{ analysis?.actualGames || 0 }} 场
            </div>
          </n-card>
          <n-card size="small" :bordered="false">
            <div class="metric-label">有效样本</div>
            <div class="metric-value">{{ analysis?.actualGames || 0 }}</div>
            <div class="metric-sub">
              缓存 {{ cachedPlayerSummary.matches }} 场 · 已分析 {{ analysis?.actualGames || 0 }} 场
            </div>
          </n-card>
          <n-card size="small" :bordered="false">
            <div class="metric-label">个人置信度</div>
            <div class="metric-value">{{ analysis?.confidence.score || 0 }}</div>
            <div class="metric-sub">
              {{ confidenceLabel(analysis?.confidence.level || "low") }} · 数据来源：PostgreSQL 本地缓存
            </div>
          </n-card>
          <n-card size="small" :bordered="false">
            <div class="metric-label">参与者完整度</div>
            <div class="metric-value">
              {{ coverageRate === null ? "--" : `${coverageRate}%` }}
            </div>
            <div class="metric-sub">
              缓存 {{ analysis?.dataCoverage?.cachedGames || 0 }} · 完整
              {{ analysis?.dataCoverage?.completeGames || 0 }}
            </div>
          </n-card>
        </div>

        <div v-if="!snapshot" class="two-columns">
          <n-card size="small" title="英雄表现" :bordered="false">
            <div v-if="analysis?.champions.length" class="hero-list">
              <div
                v-for="hero in analysis?.champions.slice(0, 6)"
                :key="hero.championId"
                class="hero-row"
              >
                <n-avatar :size="28" :src="championImage(hero.championId)" />
                <span class="hero-name">{{ championName(hero.championId) }}</span>
                <span>{{ hero.games }}场 · {{ formatRate(hero.winRate) }}</span>
              </div>
            </div>
            <n-empty v-else size="small" description="暂无英雄数据" />
          </n-card>

          <n-card size="small" title="位置表现" :bordered="false">
            <div v-if="analysis?.positions.length" class="position-list">
              <div
                v-for="position in analysis?.positions"
                :key="position.position"
                class="position-row"
              >
                <span>{{ positionName(position.position) }}</span>
                <n-progress
                  type="line"
                  :percentage="position.winRate"
                  :show-indicator="false"
                  :height="8"
                />
                <span>{{ formatRate(position.winRate) }}</span>
              </div>
            </div>
            <n-empty v-else size="small" description="暂无位置数据" />
          </n-card>
        </div>

        <n-card v-if="analysis && selectedResult === 'all'" size="small" title="队友协同表现" :bordered="false">
          <div class="party-ranking-caption">
            统计我与每名队友实际同队的对局；英雄和位置展示的是我在这些共同对局中的表现。
          </div>
          <div v-if="analysis.teammateSynergy?.length" class="synergy-list">
            <div
              v-for="item in analysis.teammateSynergy.slice(0, 8)"
              v-memo="[item.games, item.winRate, item.champions[0]?.games, item.champions[0]?.winRate, item.champions[0]?.championId, item.positions[0]?.winRate, item.positions[0]?.position, item.teammate.summonerName, item.teammate.moderation?.marked, item.teammate.moderation?.reportCount]"
              :key="item.teammate.puuid"
              class="synergy-row"
            >
              <div
                class="synergy-name synergy-name--clickable"
                :title="item.teammate.summonerName"
                @click="navigate(item.teammate)"
              >
                {{ item.teammate.summonerName }}
                <n-tag v-if="item.teammate.moderation?.marked" size="tiny" type="error">
                  黑名单
                </n-tag>
                <n-tag
                  v-else-if="item.teammate.moderation?.reportCount"
                  size="tiny"
                  type="info"
                >
                  有举报
                </n-tag>
              </div>
              <div class="text-xs text-gray-500">
                一起 {{ item.games }} 场 · 我胜率 {{ formatRate(item.winRate) }} ·
                常用英雄 {{ synergyChampionSummary(item) }} ·
                常用位置 {{ synergyPositionSummary(item) }}
              </div>
            </div>
          </div>
          <n-empty v-else size="small" description="暂无完整队友协同数据" />
        </n-card>

        <n-card v-if="analysis && selectedResult === 'all'" size="small" title="我常和谁开黑 · 组合 Top 5" :bordered="false">
          <div class="party-ranking-caption">
            基于 PostgreSQL 当前模式最近 {{ partyAnalysisGames }} 场完整对局；
            {{ partyRankingMode === "frequency" ? "常玩排行按共同同队场次排序" : "最佳胜率排行要求至少共同 5 场" }}。
          </div>
          <div class="party-ranking-toolbar">
            <span class="control-label">排行依据</span>
            <n-button-group size="tiny">
              <n-button
                :type="partyRankingMode === 'frequency' ? 'primary' : 'default'"
                @click="partyRankingMode = 'frequency'"
              >
                常玩排行
              </n-button>
              <n-button
                :type="partyRankingMode === 'winRate' ? 'primary' : 'default'"
                @click="partyRankingMode = 'winRate'"
              >
                最佳胜率
              </n-button>
            </n-button-group>
          </div>
          <div class="party-ranking-grid">
            <div
              v-for="section in partyRankingSections"
              :key="section.size"
              class="party-ranking-section"
            >
              <div class="party-ranking-heading">
                <span>{{ section.label }}</span>
                <span class="text-gray-500">{{ section.total }} 组</span>
              </div>
              <div v-if="section.items.length" class="party-ranking-list">
                <div
                  v-for="(group, index) in section.items"
                  v-memo="[group.games, group.winRate, group.stabilityScore, group.recentGames, group.lastActiveDays, group.highWinRateAlert, group.confidence.level, group.confidence.score, group.blacklistedMembers.length, group.reportedMembers.length, group.members.map((member) => `${member.puuid}:${member.summonerName}:${member.moderation?.marked}:${member.moderation?.reportCount}`).join('|'), partyRankingMode]"
                  :key="group.members.map((item) => item.puuid).join('-')"
                  class="party-ranking-row"
                >
                  <DuoGroupCard
                    :group="group"
                    :index="index + 1"
                    :self-puuid="props.player.puuid"
                    mode="full"
                    @summoner-click="navigate"
                  />
                </div>
              </div>
              <div v-else class="empty-note">暂无达到门槛的组合</div>
            </div>
          </div>
          <div class="party-ranking-note">
            判定门槛：双人至少共同同队 2 场，三/四/五人组合至少 3/4/5 场；
            只按同一局的 gameId、队伍归属和完整参与者判断，不按英雄或 KDA 猜测。
          </div>

          <div v-if="analysis?.opponents.length" class="opponent-list">
            <div class="relation-subtitle">历史交手</div>
            <div
              v-for="item in analysis.opponents.slice(0, 8)"
              v-memo="[item.games, item.winRate, item.opponent.summonerName, item.opponent.moderation?.marked, item.opponent.moderation?.reportCount]"
              :key="item.opponent.puuid"
              class="opponent-row"
            >
              <span
                class="opponent-name"
                :title="item.opponent.summonerName"
                @click.stop="navigate(item.opponent)"
              >{{ item.opponent.summonerName }}</span>
              <n-tag v-if="item.opponent.moderation?.marked" size="tiny" type="error">
                黑名单
              </n-tag>
              <n-tag
                v-else-if="item.opponent.moderation?.reportCount"
                size="tiny"
                type="info"
              >
                有举报
              </n-tag>
              <span>
                {{ item.games }} 次交手 · 我方胜率 {{ formatRate(item.winRate) }}
              </span>
            </div>
          </div>
        </n-card>

        <n-card v-if="analysis && selectedResult === 'all'" size="small" title="历史对局关系图" :bordered="false">
          <recent-network-graph
            :analysis="analysis.network || null"
            :on-node-click="navigateToNetworkNode"
          />
        </n-card>

      </div>

      <n-empty v-else-if="!loading && !snapshot" description="暂无可用历史战绩" />
    </n-spin>
  </div>
</template>

<style scoped>
.analytics-panel {
  height: 100%;
  min-height: 0;
  box-sizing: border-box;
  overflow-y: auto;
  padding: 0.45rem 0.6rem 1rem;
}

.analytics-heading,
.analytics-controls,
.hero-row,
.position-row,
.relation-row,
.opponent-row {
  display: flex;
  align-items: center;
}

.analytics-heading {
  justify-content: space-between;
  margin-bottom: 0.4rem;
}

.analytics-controls {
  gap: 0.35rem;
  flex-wrap: wrap;
  margin-bottom: 0.4rem;
}

.history-query-plan {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.3rem;
  min-height: 1.65rem;
  padding: 0.25rem 0.45rem;
  margin-bottom: 0.4rem;
  border: 1px solid rgba(24, 160, 88, 0.16);
  border-radius: 0.3rem;
  background: rgba(24, 160, 88, 0.045);
  color: #666;
  font-size: 0.66rem;
}

.history-query-plan-label {
  color: #18a058;
  font-weight: 600;
}

.control-label,
.metric-label,
.metric-sub {
  font-size: 0.68rem;
  color: #888;
}

.error-strip {
  color: #d03050;
  font-size: 0.75rem;
  margin: 0.35rem 0;
}

.analysis-progress {
  padding: 0.35rem 0.45rem;
  margin-bottom: 0.4rem;
  border: 1px solid rgba(24, 160, 88, 0.18);
  border-radius: 0.35rem;
  background: rgba(24, 160, 88, 0.05);
}

.analysis-progress-done {
  opacity: 0.8;
}

.analysis-progress-heading {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  color: #333;
  font-size: 0.72rem;
  margin-bottom: 0.15rem;
}

.analysis-progress-text {
  color: #888;
  font-size: 0.66rem;
  margin-top: 0.15rem;
}

.analysis-content {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.window-label {
  margin-left: 0.35rem;
}

.window-hint {
  color: #64748b;
  font-size: 0.68rem;
  white-space: nowrap;
}

.decision-dashboard {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.dashboard-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.65rem 0.75rem;
  border: 1px solid rgba(24, 160, 88, 0.22);
  border-radius: 0.45rem;
  background: linear-gradient(120deg, rgba(24, 160, 88, 0.1), rgba(24, 160, 88, 0.025));
}

.summary-eyebrow,
.summary-subtitle,
.summary-status,
.trend-caption,
.coverage-caption {
  color: #888;
  font-size: 0.66rem;
}

.summary-title {
  margin: 0.12rem 0;
  color: #222;
  font-size: 1.35rem;
  font-weight: 700;
}

.summary-status {
  display: flex;
  align-items: flex-end;
  flex-direction: column;
  gap: 0.22rem;
  white-space: nowrap;
}

.decision-cards,
.dashboard-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.45rem;
}

.decision-cards {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.decision-value {
  margin: 0.15rem 0;
  color: #222;
  font-size: 1.12rem;
  font-weight: 700;
}

.decision-value--text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.95rem;
}

.value-positive {
  color: #18a058;
}

.value-negative {
  color: #d03050;
}

.trend-strip {
  display: flex;
  gap: 0.25rem;
  min-height: 3.3rem;
  overflow-x: auto;
  padding: 0.1rem 0 0.25rem;
}

.trend-point {
  display: flex;
  align-items: center;
  flex-direction: column;
  flex: 0 0 2.3rem;
  gap: 0.15rem;
  color: #777;
  font-size: 0.56rem;
}

.trend-dot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.45rem;
  height: 1.45rem;
  border-radius: 50%;
  color: #fff;
  font-size: 0.62rem;
  font-weight: 600;
}

.trend-point--win .trend-dot {
  background: #18a058;
}

.trend-point--loss .trend-dot {
  background: #d03050;
}

.trend-champion {
  max-width: 2.5rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trend-detail {
  color: #18a058;
  font-size: 0.5rem;
}

.trend-caption,
.coverage-caption {
  margin-top: 0.35rem;
  line-height: 1.45;
}

.insight-list {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.insight-row {
  display: flex;
  align-items: flex-start;
  gap: 0.35rem;
  color: #666;
  font-size: 0.68rem;
  line-height: 1.45;
}

.metric-comparison-list {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.metric-comparison-row {
  display: grid;
  grid-template-columns: minmax(4.2rem, 1fr) 4.3rem 4.3rem 3.4rem;
  align-items: center;
  gap: 0.25rem;
  color: #555;
  font-size: 0.66rem;
}

.comparison-label {
  color: #333;
}

.comparison-value--loss {
  color: #d03050;
}

.comparison-delta {
  color: #18a058;
  text-align: right;
}

.quality-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.45rem;
}

.quality-grid > div {
  display: flex;
  justify-content: space-between;
  gap: 0.4rem;
  color: #888;
  font-size: 0.68rem;
}

.quality-grid strong {
  color: #333;
  font-weight: 600;
}

.analysis-table {
  display: flex;
  flex-direction: column;
  gap: 0.08rem;
  font-size: 0.66rem;
}

.analysis-table-head,
.analysis-table-row {
  display: grid;
  grid-template-columns: minmax(5.5rem, 1.4fr) repeat(4, minmax(2.5rem, 0.75fr));
  align-items: center;
  gap: 0.25rem;
}

.analysis-table-head {
  padding-bottom: 0.25rem;
  color: #999;
  font-size: 0.6rem;
  border-bottom: 1px solid rgba(128, 128, 128, 0.14);
}

.analysis-table-row {
  min-height: 1.8rem;
  color: #555;
  border-bottom: 1px solid rgba(128, 128, 128, 0.08);
}

.table-hero {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 0.28rem;
}

.table-hero :deep(.n-avatar) {
  flex: 0 0 auto;
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.35rem;
}

.metric-value {
  font-size: 1.15rem;
  font-weight: 600;
  margin: 0.1rem 0;
}

.hero-list,
.position-list,
.relation-list,
.opponent-list,
.synergy-list {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.hero-row,
.position-row,
.relation-row,
.opponent-row {
  gap: 0.35rem;
  font-size: 0.72rem;
}

.synergy-row {
  padding: 0.3rem 0;
  border-bottom: 1px solid rgba(128, 128, 128, 0.12);
}

.synergy-row:last-child {
  border-bottom: 0;
}

.synergy-name {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  min-width: 0;
  font-size: 0.72rem;
  font-weight: 600;
}

.synergy-name--clickable {
  cursor: pointer;
}

.synergy-name--clickable:hover {
  color: #18a058;
  text-decoration: underline dotted;
}

.position-row :deep(.n-progress) {
  flex: 1;
  min-width: 2rem;
}

.two-columns {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.45rem;
}

.hero-name {
  flex: 1;
}

.position-row > span:first-child {
  width: 2.5rem;
}

.position-row > span:last-child {
  width: 2.8rem;
  text-align: right;
}

.relation-row,
.opponent-row {
  display: block;
  padding: 0.25rem 0;
  border-bottom: 1px solid rgba(128, 128, 128, 0.12);
}

.opponent-name {
  cursor: pointer;
  margin-right: 0.4rem;
}

.opponent-name:hover {
  color: #d03050;
  text-decoration: underline dotted;
}

.party-ranking-caption,
.party-ranking-note {
  color: #888;
  font-size: 0.68rem;
  line-height: 1.5;
}

.party-ranking-caption {
  margin-bottom: 0.45rem;
}

.party-ranking-toolbar {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  margin-bottom: 0.45rem;
}

.party-ranking-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.45rem;
}

.party-ranking-section {
  min-width: 0;
  padding: 0.35rem;
  border: 1px solid rgba(128, 128, 128, 0.14);
  border-radius: 0.35rem;
}

.party-ranking-heading {
  display: flex;
  justify-content: space-between;
  gap: 0.35rem;
  padding-bottom: 0.25rem;
  font-size: 0.75rem;
  font-weight: 600;
  border-bottom: 1px solid rgba(128, 128, 128, 0.12);
}

.party-ranking-list {
  display: flex;
  flex-direction: column;
}

.party-ranking-row {
  display: flex;
  align-items: stretch;
  gap: 0.35rem;
  min-width: 0;
  padding: 0.35rem 0;
  border-bottom: 1px solid rgba(128, 128, 128, 0.1);
}

.party-ranking-row:last-child {
  border-bottom: 0;
}

.party-ranking-row > :deep(.duo-card) {
  flex: 1;
  min-width: 0;
}

.party-ranking-note {
  margin-top: 0.45rem;
}

.relation-subtitle {
  margin-top: 0.55rem;
  margin-bottom: 0.15rem;
  font-size: 0.75rem;
  font-weight: 600;
}

.opponent-list {
  margin-top: 0.4rem;
}

.cache-overview,
.cache-mode-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 0.75rem;
}

.cache-mode-list {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  margin-top: 0.45rem;
}

.empty-note {
  color: #888;
  font-size: 0.75rem;
}

@media (max-width: 760px) {
  .metric-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .two-columns,
  .party-ranking-grid,
  .dashboard-grid {
    grid-template-columns: 1fr;
  }

  .decision-cards {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .dashboard-summary {
    align-items: flex-start;
    flex-direction: column;
  }

  .summary-status {
    align-items: flex-start;
  }
}
</style>
