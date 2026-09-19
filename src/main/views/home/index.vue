<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import {
  NAvatar,
  NButton,
  NCard,
  NDivider,
  NEllipsis,
  NProgress,
  NResult,
  NSpace,
  NTag,
} from "naive-ui";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { querySummonerInfo } from "@/lcu/aboutSummoner";
import { TencentRsoPlatformId } from "@/resources/areaList";
import { QueryMatchWindow } from "@/background/utils/creatWindow";
import type { summonerInfo } from "@/lcu/types/SummonerTypes";

const fallbackAvatar =
  "https://wegame.gtimg.com/g.26-r.c2d3c/helper/lol/assis/images/resources/usericon/4027.png";

const currentPlayer = ref<summonerInfo | null>(null);
const loading = ref(true);
const errorMessage = ref("");
let requestId = 0;
let stopInitHome: (() => void) | null = null;

const readStoredSumInfo = (): Record<string, string | number> => {
  try {
    return JSON.parse(localStorage.getItem("sumInfo") || "{}") as Record<
      string,
      string | number
    >;
  } catch {
    return {};
  }
};

const saveCurrentPlayer = async (info: summonerInfo) => {
  const previous = readStoredSumInfo();
  const write = (region: string) => {
    const newPlatformId = region || String(previous.newPlatformId || "");
    const platformId =
      TencentRsoPlatformId[newPlatformId] ||
      String(previous.platformId || newPlatformId);

    localStorage.setItem(
      "sumInfo",
      JSON.stringify({
        name: info.name,
        summonerId: info.currentId,
        puuid: info.puuid,
        platformId,
        newPlatformId,
      }),
    );
  };

  // 先写入不依赖大区接口的基础身份，查询窗口可以立即复用当前玩家。
  write("");
  let region = "";
  try {
    region = await invoke<string>("get_lol_region");
  } catch {
    // 读取大区不是展示当前玩家的必要条件；没有大区时沿用上次缓存。
  }

  if (region) write(region);
};

const loadCurrentPlayer = async () => {
  const currentRequest = ++requestId;
  loading.value = true;
  errorMessage.value = "";

  try {
    const info = await querySummonerInfo();
    if (currentRequest !== requestId) return;

    if (info === null) {
      currentPlayer.value = null;
      errorMessage.value =
        "未读取到当前登录玩家，请先确认 League 客户端已登录。";
      return;
    }

    // 先更新界面，再写入跨窗口共用的 sumInfo，避免大区接口阻塞主面板。
    currentPlayer.value = info;
    loading.value = false;
    await saveCurrentPlayer(info);
  } catch (error) {
    if (currentRequest !== requestId) return;
    currentPlayer.value = null;
    errorMessage.value = `当前玩家读取失败：${String(error)}`;
  } finally {
    if (currentRequest === requestId) loading.value = false;
  }
};

const openMatchWindow = () => {
  new QueryMatchWindow();
};

onMounted(async () => {
  stopInitHome = await listen("initHome", () => {
    void loadCurrentPlayer();
  });
  await loadCurrentPlayer();
});

onBeforeUnmount(() => {
  stopInitHome?.();
});
</script>

<template>
  <div v-if="currentPlayer" class="mainContent">
    <n-card size="small" class="shadow" content-style="padding-bottom: 0">
      <div class="h-14 flex gap-x-2">
        <n-avatar
          class="avatarEffect"
          round
          :bordered="false"
          :size="56"
          :src="currentPlayer.imgUrl"
          :fallback-src="fallbackAvatar"
        />
        <n-space
          class="flex-grow"
          :size="[0, 0]"
          justify="space-between"
          vertical
        >
          <div class="flex justify-between">
            <n-tag
              type="success"
              style="width: 130px; justify-content: center"
              :bordered="false"
              round
            >
              <n-ellipsis style="max-width: 110px" :tooltip="false">
                {{ currentPlayer.name }}
              </n-ellipsis>
            </n-tag>
            <n-button
              class="px-2"
              :bordered="false"
              type="success"
              size="small"
              round
              @click="openMatchWindow"
            >
              我的战绩
            </n-button>
          </div>
          <div class="flex justify-between gap-x-3">
            <n-tag type="warning" size="small" round :bordered="false">
              {{ currentPlayer.lv }}
            </n-tag>
            <div
              class="flex-grow"
              style="
                background-color: rgba(240, 160, 32, 0.15);
                padding: 0 7px;
                color: #f0a020;
                font-size: 12px;
                border-radius: 12px;
              "
            >
              <div class="flex justify-between items-center">
                <n-progress
                  type="line"
                  :show-indicator="false"
                  :percentage="currentPlayer.xp"
                  status="warning"
                  processing
                  style="width: 100px; margin-top: 1.2px"
                  :height="10"
                />
                <div style="padding-top: 2px">{{ currentPlayer.xp }} %</div>
              </div>
            </div>
          </div>
        </n-space>
      </div>

      <n-divider dashed style="margin: 14px 0 2px 0" />

      <div class="py-3 text-xs text-gray-500">
        个人资料已同步，历史战绩、趋势和关系分析都在“我的战绩”中查看。
      </div>
    </n-card>

    <n-card
      size="small"
      class="shadow"
      style="height: 402px"
      content-style="padding-top: 10px"
    >
      <div class="flex items-center justify-between mb-3">
        <div class="font-medium">战绩查询</div>
        <n-tag size="small" type="success" :bordered="false">数据分析中心</n-tag>
      </div>
      <div class="text-xs text-gray-500 leading-6">
        <div>• 最近 10 / 20 / 50 / 100 场胜率趋势</div>
        <div>• 模式、位置、英雄和对手历史表现</div>
        <div>• 疑似开黑组合、稳定度、置信度和关系网络</div>
        <div>• PostgreSQL 缓存优先，减少重复请求</div>
      </div>
      <n-button
        class="mt-5"
        block
        type="primary"
        secondary
        @click="openMatchWindow"
      >
        打开个人战绩分析
      </n-button>
      <div
        class="mt-6 rounded bg-gray-50 dark:bg-zinc-800 p-3 text-xs text-gray-500 leading-5"
      >
        游戏内对局开始后，会自动打开同一套近期战绩分析面板；使用 Shift + Tab 可隐藏或显示。
      </div>
    </n-card>
  </div>

  <div v-else class="mainContent flex items-center justify-center">
    <n-result
      v-if="!loading"
      status="warning"
      title="未连接 League 客户端"
      :description="errorMessage || '请先登录客户端，再重试。'"
    >
      <template #footer>
        <n-button type="primary" @click="loadCurrentPlayer">重试</n-button>
      </template>
    </n-result>
    <div v-else class="text-sm text-gray-500">正在读取当前登录玩家…</div>
  </div>
</template>
