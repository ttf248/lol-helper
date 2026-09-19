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
  <div class="h-full flex flex-col box-border">
    <div class="h-7 flex items-center justify-end pr-3 flex-shrink-0">
      <n-tag v-if="matchSourceLabel" size="small" type="info"
             :bordered="false" round style="white-space: nowrap;">
        数据源：{{ matchSourceLabel }}
      </n-tag>
    </div>
    <div class="flex flex-1 min-h-0 box-border">
      <match-list/>
      <div class="flex-grow p-3 ml-7"
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

