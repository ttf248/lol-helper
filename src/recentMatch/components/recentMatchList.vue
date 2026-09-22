<script setup lang="ts">
import { computed, ref } from "vue";
import { NAvatar, NButton, NCard, NResult, NTag } from "naive-ui";
import {
  ChampionRecentStats,
  OpponentMatchupStats,
  PartyGroupAnalysis,
  PositionRecentStats,
  RecentHistoryStatus,
  RecentMatchLoadingState,
  RecentSumInfo,
} from "@/recentMatch/utils/queryTypes";
import DuoGroupCard from "@/recentMatch/components/DuoGroupCard.vue";
import {
  confidenceLabel,
  formatRate,
  partyEvidenceSummary,
  partyEvidenceTime,
  partyGroupNames,
} from "@/recentMatch/utils/partyDisplay";
import {
  championName as championNameShared,
  historyStatusLabel as initialStatusLabel,
  sourceEndpointSummary,
  sourceEndpointTitle,
  historySourceLabel as sharedHistorySourceLabel,
} from "@/recentMatch/utils/display";
import { positionLabel as positionLabelShared } from "@/lcu/utils";

const {
  sumList,
  isFri,
  analysisLoading,
  loadingState,
} = defineProps<{
  sumList: RecentSumInfo[];
  isFri: boolean;
  analysisLoading: boolean;
  loadingState: RecentMatchLoadingState;
}>();

const emits = defineEmits<{
  showDetail: [gameId: number, summonerId: number, isFri: boolean, champId: number];
}>();

const selectedPuuid = ref<string | null>(null);

const selectedPlayer = computed(() =>
  sumList.find((player) => player.puuid === selectedPuuid.value) || null,
);

// 缓存里可能有更多对局（首页后台同步过来的 60 场），
// 但对局面板首屏只显示前 N 场；展示容器内部可滚动查看更多。
const previewedMatches = (matchList: RecentSumInfo["matchList"]) =>
  matchList.slice(0, 5);
const hasMoreMatches = (matchList: RecentSumInfo["matchList"]) =>
  matchList.length > 5;

const showDetail = (
  gameId: number,
  summonerId: number,
  champId: number,
) => {
  emits("showDetail", gameId, summonerId, isFri, champId);
};

const toggleAnalysis = (puuid: string) => {
  selectedPuuid.value = selectedPuuid.value === puuid ? null : puuid;
};

const getChampionName = (championId: number) =>
  championNameShared(championId);

const heroSummary = (champion: ChampionRecentStats) =>
  `${champion.games}场 · ${formatRate(champion.winRate)}`;

const positionLabel = (position: string) =>
  position === "UNKNOWN" ? "未知位置" : positionLabelShared(position);

const opponentSummary = (opponent: OpponentMatchupStats) =>
  `${opponent.games}场 · 我${opponent.wins}胜 / 对手${opponent.opponentWins}胜 · ${formatRate(opponent.winRate)}`;

const positionSummary = (position: PositionRecentStats) =>
  `${position.games}场 · ${formatRate(position.winRate)}`;

const positionHeroSummary = (position: PositionRecentStats) =>
  position.champions
    .slice(0, 4)
    .map(
      (champion) =>
        `${getChampionName(champion.championId)} ${formatRate(champion.winRate)}`,
    )
    .join(" · ");

const shouldShowHistoryStatus = (status?: RecentHistoryStatus) =>
  status !== undefined && status.kind !== "ready";

const historyStatusLabel = (status?: RecentHistoryStatus) => {
  if (!status) return "";
  return initialStatusLabel(status.kind, status.title);
};

const historySourceLabel = (source: string) =>
  sharedHistorySourceLabel(source);

// 把原先一个 60 行 computed 拆成 3 个互相独立的 computed：
// analyzedPlayers 只依赖 sumList 的 recentAnalysis；rankedPlayers 在
// analyzedPlayers 上做">=3 场"过滤 + 排序；teamGroups 做"全员命中同队"的
// 去重。三者缓存相互独立，partial 更新（例如只刷新 1 个玩家的 analysis）
// 不会触发全量重排。
const analyzedPlayers = computed(() =>
  sumList.filter((player) => (player.recentAnalysis?.actualGames || 0) > 0),
);

const rankedPlayers = computed(() =>
  analyzedPlayers.value
    .filter((player) => (player.recentAnalysis?.actualGames || 0) >= 3)
    .slice()
    .sort(
      (left, right) =>
        (right.recentAnalysis?.winRate || 0) -
          (left.recentAnalysis?.winRate || 0) ||
        (right.recentAnalysis?.actualGames || 0) -
          (left.recentAnalysis?.actualGames || 0),
    ),
);

const teamGroups = computed(() => {
  const groupMap = new Map<string, PartyGroupAnalysis>();
  const currentTeam = new Set(sumList.map((player) => player.puuid));
  for (const player of sumList) {
    for (const group of player.recentAnalysis?.partyGroups || []) {
      if (!group.members.every((member) => currentTeam.has(member.puuid))) continue;
      const key = group.members.map((member) => member.puuid).sort().join("|");
      const previous = groupMap.get(key);
      if (!previous || group.games > previous.games) groupMap.set(key, group);
    }
  }
  return Array.from(groupMap.values())
    .sort(
      (left, right) =>
        Number(right.highWinRateAlert) - Number(left.highWinRateAlert) ||
        right.games - left.games ||
        right.winRate - left.winRate,
    )
    .slice(0, 2);
});

const teamInsight = computed(() => {
  const analyzed = analyzedPlayers.value;
  const totalGames = analyzed.reduce(
    (total, player) => total + (player.recentAnalysis?.actualGames || 0),
    0,
  );
  const totalWins = analyzed.reduce(
    (total, player) => total + (player.recentAnalysis?.wins || 0),
    0,
  );
  const ranked = rankedPlayers.value;
  return {
    analyzed: analyzed.length,
    total: sumList.length,
    totalGames,
    totalWins,
    winRate: totalGames > 0 ? (totalWins / totalGames) * 100 : null,
    best: ranked[0] || null,
    risk: ranked[ranked.length - 1] || null,
    groups: teamGroups.value,
  };
});

</script>

<template>
  <n-card
    size="small"
    class="team-panel shadow"
    content-style="padding: 10px"
  >
    <div v-if="sumList.length !== 0" class="team-panel-content">
      <div class="team-insight">
        <div class="team-insight-top">
          <span class="team-insight-title">{{ isFri ? "友方" : "敌方" }}历史摘要</span>
          <div class="team-insight-stats">
            <span><i>胜率</i><strong>{{ formatRate(teamInsight.winRate) }}</strong></span>
            <span><i>样本</i><strong>{{ teamInsight.totalGames }}场</strong></span>
          </div>
          <n-tag
            size="tiny"
            :bordered="false"
            :type="analysisLoading ? 'warning' : teamInsight.analyzed ? 'success' : 'default'"
            :title="analysisLoading ? '已先使用本地缓存，服务器数据正在后台补齐' : `${teamInsight.analyzed}/${teamInsight.total} 人已完成分析`"
          >
            {{ analysisLoading ? "补齐中" : `${teamInsight.analyzed}/${teamInsight.total}人` }}
          </n-tag>
        </div>
        <div
          v-if="teamInsight.best || teamInsight.risk || teamInsight.groups.length"
          class="team-insight-details"
        >
          <span v-if="teamInsight.best" class="insight-pill insight-pill-good">
            优势 {{ teamInsight.best.summonerName }} · {{ formatRate(teamInsight.best.recentAnalysis?.winRate) }}
          </span>
          <span
            v-if="teamInsight.risk && teamInsight.risk.puuid !== teamInsight.best?.puuid"
            class="insight-pill insight-pill-risk"
          >
            风险 {{ teamInsight.risk.summonerName }} · {{ formatRate(teamInsight.risk.recentAnalysis?.winRate) }}
          </span>
          <span v-if="teamInsight.groups.length" class="insight-pill insight-pill-party">
            疑似开黑 {{ teamInsight.groups[0].members.length }}人 ·
            <template v-if="teamInsight.groups[0].recentWindowGames !== undefined">
              最近5局 {{ teamInsight.groups[0].recentWindowGames }}次
            </template>
            <template v-else>
              历史 {{ teamInsight.groups[0].historicalGames ?? teamInsight.groups[0].games }}场
            </template>
          </span>
        </div>
      </div>
      <div class="team-grid">
        <div
          v-for="summoner in sumList"
          :key="summoner.puuid"
          class="team-player"
        >
          <div class="player-overview">
            <div class="player-card-head">
            <n-avatar
              @click.stop="showDetail(0, 0, summoner.champId)"
              :size="44"
              :src="summoner.championUrl"
              fallback-src="https://wegame.gtimg.com/g.26-r.c2d3c/helper/lol/assis/images/resources/usericon/4027.png"
            />
              <div class="player-identity">
                <div class="player-name" :title="summoner.summonerName">
                  {{ summoner.summonerName }}
                </div>
                <div class="player-champion">{{ getChampionName(summoner.champId) }}</div>
              </div>
            </div>

            <div v-if="summoner.recentAnalysis" class="text-xs leading-5">
              <div v-if="summoner.recentAnalysis.actualGames > 0" class="player-metrics">
                <div class="player-metrics-hero">
                  <strong>{{ formatRate(summoner.recentAnalysis.winRate) }}</strong>
                  <span class="player-metrics-label">胜率</span>
                </div>
                <div class="player-metrics-meta">
                  <div>
                    <strong>{{ summoner.recentAnalysis.wins }}/{{ summoner.recentAnalysis.actualGames }}</strong>
                    <span>近况</span>
                  </div>
                  <div>
                    <strong>{{ confidenceLabel(summoner.recentAnalysis.confidence) }}</strong>
                    <span>置信</span>
                  </div>
                </div>
              </div>
              <div v-else class="player-no-data">
                暂无可用历史样本
              </div>
              <div v-if="summoner.recentAnalysis.currentChampion" class="player-current-form">
                {{ heroSummary(summoner.recentAnalysis.currentChampion) }} · 当前英雄表现
              </div>
            </div>
            <div v-else class="player-no-data">
              {{ loadingState.stage === "history" || analysisLoading ? "分析中…" : "暂无分析" }}
            </div>

            <div
              v-if="
                shouldShowHistoryStatus(summoner.historyStatus) ||
                summoner.recentAnalysis?.partyGroups.length ||
                summoner.recentAnalysis?.moderation.reportCount
              "
              class="player-status-row"
            >
              <span
                v-if="shouldShowHistoryStatus(summoner.historyStatus)"
                class="status-chip status-chip-history"
                :class="`history-status-${summoner.historyStatus?.kind}`"
                :title="summoner.historyStatus?.detail"
              >
                {{ historyStatusLabel(summoner.historyStatus) }}
                <span v-if="summoner.historyStatus?.cachedGames" class="status-chip-detail">
                  ·{{ summoner.historyStatus.cachedGames }}场
                </span>
              </span>
              <button
                v-if="summoner.recentAnalysis?.partyGroups.length"
                class="status-chip status-chip-party"
                type="button"
                :title="partyGroupNames(summoner.recentAnalysis.partyGroups[0])"
                @click="toggleAnalysis(summoner.puuid)"
              >
                开黑 {{ summoner.recentAnalysis.partyGroups[0].members.length }}人
                <span v-if="summoner.recentAnalysis.partyGroups.length > 1" class="status-chip-extra">
                  +{{ summoner.recentAnalysis.partyGroups.length - 1 }}
                </span>
              </button>
              <n-tag
                v-if="summoner.recentAnalysis?.moderation.reportCount"
                size="small"
                :bordered="false"
                :type="summoner.recentAnalysis.moderation.marked ? 'error' : 'info'"
                @click.stop="toggleAnalysis(summoner.puuid)"
                class="status-chip"
              >
                {{ summoner.recentAnalysis.moderation.marked ? "黑名单" : "举报" }}
              </n-tag>
            </div>

            <n-button text size="tiny" class="player-expand-button" @click="toggleAnalysis(summoner.puuid)">
              {{ selectedPuuid === summoner.puuid ? "收起分析" : "展开分析" }}
            </n-button>
          </div>

          <div v-if="summoner.matchList.length" class="match-history">
            <div class="match-history-title">最近战绩</div>
            <div
              v-for="match in previewedMatches(summoner.matchList)"
              :key="match.gameId"
              @click.stop="showDetail(match.gameId, summoner.summonerId, 0)"
              class="match-history-row cursor-pointer"
            >
              <n-avatar
                :size="32"
                :src="match.champImg"
                fallback-src="https://wegame.gtimg.com/g.26-r.c2d3c/helper/lol/assis/images/resources/usericon/4027.png"
              />
              <n-tag
                :type="match.isWin ? 'success' : 'error'"
                :bordered="false"
                class="match-kda"
              >
                {{ match.kills }}-{{ match.deaths }}-{{ match.assists }}
              </n-tag>
            </div>
            <div
              v-if="hasMoreMatches(summoner.matchList)"
              class="history-more-hint"
              :title="`本地缓存共 ${summoner.matchList.length} 场`"
            >
              还有 {{ summoner.matchList.length - 5 }} 场 · 点击展开分析查看
            </div>
          </div>
          <div v-else-if="summoner.historyStatus?.kind !== 'loading'" class="history-empty">
            暂无可展示的有效对局
          </div>
        </div>
      </div>

      <div
        v-if="selectedPlayer"
        class="mt-3 rounded-md border border-gray-200 dark:border-gray-700 p-3 text-xs"
      >
        <div class="flex items-center justify-between mb-2">
          <div class="font-medium">
            {{ selectedPlayer.summonerName }} · 近期 {{ selectedPlayer.recentAnalysis?.actualGames || 0 }} 场分析
          </div>
          <n-button text size="tiny" @click="selectedPuuid = null">关闭</n-button>
        </div>

        <template v-if="selectedPlayer.recentAnalysis">
          <div class="grid grid-cols-4 gap-2 mb-3">
            <div class="rounded bg-gray-100 dark:bg-gray-800 p-2">
              <div class="text-gray-500">样本</div>
              <div class="font-medium">
                {{ selectedPlayer.recentAnalysis.actualGames }} 场
              </div>
            </div>
            <div class="rounded bg-gray-100 dark:bg-gray-800 p-2">
              <div class="text-gray-500">胜场</div>
              <div class="font-medium">{{ selectedPlayer.recentAnalysis.wins }}</div>
            </div>
            <div class="rounded bg-gray-100 dark:bg-gray-800 p-2">
              <div class="text-gray-500">总体胜率</div>
              <div class="font-medium">{{ formatRate(selectedPlayer.recentAnalysis.winRate) }}</div>
            </div>
            <div class="rounded bg-gray-100 dark:bg-gray-800 p-2">
              <div class="text-gray-500">数据源</div>
              <div
                class="font-medium truncate"
                :title="sourceEndpointTitle(selectedPlayer.recentAnalysis.sourceEndpoints) || selectedPlayer.recentAnalysis.source"
              >
                {{ historySourceLabel(selectedPlayer.recentAnalysis.source) }}
              </div>
              <div
                v-if="selectedPlayer.recentAnalysis.sourceEndpoints?.length"
                class="text-gray-500 truncate"
                :title="sourceEndpointTitle(selectedPlayer.recentAnalysis.sourceEndpoints)"
              >
                {{ sourceEndpointSummary(selectedPlayer.recentAnalysis.sourceEndpoints) }}
              </div>
              <div v-else class="text-gray-500 truncate">仅本地缓存/已加载摘要</div>
            </div>
          </div>
					<div
						v-if="!selectedPlayer.recentAnalysis.historyComplete && analysisLoading"
						class="text-blue-500 mb-2"
					>
						已先展示面板中已有的最近 10 场快速摘要；后台基于本地缓存进行团队分析。
					</div>
					<div
						v-else-if="!selectedPlayer.recentAnalysis.historyComplete"
						class="text-orange-500 mb-2"
					>
						当前队列历史不足 100 场，以上数据按实际可用样本统计。
					</div>

          <div class="mb-3">
            <div class="font-medium mb-1">个人置信度：{{ confidenceLabel(selectedPlayer.recentAnalysis.confidence) }}</div>
            <div class="text-gray-500">
              {{ selectedPlayer.recentAnalysis.confidence.reasons.join("；") }}
            </div>
          </div>

          <div class="mb-3">
            <div class="font-medium mb-1">英雄胜率</div>
            <div class="grid grid-cols-2 gap-x-3 gap-y-1">
              <div
                v-for="champion in selectedPlayer.recentAnalysis.champions"
                :key="champion.championId"
                class="flex justify-between border-b border-gray-100 dark:border-gray-800 py-1"
              >
                <span class="truncate mr-2">
                  {{ getChampionName(champion.championId) }}
                </span>
                <span class="whitespace-nowrap">
                  {{ champion.games }}场 · {{ champion.wins }}胜 · {{ formatRate(champion.winRate) }}
                </span>
              </div>
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3 mb-3">
            <div>
              <div class="font-medium mb-1">按位置统计</div>
              <div
                v-for="position in selectedPlayer.recentAnalysis.positions"
                :key="position.position"
                class="border-b border-gray-100 dark:border-gray-800 py-1"
              >
                <div class="flex justify-between">
                  <span>{{ positionLabel(position.position) }}</span>
                  <span>{{ positionSummary(position) }}</span>
                </div>
                <div
                  v-if="position.champions.length"
                  class="text-gray-500 truncate"
                  :title="positionHeroSummary(position)"
                >
                  英雄：{{ positionHeroSummary(position) }}
                </div>
              </div>
              <div v-if="!selectedPlayer.recentAnalysis.positions.length" class="text-gray-500">
                暂无位置数据
              </div>
            </div>
            <div>
              <div class="font-medium mb-1">历史交手</div>
              <div
                v-for="opponent in selectedPlayer.recentAnalysis.opponents.slice(0, 6)"
                :key="opponent.opponent.puuid"
                class="flex justify-between border-b border-gray-100 dark:border-gray-800 py-1"
              >
                <span class="truncate mr-2">{{ opponent.opponent.summonerName }}</span>
                <span class="whitespace-nowrap">
                  {{ opponentSummary(opponent) }}
                </span>
              </div>
              <div v-if="!selectedPlayer.recentAnalysis.opponents.length" class="text-gray-500">
                暂无历史交手数据
              </div>
            </div>
          </div>

          <div>
            <div class="font-medium mb-1">开黑组合分析</div>
            <div v-if="selectedPlayer.recentAnalysis.partyCoverage?.status === 'insufficient'" class="text-amber-600 mb-1">
              {{ selectedPlayer.recentAnalysis.partyCoverage.message }}
            </div>
            <div v-if="selectedPlayer.recentAnalysis.partyGroups.length" class="duo-stack">
              <DuoGroupCard
                v-for="group in selectedPlayer.recentAnalysis.partyGroups"
                :key="group.members.map((member) => member.puuid).join('-')"
                :group="group"
                mode="full"
                always-show-evidence
              >
                <template #evidence>
                  <div class="text-xs leading-5">
                    <div class="font-medium mb-1">为什么标记为“疑似开黑”</div>
                    <div class="font-medium">{{ partyGroupNames(group) }}</div>
                    <div>{{ partyEvidenceSummary(group) }}</div>
                    <div>
                      <template v-if="group.recentWindowGames !== undefined">
                        最近5局同队 {{ group.recentWindowGames }} 次（含当前） · 历史共同 {{ group.historicalGames || 0 }} 场
                      </template>
                      <template v-else>
                        完整历史共同 {{ group.historicalGames ?? group.games }} 场
                      </template>
                      · 最近一次 {{ group.lastActiveDays === null ? "未知" : `${group.lastActiveDays} 天前` }} · 组合胜率 {{ formatRate(group.winRate) }}
                    </div>
                    <div class="font-medium mt-1">共同同队对局证据</div>
                    <div
                      v-for="evidence in group.evidence.slice(0, 6)"
                      :key="evidence.gameId"
                      class="text-gray-500"
                    >
                      {{ evidence.isCurrentMatch ? "当前对局" : partyEvidenceTime(evidence.gameCreation) }} · 对局 {{ evidence.isCurrentMatch ? "本局" : evidence.gameId }}
                    </div>
                    <div class="text-gray-500 mt-1">
                      先以当前对局加最近4场中同队至少3次作为近期初筛，同时保留完整历史算法结果并合并统计；不是按个人历史列表长相、英雄、KDA 或单人胜率判断。接口没有官方组队 ID，所以只能表示疑似固定同队。
                    </div>
                  </div>
                </template>
              </DuoGroupCard>
            </div>
            <div v-else class="text-gray-500">
              {{ selectedPlayer.recentAnalysis.partyCoverage?.status === 'ready'
                ? '当前模式近期窗口及已加载历史中未发现达标组合。'
                : '数据不足，暂未识别到组合。' }}
            </div>
            <div class="text-gray-500 mt-1">
              悬停组合标签可查看最近5局初筛次数与历史共同对局；依据同队出现推断，不代表接口提供了官方组队 ID。
            </div>
          </div>

          <div class="mt-3" v-if="selectedPlayer.recentAnalysis.moderation.reportCount">
            <div class="font-medium mb-1">
              黑名单 / 举报记录
            </div>
            <div class="text-gray-500 mb-1">
              黑名单 {{ selectedPlayer.recentAnalysis.moderation.blacklistCount }} 条，
              其它记录 {{ selectedPlayer.recentAnalysis.moderation.positiveCount }} 条
            </div>
            <div
              v-for="record in selectedPlayer.recentAnalysis.moderation.records.slice(0, 3)"
              :key="`${record.updatedAt}-${record.tag}-${record.content}`"
              class="rounded bg-gray-100 dark:bg-gray-800 p-2 mb-1"
            >
              <span :class="record.isShow ? 'text-red-500' : 'text-green-500'">
                {{ record.tag }}
              </span>
              <span v-if="record.content"> · {{ record.content }}</span>
            </div>
          </div>
        </template>
        <div v-else class="text-gray-500 py-4 text-center">
						  {{ analysisLoading ? "正在基于本地缓存计算团队分析…" : "当前无法取得完整历史数据。" }}
        </div>
      </div>
    </div>
    <div v-else class="flex h-full justify-center items-center">
      <n-result
        :status="loadingState.stage === 'error' ? 'error' : '418'"
        :title="loadingState.stage === 'error' ? '数据读取失败' : '数据加载中'"
        :description="loadingState.detail || loadingState.message"
      />
    </div>
  </n-card>
</template>

<style scoped>
.team-panel {
  flex: 1 1 0;
  width: auto;
  min-width: 0;
  min-height: 0;
  height: 100%;
  margin-top: 4px;
  overflow: hidden;
}

.team-panel :deep(.n-card__content) {
  height: 100%;
  min-height: 0;
  box-sizing: border-box;
  overflow-y: auto;
  overflow-x: hidden;
  background: linear-gradient(180deg, rgba(248, 250, 252, 0.82), rgba(255, 255, 255, 0.98));
}

.team-panel-content {
	min-height: 100%;
}

.team-insight {
	margin-bottom: 9px;
	padding: 8px 9px 7px;
	border: 1px solid rgba(16, 185, 129, 0.2);
	border-radius: 9px;
	background: rgba(236, 253, 245, 0.7);
	color: #374151;
	font-size: 12px;
	line-height: 1.4;
	box-shadow: 0 2px 8px rgba(15, 118, 110, 0.05);
}

.team-insight-top,
.team-insight-details {
	display: flex;
	align-items: center;
	min-width: 0;
	gap: 8px;
}

.team-insight-top {
	justify-content: flex-start;
	min-height: 24px;
	white-space: nowrap;
}

.team-insight-title {
	font-weight: 600;
}

.team-insight-stats {
	display: flex;
	align-items: center;
	flex: 1 1 auto;
	min-width: 0;
	gap: 0;
}

.team-insight-stats > span {
	display: inline-flex;
	align-items: baseline;
	min-width: 0;
	padding: 0 7px;
	border-right: 1px solid rgba(16, 185, 129, 0.18);
}

.team-insight-stats > span:first-child {
	padding-left: 4px;
}

.team-insight-stats > span:last-child {
	border-right: 0;
}

.team-insight-stats i {
	margin-right: 4px;
	font-style: normal;
	font-variant-caps: small-caps;
	letter-spacing: 0.3px;
	color: #4b5563;
	font-weight: 500;
}

.team-insight-stats strong {
	font-size: 13px;
	color: #111827;
}

.team-insight-details {
	margin-top: 6px;
	padding-top: 6px;
	border-top: 1px solid rgba(16, 185, 129, 0.12);
	overflow: hidden;
	gap: 5px;
}

.team-insight-detail {
	display: inline-flex;
	align-items: center;
	min-width: 0;
	max-width: 50%;
	overflow: hidden;
	white-space: nowrap;
	text-overflow: ellipsis;
	color: #4b5563;
}

.insight-pill {
	display: inline-flex;
	align-items: center;
	max-width: 48%;
	padding: 3px 7px;
	border-radius: 999px;
	font-size: 11px;
	line-height: 14px;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.insight-pill-good {
	color: #047857;
	background: rgba(209, 250, 229, 0.9);
}

.insight-pill-risk {
	color: #b45309;
	background: rgba(254, 243, 199, 0.9);
}

.insight-pill-party {
	color: #4338ca;
	background: rgba(224, 231, 255, 0.9);
}

.team-insight-detail b {
	flex: 0 0 auto;
	margin-right: 3px;
	color: #6b7280;
	font-weight: 500;
}

.team-insight-party {
	flex: 1 1 auto;
	max-width: none;
	gap: 3px;
	justify-content: flex-start;
}

.team-insight-party :deep(.n-tag) {
	flex: 0 0 auto;
}

.team-insight-party {
	min-width: 0;
}

.team-insight-party-stack {
	flex: 1 1 auto;
	display: flex;
	flex-direction: column;
	gap: 3px;
	min-width: 0;
	max-width: 60%;
}

.duo-stack {
	display: flex;
	flex-direction: column;
	gap: 6px;
	min-width: 0;
}

:global(.dark) .team-insight {
	background: rgba(6, 78, 59, 0.25);
	color: #d1fae5;
}

:global(.dark) .team-insight-stats strong {
	color: #ecfdf5;
}

.team-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
  min-width: 0;
}

.team-player {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 7px;
  padding: 9px 8px 8px;
  border: 1px solid rgba(148, 163, 184, 0.24);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.9);
  box-shadow: 0 2px 7px rgba(15, 23, 42, 0.045);
}

/* 概览区固定高度，保证两队五列的“最近战绩”从同一条基线开始。 */
.player-overview {
  display: flex;
  flex: 0 0 246px;
  flex-direction: column;
  min-width: 0;
  gap: 6px;
  overflow: hidden;
}

.player-card-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  min-height: 55px;
  padding-bottom: 7px;
  border-bottom: 1px solid rgba(226, 232, 240, 0.9);
}

.team-player :deep(.n-avatar) {
  flex: 0 0 auto;
  border: 2px solid rgba(148, 163, 184, 0.32);
}

.player-identity {
  min-width: 0;
}

.player-name {
  overflow: hidden;
  color: #1f2937;
  font-size: 13px;
  font-weight: 600;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.player-champion {
  overflow: hidden;
  color: #64748b;
  font-size: 12px;
  line-height: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.player-metrics {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px 0 2px;
}

.player-metrics-hero {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 4px;
  min-height: 24px;
}

.player-metrics-hero strong {
  color: #0f766e;
  font-size: 18px;
  font-weight: 700;
  line-height: 22px;
}

.player-metrics-label,
.player-metrics-meta span {
  color: #94a3b8;
  font-size: 10px;
  line-height: 14px;
}

.player-metrics-meta {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 3px;
  min-width: 0;
}

.player-metrics-meta > div {
  min-width: 0;
  padding: 2px 1px;
  border-radius: 4px;
  background: #f8fafc;
  text-align: center;
}

.player-metrics-meta strong {
  display: block;
  color: #0f766e;
  font-size: 11px;
  font-weight: 600;
  line-height: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.player-metrics-meta span {
  display: block;
}

.player-status-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 3px;
  min-width: 0;
  padding: 1px 0 2px;
}

.status-chip {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  padding: 2px 6px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  background: #f1f5f9;
  color: #475569;
  border: none;
  font-family: inherit;
}

.status-chip-history {
  cursor: default;
  flex: 0 1 auto;
}

.status-chip-detail {
  opacity: 0.75;
  font-size: 10px;
  margin-left: 2px;
}

.status-chip-extra {
  color: #94a3b8;
  font-size: 10px;
  margin-left: 3px;
}

.status-chip-party {
  background: rgba(224, 231, 255, 0.9);
  color: #4338ca;
  border: 1px solid rgba(67, 56, 202, 0.18);
}

.status-chip-party:hover {
  background: rgba(199, 210, 254, 0.95);
}

.player-current-form,
.player-no-data {
  overflow: hidden;
  color: #64748b;
  font-size: 10px;
  line-height: 16px;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.player-current-form {
  min-height: 16px;
}

.player-no-data {
  padding: 5px 0;
  color: #94a3b8;
}

.team-player :deep(.n-tag) {
  max-width: 100%;
  overflow: hidden;
}

.match-history {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 3px;
  flex: 0 0 auto;
  padding-top: 7px;
  border-top: 1px solid rgba(226, 232, 240, 0.8);
}

.match-history-title {
  color: #475569;
  font-size: 11px;
  font-weight: 600;
  line-height: 18px;
}

.history-more-hint {
  font-size: 12px;
  color: rgba(140, 140, 140, 0.9);
  text-align: center;
  padding: 4px 0 2px 0;
  font-style: italic;
}

.history-status,
.history-empty {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 4px;
	border-radius: 4px;
	min-width: 0;
	height: 27px;
	padding: 0 5px;
	font-size: 9px;
	line-height: 13px;
	text-align: center;
}

.history-status-detail {
	overflow: hidden;
	color: inherit;
	opacity: 0.78;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.party-badge {
	width: 100%;
	min-width: 0;
	padding: 5px 4px;
	border: 1px solid rgba(45, 212, 191, 0.24);
	border-radius: 5px;
	background: rgba(236, 253, 245, 0.85);
	color: #047857;
	cursor: pointer;
	font-family: inherit;
	font-size: 10px;
	line-height: 13px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.party-badge:hover {
	background: rgba(209, 250, 229, 0.95);
}

.history-empty {
  color: #9ca3af;
  background: #f3f4f6;
}

.history-status-loading {
  color: #2563eb;
  background: #eff6ff;
}

.history-status-cache-fallback {
  color: #b45309;
  background: #fffbeb;
}

.history-status-no-data,
.history-status-mode-empty {
  color: #6b7280;
  background: #f3f4f6;
}

.history-status-identity-mismatch,
.history-status-error {
  color: #dc2626;
  background: #fef2f2;
}

.match-history-row {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr);
  align-items: center;
  min-width: 0;
  gap: 4px;
  height: 26px;
}

.match-kda {
  width: 100%;
  height: 26px;
  min-width: 0;
  justify-content: center;
  padding: 0 4px;
  font-size: 12px;
  font-weight: 500;
}

.match-history-row :deep(.n-avatar) {
  width: 26px;
  height: 26px;
}

.player-expand-button {
  margin-top: 1px;
  min-height: 22px;
  border-top: 1px dashed rgba(148, 163, 184, 0.32);
  color: #64748b;
  font-size: 11px;
}

:global(.dark) .team-panel :deep(.n-card__content) {
  background: linear-gradient(180deg, rgba(15, 23, 42, 0.92), rgba(17, 24, 39, 0.98));
}

:global(.dark) .team-player {
  border-color: rgba(71, 85, 105, 0.48);
  background: rgba(30, 41, 59, 0.82);
}

:global(.dark) .player-name {
  color: #e2e8f0;
}

:global(.dark) .player-metrics-meta > div {
  background: rgba(15, 23, 42, 0.65);
}

:global(.dark) .player-metrics-hero strong,
:global(.dark) .player-metrics-meta strong {
  color: #5eead4;
}

:global(.dark) .status-chip {
  background: rgba(30, 41, 59, 0.7);
  color: #cbd5e1;
}

:global(.dark) .status-chip-party {
  background: rgba(67, 56, 202, 0.25);
  color: #c7d2fe;
  border-color: rgba(199, 210, 254, 0.2);
}

:global(.dark) .status-chip-party:hover {
  background: rgba(67, 56, 202, 0.35);
}

:global(.dark) .history-status-loading {
  color: #93c5fd;
  background: rgba(30, 58, 138, 0.35);
}

:global(.dark) .history-status-cache-fallback {
  color: #fcd34d;
  background: rgba(120, 53, 15, 0.35);
}

:global(.dark) .history-status-no-data,
:global(.dark) .history-status-mode-empty {
  color: #cbd5e1;
  background: rgba(51, 65, 85, 0.45);
}

:global(.dark) .history-status-identity-mismatch,
:global(.dark) .history-status-error {
  color: #fca5a5;
  background: rgba(127, 29, 29, 0.35);
}

:global(.dark) .match-history-title {
  color: #cbd5e1;
}

:global(.dark) .party-badge {
  border-color: rgba(45, 212, 191, 0.35);
  background: rgba(6, 78, 59, 0.45);
  color: #a7f3d0;
}

@media (max-width: 980px) {
  .team-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
</style>
