<script setup lang="ts">
import {NButton, NInput, NSelect, NPagination, NTag,
  useMessage, NIcon, NSpace, MessageReactive} from "naive-ui"
import {ref, watch} from "vue";
import {CircleMinus, CircleX, Settings} from "@vicons/tabler";
import {querySummonerInfo} from "@/lcu/aboutSummoner";
import useMatchStore from "@/queryMatch/store";
import {getCurrentWindow} from "@tauri-apps/api/window";
import BrandLockup from "@/components/BrandLockup.vue";

const matchStore = useMatchStore()
const inputVal = ref('')
const selectVal = ref(0)
const pageVal = ref(1)
const message = useMessage()

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
  message.info('无效按钮，或许起到了造型上的作用')
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
  <header class="flex">
    <div class="flex gap-x-2 items-center mr-3">
      <BrandLockup compact />
      <n-tag
        v-if="matchStore.summonerId===matchStore.localSumId"
        :bordered="false"
        type="info"
        style="margin-left: 22px">
        本地数据
      </n-tag>
      <n-button
        v-else
        @click="backSelf"
        size="small" style="margin-left: 30px;width: 90.41px"
        secondary type="info">
        Back Self
      </n-button>
    </div>
    <div class="flex-grow flex items-center gap-x-3">
      <n-input v-model:value="inputVal" type="text" spellcheck="false"
               style="width: 141px;font-size: 13.5px" size="small"
               placeholder="输入 Riot ID 或召唤师名"
               @keyup.enter="searchSum" />
      <n-button size="small" :bordered="false" @click="searchSum"
                type="success" style="width: 46px;padding: 0 9px">
        查询
      </n-button>
      <n-select size="small" v-model:value="selectVal"
                :disabled="inputVal!==''"
                @update:value="changeMatchMode"
                :options="options" style="width: 100px;margin-left: 28px;"/>

      <n-pagination v-model:page="pageVal"
                    @update-page="pageChange"
                    :page-slot="10"
                    :page-count="12"/>

    </div>
    <n-space style="padding-top: 10px;" :size=[8,0]>
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
</template>

