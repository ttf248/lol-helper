import { invokeLcu } from "./index";
import { SgpMatchHistoryService } from "./sgpMatch";
import {
	Games,
	LcuMatchList,
	EntitlementsTokenTypes,
} from "./types/queryMatchLcuTypes";

import { GamesBySgp } from "./types/queryMatchSgpGameTypes";
import { logger } from "@/utils/logger";
import { cacheGameDetail } from "@/recentMatch/utils/databaseCache";

export type MatchHistorySource =
	| "lcu-current"
	| "lcu-puuid"
	| "sgp"
	| "postgres"
	| "mixed";

/**
 * 历史数据实际命中的接口。source 只用于兼容旧的聚合标签，
 * endpoints 才是界面展示和排查问题时应该信任的明细。
 */
export type MatchHistoryEndpoint =
	| "lcu-current-summoner"
	| "lcu-puuid"
	| "sgp-summary"
	| "sgp-summary-full"
	| "lcu-game-detail"
	| "postgres";

export const MATCH_HISTORY_SOURCE_LABELS: Record<MatchHistorySource, string> = {
	"lcu-current": "LCU（当前召唤师）",
	"lcu-puuid": "LCU（PUUID）",
	sgp: "SGP（区域服务）",
	postgres: "PostgreSQL 本地缓存",
	mixed: "LCU + SGP（混合）",
};

export const MATCH_HISTORY_ENDPOINT_LABELS: Record<MatchHistoryEndpoint, string> = {
	"lcu-current-summoner": "LCU 当前召唤师历史接口",
	"lcu-puuid": "LCU PUUID 历史接口",
	"sgp-summary": "SGP SUMMARY 历史接口",
	"sgp-summary-full": "SGP SUMMARY 完整参与者接口",
	"lcu-game-detail": "LCU 对局详情接口",
	postgres: "PostgreSQL 详情缓存",
};

export const MATCH_HISTORY_ENDPOINT_PATHS: Record<MatchHistoryEndpoint, string> = {
	"lcu-current-summoner":
		"/lol-match-history/v1/products/lol/current-summoner/matches?begIndex={start}&endIndex={end}",
	"lcu-puuid":
		"/lol-match-history/v1/products/lol/{puuid}/matches?begIndex={start}&endIndex={end}",
	"sgp-summary":
		"/match-history-query/v1/products/lol/player/{puuid}/SUMMARY?startIndex={start}&count={count}",
	"sgp-summary-full":
		"/match-history-query/v1/products/lol/player/{puuid}/SUMMARY?startIndex={start}&count={count}",
	"lcu-game-detail": "/lol-match-history/v1/games/{gameId}",
	postgres: "postgres://frank@localhost:5432/frank/game_details/{game_id}",
};

export type MatchHistoryGame = Games | GamesBySgp;

export interface MatchHistoryQueryResult {
	games: MatchHistoryGame[];
	source: MatchHistorySource;
	endpoints: MatchHistoryEndpoint[];
	/** LCU 在返回完整列表或明确提供总数时给出的历史总场数。 */
	totalCount: number | null;
}

interface MatchHistoryBatchResult extends MatchHistoryQueryResult {}

interface MatchHistoryPageResult {
	games: Games[];
	totalCount: number | null;
}

const combineSources = (sources: MatchHistorySource[]): MatchHistorySource => {
	const uniqueSources = Array.from(new Set(sources));
	return uniqueSources.length === 1 ? uniqueSources[0] : "mixed";
};

const combineEndpoints = (
	endpoints: MatchHistoryEndpoint[],
): MatchHistoryEndpoint[] => Array.from(new Set(endpoints));

const tokenFetcher = async (): Promise<string | null> => {
	const startedAt = Date.now();
	const url = "/entitlements/v1/token";
	logger.info({
		tag: "lcu.token",
		message: "entitlements token 拉取发起",
		context: { purpose: "SGP 历史接口鉴权", url, method: "GET" },
	});
	const entitlements: EntitlementsTokenTypes | null = await invokeLcu(
		"get",
		url,
	);
	if (entitlements === null) {
		logger.error({
			tag: "lcu.token",
			message: "entitlements token 获取失败",
			context: {
				purpose: "SGP 历史接口鉴权",
				url,
				duration_ms: Date.now() - startedAt,
			},
		});
		return null;
	}
	logger.info({
		tag: "lcu.token",
		message: "entitlements token 拉取完成",
		context: {
			purpose: "SGP 历史接口鉴权",
			url,
			token_bytes: entitlements.accessToken?.length ?? 0,
			entitlements_token_bytes: entitlements.token?.length ?? 0,
		},
		durationMs: Date.now() - startedAt,
	}, JSON.stringify(entitlements));
	return entitlements.accessToken;
};

const sgpService = new SgpMatchHistoryService(tokenFetcher);

const isCurrentSummoner = (puuid: string): boolean => {
	try {
		const localSumInfo = JSON.parse(
			localStorage.getItem("sumInfo") || "null",
		) as { puuid?: string } | null;
		return localSumInfo?.puuid === puuid;
	} catch {
		return false;
	}
};

/**
 * 当前玩家的历史记录使用 LCU 专用 endpoint。新客户端对该 endpoint
 * 的可用性与返回范围都优于按 PUUID 反查的历史接口。
 */
const fetchCurrentSummonerMatchHistory = async (
	begIndex: number,
	count: number,
): Promise<MatchHistoryPageResult | null> => {
	const startedAt = Date.now();
	const url = `/lol-match-history/v1/products/lol/current-summoner/matches`;
	const query = new URLSearchParams({
		begIndex: String(begIndex),
		endIndex: String(begIndex + count),
	});
	const fullUrl = `${url}?${query.toString()}`;
	logger.info({
		tag: "lcu.history",
		message: "LCU current-summoner 历史接口发起",
		context: {
			purpose: "查询当前召唤师最近 N 场历史战绩",
			url: fullUrl,
			method: "GET",
			beg_index: begIndex,
			count,
		},
	});
	try {
		const matchList = await invokeLcu<LcuMatchList>(
			"get",
			fullUrl,
		);
		if (matchList === null) {
			logger.warn({
				tag: "lcu.history",
				message: "LCU current-summoner 历史接口无响应",
				context: {
					purpose: "查询当前召唤师最近 N 场历史战绩",
					url: fullUrl,
					beg_index: begIndex,
					count,
					duration_ms: Date.now() - startedAt,
				},
			});
			return null;
		}
		const history = matchList?.games;
		const games = history?.games;
		if (!Array.isArray(games)) {
			logger.warn({
				tag: "lcu.history",
				message: "LCU current-summoner 历史接口响应缺少 games 数组",
				context: {
					purpose: "查询当前召唤师最近 N 场历史战绩",
					url: fullUrl,
					beg_index: begIndex,
					count,
					duration_ms: Date.now() - startedAt,
				},
			}, JSON.stringify(matchList));
			return null;
		}
		// 此前会把单局响应塞进一个无界的 Map，重启后还得重打服务器。
		// Phase 5 后由 PostgreSQL `game_details` 接管（cacheGameDetail），
		// 这里不再缓存整包响应。
		const responseStart = Number(history?.gameIndexBegin);
		const responseEnd = Number(history?.gameIndexEnd);
		// 新版 LCU 会按 query 参数返回分页结果，部分客户端/大区则会
		// 忽略 begIndex/endIndex，永远返回最近 21 场。非首页不能把这种
		// 响应 slice 一下就当成了目标页，否则会把“最近第 21 场”误当成
		// 历史末尾。返回 null 让调用方继续尝试 PUUID/SGP 接口。
		const paginationHonored =
			begIndex === 0 && !Number.isFinite(responseStart)
				? true
				: responseStart === begIndex;
		if (begIndex > 0 && !paginationHonored) {
			logger.warn({
				tag: "lcu.history",
				message: "LCU current-summoner 未按偏移分页，交给下一级接口",
				context: {
					purpose: "查询当前召唤师更早历史战绩",
					url: fullUrl,
					beg_index: begIndex,
					count,
					response_start: Number.isFinite(responseStart) ? responseStart : null,
					response_end: Number.isFinite(responseEnd) ? responseEnd : null,
					games_count: games.length,
					duration_ms: Date.now() - startedAt,
				},
			});
			return null;
		}
		const advertisedCount = Number(history?.gameCount);
		// gameCount 在不同 LCU 版本里既可能是历史总数，也可能只是本次
		// 返回窗口的数量。只有它明确大于当前响应覆盖的末尾时才采信，
		// 避免日志中的 gameCount=21 把可翻页数据错误锁死为 21 场。
		const responseEndExclusive = Math.max(
			Number.isFinite(responseStart)
				? responseStart + games.length
				: begIndex + games.length,
			Number.isFinite(responseEnd) ? responseEnd + 1 : 0,
		);
		const totalCount =
			Number.isFinite(advertisedCount) &&
			advertisedCount > responseEndExclusive
				? advertisedCount
				: null;
		logger.info({
			tag: "lcu.history",
			message: "LCU current-summoner 历史接口响应成功",
			context: {
				purpose: "查询当前召唤师最近 N 场历史战绩",
				url: fullUrl,
				beg_index: begIndex,
				count,
				games_count: games.length,
				game_index_begin: Number.isFinite(responseStart) ? responseStart : null,
				game_index_end: Number.isFinite(responseEnd) ? responseEnd : null,
				game_count: totalCount,
				pagination_honored: paginationHonored,
				duration_ms: Date.now() - startedAt,
			},
			durationMs: Date.now() - startedAt,
		}, JSON.stringify(matchList));
		return {
			games: paginationHonored ? games : games.slice(begIndex, begIndex + count),
			totalCount,
		};
	} catch (error) {
		logger.warn({
			tag: "lcu.history",
			message: "LCU current-summoner 历史接口异常",
			context: {
				purpose: "查询当前召唤师最近 N 场历史战绩",
				url: fullUrl,
				beg_index: begIndex,
				count,
				duration_ms: Date.now() - startedAt,
				error: String(error).slice(0, 500),
			},
		});
		return null;
	}
};

/**
 * LCU 仍然提供按 PUUID 查询历史记录的接口。它不应和
 * current-summoner endpoint 混用：前者可查询同区其它召唤师，后者只代表
 * 当前登录用户。腾讯服客户端对这个接口的兼容性通常比 SGP 更好，优先尝试。
 */
const fetchSummonerMatchHistoryFromLcu = async (
	puuid: string,
	begIndex: number,
	count: number,
): Promise<MatchHistoryPageResult | null> => {
	const startedAt = Date.now();
	const url = `/lol-match-history/v1/products/lol/${encodeURIComponent(puuid)}/matches`;
	const query = new URLSearchParams({
		begIndex: String(begIndex),
		endIndex: String(begIndex + count),
	});
	const fullUrl = `${url}?${query.toString()}`;
	logger.info({
		tag: "lcu.history",
		message: "LCU PUUID 历史接口发起",
		context: {
			purpose: "按 PUUID 查询最近 N 场历史战绩",
			url: fullUrl,
			method: "GET",
			puuid,
			beg_index: begIndex,
			count,
		},
	});
	try {
		const matchList = await invokeLcu<LcuMatchList>(
			"get",
			fullUrl,
		);
		if (matchList === null) {
			logger.warn({
				tag: "lcu.history",
				message: "LCU PUUID 历史接口无响应",
				context: {
					purpose: "按 PUUID 查询最近 N 场历史战绩",
					url: fullUrl,
					puuid,
					beg_index: begIndex,
					count,
					duration_ms: Date.now() - startedAt,
				},
			});
			return null;
		}
		const games = matchList?.games?.games;
		if (!Array.isArray(games)) {
			logger.warn({
				tag: "lcu.history",
				message: "LCU PUUID 历史接口响应缺少 games 数组",
				context: {
					purpose: "按 PUUID 查询最近 N 场历史战绩",
					url: fullUrl,
					puuid,
					beg_index: begIndex,
					count,
					duration_ms: Date.now() - startedAt,
				},
			}, JSON.stringify(matchList));
			return null;
		}
		// 此前会把单局响应塞进一个无界的 Map，重启后还得重打服务器。
		// Phase 5 后由 PostgreSQL `game_details` 接管（cacheGameDetail），
		// 这里不再缓存整包响应。
		const history = matchList?.games;
		const responseStart = Number(history?.gameIndexBegin);
		const responseEnd = Number(history?.gameIndexEnd);
		const paginationHonored =
			begIndex === 0 && !Number.isFinite(responseStart)
				? true
				: responseStart === begIndex;
		if (begIndex > 0 && !paginationHonored) {
			logger.warn({
				tag: "lcu.history",
				message: "LCU PUUID 历史接口未按偏移分页，交给 SGP 接口",
				context: {
					purpose: "按 PUUID 查询更早历史战绩",
					url: fullUrl,
					puuid,
					beg_index: begIndex,
					count,
					response_start: Number.isFinite(responseStart) ? responseStart : null,
					response_end: Number.isFinite(responseEnd) ? responseEnd : null,
					games_count: games.length,
					duration_ms: Date.now() - startedAt,
				},
			});
			return null;
		}
		const advertisedCount = Number(history?.gameCount);
		const responseEndExclusive = Math.max(
			Number.isFinite(responseStart)
				? responseStart + games.length
				: begIndex + games.length,
			Number.isFinite(responseEnd) ? responseEnd + 1 : 0,
		);
		const totalCount =
			Number.isFinite(advertisedCount) &&
			advertisedCount > responseEndExclusive
				? advertisedCount
				: null;
		logger.info({
			tag: "lcu.history",
			message: "LCU PUUID 历史接口响应成功",
			context: {
				purpose: "按 PUUID 查询最近 N 场历史战绩",
				url: fullUrl,
				puuid,
				beg_index: begIndex,
				count,
				games_count: games.length,
				game_index_begin: Number.isFinite(responseStart) ? responseStart : null,
				game_index_end: Number.isFinite(responseEnd) ? responseEnd : null,
				game_count: totalCount,
				pagination_honored: paginationHonored,
				duration_ms: Date.now() - startedAt,
			},
			durationMs: Date.now() - startedAt,
		}, JSON.stringify(matchList));
		return {
			games: paginationHonored ? games : games.slice(begIndex, begIndex + count),
			totalCount,
		};
	} catch (error) {
		logger.warn({
			tag: "lcu.history",
			message: "LCU PUUID 历史接口异常",
			context: {
				purpose: "按 PUUID 查询最近 N 场历史战绩",
				url: fullUrl,
				puuid,
				beg_index: begIndex,
				count,
				duration_ms: Date.now() - startedAt,
				error: String(error).slice(0, 500),
			},
		});
		return null;
	}
};

// 关系分析必须拿到同一局的多名参与者。LCU 的部分历史接口虽然返回
// 了对局数量，但 participants 里可能只有目标玩家，不能当作完整历史。
const hasParticipantRoster = (games: MatchHistoryGame[]): boolean =>
	games.length > 0 &&
	games.every(
		(game) => {
			if (!Array.isArray(game.participants) || game.participants.length < 5) {
				return false;
			}
			if ("participantIdentities" in game) {
				const identities = new Set(
					(game.participantIdentities || [])
						.filter((item) => {
							const player = item.player as any;
							return Boolean(
								player?.puuid ||
								player?.summonerId ||
								player?.summonerName,
							);
						})
						.map((item) => item.participantId),
				);
				return identities.size >= 5;
			}
			return game.participants.filter((participant: any) =>
				Boolean(
					participant?.puuid ||
					participant?.summonerId ||
					participant?.summonerName,
				),
			).length >= 5;
		},
	);

/**
 * LCU PUUID 历史接口在部分客户端也能返回完整十人 participant；这条路径
 * 不会经过 sgpMatch.ts，因此必须在这里把原始详情和字段化明细写入 PG。
 * 单条失败不阻断历史列表，但必须等待全部写入结束，避免 fire-and-forget
 * 在页面切换/应用退出时丢失详情。
 */
const persistLcuFullDetails = async (games: Games[]): Promise<void> => {
	const results = await Promise.all(
		games.map((game) => cacheGameDetail(game, undefined, "lcu-history-full")),
	);
	const failed = results.filter((result) => !result).length;
	if (failed > 0) {
		logger.warn({
			tag: "lcu.history",
			message: "LCU 完整历史已获取，但部分详情写入 PostgreSQL 失败",
			context: {
				purpose: "持久化完整参与者历史",
				games: games.length,
				detail_write_failed: failed,
			},
		});
	}
};

// 辅助函数：处理单次请求
const fetchMatchHistory = async (
	puuid: string,
	begIndex: number,
	endIndex: number,
	fullParticipants = false,
): Promise<MatchHistoryBatchResult> => {
	const stageStartedAt = Date.now();
	logger.info({
		tag: "lcu.history",
		message: "历史接口三级降级开始",
		context: {
			purpose: fullParticipants
				? "拉取完整参与者历史（团队/开黑分析用）"
				: "拉取摘要历史（胜率统计用）",
			puuid,
			beg_index: begIndex,
			count: endIndex,
			full_participants: fullParticipants,
		},
	});
	// 普通战绩列表可以使用当前召唤师历史 endpoint；它仍然是历史数据，
	// 不是当前正在进行的对局。完整分析则必须继续检查参与者是否齐全。
	// current-summoner 在部分腾讯服客户端只提供最近 21 场，而且会忽略
	// begIndex。它只适合作为当前用户的首屏来源；更早页交给 PUUID/SGP。
	if (!fullParticipants && isCurrentSummoner(puuid) && begIndex === 0) {
		const currentResult = await fetchCurrentSummonerMatchHistory(
			begIndex,
			endIndex,
		);
		if (currentResult !== null) {
			logger.info({
				tag: "lcu.history",
				message: "历史接口解析完成",
				context: {
					purpose: fullParticipants
						? "拉取完整参与者历史（团队/开黑分析用）"
						: "拉取摘要历史（胜率统计用）",
					puuid,
					beg_index: begIndex,
					count: endIndex,
					full_participants: fullParticipants,
					resolved: "lcu-current-summoner",
					count_games: currentResult.games.length,
					game_count: currentResult.totalCount,
					stage_duration_ms: Date.now() - stageStartedAt,
				},
			});
			return {
				games: currentResult.games,
				source: "lcu-current",
				endpoints: ["lcu-current-summoner"],
				totalCount: currentResult.totalCount,
			};
		}
	}

	// 先走 LCU 的 PUUID endpoint。对于腾讯服，它通常能直接返回他人的
	// 简要战绩；只有客户端拒绝或返回空结果时才需要 SGP。
	const lcuResult = await fetchSummonerMatchHistoryFromLcu(
		puuid,
		begIndex,
		endIndex,
	);
	if (
		lcuResult !== null &&
		lcuResult.games.length > 0 &&
		(!fullParticipants || hasParticipantRoster(lcuResult.games))
	) {
		if (fullParticipants) {
			await persistLcuFullDetails(lcuResult.games);
		}
		logger.info({
			tag: "lcu.history",
			message: "历史接口解析完成",
			context: {
				purpose: fullParticipants
					? "拉取完整参与者历史（团队/开黑分析用）"
					: "拉取摘要历史（胜率统计用）",
				puuid,
				beg_index: begIndex,
				count: endIndex,
				full_participants: fullParticipants,
				resolved: "lcu-puuid",
				count_games: lcuResult.games.length,
				game_count: lcuResult.totalCount,
				stage_duration_ms: Date.now() - stageStartedAt,
			},
		});
		return {
			games: lcuResult.games,
			source: "lcu-puuid",
			endpoints: ["lcu-puuid"],
			totalCount: lcuResult.totalCount,
		};
	}

	try {
		const sgpRequest = {
			playerPuuid: puuid,
			start: begIndex,
			count: endIndex,
		};
		const sgpGames = fullParticipants
			? await sgpService.getFullMatchHistory(sgpRequest)
			: await sgpService.getMatchHistory(sgpRequest);
		if (sgpGames.length > 0) {
			logger.info({
				tag: "lcu.history",
				message: "历史接口解析完成",
				context: {
					purpose: fullParticipants
						? "拉取完整参与者历史（团队/开黑分析用）"
						: "拉取摘要历史（胜率统计用）",
					puuid,
					beg_index: begIndex,
					count: endIndex,
					full_participants: fullParticipants,
					resolved: fullParticipants ? "sgp-summary-full" : "sgp-summary",
					count_games: sgpGames.length,
					stage_duration_ms: Date.now() - stageStartedAt,
				},
			});
			return {
				games: sgpGames,
				source: "sgp",
				endpoints: [fullParticipants ? "sgp-summary-full" : "sgp-summary"],
				totalCount: null,
			};
		}
	} catch (sgpError) {
		logger.warn({
			tag: "lcu.history",
			message: "SGP 历史接口失败，回退到 LCU",
			context: {
				purpose: fullParticipants
					? "拉取完整参与者历史（团队/开黑分析用）"
					: "拉取摘要历史（胜率统计用）",
				puuid,
				beg_index: begIndex,
				count: endIndex,
				full_participants: fullParticipants,
				resolved: "sgp-error",
				error: String(sgpError).slice(0, 500),
				stage_duration_ms: Date.now() - stageStartedAt,
			},
		});
	}

	// SGP 不可用时，仍允许页面显示目标玩家的历史胜率；但这里明确是
	// 降级数据，调用方会通过 participants 数量判断关系分析是否可信。
	if (isCurrentSummoner(puuid) && begIndex === 0) {
		const currentResult = await fetchCurrentSummonerMatchHistory(
			begIndex,
			endIndex,
		);
		if (currentResult !== null && currentResult.games.length > 0) {
			logger.info({
				tag: "lcu.history",
				message: "历史接口解析完成（LCU 降级）",
				context: {
					purpose: fullParticipants
						? "拉取完整参与者历史（团队/开黑分析用）"
						: "拉取摘要历史（胜率统计用）",
					puuid,
					beg_index: begIndex,
					count: endIndex,
					full_participants: fullParticipants,
					resolved: "lcu-current-summoner",
					count_games: currentResult.games.length,
					game_count: currentResult.totalCount,
					stage_duration_ms: Date.now() - stageStartedAt,
				},
			});
			return {
				games: currentResult.games,
				source: "lcu-current",
				endpoints: ["lcu-current-summoner"],
				totalCount: currentResult.totalCount,
			};
		}
	}
	if (lcuResult !== null) {
		logger.info({
			tag: "lcu.history",
			message: "历史接口解析完成（LCU 降级）",
			context: {
				purpose: fullParticipants
					? "拉取完整参与者历史（团队/开黑分析用）"
					: "拉取摘要历史（胜率统计用）",
				puuid,
				beg_index: begIndex,
				count: endIndex,
				full_participants: fullParticipants,
				resolved: "lcu-puuid",
				count_games: lcuResult.games.length,
				game_count: lcuResult.totalCount,
				stage_duration_ms: Date.now() - stageStartedAt,
			},
		});
		return {
			games: lcuResult.games,
			source: "lcu-puuid",
			endpoints: ["lcu-puuid"],
			totalCount: lcuResult.totalCount,
		};
	}
	logger.warn({
		tag: "lcu.history",
		message: "历史接口全部失败，无可用数据",
		context: {
			purpose: fullParticipants
				? "拉取完整参与者历史（团队/开黑分析用）"
				: "拉取摘要历史（胜率统计用）",
			puuid,
			beg_index: begIndex,
			count: endIndex,
			full_participants: fullParticipants,
			resolved: "none",
			stage_duration_ms: Date.now() - stageStartedAt,
		},
	});
	throw new Error("Match history interfaces returned no data");
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 历史分析、个人战绩页和对局内面板可能同时请求同一名玩家的同一段
// 历史。只合并进行中的请求，不长期缓存结果，避免客户端切换账号后读到
// 旧数据，同时消除并发页面造成的重复 LCU/SGP 请求。
const inFlightHistoryRequests = new Map<
	string,
	Promise<MatchHistoryQueryResult | null>
>();

// 摘要接口的串行分页实现；完整参与者分页由下面的并行实现处理。
const splitRequestsSequential = async (
	puuid: string,
	begIndex: number,
	endIndex: number,
	fullParticipants = false,
): Promise<MatchHistoryBatchResult> => {
	const step = 20; // 接口单次最多请求 20 条
	let allGames: MatchHistoryGame[] = [];
	const sources: MatchHistorySource[] = [];
	const endpoints: MatchHistoryEndpoint[] = [];
	let totalCount: number | null = null;

	// 1. 计算总共需要获取的数量
	const totalToFetch = endIndex - begIndex;

	// 2. 使用 offset (偏移量) 进行循环
	for (let i = 0; i < totalToFetch; i += step) {
		// 计算本次应该请求的数量 (最后一次可能不足 step 条)
		const currentCount = Math.min(step, totalToFetch - i);

		// 计算本次请求的起始索引
		const currentStartIndex = begIndex + i;

		// 3. 发起请求
		const result = await fetchMatchHistory(
			puuid,
			currentStartIndex,
			currentCount,
			fullParticipants,
		);
		sources.push(result.source);
		endpoints.push(...result.endpoints);
		if (result.totalCount !== null) {
			totalCount = Math.max(totalCount ?? 0, result.totalCount);
		}

		if (result.games.length > 0) {
			allGames = allGames.concat(result.games);
			// 短页（不足 step）说明服务器历史已经到末尾，再去请求下一页
			// 也只会拿到更旧的、可能无关的数据，反而拉满 200ms 间隔。
			if (result.games.length < step) {
				break;
			}
		} else {
			// 已经到达历史末尾，避免为不存在的分页继续请求。
			break;
		}

		// 4. 频率限制：如果还有下一页，则延迟
		if (i + step < totalToFetch) {
			await delay(200);
		}
	}

	return {
		games: allGames,
		source: combineSources(sources),
		endpoints: combineEndpoints(endpoints),
		totalCount,
	};
};

const splitRequests = async (
	puuid: string,
	begIndex: number,
	endIndex: number,
	fullParticipants = false,
): Promise<MatchHistoryBatchResult> => {
	if (!fullParticipants) {
		return splitRequestsSequential(puuid, begIndex, endIndex, false);
	}

	const step = 20;
	const pageConcurrency = 2;
	let allGames: MatchHistoryGame[] = [];
	const sources: MatchHistorySource[] = [];
	const endpoints: MatchHistoryEndpoint[] = [];
	let totalCount: number | null = null;
	const totalToFetch = endIndex - begIndex;

	// 完整参与者请求最多并行两页，批次之间保留间隔，兼顾速度和限流。
	for (
		let batchOffset = 0;
		batchOffset < totalToFetch;
		batchOffset += step * pageConcurrency
	) {
		const batch = Array.from(
			{
				length: Math.min(
					pageConcurrency,
					Math.ceil((totalToFetch - batchOffset) / step),
				),
			},
			(_, batchIndex) => {
				const offset = batchOffset + batchIndex * step;
				return fetchMatchHistory(
					puuid,
					begIndex + offset,
					Math.min(step, totalToFetch - offset),
					true,
				);
			},
		);
		const results = await Promise.all(batch);
		let reachedHistoryEnd = false;
		for (const result of results) {
			sources.push(result.source);
			endpoints.push(...result.endpoints);
			if (result.totalCount !== null) {
				totalCount = Math.max(totalCount ?? 0, result.totalCount);
			}
			if (result.games.length > 0) {
				allGames = allGames.concat(result.games);
			} else {
				reachedHistoryEnd = true;
			}
		}
		if (reachedHistoryEnd) break;
		if (batchOffset + step * pageConcurrency < totalToFetch) {
			await delay(200);
		}
	}

	return {
		games: allGames,
		source: combineSources(sources),
		endpoints: combineEndpoints(endpoints),
		totalCount,
	};
};

// 主函数：查询历史比赛数据，并返回本次实际使用的数据源。
export const queryMatchHistoryWithSource = async (
	puuid: string,
	begIndex: number,
	endIndex: number,
): Promise<MatchHistoryQueryResult | null> => {
	return queryMatchHistoryWithSourceInternal(puuid, begIndex, endIndex, false);
};

const queryMatchHistoryWithSourceInternalUncached = async (
	puuid: string,
	begIndex: number,
	endIndex: number,
	fullParticipants: boolean,
): Promise<MatchHistoryQueryResult | null> => {
	try {
		let result: MatchHistoryBatchResult;
		const MAX_REQUEST_SIZE = 20;

		// 如果请求范围超过最大限制，拆分请求
		if (endIndex - begIndex > MAX_REQUEST_SIZE) {
			result = await splitRequests(
				puuid,
				begIndex,
				endIndex,
				fullParticipants,
			);
		} else {
			result = await fetchMatchHistory(
				puuid,
				begIndex,
				endIndex - begIndex,
				fullParticipants,
			);
		}

		// 如果没有获取到游戏数据，返回空数组
		if (result.games.length === 0) {
			return result;
		}

		// 分页接口偶尔会在边界重复返回同一局；重复数据会同时污染
		// 胜率样本、趋势和开黑共同场次，因此在统一出口去重。
		const uniqueGames = Array.from(
			new Map(result.games.map((game) => [game.gameId, game])).values(),
		);

		// 按游戏创建时间降序排序
		return {
			games: uniqueGames.sort((a, b) => b.gameCreation - a.gameCreation),
			source: result.source,
			endpoints: result.endpoints,
			totalCount: result.totalCount,
		};
	} catch (error) {
		logger.error({
			tag: "lcu.history",
			message: "历史查询内部异常",
			context: {
				puuid,
				beg_index: begIndex,
				count: endIndex,
				full_participants: fullParticipants,
				error: String(error).slice(0, 200),
			},
		});
		return null;
	}
};

const queryMatchHistoryWithSourceInternal = (
	puuid: string,
	begIndex: number,
	endIndex: number,
	fullParticipants: boolean,
): Promise<MatchHistoryQueryResult | null> => {
	const key = `${puuid}:${begIndex}:${endIndex}:${fullParticipants ? "full" : "summary"}`;
	const pending = inFlightHistoryRequests.get(key);
	if (pending) {
		logger.debug({
			tag: "lcu.history",
			message: "inFlight 合并，跳过重复请求",
			context: { key },
		});
		return pending;
	}

	const request = queryMatchHistoryWithSourceInternalUncached(
		puuid,
		begIndex,
		endIndex,
		fullParticipants,
	);
	inFlightHistoryRequests.set(key, request);
	void request.then(
		() => {
			if (inFlightHistoryRequests.get(key) === request) {
				inFlightHistoryRequests.delete(key);
			}
		},
		() => {
			if (inFlightHistoryRequests.get(key) === request) {
				inFlightHistoryRequests.delete(key);
			}
		},
	);
	return request;
};

/** 查询完整 participant 列表，供对局内近期胜率和开黑分析使用。 */
export const queryMatchHistoryFullWithSource = async (
	puuid: string,
	begIndex: number,
	endIndex: number,
): Promise<MatchHistoryQueryResult | null> =>
	queryMatchHistoryWithSourceInternal(puuid, begIndex, endIndex, true);
