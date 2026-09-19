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
import { champDict } from "@/resources/champList";
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
import RecentNetworkGraph from "@/recentMatch/components/recentNetworkGraph.vue";

type AnalysisWindow = (typeof RECENT_ANALYSIS_WINDOWS)[number];

const props = defineProps<{ player: RecentSumInfo }>();
const selectedMode = ref<MatchModeKey>("match");
const selectedWindow = ref<AnalysisWindow>(10);
const analysis = ref<PlayerRecentAnalysis | null>(null);
const loading = ref(false);
const errorMessage = ref("");
let requestId = 0;
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

const activeTrend = computed(() =>
  analysis.value?.trends.find((item) => item.window === selectedWindow.value),
);

const formatRate = (rate: number | null | undefined) =>
  rate === null || rate === undefined ? "--" : `${rate.toFixed(1)}%`;

const confidenceLabel = (level: string) =>
  ({ high: "高", medium: "中", low: "低" } as Record<string, string>)[level] ||
  level;

const positionName = (position: string) =>
  ({
    TOP: "上路",
    JUNGLE: "打野",
    MIDDLE: "中路",
    BOTTOM: "下路",
    SUPPORT: "辅助",
    UNKNOWN: "未知",
  } as Record<string, string>)[position] || position;

const championName = (championId: number) =>
  champDict[String(championId)]?.label || `英雄 ${championId}`;

const championImage = (championId: number) => {
  const alias = champDict[String(championId)]?.alias;
  return alias
    ? `https://game.gtimg.cn/images/lol/act/img/champion/${alias}.png`
    : `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/champion-icons/${championId}.png`;
};

const loadAnalysis = async () => {
  const currentRequest = ++requestId;
  loading.value = true;
  errorMessage.value = "";
  try {
    const result = await loadPlayerModeAnalysis(
      props.player,
      selectedMode.value,
      selectedWindow.value,
    );
    if (currentRequest === requestId) analysis.value = result;
  } catch (error) {
    if (currentRequest !== requestId) return;
    analysis.value = null;
    errorMessage.value = `历史战绩分析失败：${String(error)}`;
  } finally {
    if (currentRequest === requestId) loading.value = false;
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

const formatNumber = (value: number) => value.toLocaleString("zh-CN");

const cacheModeSummary = (modeKey: string) => {
  const mode = databaseSummary.value.modes.find((item) => item.modeKey === modeKey);
  return mode
    ? `${formatNumber(mode.matches)} 场 · ${formatNumber(mode.participants)} 人次`
    : "暂无缓存";
};

watch([selectedMode, selectedWindow], () => {
  void loadAnalysis();
});

watch(
  () => props.player.puuid,
  () => {
    analysis.value = null;
    void loadAnalysis();
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
          {{ props.player.summonerName }} · {{ modeLabel(selectedMode) }} · 默认最近 10 场
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
          v-for="window in RECENT_ANALYSIS_WINDOWS"
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
      <n-button size="tiny" text type="primary" @click="loadAnalysis">重试</n-button>
    </div>

    <n-spin :show="loading">
      <template #description>优先读取 PostgreSQL 缓存，未命中时查询历史接口</template>

      <div v-if="analysis" class="analysis-content">
        <div class="metric-grid">
          <n-card size="small" :bordered="false">
            <div class="metric-label">近{{ selectedWindow }}场胜率</div>
            <div class="metric-value">{{ formatRate(activeTrend?.winRate) }}</div>
            <div class="metric-sub">
              {{ activeTrend?.wins || 0 }} 胜 / {{ activeTrend?.games || 0 }} 场
            </div>
          </n-card>
          <n-card size="small" :bordered="false">
            <div class="metric-label">有效样本</div>
            <div class="metric-value">{{ analysis.actualGames }}</div>
            <div class="metric-sub">
              {{ analysis.historyComplete ? "已覆盖完整 100 场" : "当前窗口可用数据" }}
            </div>
          </n-card>
          <n-card size="small" :bordered="false">
            <div class="metric-label">个人置信度</div>
            <div class="metric-value">{{ analysis.confidence.score }}</div>
            <div class="metric-sub">
              {{ confidenceLabel(analysis.confidence.level) }} · {{ analysis.source }}
            </div>
          </n-card>
        </div>

        <n-card size="small" title="胜率趋势" :bordered="false">
          <div class="trend-list">
            <div v-for="trend in analysis.trends" :key="trend.window" class="trend-row">
              <span class="trend-name">近{{ trend.window }}场</span>
              <n-progress
                type="line"
                :percentage="trend.winRate || 0"
                :show-indicator="false"
                :status="trend.winRate !== null && trend.winRate >= 50 ? 'success' : 'error'"
                :height="9"
              />
              <span class="trend-rate">{{ formatRate(trend.winRate) }}</span>
              <span class="trend-games">{{ trend.games }}场</span>
            </div>
          </div>
        </n-card>

        <div class="two-columns">
          <n-card size="small" title="英雄表现" :bordered="false">
            <div v-if="analysis.champions.length" class="hero-list">
              <div
                v-for="hero in analysis.champions.slice(0, 6)"
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
            <div v-if="analysis.positions.length" class="position-list">
              <div
                v-for="position in analysis.positions"
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
            <n-empty v-else size="small" description="接口未返回位置" />
          </n-card>
        </div>

        <n-card size="small" title="组队与交手分析" :bordered="false">
          <div v-if="analysis.partyGroups.length" class="relation-list">
            <div
              v-for="group in analysis.partyGroups.slice(0, 8)"
              :key="group.members.map((item) => item.puuid).join('-')"
              class="relation-row"
            >
              <div class="relation-name">
                {{ group.members.map((item) => item.summonerName).join(' + ') }}
                <n-tag v-if="group.highWinRateAlert" size="tiny" type="warning">
                  高胜率开黑队
                </n-tag>
                <n-tag v-if="group.blacklistedMembers.length" size="tiny" type="error">
                  含黑名单
                </n-tag>
                <n-tag v-if="group.reportedMembers.length" size="tiny" type="info">
                  含举报记录
                </n-tag>
              </div>
              <div class="text-xs text-gray-500">
                共同 {{ group.games }} 场 · 胜率 {{ formatRate(group.winRate) }} · 稳定度
                {{ group.stabilityScore }} · 置信度 {{ confidenceLabel(group.confidence.level) }}
              </div>
            </div>
          </div>
          <div v-else class="empty-note">当前窗口还没有可确认的共同对局组合。</div>

          <div v-if="analysis.opponents.length" class="opponent-list">
            <div
              v-for="item in analysis.opponents.slice(0, 8)"
              :key="item.opponent.puuid"
              class="opponent-row"
            >
              <span>{{ item.opponent.summonerName }}</span>
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

        <n-card size="small" title="历史对局关系图" :bordered="false">
          <recent-network-graph :analysis="analysis.network || null" />
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
              <span>{{ cacheModeSummary(mode.key) }}</span>
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
.analytics-panel {
  height: 540px;
  overflow-y: auto;
  padding: 0.45rem 0.6rem 1rem;
}

.analytics-heading,
.analytics-controls,
.trend-row,
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

.control-label,
.metric-label,
.metric-sub {
  font-size: 0.68rem;
  color: #888;
}

.window-label {
  margin-left: 0.3rem;
}

.error-strip {
  color: #d03050;
  font-size: 0.75rem;
  margin: 0.35rem 0;
}

.analysis-content {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.35rem;
}

.metric-value {
  font-size: 1.15rem;
  font-weight: 600;
  margin: 0.1rem 0;
}

.trend-list,
.hero-list,
.position-list,
.relation-list,
.opponent-list {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.trend-row,
.hero-row,
.position-row,
.relation-row,
.opponent-row {
  gap: 0.35rem;
  font-size: 0.72rem;
}

.trend-row :deep(.n-progress),
.position-row :deep(.n-progress) {
  flex: 1;
  min-width: 2rem;
}

.trend-name {
  width: 3.6rem;
}

.trend-rate {
  width: 2.8rem;
  text-align: right;
}

.trend-games {
  width: 2.5rem;
  text-align: right;
  color: #888;
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

.relation-name {
  line-height: 1.5;
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
  .two-columns {
    grid-template-columns: 1fr;
  }
}
</style>
