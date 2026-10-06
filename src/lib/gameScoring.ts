import type { ScoringValues } from "./catalog";

export type GamePlayerType = "skater" | "goalie";
export type GameStats = Record<string, number>;

const SKATER_WEIGHTS = {
  goals: "skater_goal",
  assists: "skater_assist",
  shots: "skater_shot",
  short_handed_goals: "skater_short_handed_goal",
  short_handed_assists: "skater_short_handed_assist",
  blocked_shots: "skater_blocked_shot",
  hits: "skater_hit",
  plus_minus: "skater_plus_minus",
} as const satisfies Record<string, keyof ScoringValues>;

const GOALIE_WEIGHTS = {
  goals: "goalie_goal",
  assists: "goalie_assist",
  wins: "goalie_win",
  shutouts: "goalie_shutout",
  saves: "goalie_save",
  goals_against: "goalie_goal_against",
} as const satisfies Record<string, keyof ScoringValues>;

export function scoreGameStats(
  playerType: GamePlayerType,
  stats: GameStats,
  scoring: ScoringValues,
): number {
  const weights = playerType === "goalie" ? GOALIE_WEIGHTS : SKATER_WEIGHTS;
  return Object.entries(weights).reduce((total, [stat, rule]) => {
    const value = stats[stat];
    if (!Number.isFinite(value)) {
      throw new Error(`Game statistics are missing a valid ${stat} value.`);
    }
    return total + value * scoring[rule];
  }, 0);
}

export type FinalGamePlayerStat = {
  playerId: string;
  playerType: GamePlayerType;
  stats: GameStats;
  sourcePayload: Record<string, unknown>;
};

export type FinalGameImport = {
  gameId: string;
  startsAt: string;
  gameType: "regular" | "playoff";
  status: number;
  final: boolean;
  stats: FinalGamePlayerStat[];
  sourcePayload: Record<string, unknown>;
};

export type FinalGameImportPayload = {
  scheduleComplete: boolean;
  games: FinalGameImport[];
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, label: string): string {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    !String(value).trim()
  ) {
    throw new Error(`${label} is required.`);
  }
  return String(value).trim();
}

function parseStats(value: unknown, playerType: GamePlayerType): GameStats {
  const source = object(value, "Player game stats");
  const keys = Object.keys(
    playerType === "goalie" ? GOALIE_WEIGHTS : SKATER_WEIGHTS,
  );
  const stats: GameStats = {};
  for (const key of keys) {
    const raw = source[key];
    const parsed =
      typeof raw === "number"
        ? raw
        : typeof raw === "string" && raw.trim() !== ""
          ? Number(raw)
          : Number.NaN;
    if (!Number.isFinite(parsed)) {
      throw new Error(`Player game stats require a numeric ${key} value.`);
    }
    stats[key] = parsed;
  }
  return stats;
}

export function parseFinalGameImport(value: unknown): FinalGameImportPayload {
  const root = object(value, "Game import");
  if (!Array.isArray(root.games) || root.games.length === 0) {
    throw new Error("Game import must contain a non-empty games array.");
  }
  if (
    root.regularSeasonScheduleComplete !== undefined &&
    typeof root.regularSeasonScheduleComplete !== "boolean"
  ) {
    throw new Error("regularSeasonScheduleComplete must be a boolean.");
  }
  const ids = new Set<string>();
  const games = root.games.map((item, index) => {
    const source = object(item, `games[${index}]`);
    const gameId = requiredText(source.gameId ?? source.game_id, "Game ID");
    if (ids.has(gameId)) throw new Error(`Duplicate game ID ${gameId}.`);
    ids.add(gameId);
    const startsAt = requiredText(
      source.startsAt ?? source.starts_at,
      "Game start time",
    );
    if (
      !Number.isFinite(Date.parse(startsAt)) ||
      !/(Z|[+-]\d{2}:\d{2})$/i.test(startsAt)
    ) {
      throw new Error(`Game ${gameId} has an invalid start time.`);
    }
    const gameType = source.gameType ?? source.game_type;
    if (gameType !== "regular" && gameType !== "playoff") {
      throw new Error(`Game ${gameId} has an unsupported game type.`);
    }
    const normalizedGameType: "regular" | "playoff" =
      gameType === "regular" ? "regular" : "playoff";
    const status = Number(source.status);
    const final = source.final;
    if (!Number.isInteger(status) || typeof final !== "boolean") {
      throw new Error(
        `Game ${gameId} must include numeric status and boolean finality.`,
      );
    }
    if (
      ![1, 2, 3, 4].includes(status) ||
      ([1, 2].includes(status) && final) ||
      (status === 4 && !final)
    ) {
      throw new Error(`Game ${gameId} has an unknown or contradictory status.`);
    }
    if (!Array.isArray(source.stats)) {
      throw new Error(`Game ${gameId} must include a stats array.`);
    }
    const playerIds = new Set<string>();
    const officialFinal = status === 4 && final;
    if (officialFinal && source.stats.length === 0) {
      throw new Error(
        `Official final game ${gameId} has no player statistics.`,
      );
    }
    const stats = officialFinal
      ? source.stats.map((rawStat, statIndex): FinalGamePlayerStat => {
          const stat = object(rawStat, `games[${index}].stats[${statIndex}]`);
          const playerId = requiredText(
            stat.playerId ?? stat.player_id,
            "Player ID",
          );
          if (playerIds.has(playerId)) {
            throw new Error(
              `Game ${gameId} contains duplicate stats for ${playerId}.`,
            );
          }
          playerIds.add(playerId);
          if (stat.playerType !== "skater" && stat.playerType !== "goalie") {
            throw new Error(
              `Game ${gameId} player ${playerId} has an invalid player type.`,
            );
          }
          return {
            playerId,
            playerType: stat.playerType,
            stats: parseStats(stat.stats, stat.playerType),
            sourcePayload: stat,
          };
        })
      : [];
    return {
      gameId,
      startsAt,
      gameType: normalizedGameType,
      status,
      final,
      stats,
      sourcePayload: source,
    };
  });
  return {
    scheduleComplete: root.regularSeasonScheduleComplete === true,
    games,
  };
}
