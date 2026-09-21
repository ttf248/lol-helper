<script setup lang="ts">
import {
  NAvatar,
  NSpace,
  NTag,
  NSteps,
  NStep,
  NIcon,
  NProgress,
  NCollapse,
  NCollapseItem,
} from "naive-ui";
import { ref } from "vue";
import { Crown } from "@vicons/tabler";
import { RecentDataAnalysisTypes, RoleCountMapTypes } from "../utils/analysisTypes";
import { posRate } from "@/resources/otherList";
import { getChampionImageUrl } from "@/utils/championImage";

const { analysisData, pageType } = defineProps<{
  analysisData: RecentDataAnalysisTypes;
  pageType: number;
}>();

const roles = analysisData.roleCountMap;
const usedRole = Object.keys(roles).reduce((left, right) =>
  roles[left as keyof typeof roles] > roles[right as keyof typeof roles]
    ? left
    : right,
);
const width = pageType === 0 ? 55 : 45;
const proStyle = `width: ${width}px;font-size: 14px`;
const colorGreen = { color: "#18A058", bgColor: "rgba(24,160,88,0.2)" };
const colorBlue = { color: "#f0a020", bgColor: "rgba(240,160,32,0.2)" };
const expandedNames = ref<string[]>([]);

const getImg = (champId: number) => getChampionImageUrl(champId);

const getPercent = (value: number, total: number) =>
  total > 0 ? Math.round((value / total) * 100) : 0;

const getRoleRate = (key: string) =>
  getPercent(
    analysisData.roleCountMap[key as keyof RoleCountMapTypes],
    analysisData.totalChampions,
  );
</script>

<template>
  <div class="pl-0.5">
    <n-steps size="small" vertical>
      <n-step style="margin: 4px 0" title="近期使用英雄">
        <template #icon><n-icon><Crown /></n-icon></template>
        <n-space justify="space-between">
          <n-space vertical v-for="champ in analysisData.top3Champions" :key="champ.champId">
            <n-avatar style="display: block" :size="width" :src="getImg(champ.champId)" />
            <n-tag :bordered="false" size="small" class="text-sm" :style="{ width: `${width}px`, justifyContent: 'center' }">
              {{ champ.count }}/{{ analysisData.totalChampions }}
            </n-tag>
          </n-space>
        </n-space>
      </n-step>
      <n-collapse v-model:expanded-names="expandedNames" arrow-placement="right">
          <n-collapse-item name="positions">
            <template #header>
            <span>近期位置偏好</span>
          </template>
          <n-space :class="pageType === 1 ? 'pt-1' : ''" :size="pageType === 1 ? [12, 10] : [12, 8]" justify="space-between">
            <n-space vertical v-for="pos in posRate" :key="pos.key">
              <n-progress
                :style="proStyle"
                type="circle"
                :stroke-width="10"
                :percentage="getRoleRate(pos.key)"
                :color="usedRole !== pos.key ? colorGreen.color : colorBlue.color"
                :rail-color="usedRole !== pos.key ? colorGreen.bgColor : colorBlue.bgColor"
              />
              <n-tag :bordered="false" round :style="{ width: `${width}px`, height: '22px', padding: '0 12px' }">
                <template #avatar><n-avatar style="background-color: #ffffff00" :src="pos.imgUrl" /></template>
                <span v-if="pageType === 0" class="absolute" style="top: 7px; right: 5px">{{ pos.name }}</span>
              </n-tag>
            </n-space>
          </n-space>
        </n-collapse-item>
      </n-collapse>
    </n-steps>
  </div>
</template>
