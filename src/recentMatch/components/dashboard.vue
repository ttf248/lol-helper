<script setup lang="ts">
import {
	NCheckbox,
	NTag,
	NIcon,
	NButton,
	NButtonGroup,
	NPopconfirm,
	NDivider,
	NProgress,
} from "naive-ui";
import {
	ThumbUp,
	ThumbDown,
	Bulb,
	CircleMinus,
	CircleX,
	Refresh,
} from "@vicons/tabler";
import { computed, onMounted, reactive, ref } from "vue";
import { ConfigSettingTypes } from "@/background/types";
import { getCurrentWindow } from "@tauri-apps/api/window";
import BrandLockup from "@/components/BrandLockup.vue";
import { RecentMatchLoadingState } from "@/recentMatch/utils/queryTypes";

const { winCount, isFriCount, loadingState } = defineProps<{
	winCount: { friend: number[]; enemy: number[] };
	isFriCount: boolean;
	analysisLoading: boolean;
	loadingState: RecentMatchLoadingState;
}>();
const emits = defineEmits<{ openNetwork: [] }>();
const config: ConfigSettingTypes = reactive(
	JSON.parse(<string>localStorage.getItem("configSetting")),
);

const isModalOpen = ref(false);

const loadingPercent = computed(() => {
	if (loadingState.stage === "done") return 100;
	if (loadingState.total <= 0) return 0;
	return Math.min(
		99,
		Math.max(0, Math.round((loadingState.completed / loadingState.total) * 100)),
	);
});

onMounted(() => {
	if (!config.isGameInTips) {
		isModalOpen.value = true;
	}
	window.addEventListener("keydown", handleKeyDown);
});

const handleMin = async () => {
	await getCurrentWindow().hide();
};

const handleKeyDown = (event: any) => {
	if (event.key === "Tab" && event.shiftKey) {
		handleMin();
	}
};
const handleClose = async () => {
	await getCurrentWindow().close();
};

const closeModalOutside = (event: any) => {
	// Check if the clicked element is outside the modal
	if (!event.target.closest(".bg-white")) {
		isModalOpen.value = false;
	}
};

const refresh = () => {
	window.location.reload();
};

const changeConfig = () => {
	localStorage.setItem("configSetting", JSON.stringify(config));
};
</script>

<template>
	<header class="flex w-full h-10 relative">
		<div data-tauri-drag-region class="dragDiv"></div>
		<div class="flex w-1/2 gap-x-4">
			<BrandLockup compact />
			<div class="flex">
				<div class="flex flex-col gap-y-0.5 mr-4">
					<text class="text-gray-400 text-xs">友方胜利次数</text>
					<n-tag
						:bordered="false"
						:type="isFriCount ? 'success' : 'error'"
						style="justify-content: center; width: 72px"
					>
						<template #icon>
							<n-icon
								:size="15"
								:component="isFriCount ? ThumbUp : ThumbDown"
							/>
						</template>
						{{ winCount.friend[0] }}/{{ winCount.friend[1] }}
					</n-tag>
				</div>
				<div class="flex flex-col gap-y-0.5">
					<text class="text-gray-400 text-xs">敌方胜利次数</text>
					<n-tag
						:bordered="false"
						:type="!isFriCount ? 'success' : 'error'"
						style="justify-content: center; width: 72px"
					>
						<template #icon>
							<n-icon
								:size="15"
								:component="!isFriCount ? ThumbUp : ThumbDown"
							/>
						</template>
						{{ winCount.enemy[0] }}/{{ winCount.enemy[1] }}
					</n-tag>
				</div>
				<n-tag
					class="h-10 ml-4"
					style="cursor: default !important"
					:bordered="false"
					type="default"
					:disabled="true"
				>
					显示•隐藏&nbsp;&nbsp;&nbsp;&nbsp;Shift + Tab
				</n-tag>
				<n-tag
					class="h-10 ml-2"
					:bordered="false"
					:type="loadingState.stage === 'error' ? 'error' : loadingState.stage === 'done' ? 'success' : 'warning'"
					style="cursor: default !important"
					:title="loadingState.detail"
				>
					{{ loadingState.message }}
					<span v-if="loadingState.total > 0">
						· {{ loadingState.completed }}/{{ loadingState.total }}
					</span>
				</n-tag>
			</div>
		</div>

		<div class="flex w-1/2 justify-end gap-x-8">
			<n-tag
				class="h-10"
				style="cursor: default !important"
				:bordered="false"
				type="default"
				:disabled="true"
			>
				对局中显示, 请将游戏窗口设置成【无边框】
			</n-tag>
			<n-button-group size="large">
				<n-button
					:focusable="false"
					@click="isModalOpen = true"
					style="padding: 12px"
					type="default"
				>
					<template #icon>
						<N-icon :size="20" :component="Bulb" />
					</template>
				</n-button>
				<n-button
					:focusable="false"
					@click="emits('openNetwork')"
					style="padding: 12px"
					type="default"
				>
					关系图
				</n-button>
				<n-button
					:focusable="false"
					@click="refresh"
					style="padding: 12px"
					type="default"
				>
					<template #icon>
						<N-icon :size="20" :component="Refresh" />
					</template>
				</n-button>

				<n-button
					@click="handleMin"
					style="padding: 12px"
					type="default"
				>
					<template #icon>
						<N-icon :size="20" :component="CircleMinus" />
					</template>
				</n-button>
				<n-popconfirm @positive-click="handleClose" :show-icon="false">
					<template #trigger>
						<n-button style="padding: 12px" type="default">
							<template #icon>
								<N-icon :size="20" :component="CircleX" />
							</template>
						</n-button>
					</template>
					关闭此窗口 o.O?
				</n-popconfirm>
			</n-button-group>
		</div>
		<div
			v-if="loadingState.stage !== 'done'"
			class="absolute bottom-0 left-0 right-0 px-1"
			:title="loadingState.detail"
		>
			<n-progress
				type="line"
				:percentage="loadingPercent"
				:show-indicator="false"
				:height="3"
				:status="loadingState.stage === 'error' ? 'error' : 'success'"
			/>
		</div>
	</header>

	<!-- Modal -->
	<div
		v-if="isModalOpen"
		@click="closeModalOutside"
		class="fixed inset-0 bg-neutral-950 bg-opacity-40 flex items-center justify-center z-50"
	>
		<div
			class="bg-white text-neutral-900 px-6 py-4 rounded shadow-md dark:bg-neutral-900 dark:text-neutral-200"
		>
			<!-- Modal content goes here -->
			<text class="text-xl">Tips</text>
			<p class="my-1 text-red-500">
				0：在游戏中显示，请将游戏窗口模式设置成【无边框】
			</p>
			<p class="my-1">1：悬停“疑似开黑”可查看共同对局 ID；按人数要求至少 2/3/4/5 场共同同队记录，仍属于历史推断</p>
			<p class="my-1">2：统计会区分匹配、排位、大乱斗和海克斯大乱斗模式</p>
			<p class="my-1">3：点击下方战绩标签，即可查看此局详细数据</p>
			<p class="my-1">4：点击英雄头像，可查看英雄信息</p>
			<p class="my-1">5：先展示最近 10 场，完整窗口在后台补齐</p>

			<n-divider style="margin: 22px 0 20px 0" />

			<div class="mt-2 flex items-center justify-between">
				<p class="m-0">
					<n-checkbox
						v-model:checked="config.isGameInTips"
						@update:checked="changeConfig"
					>
						<text class="text-gray-400">不再自动弹出</text>
					</n-checkbox>
				</p>
			</div>
		</div>
	</div>

</template>
