import { defineStore } from "pinia";
import { ParticipantsInfo } from "@/queryMatch/utils/MatchDetail";
import { summonerInfo } from "@/lcu/types/SummonerTypes";
import BaseMatch from "@/queryMatch/utils/baseMatch";
import { SimpleMatchDetailsTypes } from "@/lcu/types/queryMatchLcuTypes";
import MatchDetails from "@/queryMatch/utils/matchDetails";
import { RencentDataAnalysisTypes } from "@/queryMatch/utils/analysisTypes";
import { findTopChamp } from "@/queryMatch/utils/analysisSummary";
import { MatchHistorySource } from "@/lcu/aboutMatch";

const baseMatch = new BaseMatch();
const matchDetials = new MatchDetails();

const useMatchStore = defineStore("useMatchStore", {
	state: () => {
		return {
			summonerId: -1,
			localSumId: -1,
			matchList: [] as SimpleMatchDetailsTypes[] | null,
			recentMatchList20: [] as SimpleMatchDetailsTypes[],
			specialMatchList: [] as SimpleMatchDetailsTypes[],
			participantsInfo: null as null | ParticipantsInfo,
			sumInfo: null as { info: summonerInfo } | null,
			matchLoading: true,
			detailLoading: false,
			matchError: null as string | null,
			matchSource: null as MatchHistorySource | null,
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
				this.matchList = [];
				this.recentMatchList20 = [];
				this.analysisData = null;
				await this.fetchAndProcessMatches(
					this.sumInfo.info.puuid,
					queryRequestId,
				);
			} catch (error) {
				if (queryRequestId !== this.queryRequestId) {
					return;
				}
				console.error("Failed to initialize match history", error);
				this.matchList = null;
				this.recentMatchList20 = [];
				this.analysisData = null;
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
			if (page < 3 && this.recentMatchList20.length > 18) {
				// 从缓存的20局中数据取值
				this.matchList = this.recentMatchList20.slice((page - 1) * 9, page * 9);
				if (this.matchList.length === 0) {
					this.matchError = "该页没有可展示的对局数据。";
					return false;
				}
				await this.getMatchDetail(this.matchList[0].gameId);
				return true;
			} else {
				await this.getMatchFromPage(
					page,
					this.sumInfo.info.puuid,
					this.queryRequestId,
				);
				return true;
			}
		},
		async fetchAndProcessMatches(
			puuid: string,
			requestId?: number,
		) {
			const queryRequestId = requestId ?? this.queryRequestId;
			const matchResult = await baseMatch.dealMatchHistoryWithSource(
				puuid,
				0,
				20,
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
			const matchResults = matchResult.matches;
			this.recentMatchList20 = matchResults;
			this.matchList = this.recentMatchList20.slice(0, 9);
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
			return true;
		},
		async getMatchFromPage(
			page: number,
			puuid: string,
			requestId?: number,
		) {
			const queryRequestId = requestId ?? this.queryRequestId;
			const matchResult = await baseMatch.dealMatchHistoryWithSource(
				puuid,
				(page - 1) * 9,
				page * 9,
			);
			if (queryRequestId !== this.queryRequestId) {
				return false;
			}

			if (matchResult !== null) {
				this.matchSource = matchResult.source;
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
			if (matchSpecialList.length !== 0) {
				this.specialMatchList = matchSpecialList;
				this.fromSpecialToMatchList();
			} else {
				this.matchList = [];
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
				console.error("Failed to load match details", error);
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
			this.matchList = this.specialMatchList.slice(9 * (page - 1), 9 * page);
			if (this.matchList.length !== 0) {
				this.getMatchDetail(this.matchList[0].gameId);
			}
		},
	},
});

export default useMatchStore;
