<script setup lang="ts">
import MatchList from "./matchList.vue";
import MatchContent from "../common/matchContent.vue";
import useMatchStore from "@/queryMatch/store";
import {computed} from "vue";
import {NResult, NTag} from "naive-ui";
import LoadingAnime from "@/queryMatch/components/loadingAnime.vue";
import {MATCH_HISTORY_SOURCE_LABELS} from "@/lcu/aboutMatch";

const matchStore = useMatchStore()
const matchSourceLabel = computed(() => {
  const source = matchStore.matchSource
  return source === null ? null : MATCH_HISTORY_SOURCE_LABELS[source]
})
const searchSum = (summonerId: number) => {
  matchStore.init(summonerId)
}
</script>

<template>
  <div class="match-main">
    <div class="match-source-bar">
      <n-tag v-if="matchSourceLabel" size="small" type="info"
             :bordered="false" round style="white-space: nowrap;">
        数据源：{{ matchSourceLabel }}
      </n-tag>
    </div>
    <div class="match-main-body">
      <match-list/>
      <div class="match-detail-pane"
           :key="matchStore.participantsInfo?.gameId ?? 'match-detail-loading'"
           v-if="matchStore.participantsInfo !== null">
        <match-content
          :header-info="matchStore.participantsInfo.headerInfo"
          :team-one="matchStore.participantsInfo.teamOne"
          :team-two="matchStore.participantsInfo.teamTwo"
          :queue-id="matchStore.participantsInfo.queueId"
          :summoner-id="matchStore.summonerId"
          :is-game-in="false"
          :game-id="matchStore.participantsInfo.gameId"
          @change-sum="searchSum"
        />
      </div>
      <div class="w-full h-full flex justify-center items-center"
           v-else-if="matchStore.detailLoading">
        <loading-anime />
      </div>
      <div class="w-full h-full flex justify-center items-center"
           v-else-if="!matchStore.matchLoading&&matchStore.participantsInfo===null">
        <n-result
          size="large"
          status="418"
          title="获取当前战绩数据异常"
          :description="matchStore.matchError || '请在左侧切换其它战绩，尝试再次获取数据。'"
        >
        </n-result>
      </div>
    </div>
  </div>
</template>

<style scoped>
.match-main {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.match-source-bar {
  display: flex;
  flex: 0 0 28px;
  align-items: center;
  justify-content: flex-end;
  padding-right: 12px;
}

.match-main-body {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  gap: 12px;
}

.match-detail-pane {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  padding: 12px;
}
</style>

