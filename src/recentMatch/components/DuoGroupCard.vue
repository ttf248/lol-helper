<script setup lang="ts">
import { NPopover, NTag } from "naive-ui";
import { computed } from "vue";
import type { PartyGroupAnalysis, PartyMember } from "@/recentMatch/utils/queryTypes";
import {
  confidenceLabel,
  formatRate,
  lastActiveLabel,
  partyGroupNames,
  partyEvidenceTime,
  winRateTagType,
} from "@/recentMatch/utils/partyDisplay";

const props = withDefaults(
  defineProps<{
    group: PartyGroupAnalysis;
    mode?: "compact" | "inline" | "full";
    selfPuuid?: string;
    index?: number;
    expanded?: boolean;
    /** 弹窗默认开启，仅 Surface C 用作内联证据 */
    alwaysShowEvidence?: boolean;
  }>(),
  {
    mode: "compact",
    selfPuuid: undefined,
    index: undefined,
    expanded: false,
    alwaysShowEvidence: false,
  },
);

defineEmits<{
  (e: "click", group: PartyGroupAnalysis): void;
  (e: "summoner-click", member: PartyMember): void;
}>();

const names = computed(() => partyGroupNames(props.group, props.selfPuuid));
const isCompact = computed(() => props.mode === "compact");
const isInline = computed(() => props.mode === "inline");
const showRank = computed(
  () => props.mode === "full" && props.index !== undefined,
);
const tagType = computed(() =>
  props.group.highWinRateAlert
    ? "warning"
    : winRateTagType(props.group.winRate),
);
const headerTagText = computed(() =>
  props.group.highWinRateAlert ? "高胜率开黑" : "疑似开黑",
);
</script>

<template>
  <div
    class="duo-card"
    :class="{
      'duo-card-compact': isCompact,
      'duo-card-inline': isInline,
      'duo-card-full': mode === 'full',
      'duo-card-expanded': expanded,
    }"
  >
    <!-- 左侧排名圆圈（home 历史分析用） -->
    <span v-if="showRank" class="duo-card-rank">{{ index }}</span>

    <div class="duo-card-main">
      <!-- 顶部标签行：状态 pill + 高胜率提示 -->
      <div class="duo-card-top">
        <n-tag size="tiny" :type="tagType" :bordered="false">
          {{ headerTagText }}
        </n-tag>
        <n-tag
          v-if="group.blacklistedMembers.length"
          size="tiny"
          type="error"
          :bordered="false"
        >
          含黑名单
        </n-tag>
        <n-tag
          v-if="group.reportedMembers.length"
          size="tiny"
          type="info"
          :bordered="false"
        >
          含举报
        </n-tag>
      </div>

      <!-- 主体：成员名 + 数字行 -->
      <div class="duo-card-body">
        <div class="duo-card-names" :title="names">
          <template v-for="(member, idx) in group.members" :key="member.puuid">
            <button
              v-if="!(selfPuuid && member.puuid === selfPuuid)"
              type="button"
              class="duo-name-chip"
              :title="member.summonerName"
              @click.stop="$emit('summoner-click', member)"
            >{{ member.summonerName?.trim() || "未知玩家" }}</button>
            <span v-else class="duo-name-self">我</span>
            <span v-if="idx < group.members.length - 1" class="duo-name-sep">
              +
            </span>
          </template>
        </div>
        <div class="duo-card-metric-row">
          <span class="duo-card-metric duo-card-metric-primary">
            {{ formatRate(group.winRate) }}
          </span>
          <span class="duo-card-metric-sep">·</span>
          <span class="duo-card-metric">{{ group.games }}场</span>
          <span v-if="mode !== 'compact'" class="duo-card-metric-sep">·</span>
          <span v-if="mode !== 'compact'" class="duo-card-metric">
            稳定度{{ group.stabilityScore }}
          </span>
        </div>
        <div v-if="mode === 'full'" class="duo-card-submetric-row">
          <template v-if="group.recentWindowGames !== undefined">
            最近5局同队 {{ group.recentWindowGames }} 次（含当前） · 历史共同
            {{ group.historicalGames || 0 }} 场 ·
          </template>
          <template v-else>近30天 {{ group.recentGames }} 场 ·</template>
          最近 {{ lastActiveLabel(group) }} · 置信度 {{ confidenceLabel(group.confidence) }}
        </div>
      </div>
    </div>

    <!-- 证据区：compact/inline 走 popover；full 时若 alwaysShowEvidence 直接渲染 -->
    <template v-if="alwaysShowEvidence">
      <div class="duo-card-evidence">
        <slot name="evidence" :group="group">
          <div class="duo-card-evidence-inner text-xs leading-5">
            <div class="font-medium mb-1">为什么标记为“疑似开黑”</div>
            <div class="font-medium">{{ names }}</div>
            <div>
              <template v-if="group.recentWindowGames !== undefined">
                最近5局同队 {{ group.recentWindowGames }} 次（含当前） · 历史共同
                {{ group.historicalGames || 0 }} 场
              </template>
              <template v-else>
                共同同队 {{ group.games }} 场 · 近30天 {{ group.recentGames }} 场
              </template>
            </div>
            <div v-if="group.evidence.length" class="text-gray-500 mt-1">
              <div
                v-for="evidence in group.evidence.slice(0, 6)"
                :key="evidence.gameId"
              >
                {{ evidence.isCurrentMatch ? "当前对局" : partyEvidenceTime(evidence.gameCreation) }} · 对局
                {{ evidence.isCurrentMatch ? "本局" : evidence.gameId }}
              </div>
            </div>
          </div>
        </slot>
      </div>
    </template>
    <n-popover
      v-else
      trigger="hover"
      placement="top-start"
      style="max-width: 380px"
    >
      <template #trigger>
        <button
          type="button"
          class="duo-card-trigger"
          :aria-label="`开黑组合 ${names}`"
          @click.stop="
            $emit('click', group);
          "
        >
          <span class="sr-only">查看开黑组合详情</span>
        </button>
      </template>
      <slot name="evidence" :group="group">
        <div class="duo-card-evidence-inner text-xs leading-5">
          <div class="font-medium mb-1">为什么标记为“疑似开黑”</div>
          <div class="font-medium">{{ names }}</div>
          <div>
            <template v-if="group.recentWindowGames !== undefined">
              最近5局同队 {{ group.recentWindowGames }} 次（含当前） · 历史共同
              {{ group.historicalGames || 0 }} 场 ·
            </template>
            <template v-else>近30天 {{ group.recentGames }} 场 ·</template>
            胜率
            {{ formatRate(group.winRate) }}
          </div>
          <div
            v-for="evidence in group.evidence.slice(0, 3)"
            :key="evidence.gameId"
            class="text-gray-500"
          >
            证据 {{ evidence.isCurrentMatch ? "当前对局" : partyEvidenceTime(evidence.gameCreation) }} · 对局
            {{ evidence.isCurrentMatch ? "本局" : evidence.gameId }}
          </div>
          <div class="text-gray-500 mt-1">
            先按当前对局加最近4场做同队初筛，再取通过初筛的组合的历史 gameId 交集并确认 teamId。
          </div>
        </div>
      </slot>
    </n-popover>
  </div>
</template>

<style scoped>
.duo-card {
  position: relative;
  display: flex;
  align-items: stretch;
  gap: 6px;
  min-width: 0;
  border: 1px solid rgba(16, 185, 129, 0.16);
  border-radius: 6px;
  background: rgba(236, 253, 245, 0.78);
  color: #374151;
  font-size: 11px;
  line-height: 1.3;
  padding: 5px 7px;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.duo-card:hover {
  border-color: rgba(16, 185, 129, 0.35);
}

.duo-card-expanded {
  border-color: rgba(24, 160, 88, 0.55);
  box-shadow: 0 0 0 1px rgba(24, 160, 88, 0.25);
}

.duo-card-main {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.duo-card-top {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
}

.duo-card-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.duo-card-names {
  font-weight: 600;
  color: #111827;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  display: inline-flex;
  align-items: baseline;
  gap: 2px;
}

/* 单个名字的 chip：保留 inline 风格，不破坏现有拼接外观，
   但用 button 以获得键盘可达性，并通过 .stop 阻止冒泡到整卡
   compact 模式下透明 overlay 的 click 事件。 */
.duo-name-chip {
  background: transparent;
  border: 0;
  padding: 0;
  margin: 0;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.duo-name-chip:hover,
.duo-name-chip:focus-visible {
  color: #047857;
  text-decoration: underline dotted;
  outline: none;
}

.duo-name-self {
  color: #6b7280;
}

.duo-name-sep {
  color: #9ca3af;
  font-weight: 500;
  padding: 0 1px;
}

.duo-card-metric-row {
  display: flex;
  align-items: baseline;
  gap: 3px;
  min-width: 0;
  flex-wrap: wrap;
}

.duo-card-metric {
  color: #4b5563;
}

.duo-card-metric-primary {
  font-weight: 700;
  font-size: 12px;
  color: #111827;
}

.duo-card-metric-sep {
  color: #9ca3af;
}

.duo-card-submetric-row {
  color: #6b7280;
  font-size: 10px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.duo-card-rank {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 1.25rem;
  width: 1.25rem;
  height: 1.25rem;
  border-radius: 999px;
  background: rgba(128, 128, 128, 0.16);
  color: #4b5563;
  font-size: 0.7rem;
  font-weight: 600;
  margin-top: 1px;
}

/* compact：约 56px 高，适配 190px 列宽 */
.duo-card-compact {
  padding: 4px 6px;
  flex-direction: column;
  align-items: stretch;
}

.duo-card-compact .duo-card-trigger {
  position: absolute;
  inset: 0;
  background: transparent;
  border: 0;
  cursor: pointer;
  padding: 0;
  z-index: 1;
}

/* inline：横排 pill，受父容器 max-width 限制 */
.duo-card-inline {
  flex-direction: row;
  align-items: center;
  flex-wrap: wrap;
  padding: 3px 6px;
  gap: 4px;
}

.duo-card-inline .duo-card-top {
  flex: 0 0 auto;
}

.duo-card-inline .duo-card-body {
  flex: 1 1 0;
  flex-direction: row;
  align-items: baseline;
  gap: 4px;
  min-width: 0;
}

.duo-card-inline .duo-card-names {
  flex: 1 1 0;
  min-width: 0;
}

.duo-card-inline .duo-card-submetric-row {
  display: none;
}

/* full：纵向铺开证据区 */
.duo-card-full {
  padding: 6px 8px;
  flex-direction: row;
  align-items: flex-start;
}

.duo-card-full .duo-card-main {
  flex: 1 1 auto;
}

.duo-card-evidence {
  width: 100%;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed rgba(16, 185, 129, 0.18);
  color: #4b5563;
}

.duo-card-evidence-inner {
  color: #4b5563;
}

.duo-card-trigger {
  display: none;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

:global(.dark) .duo-card {
  background: rgba(6, 78, 59, 0.25);
  border-color: rgba(16, 185, 129, 0.28);
  color: #d1fae5;
}

:global(.dark) .duo-card-names,
:global(.dark) .duo-card-metric-primary {
  color: #ecfdf5;
}

:global(.dark) .duo-name-chip:hover,
:global(.dark) .duo-name-chip:focus-visible {
  color: #6ee7b7;
}

:global(.dark) .duo-name-self {
  color: #a7f3d0;
}

:global(.dark) .duo-name-sep {
  color: #6ee7b7;
}

:global(.dark) .duo-card-metric {
  color: #a7f3d0;
}

:global(.dark) .duo-card-submetric-row {
  color: #6ee7b7;
}

:global(.dark) .duo-card-rank {
  background: rgba(110, 231, 183, 0.18);
  color: #a7f3d0;
}
</style>
