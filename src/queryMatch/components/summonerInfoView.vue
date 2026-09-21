<script setup lang="ts">
import {
  NAvatar,
  NCard,
  NProgress,
  NSpace,
  NTag,
  NEllipsis,
  NStep,
  NIcon,
  NSteps,
  NSkeleton
  ,NCollapse
  ,NCollapseItem
} from "naive-ui"
import { computed, ref, watch } from "vue";
import {summonerInfo} from "@/lcu/types/SummonerTypes";
import MatchAnalysis from "@/queryMatch/components/matchAnalysisSummary.vue";
import useMatchStore from "@/queryMatch/store";
import {Crown, Planet} from "@vicons/tabler";
import {
  getCachedPlayerSummary,
  getDatabaseStatus,
  getDatabaseSummary,
  type CachedPlayerSummary,
  type DatabaseSummary,
} from "@/recentMatch/utils/databaseCache";
import { MATCH_MODES, modeForQueue, modeLabel } from "@/recentMatch/utils/matchMode";

const {sumInfo} = defineProps<{
  sumInfo:{ info:summonerInfo }
}>()

const matchStore = useMatchStore()

const databaseStatus = ref({ available: false, message: "正在检查 PostgreSQL" });
const databaseSummary = ref<DatabaseSummary>({
  totalMatches: 0,
  totalParticipants: 0,
  totalPlayers: 0,
  modes: [],
});
const cachedPlayerSummary = ref<CachedPlayerSummary>({
  puuid: "",
  modeKey: "match",
  matches: 0,
  completeMatches: 0,
  wins: 0,
  latestGameCreation: null,
  sources: [],
});
const cacheLoading = ref(false);
const expandedCacheNames = ref<string[]>(["player-cache", "database-cache"]);
const cacheModeKey = computed(() =>
  modeForQueue(Number(matchStore.matchList?.[0]?.queueId || 0)),
);
const formatNumber = (value: number) => value.toLocaleString("zh-CN");
const formatRate = (value: number | null) =>
  value === null ? "--" : `${Math.round(value * 10) / 10}%`;
const formatCacheTime = (timestamp: number | null | undefined) => {
  if (!timestamp) return "暂无";
  const normalized = timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime())
    ? "时间未知"
    : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
};
const cachedPlayerWinRate = computed(() =>
  cachedPlayerSummary.value.matches > 0
    ? (cachedPlayerSummary.value.wins / cachedPlayerSummary.value.matches) * 100
    : null,
);
const cacheModeSummary = (modeKey: string) => {
  const mode = databaseSummary.value.modes.find((item) => item.modeKey === modeKey);
  return mode ? `${formatNumber(mode.matches)} 场 · ${formatNumber(mode.participants)} 人次` : "暂无缓存";
};

const loadCacheOverview = async () => {
  const puuid = sumInfo.info.puuid;
  if (!puuid) return;
  cacheLoading.value = true;
  try {
    const [status, summary, playerSummary] = await Promise.all([
      getDatabaseStatus(),
      getDatabaseSummary(),
      getCachedPlayerSummary(puuid, cacheModeKey.value),
    ]);
    databaseStatus.value = status;
    databaseSummary.value = summary;
    cachedPlayerSummary.value = playerSummary;
  } finally {
    cacheLoading.value = false;
  }
};

watch(
  () => [sumInfo.info.puuid, cacheModeKey.value],
  () => void loadCacheOverview(),
  { immediate: true },
);

</script>

<template>
  <div class="summoner-panel">
    <n-card size="small" class="profile-card shadow" content-style="padding-bottom:0">
      <!--    头像 昵称 等级-->
      <div class="h-14 flex gap-x-2">
        <n-avatar class="avatarEffect" round :bordered="false" :size="56"
                  :src="sumInfo.info.imgUrl"
                  fallback-src="https://wegame.gtimg.com/g.26-r.c2d3c/helper/lol/assis/images/resources/usericon/4027.png"
        />
        <n-space class="flex-grow" :size="[0,0]"
                 justify="space-between" vertical>
          <div class="flex justify-between">
            <!--昵称-->
            <n-tag class="w-full justify-center" style="width: 164px;" type="success" :bordered="false" round>
              <n-ellipsis style="max-width: 140px">
                {{ sumInfo.info.name }}
              </n-ellipsis>
            </n-tag>
          </div>

          <div class="flex justify-between gap-x-3">
            <div class="flex-grow"
                 style="background-color: rgba(240, 160, 32, 0.15);
               padding: 0 7px; color: #f0a020; font-size: 12px;
               border-radius: 12px">
              <div class="flex justify-between items-center gap-x-2">
                <n-progress
                  type="line"
                  :show-indicator="false"
                  :percentage="sumInfo.info.xp"
                  status="warning"
                  processing

                  :height="10"
                />
                <div style="padding-top: 1px;">
                  <n-ellipsis style="max-width: 40px">
                    {{ sumInfo.info.lv }}
                  </n-ellipsis>
                </div>
              </div>
            </div>
          </div>
        </n-space>
      </div>
      <!--    头像 昵称 等级-->

    </n-card>
    <n-card size="small" class="profile-analysis-card shadow" content-style="padding-top:10px">
      <!--      战绩分析加载页面-->
      <div class="pl-0.5" v-if="matchStore.matchLoading">
        <n-steps size="small" vertical>
          <n-step
            style="margin: 4px 0"
            title="近期使用英雄">
            <template #icon>
              <n-icon>
                <Crown/>
              </n-icon>
            </template>
            <n-space justify="space-between">
              <n-space vertical :size="[0,2.5]" v-for="index in 3" :key="index">
                <n-skeleton height="45px" width="45px" :sharp="false"/>
                <n-tag :bordered="false" size="small" class="text-sm"
                       style="width: 45px;justify-content: center">
                </n-tag>
              </n-space>
            </n-space>
          </n-step>
          <n-step
            style="margin: 0"
            title="近期活跃程度">
            <template #icon>
              <n-icon>
                <Planet/>
              </n-icon>
            </template>
            <n-space class="pt-1" :size="[12,16]" justify="space-between">
              <n-space :size="[0,3]" vertical v-for="index in 6" :key="index">
                <n-skeleton height="45px" circle/>
                <n-tag :bordered="false" round
                       style="width: 45px;height:22px;padding: 0 12px">
                  <text class="absolute" style="top: 7px;right: 5px"></text>
                </n-tag>
              </n-space>
            </n-space>
          </n-step>
        </n-steps>
      </div>
      <!--      战绩分析加载页面-->
      <match-analysis
        v-if="matchStore.analysisData && !matchStore.matchLoading"
        :analysis-data="matchStore.analysisData"
        :pageType="1"
      />
      <div v-if="!matchStore.matchLoading" class="cache-overview-stack">
        <n-collapse v-model:expanded-names="expandedCacheNames" arrow-placement="right">
          <n-collapse-item name="player-cache">
            <template #header>本玩家缓存派生总览</template>
            <div class="cache-overview">
              <span>{{ modeLabel(cacheModeKey) }} {{ formatNumber(cachedPlayerSummary.matches) }} 场</span>
              <span>完整 {{ formatNumber(cachedPlayerSummary.completeMatches) }} 场</span>
              <span>胜率 {{ formatRate(cachedPlayerWinRate) }}</span>
            </div>
            <div class="cache-note">
              最新缓存：{{ formatCacheTime(cachedPlayerSummary.latestGameCreation) }} ·
              {{ cacheLoading ? "正在查询数据库" : "按 gameId 去重后的本地派生结果" }}
            </div>
          </n-collapse-item>
          <n-collapse-item name="database-cache">
            <template #header>本地缓存总览</template>
            <div class="cache-overview">
              <span>对局 {{ formatNumber(databaseSummary.totalMatches) }}</span>
              <span>参赛记录 {{ formatNumber(databaseSummary.totalParticipants) }}</span>
              <span>玩家 {{ formatNumber(databaseSummary.totalPlayers) }}</span>
            </div>
            <div class="cache-mode-list">
              <div v-for="mode in MATCH_MODES" :key="mode.key" class="cache-mode-row">
                <span>{{ mode.label }}</span><span>{{ cacheModeSummary(mode.key) }}</span>
              </div>
            </div>
            <div class="cache-note">{{ databaseStatus.message }}</div>
          </n-collapse-item>
        </n-collapse>
      </div>
    </n-card>
  </div>
</template>

<style scoped>
.summoner-panel {
  display: flex;
  flex: 0 0 254px;
  flex-direction: column;
  width: 254px;
  min-height: 0;
  gap: 12px;
}

.profile-card,
.profile-analysis-card {
  flex-shrink: 0;
  margin: 0;
}

.profile-analysis-card {
  flex: 1 1 auto;
  min-height: 0;
}

.profile-analysis-card :deep(.n-card__content) {
  height: 100%;
  min-height: 0;
  box-sizing: border-box;
  overflow-y: auto;
}

.cache-overview-stack {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  margin-top: 0.6rem;
}

.cache-overview,
.cache-mode-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.35rem;
  font-size: 0.68rem;
}

.cache-mode-list {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin-top: 0.4rem;
}

.cache-note {
  margin-top: 0.35rem;
  color: #888;
  font-size: 0.62rem;
  line-height: 1.4;
}
</style>


