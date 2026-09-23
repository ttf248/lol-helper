import type { MatchModeKey } from "./matchMode";

export interface PlayerChampionSelection {
  championId: number;
  selectedSkinIndex: number;
  spell1Id: number;
  spell2Id: number;
  summonerInternalName: string;
  /** 新版 gameflow 在未完成阵容对象中可能只提供 PUUID。 */
  puuid?: string;
}

export interface GameTypeConfig {
  advancedLearningQuests: boolean;
  allowTrades: boolean;
  banMode: string;
  banTimerDuration: number;
  battleBoost: boolean;
  crossTeamChampionPool: boolean;
  deathMatch: boolean;
  doNotRemove: boolean;
  duplicatePick: boolean;
  exclusivePick: boolean;
  id: number;
  learningQuests: boolean;
  mainPickTimerDuration: number;
  maxAllowableBans: number;
  name: string;
  onboardCoopBeginner: boolean;
  pickMode: string;
  postPickTimerDuration: number;
  reroll: boolean;
  teamChampionPool: boolean;
}

export interface QueueReward {
  isChampionPointsEnabled: boolean;
  isIpEnabled: boolean;
  isXpEnabled: boolean;
  partySizeIpRewards: any[];
}

export interface Queue {
  allowablePremadeSizes: number[];
  areFreeChampionsAllowed: boolean;
  assetMutator: string;
  category: string;
  championsRequiredToPlay: number;
  description: string;
  detailedDescription: string;
  gameMode: string;
  gameTypeConfig: GameTypeConfig;
  id: number;
  isRanked: boolean;
  isTeamBuilderManaged: boolean;
  lastToggledOffTime: number;
  lastToggledOnTime: number;
  mapId: number;
  maximumParticipantListSize: number;
  minLevel: number;
  minimumParticipantListSize: number;
  name: string;
  numPlayersPerTeam: number;
  queueAvailability: string;
  queueRewards: QueueReward;
  removalFromGameAllowed: boolean;
  removalFromGameDelayMinutes: number;
  shortName: string;
  showPositionSelector: boolean;
  spectatorEnabled: boolean;
  type: string;
}


export interface TeamData {
  championId: number;
  lastSelectedSkinIndex: number;
  profileIconId: number;
  puuid: string;
  selectedPosition: string;
  selectedRole: string;
  summonerId: number;
  summonerInternalName: string;
  summonerName: string;
  teamOwner: boolean;
  teamParticipantId: number;
}

// 游戏内 Live Client Data API 返回的玩家基础信息。
export interface LiveGamePlayer {
  championName: string;
  rawChampionName: string;
  summonerName: string;
  team: string;
}

export interface GameDataTypes {
  gameId: number;
  gameName: string;
  isCustomGame: boolean;
  password: string;
  playerChampionSelections: PlayerChampionSelection[];
  queue: Queue;
  spectatorsAllowed: boolean;
  teamOne: TeamData[];
  teamTwo: TeamData[];
}

export interface SessionTypes {
  gameClient: any;
  gameData: GameDataTypes;
  gameDodge: any;
  map: any;
  phase: string;
}

export type RecentHistoryStatusKind =
  | "loading"
  | "ready"
  | "cache-fallback"
  | "no-data"
  | "mode-empty"
  | "identity-mismatch"
  | "error";

export interface RecentHistoryStatus {
  kind: RecentHistoryStatusKind;
  title: string;
  detail: string;
  /** 本地缓存中成功匹配到目标玩家的对局数。 */
  cachedGames: number;
  /** 接口本次扫描返回的原始对局数，包含其它模式。 */
  serverGames: number;
  /** 接口返回且属于当前筛选模式的对局数。 */
  modeGames: number;
  /** 接口返回且成功匹配到目标身份的对局数。 */
  matchedGames: number;
  /** 本次成功返回数据的服务器接口；空数组表示只使用本地/页面缓存。 */
  sourceEndpoints?: string[];
}

export interface RecentSumInfo {
  summonerId: number;
  summonerName: string;
  puuid: string;
  championUrl: string;
  champId:number;
  teamParticipantId: number;
  matchList: MatchItemTypes[];
  historyStatus?: RecentHistoryStatus;
  recentAnalysis?: PlayerRecentAnalysis;
}

export interface RecentAllSumInfo {
  friendList: RecentSumInfo[];
  enemyList: RecentSumInfo[];
  queueId: number;
  /** 当前对局 gameflow session 的 gameId，用于把本局计入开黑初筛。 */
  currentGameId?: number;
}

export type RecentMatchLoadingStage =
  | "players"
  | "history"
  | "recent"
  | "full"
  | "done"
  | "error";

export interface RecentMatchLoadingState {
  stage: RecentMatchLoadingStage;
  completed: number;
  total: number;
  message: string;
  detail: string;
}

export interface MatchItemTypes {
  champImg: string;
  championId?: number;
  kills: number;
  deaths: number;
  assists: number;
  isWin: boolean;
  gameId: number;
  queueId: number;
  /** 对局真实创建时间，用于合并数据库/API结果时保持时间顺序。 */
  gameCreation?: number;
}

export interface HistoryCoverageInfo {
  cachedGames: number;
  interfaceGames: number;
  mergedGames: number;
  completeGames: number;
  partialGames: number;
  conflicts: number;
  sources: string[];
  latestGameCreation: number | null;
}

/** PostgreSQL 历史分析快照：基础统计和详情派生指标共用同一窗口。 */
export interface HistoryMetricStat {
  average: number | null;
  winAverage: number | null;
  lossAverage: number | null;
  delta: number | null;
  coverage: number;
}

export interface HistoryMetricSummary {
  kda: HistoryMetricStat;
  damagePerMinute: HistoryMetricStat;
  goldPerMinute: HistoryMetricStat;
  csPerMinute: HistoryMetricStat;
  visionPerMinute: HistoryMetricStat;
  teamDamageShare: HistoryMetricStat;
  damageTakenPerMinute: HistoryMetricStat;
  teamObjectiveScore: HistoryMetricStat;
  firstBloodRate: HistoryMetricStat;
  firstTowerRate: HistoryMetricStat;
}

export interface HistoryChampionStat {
  championId: number;
  games: number;
  wins: number;
  winRate: number | null;
  averageKda: number | null;
  damagePerMinute: number | null;
  csPerMinute: number | null;
  visionPerMinute: number | null;
  detailGames: number;
}

export interface HistoryPositionStat {
  position: string;
  games: number;
  wins: number;
  winRate: number | null;
  averageKda: number | null;
  damagePerMinute: number | null;
  csPerMinute: number | null;
  visionPerMinute: number | null;
  detailGames: number;
}

export interface HistoryTrendPoint {
  gameId: number;
  gameCreation: number;
  championId: number;
  position: string;
  win: boolean;
  kda: number;
  damagePerMinute: number | null;
  csPerMinute: number | null;
  detailAvailable: boolean;
}

export interface HistoryAnalysisInsight {
  kind: "difference" | "champion" | "position" | "quality";
  title: string;
  detail: string;
  metric: string | null;
  delta: number | null;
}

export interface HistoryAnalysisQuality {
  totalGames: number;
  detailGames: number;
  completeGames: number;
  baseCoverage: number;
  detailCoverage: number;
  metricCoverage: Record<string, number>;
  sources: string[];
  latestGameCreation: number | null;
}

export interface HistoryAnalysisSnapshot {
  puuid: string;
  modeKey: MatchModeKey | null;
  windowSize: number;
  actualGames: number;
  wins: number;
  losses: number;
  winRate: number | null;
  recentWins: number;
  recentGames: number;
  previousWins: number;
  previousGames: number;
  streakType: "win" | "loss" | "none" | string;
  streakCount: number;
  trend: HistoryTrendPoint[];
  metrics: HistoryMetricSummary;
  champions: HistoryChampionStat[];
  positions: HistoryPositionStat[];
  insights: HistoryAnalysisInsight[];
  quality: HistoryAnalysisQuality;
  source: string;
}

export type HistoryResultFilter = "all" | "win" | "loss";

export type HistoryCacheSyncKind =
  | "idle"
  | "syncing"
  | "complete"
  | "limited"
  | "error"
  | "cancelled";

export interface HistoryCacheSyncStatus {
  kind: HistoryCacheSyncKind;
  currentPage: number;
  totalPages: number | null;
  /** 服务器报告的历史总场数；totalPages 是按服务器分页大小计算的同步页数。 */
  totalCount: number | null;
  maxPages: number;
  cachedGames: number;
  downloadedGames: number;
  message: string;
  detail: string;
  /** 触发本次同步的召唤师名；底部进度条用它做标签。 */
  summonerName?: string;
  /** store 在 push 时分配的行 id，给底部进度条组件关联定时器用。 */
  rowId?: number;
}

export interface ChampionRecentStats {
  championId: number;
  games: number;
  wins: number;
  winRate: number;
  kills: number;
  deaths: number;
  assists: number;
}

export type ConfidenceLevel = "high" | "medium" | "low";

export interface ConfidenceInfo {
  level: ConfidenceLevel;
  score: number;
  reasons: string[];
}

export interface PositionRecentStats {
  position: string;
  games: number;
  wins: number;
  winRate: number;
  champions: ChampionRecentStats[];
}

export interface ModerationRecord {
  tag: string;
  content: string;
  isShow: boolean;
  updatedAt: string;
  playerSumName: string;
}

export interface PlayerModerationInfo {
  available: boolean;
  marked: boolean;
  reportCount: number;
  blacklistCount: number;
  positiveCount: number;
  records: ModerationRecord[];
}

export interface PartyMember {
  puuid: string;
  /** LCU/PG 的稳定召唤师 ID；历史分析跳转优先使用它。 */
  summonerId?: number;
  summonerName: string;
  moderation?: PlayerModerationInfo;
}

export interface PartyEvidence {
  gameId: number;
  gameCreation: number;
  /** 当前正在查看的对局，不代表已经产生可统计的胜负结果。 */
  isCurrentMatch?: boolean;
}

export interface PartyGroupAnalysis {
  relationKind: "recent" | "historical";
  /** 数据覆盖与身份覆盖，0..100；并非组队概率。 */
  evidenceCoverage: { complete: number; identity: number };
  members: PartyMember[];
  /** 该结果使用的最少同队次数；对局内初筛固定为 3，历史页按组合规模计算。 */
  requiredGames: number;
  /** 当前对局 + 最近历史窗口内的共同同队次数；对局内初筛使用。 */
  recentWindowGames?: number;
  /** 完整历史中排除当前对局后的共同同队次数。 */
  historicalGames?: number;
  /** 当前对局计数，通常为 1；当前对局结果未知时不计入胜率。 */
  currentMatchGames?: number;
  /** 共同同队总次数；对局内分析包含当前对局。 */
  games: number;
  /** 已结束共同对局中的胜场，当前对局不计入。 */
  wins: number;
  winRate: number;
  latestGameAt: number;
  recentGames: number;
  lastActiveDays: number | null;
  stabilityScore: number;
  stabilityLevel: ConfidenceLevel;
  highWinRateAlert: boolean;
  confidence: ConfidenceInfo;
  moderationAvailable: boolean;
  blacklistedMembers: PartyMember[];
  reportedMembers: PartyMember[];
  /** 实际参与判定的共同对局，按最近时间优先。 */
  evidence: PartyEvidence[];
  /**
   * 组合内每个成员作为同队成员出现的最少场次。用于识别"4 黑 + 路人"
   * 模式：size=5 组合若成员中混入只同队 1-2 场的路人，该值会远低于
   * size=4 子组合的对应值，UI 自然倾向于展示稳定的子组合。
   * 未提供时按 historicalGames 回退。
   */
  minMemberFrequency?: number;
}

export interface TeammateSynergyStats {
  teammate: PartyMember;
  games: number;
  wins: number;
  winRate: number;
  champions: ChampionRecentStats[];
  positions: PositionRecentStats[];
  latestGameAt: number;
}

export interface PlayerRecentAnalysis {
  actualGames: number;
  wins: number;
  winRate: number | null;
  currentChampion: ChampionRecentStats | null;
  champions: ChampionRecentStats[];
  positions: PositionRecentStats[];
  opponents: OpponentMatchupStats[];
  partyGroups: PartyGroupAnalysis[];
  partyCoverage?: {
    status: "ready" | "insufficient";
    message: string;
  };
  teammateSynergy?: TeammateSynergyStats[];
  confidence: ConfidenceInfo;
  moderation: PlayerModerationInfo;
  source: string;
  /** 本次分析实际命中的服务器接口；本地缓存分析时为空数组。 */
  sourceEndpoints?: string[];
  historyComplete: boolean;
  dataCoverage?: HistoryCoverageInfo;
  network?: RecentNetworkAnalysis;
}

export interface PlayerAnalysisProgress {
  stage: "cache" | "personal" | "full" | "relations" | "done";
  completed: number;
  total: number;
  percentage: number;
  message: string;
  /** 后台补齐期间可直接展示的阶段性个人统计。 */
  analysis?: PlayerRecentAnalysis;
}

export interface OpponentMatchupStats {
  opponent: PartyMember;
  games: number;
  wins: number;
  opponentWins: number;
  winRate: number;
}

export interface RecentNetworkNode {
  puuid: string;
  /** 与对局详情页相同的稳定跳转主键。 */
  summonerId?: number;
  summonerName: string;
  team: "friend" | "enemy";
  teamIndex: number;
}

export interface RecentNetworkEdge {
  source: string;
  target: string;
  sharedGames: number;
  sameTeamGames: number;
  opposedGames: number;
  sourceWins: number;
  targetWins: number;
}

export interface RecentNetworkAnalysis {
  nodes: RecentNetworkNode[];
  edges: RecentNetworkEdge[];
  availableGames: number;
}

export interface SuperChampTypes {
  championId: number;
  championLevel: number;
  championPoints: number;
  championPointsSinceLastLevel: number;
  championPointsUntilNextLevel: number;
  chestGranted: boolean;
  formattedChampionPoints: string;
  formattedMasteryGoal: string;
  highestGrade: string;
  lastPlayTime: number;
  playerId: number;
  tokensEarned: number;
}

export interface ChampInfoTypes {
  heroId:             string;
  spellKey:           string;
  name:               string;
  description:        string;
  abilityIconPath:    string;
  abilityVideoPath:   string;
  dynamicDescription: string;
  cost:               string;
  costburn:           string;
  cooldown:           string;
  cooldownburn:       string;
  range:              string;
  cooldownupgrade:    string;
  costupgrade:        string;
}

export interface ChampTinyTypes {
  alias:string;
  name: string;
  roles:string[];
}
