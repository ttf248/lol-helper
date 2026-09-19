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
import { querySummonerInfo } from "@/lcu/aboutSummoner";
import {
  DatabaseSummary,
  getDatabaseStatus,
  getDatabaseSummary,
} from "@/recentMatch/utils/databaseCache";
import {
  MATCH_MODES,
  MatchModeKey,
  modeLabel,
} from "@/recentMatch/utils/matchMode";
import {
  loadPlayerModeAnalysis,
  RECENT_ANALYSIS_WINDOWS,
} from "@/recentMatch/utils/recentAnalytics";
import {
  PlayerRecentAnalysis,
  RecentSumInfo,
} from "@/recentMatch/utils/queryTypes";
import { champDict } from "@/resources/champList";

const DEFAULT_WINDOWS = RECENT_ANALYSIS_WINDOWS;
type AnalysisWindow = (typeof DEFAULT_WINDOWS)[number];

const player = ref<RecentSumInfo | null>(null);
const analysis = ref<PlayerRecentAnalysis | null>(null);
const selectedMode = ref<MatchModeKey>("match");
const selectedWindow = ref<AnalysisWindow>(10);
const loading = ref(false);
const errorMessage = ref("");
const requestId = ref(0);
const databaseStatus = ref({
  available: false,
  message: "正在检查 PostgreSQL",
  checkedAt: 0,
});
const databaseSummary = ref<DatabaseSummary>({
  totalMatches: 0,
  totalParticipants: 0,
  totalPlayers: 0,
  modes: [],
});

const createPlayer = (info: Awaited<ReturnType<typeof querySummonerInfo>>): RecentSumInfo | null => {
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
};

const loadAnalysis = async () => {
  if (!player.value) return;
  const currentRequest = ++requestId.value;
  loading.value = true;
  errorMessage.value = "";
  try {
    const result = await loadPlayerModeAnalysis(
      player.value,
      selectedMode.value,
      selectedWindow.value,
    );
    if (currentRequest === requestId.value) {
      analysis.value = result;
    }
  } catch (error) {
    if (currentRequest === requestId.value) {
      errorMessage.value = `历史战绩分析失败：${String(error)}`;
      analysis.value = null;
    }
  } finally {
    if (currentRequest === requestId.value) loading.value = false;
  }
};

const loadDatabaseInfo = async () => {
  const [status, summary] = await Promise.all([
    getDatabaseStatus(),
    getDatabaseSummary(),
  ]);
  databaseStatus.value = status;
  databaseSummary.value = summary;
};

const refresh = async () => {
  await Promise.all([loadDatabaseInfo(), loadAnalysis()]);
};

const formatRate = (rate: number | null | undefined) =>
  rate === null || rate === undefined ? "--" : `${rate.toFixed(1)}%`;

const formatNumber = (value: number) => value.toLocaleString("zh-CN");

const championName = (championId: number) =>
  champDict[String(championId)]?.label || `英雄 ${championId}`;

const championImage = (championId: number) => {
  const alias = champDict[String(championId)]?.alias;
  return alias
    ? `https://game.gtimg.cn/images/lol/act/img/champion/${alias}.png`
    : `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-icons/${championId}.png`;
};

const positionName = (position: string) =>
  ({ TOP: "上路", JUNGLE: "打野", MIDDLE: "中路", BOTTOM: "下路", SUPPORT: "辅助", UNKNOWN: "未知" } as Record<string, string>)[position] || position;

const confidenceName = (level: string) =>
  ({ high: "高", medium: "中", low: "低" } as Record<string, string>)[level] || level;

const activeTrend = computed(() =>
  analysis.value?.trends.find((item) => item.window === selectedWindow.value),
);

const selectedModeLabel = computed(() => modeLabel(selectedMode.value));

const summaryForMode = (modeKey: string) => {
  const mode = databaseSummary.value.modes.find((item) => item.modeKey === modeKey);
  return mode ? `${formatNumber(mode.matches)} 场 · ${formatNumber(mode.participants)} 人次` : "暂无缓存";
};

watch([selectedMode, selectedWindow], () => {
  void loadAnalysis();
});

onMounted(async () => {
  // 数据库状态与本地玩家信息并行读取；数据库不可用时仍允许使用 LCU 实时数据。
  void loadDatabaseInfo();
  const info = await querySummonerInfo();
  player.value = createPlayer(info);
  if (!player.value) {
    errorMessage.value = "未读取到当前登录玩家，请确认 League 客户端已登录。";
    return;
  }
  await loadAnalysis();
});
</script>

<template>
  <div class="history-page">
    <div class="history-title">
      <div>
        <div class="text-lg font-semibold">历史战绩分析</div>
        <div class="text-xs text-gray-500">按模式独立统计，默认展示最近 10 场</div>
      </div>
      <n-tag :type="databaseStatus.available ? 'success' : 'warning'" size="small" :bordered="false">
        {{ databaseStatus.available ? "PostgreSQL 已连接" : "实时数据模式" }}
      </n-tag>
    </div>

    <div v-if="player" class="player-strip">
      <n-avatar round :size="42" :src="player.championUrl" fallback-src="https://wegame.gtimg.com/g.26-r.c2d3c/helper/lol/assis/images/resources/usericon/4027.png" />
      <div class="min-w-0">
        <div class="font-medium truncate">{{ player.summonerName }}</div>
        <div class="text-xs text-gray-500">{{ selectedModeLabel }} · {{ analysis?.source || "等待历史数据" }}</div>
      </div>
      <n-button size="small" secondary @click="refresh">刷新</n-button>
    </div>

    <div class="control-block">
      <div class="control-label">统计模式</div>
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
      <div class="control-label window-label">窗口</div>
      <n-button-group size="small">
        <n-button
          v-for="window in DEFAULT_WINDOWS"
          :key="window"
          :type="selectedWindow === window ? 'primary' : 'default'"
          @click="selectedWindow = window"
        >
          {{ window }}场
        </n-button>
      </n-button-group>
    </div>

    <div v-if="errorMessage" class="error-strip">
      {{ errorMessage }}
      <n-button size="tiny" text type="primary" @click="refresh">重试</n-button>
    </div>

    <n-spin :show="loading">
      <template #description>正在读取本地缓存，未命中时查询 LCU 历史接口</template>

      <div v-if="analysis" class="analysis-content">
        <div class="metric-grid">
          <n-card size="small" :bordered="false">
            <div class="metric-label">{{ selectedWindow }}场胜率</div>
            <div class="metric-value">{{ formatRate(activeTrend?.winRate) }}</div>
            <div class="metric-sub">{{ activeTrend?.wins || 0 }} 胜 / {{ activeTrend?.games || 0 }} 场</div>
          </n-card>
          <n-card size="small" :bordered="false">
            <div class="metric-label">有效样本</div>
            <div class="metric-value">{{ analysis.actualGames }}</div>
            <div class="metric-sub">{{ analysis.historyComplete ? "已覆盖完整 100 场" : "当前窗口可用数据" }}</div>
          </n-card>
          <n-card size="small" :bordered="false">
            <div class="metric-label">个人置信度</div>
            <div class="metric-value">{{ analysis.confidence.score }}</div>
            <div class="metric-sub">{{ confidenceName(analysis.confidence.level) }} · {{ analysis.source }}</div>
          </n-card>
        </div>

        <n-card size="small" title="胜率趋势" :bordered="false">
          <div class="trend-list">
            <div v-for="trend in analysis.trends" :key="trend.window" class="trend-row">
              <span class="trend-name">近 {{ trend.window }} 场</span>
              <n-progress
                type="line"
                :percentage="trend.winRate || 0"
                :show-indicator="false"
                :status="trend.winRate !== null && trend.winRate >= 50 ? 'success' : 'error'"
                :height="10"
              />
              <span class="trend-rate">{{ formatRate(trend.winRate) }}</span>
              <span class="trend-games">{{ trend.games }}场</span>
            </div>
          </div>
        </n-card>

        <div class="two-columns">
          <n-card size="small" title="英雄表现" :bordered="false">
            <div v-if="analysis.champions.length" class="hero-list">
              <div v-for="hero in analysis.champions.slice(0, 5)" :key="hero.championId" class="hero-row">
                <n-avatar :size="30" :src="championImage(hero.championId)" />
                <span class="hero-name">{{ championName(hero.championId) }}</span>
                <span>{{ hero.games }}场 · {{ formatRate(hero.winRate) }}</span>
              </div>
            </div>
            <n-empty v-else size="small" description="暂无英雄数据" />
          </n-card>

          <n-card size="small" title="位置表现" :bordered="false">
            <div v-if="analysis.positions.length" class="position-list">
              <div v-for="position in analysis.positions" :key="position.position" class="position-row">
                <span>{{ positionName(position.position) }}</span>
                <n-progress type="line" :percentage="position.winRate" :show-indicator="false" :height="8" />
                <span>{{ formatRate(position.winRate) }}</span>
              </div>
            </div>
            <n-empty v-else size="small" description="接口未返回位置" />
          </n-card>
        </div>

        <n-card size="small" title="历史关系分析" :bordered="false">
          <div v-if="analysis.partyGroups.length" class="relation-list">
            <div v-for="group in analysis.partyGroups.slice(0, 5)" :key="group.members.map((item) => item.puuid).join('-')" class="relation-row">
              <div class="relation-name">
                {{ group.members.map((item) => item.summonerName).join(' + ') }}
                <n-tag v-if="group.highWinRateAlert" size="tiny" type="warning">高胜率开黑队</n-tag>
              </div>
              <div class="text-xs text-gray-500">
                {{ group.games }} 场共同对局 · {{ formatRate(group.winRate) }} · 稳定度 {{ group.stabilityScore }} · 置信度 {{ confidenceName(group.confidence.level) }}
              </div>
            </div>
          </div>
          <div v-else class="empty-note">当前缓存中还没有可确认的共同对局组合。</div>
          <div v-if="analysis.opponents.length" class="opponent-list">
            <div v-for="item in analysis.opponents.slice(0, 5)" :key="item.opponent.puuid" class="opponent-row">
              <span>{{ item.opponent.summonerName }}</span>
              <span>{{ item.games }} 次交手 · 对手胜率 {{ formatRate(item.opponentWins / item.games * 100) }}</span>
            </div>
          </div>
        </n-card>

        <n-card size="small" title="本地缓存汇总" :bordered="false">
          <div class="cache-overview">
            <span>对局 {{ formatNumber(databaseSummary.totalMatches) }}</span>
            <span>参赛记录 {{ formatNumber(databaseSummary.totalParticipants) }}</span>
            <span>玩家 {{ formatNumber(databaseSummary.totalPlayers) }}</span>
          </div>
          <div class="cache-mode-list">
            <div v-for="mode in MATCH_MODES" :key="mode.key" class="cache-mode-row">
              <span>{{ mode.label }}</span>
              <span>{{ summaryForMode(mode.key) }}</span>
            </div>
          </div>
          <div class="text-xs text-gray-500 mt-2">{{ databaseStatus.message }}</div>
        </n-card>
      </div>

      <n-empty v-else-if="!loading" description="暂无可用历史战绩" />
    </n-spin>
  </div>
</template>

<style scoped>
.history-page {
  height: calc(100vh - 3rem);
  overflow-y: auto;
  padding: 0 0.1rem 1rem;
}
.history-title, .player-strip, .control-block, .cache-overview, .cache-mode-row,
.trend-row, .hero-row, .position-row, .relation-row, .opponent-row {
  display: flex;
  align-items: center;
}
.history-title { justify-content: space-between; margin-bottom: 0.5rem; }
.player-strip { gap: 0.5rem; padding: 0.45rem 0.55rem; margin-bottom: 0.5rem; background: rgba(128, 128, 128, 0.08); border-radius: 0.45rem; }
.player-strip > div:nth-child(2) { flex: 1; }
.control-block { gap: 0.35rem; flex-wrap: wrap; margin-bottom: 0.5rem; }
.control-label { font-size: 0.75rem; color: #888; }
.window-label { margin-left: 0.25rem; }
.error-strip { color: #d03050; font-size: 0.75rem; margin: 0.4rem 0; }
.analysis-content { display: flex; flex-direction: column; gap: 0.5rem; }
.metric-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.4rem; }
.metric-label, .metric-sub { font-size: 0.68rem; color: #888; }
.metric-value { font-size: 1.25rem; font-weight: 600; margin: 0.15rem 0; }
.trend-list, .hero-list, .position-list, .relation-list, .opponent-list, .cache-mode-list { display: flex; flex-direction: column; gap: 0.45rem; }
.trend-row { gap: 0.35rem; font-size: 0.72rem; }
.trend-row :deep(.n-progress) { flex: 1; min-width: 2rem; }
.trend-name { width: 3.5rem; }
.trend-rate { width: 2.8rem; text-align: right; }
.trend-games { width: 2.4rem; text-align: right; color: #888; }
.two-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; }
.hero-row, .position-row, .relation-row, .opponent-row { gap: 0.35rem; font-size: 0.75rem; }
.hero-name { flex: 1; }
.position-row > span:first-child { width: 2.4rem; }
.position-row :deep(.n-progress) { flex: 1; }
.position-row > span:last-child { width: 2.7rem; text-align: right; }
.relation-row, .opponent-row { display: block; padding: 0.25rem 0; border-bottom: 1px solid rgba(128, 128, 128, 0.12); }
.relation-name { line-height: 1.5; }
.empty-note { color: #888; font-size: 0.75rem; }
.cache-overview { justify-content: space-between; font-size: 0.75rem; }
.cache-mode-row { justify-content: space-between; font-size: 0.75rem; }
@media (max-width: 360px) {
  .two-columns { grid-template-columns: 1fr; }
  .metric-value { font-size: 1.1rem; }
}
</style>
