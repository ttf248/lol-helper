<script setup lang="ts">
import { computed, ref } from "vue";
import { NAvatar, NButton, NCard, NPopover, NResult, NTag } from "naive-ui";
import { champDict } from "@/resources/champList";
import {
  ChampionRecentStats,
  ConfidenceInfo,
  OpponentMatchupStats,
  PartyGroupAnalysis,
  PositionRecentStats,
  RecentMatchLoadingState,
  RecentSumInfo,
} from "@/recentMatch/utils/queryTypes";

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
  champDict[String(championId)]?.label || `英雄 ${championId}`;

const formatRate = (rate: number | null | undefined) =>
  rate === null || rate === undefined ? "--" : `${rate.toFixed(1)}%`;

const groupNames = (group: PartyGroupAnalysis) =>
  group.members.map((member) => member.summonerName).join(" + ");

const partyEvidenceTime = (timestamp: number) => {
  const normalizedTimestamp = timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
  const date = new Date(normalizedTimestamp);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const partyEvidenceSummary = (group: PartyGroupAnalysis) =>
  `共同同队 ${group.games} 场 / ${group.members.length} 人组合门槛 ${group.requiredGames} 场`;

const heroSummary = (champion: ChampionRecentStats) =>
  `${champion.games}场 · ${formatRate(champion.winRate)}`;

const confidenceLabel = (confidence: ConfidenceInfo) => {
  const labels = { high: "高", medium: "中", low: "低" };
  return `${labels[confidence.level]} · ${confidence.score}`;
};

const positionLabel = (position: string) => {
  const labels: Record<string, string> = {
    TOP: "上路",
    JUNGLE: "打野",
    MIDDLE: "中路",
    BOTTOM: "下路",
    SUPPORT: "辅助",
    UNKNOWN: "未知位置",
  };
  return labels[position] || position;
};

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

</script>

<template>
  <n-card
    size="small"
    class="team-panel shadow"
    content-style="padding: 10px"
  >
    <div v-if="sumList.length !== 0" class="team-panel-content">
      <div class="team-grid">
        <div
          v-for="summoner in sumList"
          :key="summoner.puuid"
          class="team-player"
        >
          <div class="team-player-avatar">
            <n-avatar
              @click.stop="showDetail(0, 0, summoner.champId)"
              :size="55"
              :src="summoner.championUrl"
              fallback-src="https://wegame.gtimg.com/g.26-r.c2d3c/helper/lol/assis/images/resources/usericon/4027.png"
            />
          </div>

          <div class="text-xs text-center truncate" :title="summoner.summonerName">
            {{ summoner.summonerName }}
          </div>

          <n-tag
            class="p-0"
            :bordered="false"
            type="default"
            style="height: 30px; width: 100%; font-size: 12px; justify-content: center; margin: 0"
          >
            {{ getChampionName(summoner.champId) }}
          </n-tag>

          <div v-if="summoner.recentAnalysis" class="text-xs leading-5">
            <div class="flex justify-between">
              <span>
                近{{ summoner.recentAnalysis.actualGames }}场
                {{ summoner.recentAnalysis.wins }}胜
              </span>
              <span class="font-medium">
                {{ formatRate(summoner.recentAnalysis.winRate) }}
              </span>
            </div>
            <div class="text-gray-500 truncate">
              {{ getChampionName(summoner.champId) }}
              {{ summoner.recentAnalysis.currentChampion ? heroSummary(summoner.recentAnalysis.currentChampion) : "暂无记录" }}
            </div>
            <div class="text-gray-500">
              置信度 {{ confidenceLabel(summoner.recentAnalysis.confidence) }}
            </div>
          </div>
          <div v-else class="text-xs text-gray-400 text-center leading-5">
            {{ loadingState.stage === "history" || analysisLoading ? "最近10场数据加载中" : "暂无完整分析" }}
          </div>

          <div
            v-if="summoner.recentAnalysis?.partyGroups.length"
            class="text-center"
          >
            <n-popover trigger="hover" placement="top-start" style="max-width: 360px">
              <template #trigger>
                <n-tag
                  size="small"
                  :type="selectedPuuid === summoner.puuid ? 'success' : 'warning'"
                  :bordered="false"
                  @click.stop="toggleAnalysis(summoner.puuid)"
                >
                  疑似开黑 {{ summoner.recentAnalysis.partyGroups.length }}组
                </n-tag>
              </template>
              <div class="text-xs leading-5">
                <div class="font-medium mb-1">疑似开黑判定依据</div>
                <div
                  v-for="group in summoner.recentAnalysis.partyGroups"
                  :key="group.members.map((member) => member.puuid).join('-')"
                  class="mb-2 last:mb-0"
                >
                  <div class="font-medium truncate" :title="groupNames(group)">
                    {{ groupNames(group) }}
                  </div>
                  <div>{{ partyEvidenceSummary(group) }}</div>
                  <div>
                    近30天 {{ group.recentGames }} 场 · 胜率 {{ formatRate(group.winRate) }}
                  </div>
                  <div
                    v-for="evidence in group.evidence.slice(0, 3)"
                    :key="evidence.gameId"
                    class="text-gray-500"
                  >
                    证据 {{ partyEvidenceTime(evidence.gameCreation) }} · 对局 {{ evidence.gameId }}
                  </div>
                </div>
                <div class="text-gray-500 mt-1">
                  取所有成员历史 gameId 的交集，并确认这些对局中处于同一队；个人最近 10/100 场列表、英雄和胜率不需要完全相同。接口没有官方组队 ID，因此结论仅为“疑似”。
                </div>
              </div>
            </n-popover>
          </div>

          <div v-if="summoner.recentAnalysis?.moderation.reportCount" class="text-center">
            <n-tag
              size="small"
              :bordered="false"
              :type="summoner.recentAnalysis.moderation.marked ? 'error' : 'info'"
              @click.stop="toggleAnalysis(summoner.puuid)"
            >
              {{ summoner.recentAnalysis.moderation.marked ? "黑名单" : "有举报记录" }}
            </n-tag>
          </div>

          <n-button
            text
            size="tiny"
            class="w-full"
            @click="toggleAnalysis(summoner.puuid)"
          >
            {{ selectedPuuid === summoner.puuid ? "收起分析" : "展开分析" }}
          </n-button>

          <div class="match-history">
            <div
              v-for="match in summoner.matchList"
              :key="match.gameId"
              @click.stop="showDetail(match.gameId, summoner.summonerId, 0)"
              class="match-history-row cursor-pointer"
            >
              <n-avatar
                :size="27"
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
          </div>
        </div>
      </div>

      <div
        v-if="selectedPlayer"
        class="mt-3 rounded-md border border-gray-200 dark:border-gray-700 p-3 text-xs"
      >
        <div class="flex items-center justify-between mb-2">
          <div class="font-medium">
            {{ selectedPlayer.summonerName }} · 近期 {{ selectedPlayer.recentAnalysis?.requestedGames || 10 }} 场分析
          </div>
          <n-button text size="tiny" @click="selectedPuuid = null">关闭</n-button>
        </div>

        <template v-if="selectedPlayer.recentAnalysis">
          <div class="grid grid-cols-4 gap-2 mb-3">
            <div class="rounded bg-gray-100 dark:bg-gray-800 p-2">
              <div class="text-gray-500">样本</div>
              <div class="font-medium">
                {{ selectedPlayer.recentAnalysis.actualGames }}/{{ selectedPlayer.recentAnalysis.requestedGames }} 场
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
              <div class="font-medium truncate" :title="selectedPlayer.recentAnalysis.source">
                {{ selectedPlayer.recentAnalysis.source }}
              </div>
            </div>
          </div>
					<div
						v-if="!selectedPlayer.recentAnalysis.historyComplete && analysisLoading"
						class="text-blue-500 mb-2"
					>
						已先展示面板中已有的最近 10 场，位置、交手和组合关系正在后台补齐。
					</div>
					<div
						v-else-if="!selectedPlayer.recentAnalysis.historyComplete"
						class="text-orange-500 mb-2"
					>
						当前队列历史不足 100 场，以上数据按实际可用样本统计。
					</div>

          <div class="mb-3">
            <div class="font-medium mb-1">胜率趋势</div>
				<div class="grid grid-cols-4 gap-2">
              <div
                v-for="trend in selectedPlayer.recentAnalysis.trends"
                :key="trend.window"
                class="rounded bg-gray-100 dark:bg-gray-800 p-2"
              >
                <div class="text-gray-500">最近{{ trend.window }}场</div>
                <div class="font-medium">
                  {{ trend.wins }}胜 / {{ trend.games }}场 · {{ formatRate(trend.winRate) }}
                </div>
              </div>
            </div>
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
            <div class="font-medium mb-1">历史同队组合</div>
            <div v-if="selectedPlayer.recentAnalysis.partyGroups.length" class="flex flex-wrap gap-1">
              <n-popover
                v-for="group in selectedPlayer.recentAnalysis.partyGroups"
                :key="group.members.map((member) => member.puuid).join('-')"
                trigger="hover"
                placement="top-start"
                style="max-width: 380px"
              >
                <template #trigger>
                  <n-tag
                    size="small"
                    :type="group.winRate >= 50 ? 'success' : 'warning'"
                    :bordered="false"
                  >
                    {{ group.highWinRateAlert ? "高胜率开黑队 · " : "" }}{{ groupNames(group) }} · {{ group.games }}场 · {{ group.wins }}胜 · {{ formatRate(group.winRate) }} · 稳定度{{ group.stabilityScore }} · 置信度{{ confidenceLabel(group.confidence) }}{{ group.blacklistedMembers.length ? " · 含黑名单" : "" }}{{ group.reportedMembers.length ? " · 含举报记录" : "" }}
                  </n-tag>
                </template>
                <div class="text-xs leading-5">
                  <div class="font-medium mb-1">为什么标记为“疑似开黑”</div>
                  <div class="font-medium">{{ groupNames(group) }}</div>
                  <div>{{ partyEvidenceSummary(group) }}</div>
                  <div>
                    近30天共同 {{ group.recentGames }} 场 · 最近一次 {{ group.lastActiveDays === null ? "未知" : `${group.lastActiveDays} 天前` }} · 组合胜率 {{ formatRate(group.winRate) }}
                  </div>
                  <div class="font-medium mt-1">共同同队对局证据</div>
                  <div
                    v-for="evidence in group.evidence.slice(0, 6)"
                    :key="evidence.gameId"
                    class="text-gray-500"
                  >
                    {{ partyEvidenceTime(evidence.gameCreation) }} · 对局 {{ evidence.gameId }}
                  </div>
                  <div class="text-gray-500 mt-1">
                    判定使用的是多人历史对局的 gameId 交集，并逐局确认成员 teamId 相同；不是按个人历史列表长相、英雄、KDA 或单人胜率判断。接口没有官方组队 ID，所以只能表示历史上疑似固定同队。
                  </div>
                </div>
              </n-popover>
            </div>
            <div v-else class="text-gray-500">
              最近 100 场未发现达到人数门槛的共同同队记录。
            </div>
            <div class="text-gray-500 mt-1">
              悬停组合标签可查看共同对局 ID 与判定门槛；依据历史同队出现推断，不代表接口提供了官方组队 ID。
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
          {{ analysisLoading ? "正在查询最近 100 场完整对局数据…" : "当前无法取得完整历史数据。" }}
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
  margin-top: 6px;
  overflow: hidden;
}

.team-panel :deep(.n-card__content) {
  height: 100%;
  min-height: 0;
  box-sizing: border-box;
  overflow-y: auto;
  overflow-x: hidden;
}

.team-panel-content {
  min-height: 100%;
}

.team-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
  min-width: 0;
}

.team-player {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 8px;
}

.team-player-avatar {
  display: flex;
  justify-content: center;
  min-height: 55px;
}

.team-player :deep(.n-avatar) {
  flex: 0 0 auto;
}

.team-player :deep(.n-tag) {
  max-width: 100%;
  overflow: hidden;
}

.match-history {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 6px;
}

.match-history-row {
  display: grid;
  grid-template-columns: 27px minmax(0, 1fr);
  align-items: center;
  min-width: 0;
  gap: 4px;
}

.match-kda {
  width: 100%;
  height: 27px;
  min-width: 0;
  justify-content: center;
  padding: 0 2px;
  font-size: 11px;
}

@media (max-width: 980px) {
  .team-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
</style>
