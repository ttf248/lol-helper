<script setup lang="ts">
import { onMounted } from "vue";
import { useRouter } from "vue-router";
import { window } from "@tauri-apps/api";
import { emitTo, listen } from "@tauri-apps/api/event";
import Dashboard from "@/main/common/dashboard.vue";

const router = useRouter();
const configSetting = JSON.parse(
	localStorage.getItem("configSetting") || "{}",
);

const showHistoryDashboard = () => {
	router.push({ name: "home" });
};

onMounted(showHistoryDashboard);

listen<{ messageId: string }>("clientStatus", (event) => {
	// 主窗口只负责展示历史数据，游戏流程变化不再切换到排位、选英雄或结算辅助页面。
	if (
		["None", "Lobby", "Matchmaking", "GameStart", "EndOfGame"].includes(
			event.payload.messageId,
		)
	) {
		showHistoryDashboard();
	}
});

listen<string>("cacheMatchList", (event) => {
	if (event.payload !== "getMatchList") return;
	window.Window.getByLabel("recentMatchWindow").then((win) => {
		if (win !== null) {
			// 最近对局窗口现在自行走数据库缓存和 LCU 查询，不再依赖选英雄页面的内存缓存。
			emitTo("recentMatchWindow", "matchListCache", {});
		}
	});
});
</script>

<template>
	<div class="main bg-neutral-100 dark:bg-neutral-900">
		<dashboard :config-setting="configSetting" />
		<router-view />
	</div>
</template>
