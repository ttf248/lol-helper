<script setup lang="ts">
import {NButton, NAutoComplete, NSelect, NPagination, NTag,
  useMessage, NIcon, NSpace, MessageReactive, NDrawer} from "naive-ui"
import {computed, h, ref, watch} from "vue";
import type {SelectOption} from "naive-ui";
import {CircleMinus, CircleX, Refresh, Settings} from "@vicons/tabler";
import {querySummonerInfo} from "@/lcu/aboutSummoner";
import useMatchStore from "@/queryMatch/store";
import {searchCachedSummoners} from "@/recentMatch/utils/databaseCache";
import type {CachedSummonerSearchRow} from "@/recentMatch/utils/databaseCache";
import {getCurrentWindow} from "@tauri-apps/api/window";
import BrandLockup from "@/components/BrandLockup.vue";
import Setting from "@/main/common/setting.vue";

// 与 lodash.debounce 同语义：N 毫秒内的多次调用合并为最后一次。
// 项目里没有其他文件用 lodash sub-import，引入一个工具包会带来类型依赖；
// 搜索框只在一个地方使用，手写 10 行更轻。
const debounce = <Args extends unknown[]>(
  fn: (...args: Args) => void,
  ms: number,
): ((...args: Args) => void) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: Args) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
};

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
    if (status.totalPages) {
      return `历史缓存 ${status.currentPage}/${status.totalPages} 页`
    }
    const maxPages = status.maxPages || 0
    return maxPages > 0
      ? `历史缓存 ${status.currentPage}/${maxPages} 页`
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

// 本地缓存已经覆盖最近 500 场的情况下才允许强制同步。
// 缓存还没拉满时按下按钮只会立即跑一次完整拉取，体感上是
// "正常启动的同步过程"，没必要单独留按钮。
const canForceRefreshHistory = computed(
  () =>
    matchStore.historyCacheFull === true &&
    matchStore.historyCacheSync.kind !== "syncing",
)

const forceRefreshHistoryTitle = computed(() =>
  canForceRefreshHistory.value
    ? "忽略本地缓存，重新拉取最近 25 页战绩"
    : "本地缓存未覆盖最近 500 场，暂无强制同步必要",
)

watch(() => matchStore.summonerId, () => {
  clearVal()
})

// 完整 init 会把列表切回“全部模式”。即使目标召唤师没有变化（例如
// 窗口聚焦自动刷新），也要同步清掉旧的模式和页码，避免下拉框、列表
// 与分页继续引用上一轮 specialMatchList。强制同步不修改 matchLoading，
// 因此不会被这里误清空。
watch(() => matchStore.matchLoading, (loading) => {
  if (loading) clearVal()
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

    // 不论 resolve 还是 reject 都要销毁 loading toast，否则失败时 toast
    // 会停留到 duration 过期，期间用户再次切模式看不到新 toast。
    matchStore.getSpecialMatchList(queueId, sumInfo.info.puuid)
      .then(() => mes.destroy())
      .catch((error) => {
        mes.destroy()
        message.error(`${curMod} 加载失败：${String(error).slice(0, 120)}`)
      })

  } else {
    matchStore.getSpecialMatchList(queueId)
  }
  pageVal.value = 1
}

const isCompleteRiotId = (value: string) => {
  const normalized = value.trim()
  const separator = normalized.lastIndexOf("#")
  return separator > 0 && separator < normalized.length - 1
}

const searchOfficial = async (query: string) => {
  const loading = message.loading('查询召唤师中...', {duration: 0})
  try {
    const sumInfo = await querySummonerInfo(undefined, query)
    if (sumInfo === null) {
      message.error(
        isCompleteRiotId(query)
          ? `官方接口未找到「${query}」，请确认 Riot ID 和大区是否正确`
          : '没有找到该玩家；请先从本地候选中选择，或输入完整 Riot ID（name#tag）再查询',
      )
      return
    }

    // privacy 只表示召唤师资料的可见性，不等于 SGP 战绩接口的访问权限。
    // LCU 已经返回了有效的 summonerId/PUUID，交由 matchStore 选择正确的
    // 当前用户 LCU 或他人 SGP 数据源，不在这里提前拦截查询。
    await matchStore.init(sumInfo.currentId)
    clearVal()
  } catch (error) {
    message.error(`官方接口查询失败：${String(error).slice(0, 120)}`)
  } finally {
    loading.destroy()
  }
}

const searchSum = async () => {
  // AutoComplete 在 keydown 阶段已经选中高亮候选；同一次按键随后触发的
  // keyup 不能再按文本走一次 LCU 查询，否则会并发初始化两次。
  if (candidateSelectionInFlight) return
  const query = inputVal.value.trim()
  if (query === '') {
    message.warning('请输入 Riot ID 或召唤师名')
    return
  }
  await searchOfficial(query)
}
const clearVal = () => {
  // 使已排队或进行中的搜索结果失效，防止清空后旧结果重新出现。
  ++candidateSearchVersion
  inputVal.value = ''
  selectVal.value = 0
  pageVal.value = 1
  candidates.value = []
  candidateSearchLoading.value = false
}

// ── 本地缓存玩家模糊搜索建议 ────────────────────────────────────────
// candidates 持有最近一次后端返回；inputVal 触发 onInputChange 防抖刷新。
// 选中候选走 onCandidateSelect → matchStore.init，与原 searchSum 等价。
const candidates = ref<CachedSummonerSearchRow[]>([])
let candidateSearchVersion = 0
let candidateSelectionInFlight = false

interface CachedSummonerSearchOption {
  [key: string]: unknown;
  label: string;
  value: string;
  kind: "cached" | "feedback" | "official";
  displayLabel?: string;
  query?: string;
  disabled?: boolean;
  puuid: string;
  summonerId: number;
  summonerLevel: number | null | undefined;
  subLabel: string;
}

const candidateSearchLoading = ref(false)

const renderOptions = computed<CachedSummonerSearchOption[]>(() => {
  const localOptions = candidates.value.map((c) => {
    const baseName = c.gameName ?? c.displayName ?? c.summonerName ?? c.puuid
    const tag = c.tagLine ?? ""
    const label = tag ? `${baseName}#${tag}` : baseName
    // 与 searchSum 兼容：summonerName 在 Riot ID 迁移前的“旧召唤师名”，与
    // gameName 不一致时单独展示一行副标题。
    const subLabel =
      c.summonerName && c.summonerName !== c.gameName
        ? `旧召唤师名：${c.summonerName}`
        : c.displayName ?? ""
    return {
      label,
      value: c.puuid,
      kind: "cached" as const,
      puuid: c.puuid,
      summonerId: c.summonerId,
      summonerLevel: c.summonerLevel,
      subLabel,
    }
  })

  const query = inputVal.value.trim()
  if (!query || localOptions.length > 0) {
    return localOptions
  }

  if (candidateSearchLoading.value) {
    return [{
      label: "正在搜索本地玩家…",
      value: "__local-search-loading__",
      kind: "feedback",
      disabled: true,
      displayLabel: "正在搜索本地玩家…",
      puuid: "",
      summonerId: 0,
      summonerLevel: null,
      subLabel: "请稍候",
    }]
  }

  const emptyOption: CachedSummonerSearchOption = {
    label: `未找到“${query}”`,
    value: "__local-search-empty__",
    kind: "feedback",
    disabled: true,
    displayLabel: `未找到“${query}”`,
      puuid: "",
      summonerId: 0,
      summonerLevel: null,
      subLabel: isCompleteRiotId(query)
      ? "本地缓存暂无匹配，可使用官方接口继续搜索"
      : "本地缓存暂无匹配，请输入完整 Riot ID（name#tag）后再搜索",
  }

  if (!isCompleteRiotId(query)) {
    return [emptyOption]
  }

  return [
    emptyOption,
    {
      // AutoComplete 选中后会把 option.label 写回输入框，所以 label 保留
      // 原始查询；displayLabel 才是下拉项里给用户看的操作提示。
      label: query,
      value: query,
      kind: "official" as const,
      displayLabel: "使用官方接口搜索",
      query,
      puuid: "",
      summonerId: 0,
      summonerLevel: null,
      subLabel: "本地没有结果，按 Enter 或点击此项继续",
    },
  ]
})

const refreshCandidates = debounce(async (value: string, version: number) => {
  const trimmed = value.trim()
  if (trimmed.length < 1) {
    if (version === candidateSearchVersion) {
      candidateSearchLoading.value = false
    }
    return
  }
  try {
    const result = await searchCachedSummoners(trimmed, 20)
    // IPC 的完成顺序不保证与输入顺序一致。只允许当前输入对应的结果更新下拉项，
    // 避免删字或选中候选后又显示旧查询的结果。
    if (version === candidateSearchVersion) {
      candidates.value = result
    }
  } finally {
    if (version === candidateSearchVersion) {
      candidateSearchLoading.value = false
    }
  }
}, 200)

const onInputChange = (value: string) => {
  const version = ++candidateSearchVersion
  if (!value.trim()) {
    candidates.value = []
    candidateSearchLoading.value = false
    return
  }
  candidates.value = []
  candidateSearchLoading.value = true
  refreshCandidates(value, version)
}

const preloadCandidates = async () => {
  const version = ++candidateSearchVersion
  candidateSearchLoading.value = true
  try {
    const result = await searchCachedSummoners("", 20)
    if (version === candidateSearchVersion && !inputVal.value.trim()) {
      candidates.value = result
    }
  } finally {
    if (version === candidateSearchVersion) {
      candidateSearchLoading.value = false
    }
  }
}

const renderCandidateLabel = (option: SelectOption) => {
  const candidate = option as SelectOption & CachedSummonerSearchOption
  if (candidate.kind === "feedback") {
    return h("div", {class: "candidate-feedback"}, [
      h("div", {class: "candidate-feedback-title"}, candidate.displayLabel ?? candidate.label),
      h("div", {class: "candidate-sub"}, candidate.subLabel),
    ])
  }
  if (candidate.kind === "official") {
    return h("div", {class: "candidate-official"}, [
      h("div", {class: "candidate-official-title"}, candidate.displayLabel),
      h("div", {class: "candidate-sub"}, candidate.subLabel),
    ])
  }
  return h("div", {class: "candidate-row"}, [
    h("div", {class: "candidate-main"}, [
      h("span", {class: "candidate-name"}, candidate.label),
      h("span", {class: "candidate-meta"}, `Lv ${candidate.summonerLevel ?? "?"}`),
    ]),
    candidate.subLabel
      ? h("div", {class: "candidate-sub"}, candidate.subLabel)
      : null,
  ])
}

const shouldShowCandidates = (_value: string) => renderOptions.value.length > 0

const onCandidateSelect = (puuid: string | number) => {
  if (typeof puuid !== "string") return
  const option = renderOptions.value.find((item) => item.value === puuid)
  if (!option) return
  if (option.kind === "official") {
    candidateSelectionInFlight = true
    void searchOfficial(option.query ?? inputVal.value.trim()).finally(() => {
      candidateSelectionInFlight = false
    })
    return
  }
  if (option.kind !== "cached") return
  const row = candidates.value.find((c) => c.puuid === option.puuid)
  if (!row) return
  // @select 同步触发，Promise 返回值 vue-tsc 不接受；fire-and-forget。
  const loading = message.loading("查询召唤师中...", { duration: 0 })
  candidateSelectionInFlight = true
  matchStore
    .init(row.summonerId)
    .then(() => clearVal())
    .catch((err: unknown) => {
      message.error(`查询失败：${String(err).slice(0, 120)}`)
    })
    .finally(() => {
      candidateSelectionInFlight = false
      loading.destroy()
    })
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
      <n-button
        v-if="canForceRefreshHistory"
        size="small"
        quaternary
        type="info"
        class="force-refresh-history"
        :title="forceRefreshHistoryTitle"
        @click="matchStore.forceRefreshHistoryCache()"
      >
        <template #icon>
          <n-icon :component="Refresh" :size="14" />
        </template>
        强制同步
      </n-button>
    </div>
    <div class="header-controls">
      <n-auto-complete
        v-model:value="inputVal"
        :options="renderOptions"
        placeholder="输入 Riot ID 或召唤师名"
        size="small"
        class="search-input"
        spellcheck="false"
        :loading="candidateSearchLoading"
        :clear-after-select="false"
        :get-show="shouldShowCandidates"
        :render-label="renderCandidateLabel"
        @focus="preloadCandidates"
        @update:value="onInputChange"
        @select="onCandidateSelect"
        @keyup.enter="searchSum"
      />
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
      <n-button aria-label="最小化窗口" @click="handleMin" text>
        <n-icon size="20">
          <circle-minus/>
        </n-icon>
      </n-button>
      <n-button aria-label="打开设置" text circle @click="handleSet">
        <n-icon size="20">
          <settings/>
        </n-icon>
      </n-button>
      <n-button aria-label="关闭窗口" text circle @click="handleClose">
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

.force-refresh-history {
  padding: 0 8px;
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

/* ── 搜索建议下拉项样式 ─────────────────────────────────── */
.candidate-row {
  display: flex;
  flex-direction: column;
  padding: 4px 8px;
  cursor: pointer;
}
.candidate-row:hover {
  background: rgba(99, 224, 123, 0.08);
}
.candidate-main {
  display: flex;
  align-items: center;
  gap: 8px;
}
.candidate-name {
  font-weight: 500;
}
.candidate-meta {
  color: #888;
  font-size: 12px;
}
.candidate-sub {
  font-size: 11px;
  color: #888;
  margin-top: 2px;
}
.candidate-feedback,
.candidate-official {
  padding: 4px 8px;
}
.candidate-feedback-title {
  color: #888;
}
.candidate-official {
  border-top: 1px solid rgba(128, 128, 128, 0.12);
}
.candidate-official-title {
  color: #2080f0;
  font-weight: 500;
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

