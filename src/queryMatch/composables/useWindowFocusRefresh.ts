import { onBeforeUnmount, onMounted } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";
import useMatchStore from "@/queryMatch/store";
import { logger } from "@/utils/logger";

// 两次自动刷新之间的最小间隔 (ms)。
const AUTO_REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000;
// onFocusChanged 在窗口已聚焦时挂载会立刻触发一次。这段时间内的 focus
// 事件一律视为首次激活，不算自动刷新，避免与 queryMatch.vue 的
// onMounted 兜底 init() 重复。
const MOUNT_FOCUS_GRACE_MS = 1_500;

/**
 * 监听当前窗口（mainWindow）的焦点变化，重新获得焦点时
 * 触发 useMatchStore.maybeAutoRefreshOnFocus()。
 *
 * 选择 Tauri 原生 onFocusChanged 而非 window.addEventListener('focus', ...)，
 * 是因为前者只对 OS 层面的窗口聚焦变化敏感，devtools / webview 内部
 * 焦点切换不会误触。
 *
 * 监听注册在 mainWindow 的 webview 里，recentMatchWindow 聚焦时
 * 这里的 handler 不会被调用，作用域天然隔离，不需要额外的 label 守卫。
 *
 * 节流与各前置守卫全部下沉到 store action，本 composable 只负责：
 * 1. 挂载 / 卸载时注册 / 注销监听；
 * 2. 首次挂载豁免（grace period）；
 * 3. 根据 store 返回的 reason 写日志分流。
 */
export function useWindowFocusRefresh(): void {
	const matchStore = useMatchStore();
	let unlistenFocus: UnlistenFn | null = null;
	let mountedAt = 0;
	let disposed = false;

	onMounted(async () => {
		mountedAt = Date.now();
		try {
			const unlisten = await getCurrentWindow().onFocusChanged(
				({ payload: focused }) => {
					if (!focused || disposed) {
						return;
					}
					// 挂载后短时间内窗口已经聚焦，这通常是 onFocusChanged
					// 首次回调，不算用户主动切回。
					if (Date.now() - mountedAt < MOUNT_FOCUS_GRACE_MS) {
						return;
					}
					void matchStore
						.maybeAutoRefreshOnFocus()
						.then((reason) => {
							if (reason === "refreshed") {
								logger.info({
									tag: "queryMatch.auto_refresh",
									message: "auto-refresh triggered by window focus",
								});
							} else {
								logger.debug({
									tag: "queryMatch.auto_refresh",
									message: "auto-refresh skipped",
									context: {
										reason,
										minIntervalMs: AUTO_REFRESH_MIN_INTERVAL_MS,
									},
								});
							}
						})
						.catch((error) => {
							logger.warn({
								tag: "queryMatch.auto_refresh",
								message: "窗口 focus 自动刷新失败",
								context: { error: String(error).slice(0, 200) },
							});
						});
				},
			);
			if (disposed) {
				// 组件可能在异步注册完成前卸载；不能把刚注册的监听遗留在
				// 已销毁的组件实例上。
				unlisten();
				return;
			}
			unlistenFocus = unlisten;
		} catch (error) {
			if (disposed) return;
			logger.warn({
				tag: "queryMatch.auto_refresh",
				message: "注册窗口 focus 监听失败",
				context: { error: String(error).slice(0, 200) },
			});
		}
	});

	onBeforeUnmount(() => {
		disposed = true;
		unlistenFocus?.();
		unlistenFocus = null;
	});
}
