<script setup lang="ts">
import {ref, watch} from "vue";
import {NAvatar, NSpace, NTag, NList, NListItem, NPopover} from "naive-ui";
import {ThumbUp,ThumbDown} from "@vicons/tabler"
import useMatchStore from "@/queryMatch/store";

const curMatch = ref(0)
const matchStore = useMatchStore()

watch(() => matchStore.matchList,() => {
  curMatch.value = 0
})

const renderMatch = (index:number,gameId:number) => {
  curMatch.value = index
  matchStore.getMatchDetail(gameId)
}

/**
 * hover 时立即显示对局元信息，不需要展开抽屉拿新路由。
 * 完整开黑分析仍需要点击展开（依赖 SGP 拉取 10 人阵容）。
 */
const hoverSummary = (match: any) => {
    const kda = `${match.kills}/${match.deaths}/${match.assists}`;
    const kdaRatio =
        match.deaths === 0
            ? "完美"
            : ((match.kills + match.assists) / match.deaths).toFixed(2);
    return {
        kda,
        kdaRatio,
        gameModel: match.gameModel,
        startTime: match.startTime,
        isWin: match.isWin,
    };
};
</script>

<template>
  <div class="match-history-list">
    <n-list>
      <n-list-item v-for="(match,index) in matchStore.matchList" :key="match.gameId">
      <n-popover
        trigger="hover"
        placement="right-start"
        :show-arrow="false"
        :delay="200"
        style="padding: 8px 12px"
      >
        <template #trigger>
          <n-space @click="renderMatch(index,match.gameId)">
            <n-avatar
              :bordered="false"
              :size="42"
              :src="match.champImgUrl"
              fallback-src="https://wegame.gtimg.com/g.26-r.c2d3c/helper/lol/assis/images/resources/usericon/4027.png"
              style="display:block"
            />
            <n-space class="relative h-full" vertical :size="[0,0]">
              <div class="flex gap-x-3">
                <n-tag size="small" type="success" v-if="match.isWin"
                       style="width: 74px;justify-content: center"
                       :bordered="false">{{ match.kills }}-{{ match.deaths }}-{{ match.assists }}
                </n-tag>
                <n-tag size="small" type="error" v-else
                       style="width: 74px;justify-content: center"
                       :bordered="false">{{ match.kills }}-{{ match.deaths }}-{{ match.assists }}
                </n-tag>

                <n-tag size="small"
                       :type="index === curMatch?'warning':'default'"
                       :class="index === curMatch?'':' text-gray-400'" :bordered="false"
                       style="width: 46px;justify-content: center;cursor: default !important;">
                  <div class="flex items-center gap-x-1">
                    <N-icon size="14">
                      <ThumbUp v-if="match.kda>=9"/>
                      <ThumbDown v-else/>
                    </N-icon>
                    {{match.kda}}
                  </div>
                </n-tag>
              </div>
             <div class="match-history-meta flex justify-between absolute w-full" style="bottom: -3px">
               <div class="flex justify-between" style="width: 73px;">
                 <text class="text-xs text-gray-400">{{ match.matchTime }}</text>
                 <text class="text-xs text-gray-400">{{ match.startTime }}</text>
               </div>
               <text class="match-history-meta-game text-xs text-gray-400">{{ match.gameModel }}</text>
             </div>
            </n-space>
          </n-space>
        </template>
        <div class="match-hover-popover">
          <div class="flex items-center gap-x-2">
            <n-tag size="tiny" :type="hoverSummary(match).isWin ? 'success' : 'error'" :bordered="false">
              {{ hoverSummary(match).isWin ? '胜' : '败' }}
            </n-tag>
            <text class="font-medium">{{ hoverSummary(match).gameModel }}</text>
            <text class="text-xs text-gray-500">{{ hoverSummary(match).startTime }}</text>
          </div>
          <div class="text-sm mt-1">
            KDA <strong>{{ hoverSummary(match).kda }}</strong>
            <span class="text-xs text-gray-500 ml-1">({{ hoverSummary(match).kdaRatio }})</span>
          </div>
          <div class="text-xs text-gray-400 mt-1">
            点击展开开黑分析 →
          </div>
        </div>
      </n-popover>
      </n-list-item>
    </n-list>
  </div>
</template>

<style scoped>
.match-history-list {
  flex: 0 0 224px;
  width: 224px;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}

.match-history-meta,
.match-history-meta-game {
  white-space: nowrap;
}

.match-history-list :deep(.n-list-item) {
  width: 100%;
  padding: 8px 0;
  cursor: pointer;
}

.match-history-list :deep(.n-list-item__main) {
  min-width: 0;
}

.match-hover-popover {
  min-width: 180px;
  font-size: 12px;
}
</style>
