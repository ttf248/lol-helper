export interface RoleCountMapTypes {
  assassin: number;
  fighter: number;
  mage: number;
  marksman: number;
  support: number;
  tank: number;
}

export interface RecentDataAnalysisTypes {
  top3Champions: { champId: number; count: number }[];
  totalChampions: number;
  roleCountMap: RoleCountMapTypes;
  oneGameId: number;
}
