<script setup lang="ts">
import {NButton, NInput, NSelect, NPagination, NTag,
  useMessage, NIcon, NSpace, MessageReactive, NDrawer} from "naive-ui"
import {computed, ref, watch} from "vue";
import {CircleMinus, CircleX, Settings} from "@vicons/tabler";
import {querySummonerInfo} from "@/lcu/aboutSummoner";
import useMatchStore from "@/queryMatch/store";
import {getCurrentWindow} from "@tauri-apps/api/window";
import BrandLockup from "@/components/BrandLockup.vue";
import Setting from "@/main/common/setting.vue";

const matchStore = useMatchStore()
const inputVal = ref('')
const selectVal = ref(0)
const pageVal = ref(1)
const isShowSetting = ref(false)
const message = useMessage()

const historyCacheStatusLabel = computed(() => {
  const status = matchStore.historyCacheSync
  if (status.kind === "complete") return status.message
  if (status.kind === "syncing") {
    return status.totalPages
      ? `历史缓存 ${status.currentPage}/${status.totalPages} 页`
      : `历史缓存第 ${status.currentPage} 页`
  }
  if (status.kind === "limited") return status.message
  if (status.kind === "error") return status.message
  return ""
})

const historyCacheStatusType = computed(() => {
  switch (matchStore.historyCacheSync.kind) {
    case "complete":
      return "success" as const
    case "error":
      return "error" as const
    case "limited":
      return "warning" as const
    default:
      return "info" as const
  }
})

watch(() => matchStore.summonerId, () => {
  clearVal()
})

const options = [
  {
    label: "全部模式",
    value: 0,
  },
  {
    label: "单双排位",
    value: 420,
  },
  {
    label: '灵活排位',
    value: 440
  },
  {
    label: '匹配模式',
    value: 430
  },
  {
    label: '极地乱斗',
    value: 450
  },
  {
    label: '斗魂竞技',
    value: 1700
  },
]
const changeMatchMode = async (queueId: number) => {
  const sumInfo = matchStore.sumInfo
  if (sumInfo !== null) {
    const curMod = options.find(i => i.value === selectVal.value)?.label
    const mes: MessageReactive = message.loading(`${curMod} 加载中...`,
      {duration:10000})

    matchStore.getSpecialMatchList(queueId,sumInfo.info.puuid).then(() => mes.destroy())

  } else {
    matchStore.getSpecialMatchList(queueId)
  }
  pageVal.value = 1
}

const searchSum = async () => {
  const query = inputVal.value.trim()
  if (query === '') {
    message.warning('请输入 Riot ID 或召唤师名')
    return
  }

  const loading = message.loading('查询召唤师中...', {duration: 0})
  try {
    const sumInfo = await querySummonerInfo(undefined, query)
    if (sumInfo === null) {
      message.error('当前召唤师不存在，请输入同大区的 Riot ID（例如 name#tag）或召唤师名')
      return
    }

    // privacy 只表示召唤师资料的可见性，不等于 SGP 战绩接口的访问权限。
    // LCU 已经返回了有效的 summonerId/PUUID，交由 matchStore 选择正确的
    // 当前用户 LCU 或他人 SGP 数据源，不在这里提前拦截查询。
    await matchStore.init(sumInfo.currentId)
    clearVal()
  } finally {
    loading.destroy()
  }
}
const clearVal = () => {
  inputVal.value = ''
  selectVal.value = 0
  pageVal.value = 1
}
const handleMin = async () => {
  await getCurrentWindow().minimize()
}
const handleClose = async () => {
  await getCurrentWindow().close()
}
const handleSet = () => {
  isShowSetting.value = true
}
const backSelf = () => {
  matchStore.init()
  clearVal()
}
const pageChange = (page: number) => {
  if (selectVal.value === 0) {
    matchStore.getMatchList(page)
  } else {
    matchStore.fromSpecialToMatchList(page)
  }
}
</script>

<template>
  <header class="query-header-bar">
    <div class="header-identity">
      <BrandLockup compact />
      <n-tag
        v-if="matchStore.summonerId===matchStore.localSumId"
        :bordered="false"
        type="info">
        本地数据
      </n-tag>
      <n-button
        v-else
        @click="backSelf"
        size="small"
        secondary type="info">
        返回本人
      </n-button>
      <n-tag
        v-if="historyCacheStatusLabel"
        :bordered="false"
        :type="historyCacheStatusType"
        size="small"
        class="history-cache-status"
        :title="matchStore.historyCacheSync.detail"
      >
        {{ historyCacheStatusLabel }}
      </n-tag>
    </div>
    <div class="header-controls">
      <n-input v-model:value="inputVal" type="text" spellcheck="false"
               class="search-input" size="small"
               placeholder="输入 Riot ID 或召唤师名"
               @keyup.enter="searchSum" />
      <n-button size="small" :bordered="false" @click="searchSum"
                type="success" class="search-button">
        查询
      </n-button>
      <n-select size="small" v-model:value="selectVal"
                :disabled="inputVal!==''"
                @update:value="changeMatchMode"
                :options="options" class="mode-select"/>

      <n-pagination v-model:page="pageVal"
                    @update-page="pageChange"
                    :page-slot="5"
                    :page-count="matchStore.matchPageCount"
                    class="match-pagination"/>

    </div>
    <n-space class="header-actions" :size="[4, 0]">
      <n-button @click="handleMin" text>
        <n-icon size="20">
          <circle-minus/>
        </n-icon>
      </n-button>
      <n-button text circle @click="handleSet">
        <n-icon size="20">
          <settings/>
        </n-icon>
      </n-button>
      <n-button text circle @click="handleClose">
        <n-icon size="20">
          <circle-x/>
        </n-icon>
      </n-button>
    </n-space>
  </header>
  <n-drawer
    v-model:show="isShowSetting"
    placement="bottom"
    :height="473"
    :auto-focus="false"
  >
    <setting />
  </n-drawer>
</template>

<style scoped>
.query-header-bar {
  display: flex;
  align-items: center;
  min-width: 0;
  height: 40px;
  gap: 12px;
}

.header-identity,
.header-controls,
.header-actions {
  display: flex;
  align-items: center;
  min-width: 0;
}

.header-identity {
  flex: 0 0 auto;
  gap: 10px;
}

.history-cache-status {
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-controls {
  flex: 1 1 auto;
  gap: 8px;
  overflow: hidden;
}

.search-input {
  flex: 0 1 190px;
  width: 190px;
  min-width: 120px;
}

.search-button {
  flex: 0 0 48px;
  padding: 0 9px;
}

.mode-select {
  flex: 0 0 108px;
  width: 108px;
  margin-left: 8px;
}

.match-pagination {
  min-width: 0;
  flex: 0 1 auto;
}

.header-actions {
  flex: 0 0 auto;
  padding-top: 0;
}

@media (max-width: 900px) {
  .mode-select {
    margin-left: 0;
  }

  .match-pagination {
    display: none;
  }
}
</style>

