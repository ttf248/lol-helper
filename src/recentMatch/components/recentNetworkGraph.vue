<script setup lang="ts">
import { computed } from "vue";
import { NTag } from "naive-ui";
import {
  RecentNetworkAnalysis,
  RecentNetworkEdge,
  RecentNetworkNode,
} from "@/recentMatch/utils/queryTypes";

const { analysis, onNodeClick } = defineProps<{
  analysis: RecentNetworkAnalysis | null;
  /** 节点点击回调；不传则节点不可点击。 */
  onNodeClick?: (node: RecentNetworkNode) => void;
}>();

const nodePositions = computed(() => {
  const result = new Map<string, { x: number; y: number }>();
  for (const node of analysis?.nodes || []) {
    result.set(node.puuid, {
      x: 90 + node.teamIndex * 220,
      y: node.team === "friend" ? 48 : 188,
    });
  }
  return result;
});

const positionOf = (puuid: string) =>
  nodePositions.value.get(puuid) || { x: 0, y: 0 };

const nodeOf = (puuid: string): RecentNetworkNode | undefined =>
  analysis?.nodes.find((node) => node.puuid === puuid);

const edgeColor = (edge: RecentNetworkEdge) => {
  if (edge.sameTeamGames > edge.opposedGames) return "#18a058";
  if (edge.opposedGames > edge.sameTeamGames) return "#d03050";
  return "#909399";
};

const edgeWidth = (edge: RecentNetworkEdge) =>
  Math.min(6, 1 + edge.sharedGames / 4);

const sortedEdges = computed(() =>
  [...(analysis?.edges || [])].sort(
    (left, right) => right.sharedGames - left.sharedGames,
  ),
);

const displayName = (name: string) =>
  name.length > 8 ? `${name.slice(0, 8)}…` : name;

const edgeDescription = (edge: RecentNetworkEdge) => {
  const source = nodeOf(edge.source)?.summonerName || "玩家";
  const target = nodeOf(edge.target)?.summonerName || "玩家";
  if (edge.sameTeamGames >= edge.opposedGames) {
    return `${source} + ${target}：同队 ${edge.sameTeamGames} 场`;
  }
  return `${source} ↔ ${target}：对手 ${edge.opposedGames} 场`;
};
</script>

<template>
  <div class="text-xs">
    <div class="flex items-center justify-between mb-2">
      <div class="font-medium">历史对局关系图</div>
      <div class="text-gray-500">
        覆盖 {{ analysis?.availableGames || 0 }} 个去重对局
      </div>
    </div>

    <div v-if="analysis && analysis.nodes.length" class="rounded border border-gray-200 dark:border-gray-700 p-2">
      <svg viewBox="0 0 1050 240" width="100%" height="240" role="img" aria-label="历史对局关系图">
        <line
          v-for="edge in sortedEdges"
          :key="`${edge.source}-${edge.target}`"
          :x1="positionOf(edge.source).x"
          :y1="positionOf(edge.source).y"
          :x2="positionOf(edge.target).x"
          :y2="positionOf(edge.target).y"
          :stroke="edgeColor(edge)"
          :stroke-width="edgeWidth(edge)"
          stroke-linecap="round"
          opacity="0.42"
        />
        <g
          v-for="node in analysis.nodes"
          :key="node.puuid"
          :class="{ 'cursor-pointer': !!onNodeClick }"
          @click="onNodeClick?.(node)"
        >
          <circle
            :cx="positionOf(node.puuid).x"
            :cy="positionOf(node.puuid).y"
            r="18"
            :fill="node.team === 'friend' ? '#2080f0' : '#d03050'"
            opacity="0.9"
          />
          <text
            :x="positionOf(node.puuid).x"
            :y="positionOf(node.puuid).y + 4"
            text-anchor="middle"
            fill="white"
            font-size="10"
            pointer-events="none"
          >
            {{ node.teamIndex + 1 }}
          </text>
          <text
            :x="positionOf(node.puuid).x"
            :y="positionOf(node.puuid).y + (node.team === 'friend' ? -28 : 36)"
            text-anchor="middle"
            fill="currentColor"
            font-size="11"
            pointer-events="none"
          >
            {{ displayName(node.summonerName) }}
          </text>
        </g>
        <text x="8" y="18" fill="#2080f0" font-size="11">友方</text>
        <text x="8" y="232" fill="#d03050" font-size="11">敌方</text>
      </svg>

      <div class="flex gap-3 text-gray-500 mb-2">
        <span><i class="inline-block w-2 h-2 rounded-full bg-green-500 mr-1" />历史同队</span>
        <span><i class="inline-block w-2 h-2 rounded-full bg-red-500 mr-1" />历史对手</span>
        <span>线条越粗代表共同对局越多</span>
      </div>

      <div v-if="sortedEdges.length" class="grid grid-cols-2 gap-x-3 gap-y-1">
        <div v-for="edge in sortedEdges.slice(0, 12)" :key="`detail-${edge.source}-${edge.target}`" class="flex justify-between">
          <span class="truncate mr-2">{{ edgeDescription(edge) }}</span>
          <span class="whitespace-nowrap">{{ edge.sharedGames }}场</span>
        </div>
      </div>
      <div v-else class="text-gray-500 text-center py-3">暂无足够的共同历史对局。</div>
    </div>
    <div v-else class="text-gray-500 text-center py-6">
      历史关系数据尚未完成。
    </div>

    <div class="flex gap-2 mt-2">
      <n-tag size="small" :bordered="false" type="info">同队关系仅为历史同队推断</n-tag>
      <n-tag size="small" :bordered="false" type="warning">不等同于官方组队 ID</n-tag>
    </div>
  </div>
</template>
