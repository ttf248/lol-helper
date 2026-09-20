<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from "vue";
import { NButton, NIcon, NProgress } from "naive-ui";
import { AlertTriangle, AlertCircle, X } from "@vicons/tabler";
import useMatchStore from "@/queryMatch/store";
import type { HistoryCacheSyncStatus } from "@/recentMatch/utils/queryTypes";

const matchStore = useMatchStore();

// cancelled 行不进显示；complete / limited / error 由定时器或
// 用户手动关闭后移除。
const visibleRows = computed(() =>
  matchStore.historySyncStripRows.filter((row) => row.kind !== "cancelled"),
);

// 数组按 push 顺序追加（store 里 push 时机见 syncCurrentUserHistory），
// 反转后最新同步显示在顶部。
const orderedRows = computed(() => [...visibleRows.value].reverse());
const hasRows = computed(() => orderedRows.value.length > 0);

const AUTO_DISMISS_MS = 4000;

const statusFor = (row: HistoryCacheSyncStatus) => {
  switch (row.kind) {
    case "syncing":
      return "info" as const;
    case "complete":
      return "success" as const;
    case "limited":
      return "warning" as const;
    case "error":
      return "error" as const;
    default:
      return "default" as const;
  }
};

const percentageFor = (row: HistoryCacheSyncStatus): number => {
  if (row.kind === "complete") return 100;
  const denom = row.totalPages ?? row.maxPages;
  if (!denom || denom <= 0) return 0;
  return Math.min(100, Math.round((row.currentPage / denom) * 100));
};

const messageFor = (row: HistoryCacheSyncStatus): string => {
  if (row.kind === "complete") return row.message || "已缓存最近 500 场";
  if (row.kind === "limited") return row.message || "已缓存最近 500 场";
  if (row.kind === "error") return row.message || "同步未完成";
  if (row.totalPages) return `历史缓存 ${row.currentPage}/${row.totalPages} 页`;
  if (row.maxPages > 0) return `历史缓存 ${row.currentPage}/${row.maxPages} 页`;
  return `历史缓存第 ${row.currentPage} 页`;
};

const canClose = (row: HistoryCacheSyncStatus) =>
  row.kind === "limited" || row.kind === "error";

const iconFor = (row: HistoryCacheSyncStatus) => {
  if (row.kind === "limited") return AlertTriangle;
  if (row.kind === "error") return AlertCircle;
  return null;
};

// 行从 syncing/limited/error 转到 complete 时启动 4s 自动消失定时器。
// 用 rowId 关联，避免数组下标变化时绑错行。
const timers = new Map<number, number>();

watch(
  () =>
    matchStore.historySyncStripRows.map((row) => ({
      rowId: row.rowId,
      kind: row.kind,
    })),
  (current, previous) => {
    const prevMap = new Map(
      (previous ?? []).map((item) => [item.rowId, item.kind]),
    );
    for (const item of current) {
      if (
        item.kind === "complete" &&
        prevMap.get(item.rowId) !== "complete" &&
        item.rowId !== undefined &&
        !timers.has(item.rowId)
      ) {
        const id = window.setTimeout(() => {
          if (item.rowId !== undefined) {
            matchStore.dismissHistorySyncStripRow(item.rowId);
            timers.delete(item.rowId);
          }
        }, AUTO_DISMISS_MS);
        timers.set(item.rowId, id);
      }
    }
  },
  { deep: true },
);

onBeforeUnmount(() => {
  timers.forEach((id) => window.clearTimeout(id));
  timers.clear();
});
</script>

<template>
  <Transition name="strip-slide">
    <div v-if="hasRows" class="history-sync-strip">
      <div
        v-for="row in orderedRows"
        :key="row.rowId"
        class="history-sync-strip__row"
        :class="`history-sync-strip__row--${row.kind}`"
      >
        <div class="history-sync-strip__label">
          <n-icon
            v-if="iconFor(row)"
            :component="iconFor(row)!"
            :size="14"
            class="history-sync-strip__icon"
          />
          <span class="history-sync-strip__name">
            {{ row.summonerName || "未知玩家" }}
          </span>
          <span class="history-sync-strip__sep">·</span>
          <span class="history-sync-strip__message">{{ messageFor(row) }}</span>
        </div>
        <n-progress
          class="history-sync-strip__progress"
          type="line"
          :percentage="percentageFor(row)"
          :status="statusFor(row)"
          :show-indicator="false"
          :height="4"
          :border-radius="2"
        />
        <n-button
          v-if="canClose(row) && row.rowId !== undefined"
          size="tiny"
          quaternary
          circle
          @click="matchStore.dismissHistorySyncStripRow(row.rowId)"
        >
          <template #icon>
            <n-icon :component="X" :size="12" />
          </template>
        </n-button>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.history-sync-strip {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 12px 5px;
  background: rgba(255, 255, 255, 0.92);
  backdrop-filter: blur(8px);
  border-top: 1px solid rgba(128, 128, 128, 0.18);
  pointer-events: auto;
}

:global(.dark) .history-sync-strip {
  background: rgba(24, 24, 28, 0.92);
  border-top-color: rgba(255, 255, 255, 0.1);
}

.history-sync-strip__row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 22px;
  padding: 1px 6px;
  border-radius: 4px;
}

.history-sync-strip__row--complete {
  background: rgba(24, 160, 88, 0.06);
}

.history-sync-strip__row--limited {
  background: rgba(240, 160, 32, 0.08);
}

.history-sync-strip__row--error {
  background: rgba(208, 48, 80, 0.08);
}

.history-sync-strip__label {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 220px;
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  flex: 0 0 auto;
}

.history-sync-strip__icon {
  flex: 0 0 auto;
}

.history-sync-strip__name {
  font-weight: 600;
  color: var(--n-text-color);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-sync-strip__sep {
  color: rgba(128, 128, 128, 0.5);
}

.history-sync-strip__message {
  color: rgba(128, 128, 128, 0.85);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-sync-strip__progress {
  flex: 1 1 auto;
  min-width: 0;
}

.strip-slide-enter-active,
.strip-slide-leave-active {
  transition: transform 240ms ease, opacity 240ms ease;
}

.strip-slide-enter-from,
.strip-slide-leave-to {
  transform: translateY(110%);
  opacity: 0;
}
</style>
