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
  PlayerAnalysisProgress,
  PartyGroupAnalysis,
  RecentSumInfo,
  TeammateSynergyStats,
} from "@/recentMatch/utils/queryTypes";
import RecentNetworkGraph from "@/recentMatch/components/recentNetworkGraph.vue";

type AnalysisWindow = (typeof RECENT_ANALYSIS_WINDOWS)[number];
type PartyRankingMode = "frequency" | "winRate";

const props = defineProps<{ player: RecentSumInfo }>();
const selectedMode = ref<MatchModeKey>("match");
const selectedWindow = ref<AnalysisWindow>(10);
const partyRankingMode = ref<PartyRankingMode>("frequency");
const analysis = ref<PlayerRecentAnalysis | null>(null);
const analysisProgress = ref<PlayerAnalysisProgress | null>(null);
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

const partyAnalysisGames = computed(
  () =>
    analysis.value?.trends.find((item) => item.window === 100)?.games ||
    analysis.value?.actualGames ||
    0,
);

const coverageRate = computed(() => {
  const coverage = analysis.value?.dataCoverage;
  if (!coverage || coverage.mergedGames === 0) return null;
  return Math.round((coverage.completeGames / coverage.mergedGames) * 1000) / 10;
});

const partyRankingSections = computed(() => {
  const groups = analysis.value?.partyGroups || [];
  return [2, 3, 4, 5].map((size) => {
    const allGroups = groups
      .filter(
        (group) =>
          group.members.length === size &&
          (partyRankingMode.value === "frequency" || group.games >= 5),
      )
      .sort(
        (left, right) =>
          partyRankingMode.value === "frequency"
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
      total: allGroups.length,
      items: allGroups.slice(0, 5) as PartyGroupAnalysis[],
    };
  });
});

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

const partyGroupNames = (group: PartyGroupAnalysis) =>
  group.members
    .map((member) =>
      member.puuid === props.player.puuid ? "我" : member.summonerName,
    )
    .join(" + ");

const lastActiveLabel = (group: PartyGroupAnalysis) => {
  if (group.lastActiveDays === null) return "未知";
  if (group.lastActiveDays === 0) return "今天";
  return `${group.lastActiveDays}天前`;
};

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

const loadAnalysis = async () => {
  const currentRequest = ++requestId;
  loading.value = true;
  analysis.value = null;
  analysisProgress.value = {
    stage: "cache",
    completed: 0,
    total: 1,
    percentage: 0,
    message: "准备读取本地缓存",
  };
  errorMessage.value = "";
  try {
    const result = await loadPlayerModeAnalysis(
      props.player,
      selectedMode.value,
      selectedWindow.value,
      (progress) => {
        if (currentRequest !== requestId) return;
        analysisProgress.value = progress;
        if (progress.analysis) {
          analysis.value = progress.analysis;
        }
      },
    );
    if (currentRequest === requestId) analysis.value = result;
  } catch (error) {
    if (currentRequest !== requestId) return;
    analysis.value = null;
    analysisProgress.value = null;
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
  () => [props.player.puuid, props.player.matchList.length],
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
          {{ props.player.summonerName }} · 历史数据 · {{ modeLabel(selectedMode) }} · 默认最近 10 场
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
        <span v-if="analysisProgress.stage === 'cache'">先检查 PostgreSQL，命中缓存就不重复请求服务器。</span>
        <span v-else-if="analysisProgress.stage === 'personal'">个人胜率、英雄表现先使用快速历史摘要展示。</span>
        <span v-else-if="analysisProgress.stage === 'full'">正在补齐完整参与者，仅用于同队、对手和关系图分析。</span>
        <span v-else-if="analysisProgress.stage === 'relations'">正在计算共同对局、交手胜率和黑名单关联。</span>
        <span v-else>个人指标与关系分析均已完成。</span>
      </div>
    </div>

    <n-spin :show="loading">
      <template #description>{{ analysisProgress?.message || "正在读取历史数据" }}</template>

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
          <n-card size="small" :bordered="false">
            <div class="metric-label">参与者完整度</div>
            <div class="metric-value">
              {{ coverageRate === null ? "--" : `${coverageRate}%` }}
            </div>
            <div class="metric-sub">
              缓存 {{ analysis.dataCoverage?.cachedGames || 0 }} · 接口
              {{ analysis.dataCoverage?.interfaceGames || 0 }} · 冲突
              {{ analysis.dataCoverage?.conflicts || 0 }}
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

        <n-card size="small" title="队友协同表现" :bordered="false">
          <div class="party-ranking-caption">
            统计我与每名队友实际同队的对局；英雄和位置展示的是我在这些共同对局中的表现。
          </div>
          <div v-if="analysis.teammateSynergy?.length" class="synergy-list">
            <div
              v-for="item in analysis.teammateSynergy.slice(0, 8)"
              :key="item.teammate.puuid"
              class="synergy-row"
            >
              <div class="synergy-name" :title="item.teammate.summonerName">
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

        <n-card size="small" title="我常和谁开黑 · 组合 Top 5" :bordered="false">
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
                  :key="group.members.map((item) => item.puuid).join('-')"
                  class="party-ranking-row"
                >
                  <span class="party-rank">{{ index + 1 }}</span>
                  <div class="party-ranking-main">
                    <div class="party-ranking-name" :title="partyGroupNames(group)">
                      {{ partyGroupNames(group) }}
                      <n-tag v-if="group.highWinRateAlert" size="tiny" type="warning">
                        高胜率
                      </n-tag>
                      <n-tag v-if="group.blacklistedMembers.length" size="tiny" type="error">
                        黑名单
                      </n-tag>
                      <n-tag v-if="group.reportedMembers.length" size="tiny" type="info">
                        有举报
                      </n-tag>
                    </div>
                    <div class="party-ranking-metrics">
                      共同 {{ group.games }} 场 · {{ group.wins }} 胜 ·
                      胜率 {{ formatRate(group.winRate) }} · 稳定度 {{ group.stabilityScore }}
                    </div>
                    <div class="party-ranking-submetrics">
                      近30天 {{ group.recentGames }} 场 · 最近 {{ lastActiveLabel(group) }} ·
                      置信度 {{ confidenceLabel(group.confidence.level) }}
                    </div>
                  </div>
                </div>
              </div>
              <div v-else class="empty-note">暂无达到门槛的组合</div>
            </div>
          </div>
          <div class="party-ranking-note">
            判定门槛：双人至少共同同队 2 场，三/四/五人组合至少 3/4/5 场；
            只按同一局的 gameId、队伍归属和完整参与者判断，不按英雄或 KDA 猜测。
          </div>

          <div v-if="analysis.opponents.length" class="opponent-list">
            <div class="relation-subtitle">历史交手</div>
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
          <div
            v-if="analysis.dataCoverage?.sources?.length"
            class="text-xs text-gray-500 mt-1"
          >
            本次分析来源：{{ analysis.dataCoverage.sources.join("、") }}
          </div>
        </n-card>
      </div>

      <n-empty v-else-if="!loading" description="暂无可用历史战绩" />
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

.trend-list,
.hero-list,
.position-list,
.relation-list,
.opponent-list,
.synergy-list {
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

.party-ranking-caption,
.party-ranking-note,
.party-ranking-submetrics {
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
  align-items: flex-start;
  gap: 0.35rem;
  min-width: 0;
  padding: 0.35rem 0;
  border-bottom: 1px solid rgba(128, 128, 128, 0.1);
}

.party-ranking-row:last-child {
  border-bottom: 0;
}

.party-rank {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 1.25rem;
  width: 1.25rem;
  height: 1.25rem;
  border-radius: 999px;
  color: #666;
  background: rgba(128, 128, 128, 0.12);
  font-size: 0.7rem;
  font-weight: 600;
}

.party-ranking-main {
  min-width: 0;
  flex: 1;
}

.party-ranking-name {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.2rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.72rem;
  font-weight: 600;
}

.party-ranking-metrics {
  color: #333;
  font-size: 0.68rem;
  line-height: 1.5;
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
  .party-ranking-grid {
    grid-template-columns: 1fr;
  }
}
</style>
