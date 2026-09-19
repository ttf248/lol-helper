<script setup lang="ts">
import {NResult} from "naive-ui"

const props = defineProps<{ message?: string }>();

</script>

<template>
  <div class="w-full h-full flex justify-center items-center">
    <n-result
      size="large"
      status="500"
      title="查询战绩数据失败"
      :description="props.message || '或许这与英雄联盟服务器有关'"
    >
    </n-result>
  </div>
</template>
