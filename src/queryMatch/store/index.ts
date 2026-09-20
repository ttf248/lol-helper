import { defineStore } from "pinia";
import { ParticipantsInfo } from "@/queryMatch/utils/MatchDetail";
import { summonerInfo } from "@/lcu/types/SummonerTypes";
import BaseMatch from "@/queryMatch/utils/baseMatch";
import { SimpleMatchDetailsTypes } from "@/lcu/types/queryMatchLcuTypes";
import MatchDetails from "@/queryMatch/utils/matchDetails";
import { RencentDataAnalysisTypes } from "@/queryMatch/utils/analysisTypes";
import { findTopChamp } from "@/queryMatch/utils/analysisSummary";
import { MatchHistoryEndpoint, MatchHistorySource } from "@/lcu/aboutMatch";
import { invoke } from "@tauri-apps/api/core";
import { TencentRsoPlatformId } from "@/resources/areaList";
import { logger } from "@/utils/logger";
import {
	HISTORY_COLD_START_PAGES,
	HISTORY_HOMEPAGE_PAGE_SIZE,
	HISTORY_CACHE_SYNC_LIMIT,
	HISTORY_SERVER_PAGE_SIZE,
} from "@/recentMatch/utils/historyConfig";
import { getCachedHistory, getCachedHistoryPage } from "@/recentMatch/utils/databaseCache";
import type { HistoryCacheSyncStatus } from "@/recentMatch/utils/queryTypes";

const baseMatch = new BaseMatch();
const matchDetials = new MatchDetails();

const createIdleHistoryCacheSync = (): HistoryCacheSyncStatus => ({
	kind: "idle",
	currentPage: 0,
	totalPages: null,
	totalCount: null,
	maxPages: HISTORY_COLD_START_PAGES,
	cachedGames: 0,
	downloadedGames: 0,
	message: "",
	detail: "",
});

const persistLocalSummoner = (info: summonerInfo) => {
	let previous: Record<string, string | number> = {};
	try {
		previous = JSON.parse(
			localStorage.getItem("sumInfo") || "{}",
		) as Record<string, string | number>;
	} catch {
		previous = {};
	}

	const write = (region: string) => {
		const newPlatformId = region || String(previous.newPlatformId || "");
		const platformId =
			TencentRsoPlatformId[newPlatformId] ||
			String(previous.platformId || newPlatformId);
		localStorage.setItem(
			"sumInfo",
			JSON.stringify({
				name: info.name,
				summonerId: info.currentId,
				puuid: info.puuid,
				platformId,
				newPlatformId,
			}),
		);
	};

	// 基础身份先落盘，让游戏内窗口不必等待大区接口。
	write("");
	void invoke<string>("get_lol_region")
		.then((region) => {
			if (region) write(region);
		})
		.catch(() => undefined);
};

const useMatchStore = defineStore("useMatchStore", {
	state: () => {
		return {
			summonerId: -1,
			localSumId: -1,
			matchList: [] as SimpleMatchDetailsTypes[] | null,
			recentMatchList20: [] as SimpleMatchDetailsTypes[],
			specialMatchList: [] as SimpleMatchDetailsTypes[],
			matchAvailableCount: 0,
			matchTotalCount: null as number | null,
			matchPageCount: 1,
			participantsInfo: null as null | ParticipantsInfo,
			sumInfo: null as { info: summonerInfo } | null,
			matchLoading: true,
			detailLoading: false,
			matchError: null as string | null,
			matchSource: null as MatchHistorySource | null,
			matchSourceEndpoints: [] as MatchHistoryEndpoint[],
			matchLocalCacheUsed: false,
			historyCacheSync: createIdleHistoryCacheSync(),
			analysisData: null as RencentDataAnalysisTypes | null,
			// 页面首次加载和搜索可以同时触发，只有最后一次查询允许提交结果。
			queryRequestId: 0,
			detailRequestId: 0,
		};
	},
	actions: {
		async init(summonerId?: number, locSumId?: number) {
			const queryRequestId = ++this.queryRequestId;
			// 新的召唤师查询会让旧的详情请求失效，避免旧响应覆盖新页面。
			++this.detailRequestId;
			this.matchLoading = true;
			this.detailLoading = false;
			this.matchError = null;
			this.matchSource = null;
			this.matchSourceEndpoints = [];
			this.matchLocalCacheUsed = false;
			this.historyCacheSync = createIdleHistoryCacheSync();
			this.participantsInfo = null;
			try {
				const sumResult = await baseMatch.gerSummonerInfo(summonerId);
				if (queryRequestId !== this.queryRequestId) {
					return;
				}
				if (sumResult === null) {
					this.matchList = null;
					this.matchError =
						"无法读取该召唤师信息，请确认 Riot ID 正确且客户端仍处于登录状态。";
					return;
				}
				if (summonerId === undefined && locSumId === undefined) {
					this.localSumId = sumResult.summonerInfo.currentId;
				} else if (locSumId !== undefined) {
					this.localSumId = locSumId;
				}
				this.sumInfo = {
					info: sumResult.summonerInfo,
				};
				this.summonerId = sumResult.summonerInfo.currentId;
				if (summonerId === undefined && locSumId === undefined) {
					persistLocalSummoner(sumResult.summonerInfo);
				}
				this.matchList = [];
				this.recentMatchList20 = [];
				this.analysisData = null;
				this.matchAvailableCount = 0;
				this.matchTotalCount = null;
				this.matchPageCount = 1;
				const localPuuid = (() => {
					try {
						return (JSON.parse(localStorage.getItem("sumInfo") || "null") as {
							puuid?: string;
						} | null)?.puuid;
					} catch {
						return undefined;
					}
				})();
				const isCurrentUser =
					(summonerId === undefined && locSumId === undefined) ||
					(localPuuid !== undefined &&
						localPuuid === sumResult.summonerInfo.puuid);
				await this.fetchAndProcessMatches(
					this.sumInfo.info.puuid,
					queryRequestId,
					isCurrentUser,
				);
			} catch (error) {
				if (queryRequestId !== this.queryRequestId) {
					return;
				}
				logger.error({
					tag: "queryMatch.fetch_history",
					message: "初始化历史战绩失败",
					context: {
						queryRequestId,
						error: String(error).slice(0, 200),
					},
				});
				this.matchList = null;
				this.recentMatchList20 = [];
				this.analysisData = null;
				this.matchAvailableCount = 0;
				this.matchTotalCount = null;
				this.matchPageCount = 1;
				this.matchError =
					"战绩接口请求失败，请稍后重试；如果该账号没有公开战绩，客户端不会返回对局数据。";
			} finally {
				if (queryRequestId === this.queryRequestId) {
					this.matchLoading = false;
				}
			}
		},
		async getMatchList(page = 1) {
			if (this.sumInfo === null) {
				return false;
			}
			const puuid = this.sumInfo.info.puuid;
			const pageSize = HISTORY_HOMEPAGE_PAGE_SIZE;
			const offset = (page - 1) * pageSize;

			// 第 1 页：优先用首屏已经拿到的 20 场，避免重复请求
			if (
				page === 1 &&
				this.recentMatchList20.length >= pageSize
			) {
				this.matchList = this.recentMatchList20.slice(0, pageSize);
				if (this.matchList.length === 0) {
					this.matchError = "该页没有可展示的对局数据。";
					return false;
				}
				await this.getMatchDetail(this.matchList[0].gameId);
				return true;
			}

			// 任意页：先查本地 PG。若目标页尚未缓存，按服务器 20 场一页
			// 补齐到目标偏移；主动缓存只负责前三个服务器页，之后由翻页
			// 按需读取，不把主动缓存上限误当成分页上限。
			let cached = await getCachedHistoryPage(puuid, offset, pageSize);
			let reachedEnd = false;
			if (cached.length < pageSize) {
				const targetEnd = offset + pageSize;
				const lastServerPage = Math.floor(
					(targetEnd - 1) / HISTORY_SERVER_PAGE_SIZE,
				);
				for (let serverPage = 0; serverPage <= lastServerPage; serverPage += 1) {
					const result = await baseMatch.fetchAndCacheSinglePage(
						puuid,
						serverPage,
					);
					if (result.reachedEnd) {
							reachedEnd = true;
							break;
						}
					}
				cached = await getCachedHistoryPage(puuid, offset, pageSize);
			}
			this.matchList = baseMatch.getSimpleMatchList(cached, puuid);
			if (reachedEnd && this.matchTotalCount === null) {
				// 服务器已明确到末尾时，撤销“未知总数”场景下
				// 为了允许继续翻页而临时多展示的页。
				this.matchAvailableCount = offset + this.matchList.length;
				this.matchPageCount = Math.max(
					1,
					Math.ceil(
						this.matchAvailableCount / HISTORY_HOMEPAGE_PAGE_SIZE,
					),
				);
			} else {
				await this.refreshMatchAvailableCount(
					puuid,
					offset + this.matchList.length,
				);
			}

			if (this.matchList.length === 0) {
				this.matchError = "本地暂无更早战绩。";
				return false;
			}
			await this.getMatchDetail(this.matchList[0].gameId);
			return true;
		},
		async refreshMatchAvailableCount(puuid: string, minimumCount = 0) {
			if (this.matchTotalCount !== null) {
				// 服务器已经给出总数时，PG 当前只缓存前三页也不能覆盖
				// 这个值，否则翻页后会把顶部页数缩回缓存页数。
				this.matchAvailableCount = this.matchTotalCount;
				this.matchPageCount = Math.max(
					1,
					Math.ceil(
						this.matchTotalCount / HISTORY_HOMEPAGE_PAGE_SIZE,
					),
				);
				return;
			}
			const all = await getCachedHistory({
				puuid,
				limit: Math.max(HISTORY_CACHE_SYNC_LIMIT, minimumCount),
			});
			this.matchAvailableCount = Math.max(
				this.matchAvailableCount,
				minimumCount,
				all.length,
			);
			this.matchPageCount = Math.max(
				1,
				Math.ceil(
					this.matchAvailableCount / HISTORY_HOMEPAGE_PAGE_SIZE,
				),
			);
		},
		async fetchAndProcessMatches(
			puuid: string,
			requestId?: number,
			isCurrentUser = false,
		) {
			const queryRequestId = requestId ?? this.queryRequestId;
			// 主窗口首屏只拉最近 20 场，避免触发服务器三页 (60 场) 的
			// 200ms 串行延迟。分析面板 / 翻页时再走全量窗口。
			const matchResult = await baseMatch.dealMatchHistoryWithSource(
				puuid,
				0,
				HISTORY_SERVER_PAGE_SIZE,
				HISTORY_SERVER_PAGE_SIZE,
			);
			if (queryRequestId !== this.queryRequestId) {
				return false;
			}
			if (matchResult === null) {
				this.matchList = null;
				this.recentMatchList20 = [];
				this.analysisData = null;
				this.matchError =
					"战绩接口没有返回数据，请检查该账号是否公开战绩，或稍后重试。";
				return false;
			}

			this.matchSource = matchResult.source;
			this.matchSourceEndpoints = matchResult.sourceEndpoints;
			this.matchLocalCacheUsed = matchResult.localCacheUsed;
			const matchResults = matchResult.matches;
			this.recentMatchList20 = matchResults;
			this.matchTotalCount = matchResult.totalCount;
			this.matchAvailableCount =
				matchResult.totalCount ??
				Math.max(matchResult.availableCount, matchResults.length);
			this.matchPageCount = Math.max(
				1,
				Math.ceil(this.matchAvailableCount / HISTORY_HOMEPAGE_PAGE_SIZE),
			);
			this.matchList = this.recentMatchList20.slice(0, HISTORY_HOMEPAGE_PAGE_SIZE);
			this.analysisData =
				this.recentMatchList20.length === 0
					? null
					: findTopChamp(this.recentMatchList20 as any);
			if (this.matchList.length === 0) {
				this.matchError = "该召唤师没有可展示的公开战绩。";
				return false;
			}

			// 先交付列表，首场详情单独加载。详情接口慢或失败时不能遮住
			// 已经成功返回的战绩列表。
			void this.getMatchDetail(this.matchList[0].gameId);

			if (isCurrentUser) {
				void this.syncCurrentUserHistory(puuid, queryRequestId);
			}
			return true;
		},
		async syncCurrentUserHistory(puuid: string, requestId: number) {
			const result = await baseMatch.syncCurrentUserHistory(
				puuid,
				(progress) => {
					if (requestId === this.queryRequestId) {
						this.historyCacheSync = progress;
					}
				},
				() => requestId === this.queryRequestId,
			);
			if (requestId !== this.queryRequestId) return;

			this.historyCacheSync = result;
			// 主动缓存只扫描前三个服务器页，但这不应限制首页分页。
			// 只要服务器报告总数，顶部页数就严格按服务器总数计算；
			// 没有总数时才回退到当前已缓存数量。
			if (result.totalCount !== null) {
				this.matchTotalCount = result.totalCount;
				this.matchAvailableCount = result.totalCount;
				this.matchPageCount = Math.max(
					1,
					Math.ceil(
						result.totalCount / HISTORY_HOMEPAGE_PAGE_SIZE,
					),
				);
				return;
			}

			if (this.matchTotalCount === null) {
				const availableCount = Math.max(
					result.cachedGames,
					this.matchAvailableCount,
				);
				this.matchAvailableCount = availableCount;
				this.matchPageCount = Math.max(
					1,
					Math.ceil(
						this.matchAvailableCount / HISTORY_HOMEPAGE_PAGE_SIZE,
					),
					result.kind === "limited"
						? Math.ceil(
							this.matchAvailableCount / HISTORY_HOMEPAGE_PAGE_SIZE,
						) + 1
						: 1,
				);
			}
		},
		async getMatchFromPage(
			page: number,
			puuid: string,
			requestId?: number,
		) {
			const queryRequestId = requestId ?? this.queryRequestId;
			// 翻页也只取最近 20 场窗口；超过 20 场的页面依赖 PG 缓存
			// 提供，避免每次翻页都重新拉服务器 60 场。
			const matchResult = await baseMatch.dealMatchHistoryWithSource(
				puuid,
				(page - 1) * HISTORY_HOMEPAGE_PAGE_SIZE,
				page * HISTORY_HOMEPAGE_PAGE_SIZE,
				HISTORY_SERVER_PAGE_SIZE,
			);
			if (queryRequestId !== this.queryRequestId) {
				return false;
			}

			if (matchResult !== null) {
				this.matchSource = matchResult.source;
				this.matchSourceEndpoints = matchResult.sourceEndpoints;
				this.matchLocalCacheUsed = matchResult.localCacheUsed;
				this.matchAvailableCount = matchResult.availableCount;
				this.matchPageCount = Math.max(
					1,
					Math.ceil(
						this.matchAvailableCount / HISTORY_HOMEPAGE_PAGE_SIZE,
					),
				);
			}
			const matchItems = matchResult?.matches ?? [];

			// 获取战绩详细数据
			if (matchResult === null) {
				this.matchList = null;
				this.matchError = "该页战绩接口没有返回数据，请稍后重试。";
				return false;
			} else if (matchItems.length === 0) {
				this.matchList = [];
				this.matchError = "该页没有可展示的对局数据。";
				return false;
			}

			// 处理其它页面的重复数据
			if (
				page > 1 &&
				this.recentMatchList20[0].gameId === matchItems[0].gameId
			) {
				this.matchList = [];
				this.matchError = "该页没有更多可展示的对局数据。";
				return false;
			}

			this.matchList = matchItems.slice(0, 9);
			await this.getMatchDetail(this.matchList[0].gameId);
		},
		async getSpecialMatchList(queueId: number, puuid?: string) {
			if (queueId === 0) {
				this.specialMatchList = [];
				this.getMatchList();
				return;
			}

			const matchSpecialResult = await baseMatch.querySpecialMatchWithSource(
				<string>puuid,
				queueId,
			);
			const matchSpecialList = matchSpecialResult.matches;
			this.matchSource = matchSpecialResult.source;
			this.matchSourceEndpoints = matchSpecialResult.sourceEndpoints;
			this.matchLocalCacheUsed = matchSpecialResult.localCacheUsed;
			if (matchSpecialList.length !== 0) {
				this.specialMatchList = matchSpecialList;
				this.matchAvailableCount = matchSpecialList.length;
				this.matchPageCount = Math.max(
					1,
					Math.ceil(
						this.matchAvailableCount / HISTORY_HOMEPAGE_PAGE_SIZE,
					),
				);
				this.fromSpecialToMatchList();
			} else {
				this.matchList = [];
				this.matchAvailableCount = 0;
				this.matchPageCount = 1;
				this.matchError = "该模式暂无可展示的公开战绩。";
			}
		},
		async getMatchDetail(gameId: number) {
			const detailRequestId = ++this.detailRequestId;
			this.detailLoading = true;
			this.participantsInfo = null;
			this.matchError = null;
			try {
				const participantsInfo = await matchDetials.queryGameDetail(
					gameId,
					this.summonerId,
					this.sumInfo?.info.puuid,
				);
				if (detailRequestId !== this.detailRequestId) {
					return false;
				}
				if (participantsInfo === null) {
					this.matchError =
						"对局列表已返回，但详情接口没有返回可展示的数据。";
					return false;
				}
				this.participantsInfo = participantsInfo;
				return true;
			} catch (error) {
				if (detailRequestId !== this.detailRequestId) {
					return false;
				}
				logger.error({
					tag: "queryMatch.fetch_details",
					message: "加载对局详情失败",
					context: {
						detailRequestId,
						error: String(error).slice(0, 200),
					},
				});
				this.participantsInfo = null;
				this.matchError =
					"对局详情查询失败，请切换其它对局重试；如果接口无数据，页面会保留当前提示。";
				return false;
			} finally {
				if (detailRequestId === this.detailRequestId) {
					this.detailLoading = false;
				}
			}
		},
		async queryMatchDetail(gameId: number, summonerId: number) {
			return await matchDetials.queryGameDetail(
				gameId,
				summonerId,
				this.sumInfo?.info.puuid,
			);
		},
		fromSpecialToMatchList(page = 1) {
			this.matchList = this.specialMatchList.slice(
				HISTORY_HOMEPAGE_PAGE_SIZE * (page - 1),
				HISTORY_HOMEPAGE_PAGE_SIZE * page,
			);
			if (this.matchList.length !== 0) {
				this.getMatchDetail(this.matchList[0].gameId);
			}
		},
		},
});

export default useMatchStore;
