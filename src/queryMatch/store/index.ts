import { defineStore } from "pinia";
import { ParticipantsInfo } from "@/queryMatch/utils/MatchDetail";
import { summonerInfo } from "@/lcu/types/SummonerTypes";
import BaseMatch from "@/queryMatch/utils/baseMatch";
import { SimpleMatchDetailsTypes } from "@/lcu/types/queryMatchLcuTypes";
import MatchDetails from "@/queryMatch/utils/matchDetails";
import { RencentDataAnalysisTypes } from "@/main/views/teammate/teammateTypes";
import { findTopChamp } from "@/main/views/teammate/utils";

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
			sumInfo: null as { info: summonerInfo; rank: string[] } | null,
			matchLoading: true,
			analysisData: null as RencentDataAnalysisTypes | null,
		};
	},
	actions: {
		async init(summonerId?: number, locSumId?: number) {
			this.matchLoading = true;
			this.participantsInfo = null;
			try {
				const sumResult = await baseMatch.gerSummonerInfo(summonerId);
				if (sumResult === null) {
					this.matchList = null;
					return;
				}
				if (summonerId === undefined && locSumId === undefined) {
					this.localSumId = sumResult.summonerInfo.currentId;
				} else if (locSumId !== undefined) {
					this.localSumId = locSumId;
				}
				this.sumInfo = {
					info: sumResult.summonerInfo,
					rank: sumResult.rankList,
				};
				this.summonerId = sumResult.summonerInfo.currentId;
				this.matchList = [];
				this.recentMatchList20 = [];
				this.analysisData = null;
				await this.fetchAndProcessMatches(this.sumInfo.info.puuid);
			} catch (error) {
				console.error("Failed to initialize match history", error);
				this.matchList = null;
				this.recentMatchList20 = [];
				this.analysisData = null;
			} finally {
				this.matchLoading = false;
			}
		},
		async getMatchList(page = 1) {
			if (this.sumInfo === null) {
				return false;
			}
			if (page < 3 && this.recentMatchList20.length > 18) {
				// 从缓存的20局中数据取值
				this.matchList = this.recentMatchList20.slice((page - 1) * 9, page * 9);
				await this.getMatchDetail(this.matchList[0].gameId);
				return true;
			} else {
				await this.getMatchFromPage(page, this.sumInfo.info.puuid);
				return true;
			}
		},
		async fetchAndProcessMatches(puuid: string) {
			const matchResults = await baseMatch.dealMatchHistory(puuid, 0, 20);
			if (matchResults !== null) {
				this.recentMatchList20 = matchResults;
				this.matchList = this.recentMatchList20.slice(0, 9);
				this.analysisData =
					this.recentMatchList20.length === 0
						? null
						: findTopChamp(this.recentMatchList20 as any);

				if (this.matchList.length !== 0) {
					await this.getMatchDetail(this.matchList[0].gameId);
				}
				return;
			}
			this.matchList = null;
			this.recentMatchList20 = [];
			this.analysisData = null;
		},
		async getMatchFromPage(page: number, puuid: string) {
			const matchItems = await baseMatch.dealMatchHistory(
				puuid,
				(page - 1) * 9,
				page * 9,
			);

			// 获取战绩详细数据
			if (matchItems === null) {
				this.matchList = null;
				return false;
			} else if (matchItems.length === 0) {
				this.matchList = [];
				return false;
			}

			// 处理其它页面的重复数据
			if (
				page > 1 &&
				this.recentMatchList20[0].gameId === matchItems[0].gameId
			) {
				this.matchList = [];
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

			const matchSpecialList = await baseMatch.querySpecialMatch(
				<string>puuid,
				queueId,
			);
			if (matchSpecialList.length !== 0) {
				this.specialMatchList = matchSpecialList;
				this.fromSpecialToMatchList();
			} else {
				this.matchList = [];
			}
		},
		async getMatchDetail(gameId: number) {
			try {
				this.participantsInfo = await matchDetials.queryGameDetail(
					gameId,
					this.summonerId,
					this.sumInfo?.info.puuid,
				);
			} catch (error) {
				console.error("Failed to load match details", error);
				this.participantsInfo = null;
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
