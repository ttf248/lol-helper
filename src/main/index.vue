<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue";
import { useRouter } from "vue-router";
import { window } from "@tauri-apps/api";
import { emitTo, listen } from "@tauri-apps/api/event";

const router = useRouter();
let stopCacheMatchList: (() => void) | null = null;

const showHistoryDashboard = () => {
  router.push({ name: "home" });
};

onMounted(async () => {
  showHistoryDashboard();
  stopCacheMatchList = await listen<string>("cacheMatchList", (event) => {
    if (event.payload !== "getMatchList") return;
    window.Window.getByLabel("recentMatchWindow").then((win) => {
      if (win !== null) {
        // 游戏内窗口自行走数据库缓存和 LCU 查询，不依赖旧的选英雄缓存。
        emitTo("recentMatchWindow", "matchListCache", {});
      }
    });
  });
});

onBeforeUnmount(() => {
  stopCacheMatchList?.();
});
</script>

<template>
  <router-view />
</template>
