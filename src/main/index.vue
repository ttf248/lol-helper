<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { window } from "@tauri-apps/api";
import { emitTo, listen } from "@tauri-apps/api/event";
import Dashboard from "@/main/common/dashboard.vue";
import Navigation from "@/main/common/navigation.vue";

const router = useRouter();
const curPos = ref(0);
const configSetting = JSON.parse(
	localStorage.getItem("configSetting") || "{}",
);
let stopClientStatus: (() => void) | null = null;
let stopCacheMatchList: (() => void) | null = null;

const showHistoryDashboard = () => {
	curPos.value = 0;
	router.push({ name: "home" });
};

const navigateToPage = (page: string, index: number) => {
	curPos.value = index;
	router.push({ name: page });
};

onMounted(async () => {
	showHistoryDashboard();
	stopClientStatus = await listen<{ messageId: string }>(
		"clientStatus",
		(event) => {
			// 主窗口恢复为基础主页；排位、选英雄和结算辅助页不再参与导航。
			if (
				["None", "Lobby", "Matchmaking", "GameStart", "EndOfGame"].includes(
					event.payload.messageId,
				)
			) {
				showHistoryDashboard();
			}
		},
	);
	stopCacheMatchList = await listen<string>("cacheMatchList", (event) => {
		if (event.payload !== "getMatchList") return;
		window.Window.getByLabel("recentMatchWindow").then((win) => {
			if (win !== null) {
				// 最近对局窗口现在自行走数据库缓存和 LCU 查询，不再依赖选英雄页面的内存缓存。
				emitTo("recentMatchWindow", "matchListCache", {});
			}
		});
	});
});

onBeforeUnmount(() => {
	stopClientStatus?.();
	stopCacheMatchList?.();
});
</script>

<template>
	<div class="main bg-neutral-100 dark:bg-neutral-900">
		<dashboard :config-setting="configSetting" />
		<router-view v-slot="{ Component }">
			<keep-alive>
				<component :is="Component" />
			</keep-alive>
		</router-view>
		<navigation
			:cur-pos="curPos"
			:navigate-to-page="navigateToPage"
		/>
	</div>
</template>
