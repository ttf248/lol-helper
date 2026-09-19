<script setup lang="ts">
import { Ref, ref } from "vue";
import { ConfigSettingTypes } from "@/background/types/";
import {
	NDrawerContent,
	NTag,
	NButton,
	NSwitch,
	NRadio,
	NList,
	NListItem,
	NScrollbar,
	useDialog,
} from "naive-ui";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke } from "@tauri-apps/api/core";

const config: Ref<ConfigSettingTypes> = ref(
	JSON.parse(localStorage.getItem("configSetting") as string),
);
const theme = localStorage.getItem("theme") || "light";
const dialog = useDialog();
declare const __APP_VERSION__: string;
const version = __APP_VERSION__;

const saveConfig = () => {
	localStorage.setItem("configSetting", JSON.stringify(config.value));
};
// 切换主题
const handleThemeChange = () => {
	dialog.warning({
		title: "Tips",
		content: "主题切换将重启本地试验台, 是否执行操作o.O?",
		showIcon: true,
		positiveText: "确认",
		negativeText: "取消",
		maskClosable: true,
		closable: false,
		autoFocus: false,
		style: "margin:8px;max-width:334px",
		onPositiveClick: async () => {
			if (theme !== "dark") {
				localStorage.setItem("theme", "dark");
			} else {
				localStorage.setItem("theme", "light");
			}
			await relaunch();
		},
	});
};
// 设置自动吸附配置
const changeAutoAdhere = async (key: number) => {
	config.value.lolTracker = key;
	saveConfig();

	const enabled = key > 0;
	const side = key === 1 ? "Left" : "Right";
	// 实时同步给后端，线程会在下一次循环（16ms内）自动调整位置
	await invoke("sync_tracker_config", { enabled, side });
};

const restart = async () => {
	await relaunch();
};
</script>

<template>
	<n-drawer-content
		body-style="padding:12px 0px"
		body-content-style="padding:0px"
	>
		<n-list>
			<n-scrollbar
				style="max-height: 448px"
				content-style="padding:0px 12px"
			>
				<n-list-item style="padding-top: 0px">
					<div class="gap-x-5 flex justify-between items-center">
						<n-tag :bordered="false">运行模式</n-tag>
						<n-tag type="info" :bordered="false">
							本地测试 · 内部使用
						</n-tag>
					</div>
				</n-list-item>
				<!--        切换主题-->
				<n-list-item>
					<div class="flex gap-x-5 justify-between items-center">
						<n-tag :bordered="false">主题样式</n-tag>
						<div class="flex flex-grow justify-between">
							<n-radio
								:checked="theme === 'light'"
								value="light"
								name="basic-demo"
								@click="handleThemeChange"
							>
								白羽清风
							</n-radio>
							<n-radio
								:checked="theme === 'dark'"
								value="dark"
								name="basic-demo"
								@click="handleThemeChange"
							>
								幽黑星空
							</n-radio>
						</div>
					</div>
				</n-list-item>

				<!--        窗口吸附-->
				<n-list-item>
					<div class="gap-x-5 flex justify-between items-center">
						<n-tag :bordered="false">窗口吸附</n-tag>
						<div class="flex flex-grow justify-between">
							<n-radio
								:checked="config.lolTracker === 0"
								value="light"
								name="basic-demo"
								@click="changeAutoAdhere(0)"
							>
								关闭
							</n-radio>
							<n-radio
								:checked="config.lolTracker === 1"
								value="dark"
								name="basic-demo"
								@click="changeAutoAdhere(1)"
							>
								左侧
							</n-radio>
							<n-radio
								:checked="config.lolTracker === 2"
								value="dark"
								name="basic-demo"
								@click="changeAutoAdhere(2)"
							>
								右侧
							</n-radio>
						</div>
					</div>
				</n-list-item>
				<!--        窗口吸附-->

				<!--        游戏窗口-->
				<n-list-item>
					<div class="gap-x-5 flex justify-between">
						<n-tag :bordered="false">游戏窗口</n-tag>
						<div
							class="flex flex-grow items-center justify-between"
						>
							<n-tag
								:type="
									config.isGameInWindow
										? 'success'
										: 'default'
								"
								:disabled="!config.isGameInWindow"
							>
								自动打开游戏窗口</n-tag
							>
							<n-switch
								v-model:value="config.isGameInWindow"
								@click="saveConfig"
							/>
						</div>
					</div>
					<n-tag
						class="mt-1.5 w-full justify-center"
						:disabled="true"
						:bordered="false"
						size="small"
					>
						游戏内显示战绩窗口，显示|隐藏 SHIFT+TAB</n-tag
					>
					<n-tag
						class="mt-1.5 w-full justify-center"
						:disabled="!config.isGameInWindow ? false : true"
						:bordered="false"
						size="small"
					>
						关闭自动打开后，进入游戏需点击右下角图标</n-tag
					>
				</n-list-item>
				<n-list-item style="padding-bottom: 0px">
					<div class="flex justify-between items-center">
						<n-tag :bordered="false" size="small">
							测试版本 {{ version }}
						</n-tag>
						<n-tag type="info" :bordered="false" size="small">
							仅本机运行
						</n-tag>
						<n-button
							size="small"
							secondary
							type="tertiary"
							@click="restart"
						>
							重启
						</n-button>
					</div>
				</n-list-item>
			</n-scrollbar>
		</n-list>
	</n-drawer-content>
</template>
