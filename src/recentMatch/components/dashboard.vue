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
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { ConfigSettingTypes } from "@/background/types";
import { getCurrentWindow } from "@tauri-apps/api/window";
import BrandLockup from "@/components/BrandLockup.vue";
import { RecentMatchLoadingState } from "@/recentMatch/utils/queryTypes";

const { winCount, isFriCount, loadingState, historySourceLabels } = defineProps<{
	winCount: { friend: number[]; enemy: number[] };
	isFriCount: boolean;
	analysisLoading: boolean;
	loadingState: RecentMatchLoadingState;
	historySourceLabels: string[];
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

onBeforeUnmount(() => {
	window.removeEventListener("keydown", handleKeyDown);
});

const handleMin = async () => {
	await getCurrentWindow().hide();
};

// Shift+Tab 全局监听是为了"对局内任意位置 Shift+Tab 收起面板"。但用户在
// 输入框里按 Shift+Tab 时同样会被劫持，导致无法把焦点移出输入框。
// 当焦点在 <input>/<textarea>/contentEditable 内时早返回，避免吞用户的
// 真实焦点操作。
const isEditableTarget = (target: EventTarget | null): boolean => {
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;
	const tag = target.tagName;
	return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
};

const handleKeyDown = (event: KeyboardEvent) => {
	if (isEditableTarget(event.target)) return;
	if (event.key === "Tab" && event.shiftKey) {
		event.preventDefault();
		handleMin();
	}
};
const handleClose = async () => {
	await getCurrentWindow().close();
};

const closeModalOutside = (event: MouseEvent) => {
	// Check if the clicked element is outside the modal
	const target = event.target;
	if (!(target instanceof HTMLElement)) return;
	if (!target.closest(".tips-modal-card")) {
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
	<header class="game-dashboard">
		<div data-tauri-drag-region class="dragDiv"></div>
		<div class="dashboard-primary">
			<BrandLockup compact />
			<div class="team-win-summary">
				<div class="team-win-stat">
					<text class="text-gray-400 text-xs">友方胜</text>
					<n-tag
						:bordered="false"
						:type="isFriCount ? 'success' : 'error'"
						class="win-count-tag"
					>
						<template #icon>
							<n-icon
								:size="14"
								:component="isFriCount ? ThumbUp : ThumbDown"
							/>
						</template>
						{{ winCount.friend[0] }}/{{ winCount.friend[1] }}
					</n-tag>
				</div>
				<div class="team-win-stat">
					<text class="text-gray-400 text-xs">敌方胜</text>
					<n-tag
						:bordered="false"
						:type="!isFriCount ? 'success' : 'error'"
						class="win-count-tag"
					>
						<template #icon>
							<n-icon
								:size="14"
								:component="!isFriCount ? ThumbUp : ThumbDown"
							/>
						</template>
						{{ winCount.enemy[0] }}/{{ winCount.enemy[1] }}
					</n-tag>
				</div>
				<n-tag
					class="dashboard-shortcut"
					:bordered="false"
					type="default"
					:disabled="true"
				>
					显示•隐藏&nbsp;&nbsp;&nbsp;&nbsp;Shift + Tab
				</n-tag>
				<n-tag
					class="dashboard-loading"
					:bordered="false"
					:type="loadingState.stage === 'error' ? 'error' : loadingState.stage === 'done' ? 'success' : 'warning'"
					:title="loadingState.detail"
				>
					{{ loadingState.message }}
					<span v-if="loadingState.total > 0">
						· {{ loadingState.completed }}/{{ loadingState.total }}
					</span>
				</n-tag>
				<n-tag
					v-if="historySourceLabels.length"
					class="dashboard-source"
					:bordered="false"
					type="info"
					:title="`本局历史服务器接口：${historySourceLabels.join('、')}`"
				>
					接口：{{ historySourceLabels.join("、") }}
				</n-tag>
			</div>
		</div>

		<div class="dashboard-actions">
			<n-tag
				class="dashboard-hint"
				:bordered="false"
				type="default"
				:disabled="true"
			>
				对局中显示, 请将游戏窗口设置成【无边框】
			</n-tag>
			<n-button-group size="large">
				<n-button
					:focusable="false"
					aria-label="查看使用提示"
					@click="isModalOpen = true"
					class="dashboard-action-button"
					type="default"
				>
					<template #icon>
						<N-icon :size="20" :component="Bulb" />
					</template>
				</n-button>
				<n-button
					:focusable="false"
					aria-label="打开关系图"
					@click="emits('openNetwork')"
					class="dashboard-action-button"
					type="default"
				>
					关系图
				</n-button>
				<n-button
					:focusable="false"
					aria-label="刷新面板"
					@click="refresh"
					class="dashboard-action-button"
					type="default"
				>
					<template #icon>
						<N-icon :size="20" :component="Refresh" />
					</template>
				</n-button>

				<n-button
					aria-label="隐藏面板（Shift+Tab）"
					@click="handleMin"
					class="dashboard-action-button"
					type="default"
				>
					<template #icon>
						<N-icon :size="20" :component="CircleMinus" />
					</template>
				</n-button>
				<n-popconfirm @positive-click="handleClose" :show-icon="false">
					<template #trigger>
						<n-button
							aria-label="关闭面板"
							class="dashboard-action-button"
							type="default"
						>
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
			class="tips-overlay fixed inset-0 bg-neutral-950 bg-opacity-40 flex items-center justify-center z-50"
		>
		<div
			class="tips-modal-card bg-white text-neutral-900 px-6 py-4 rounded shadow-md dark:bg-neutral-900 dark:text-neutral-200"
		>
			<!-- Modal content goes here -->
			<text class="text-xl">Tips</text>
			<p class="my-1 text-red-500">
				0：在游戏中显示，请将游戏窗口模式设置成【无边框】
			</p>
			<p class="my-1">1：开黑先看当前对局加最近4场，组合在最近5局中同队至少3次；同时保留完整历史算法并合并结果</p>
			<p class="my-1">2：统计会区分匹配、排位、大乱斗和海克斯大乱斗模式</p>
			<p class="my-1">3：点击下方战绩标签，即可查看此局详细数据</p>
			<p class="my-1">4：点击英雄头像，可查看英雄信息</p>
			<p class="my-1">5：先展示最近 10 场快速摘要；开黑初筛使用最近5局（含当前），随后基于本地历史缓存统计更多数据</p>

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

<style scoped>
.game-dashboard {
	display: flex;
	align-items: center;
	position: relative;
	min-width: 0;
	height: 40px;
	gap: 10px;
}

.dashboard-primary,
.dashboard-actions,
.team-win-summary,
.team-win-stat {
	display: flex;
	align-items: center;
}

.dashboard-primary {
	flex: 1 1 auto;
	min-width: 0;
	gap: 10px;
}

.team-win-summary {
	flex: 0 0 auto;
	gap: 8px;
}

.team-win-stat {
	flex-direction: row;
	align-items: center;
	gap: 4px;
}

.win-count-tag {
	justify-content: center;
	width: 80px;
	font-size: 13px;
	font-weight: 600;
}

.win-count-tag :deep(.n-tag__content) {
	font-size: 13px;
	font-weight: 600;
}

.dashboard-shortcut,
.dashboard-loading,
.dashboard-source,
.dashboard-hint {
	flex: 0 1 auto;
	min-width: 0;
	max-width: 220px;
	overflow: hidden;
	white-space: nowrap;
	text-overflow: ellipsis;
	cursor: default !important;
}

.dashboard-actions {
	flex: 0 0 auto;
	min-width: 0;
	justify-content: flex-end;
	gap: 8px;
}

.dashboard-hint {
	max-width: 250px;
}

.dashboard-action-button {
	padding: 10px;
}

.tips-overlay {
	padding: 16px;
}

.tips-modal-card {
	width: min(520px, calc(100vw - 32px));
	max-height: calc(100vh - 32px);
	overflow-y: auto;
}

@media (max-width: 1120px) {
	.dashboard-hint {
		display: none;
	}

	.dashboard-loading {
		max-width: 170px;
	}

	.dashboard-source {
		max-width: 210px;
	}
}
</style>
