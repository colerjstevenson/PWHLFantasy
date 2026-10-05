import type { PlayerType } from "./catalog";

export type ImportedPlayer = {
  id: string;
  name: string;
  teamId: string | null;
  teamName: string | null;
  position: "F" | "D" | "G";
  playerType: PlayerType;
  active: boolean;
};

export type ImportedSeasonStat = {
  playerId: string;
  stats: Record<string, number>;
  complete: boolean;
};

export type PwhlImportPayload = {
  seasonId: string;
  seasonName: string;
  priorSeasonId: string;
  players: ImportedPlayer[];
  seasonStats: ImportedSeasonStat[];
};

const SKATER_FIELDS = [
  "goals",
  "assists",
  "shots",
  "short_handed_goals",
  "short_handed_assists",
  "blocked_shots",
  "hits",
  "plus_minus",
] as const;

const GOALIE_FIELDS = [
  "goals",
  "assists",
  "wins",
  "shutouts",
  "saves",
  "goals_against",
] as const;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`${label} is required.`);
  }
  const result = String(value).trim();
  if (!result) throw new Error(`${label} is required.`);
  return result;
}

function nullableText(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value).trim() || null;
}

function parseActive(value: unknown): boolean {
  if (value === undefined || value === true || value === 1) {
    return true;
  }
  if (value === false || value === 0) {
    return false;
  }
  if (typeof value === "string") {
    if (value.toLowerCase() === "true" || value === "1") return true;
    if (value.toLowerCase() === "false" || value === "0") return false;
  }
  throw new Error("Player active status must be a boolean or 0/1 value.");
}

function parseStat(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pick(source: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined) return source[key];
  }
  return undefined;
}

function normalizeStats(
  source: Record<string, unknown>,
  playerType: PlayerType,
): ImportedSeasonStat {
  const playerId = text(
    pick(source, "player_id", "playerId", "id"),
    "Season statistic player_id",
  );
  const nested = source.stats;
  const statsSource =
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : source;
  const aliases: Record<string, string[]> = {
    blocked_shots: ["blocked_shots", "shots_blocked_by_player"],
    plus_minus: ["plus_minus", "plusminus"],
  };
  const fields = playerType === "goalie" ? GOALIE_FIELDS : SKATER_FIELDS;
  const stats: Record<string, number> = {};
  let complete = true;

  for (const field of fields) {
    const value = parseStat(pick(statsSource, ...(aliases[field] ?? [field])));
    if (value === null) complete = false;
    else stats[field] = value;
  }

  return { playerId, stats, complete };
}

export function parsePwhlImport(value: unknown): PwhlImportPayload {
  const root = record(value, "Import");
  const metadata = root.season ? record(root.season, "season") : root;
  const playersValue = root.players;
  const statsValue = pick(root, "seasonStats", "season_stats", "statistics");
  if (!Array.isArray(playersValue) || !Array.isArray(statsValue)) {
    throw new Error("Import must contain players and seasonStats arrays.");
  }

  const players = playersValue.map((item, index) => {
    const source = record(item, `players[${index}]`);
    const playerTypeValue = String(
      pick(source, "player_type", "playerType", "type") ?? "",
    ).toLowerCase();
    const sourcePosition = String(
      pick(source, "position_analysis", "position", "positionAnalysis") ?? "",
    ).toUpperCase();
    const playerType: PlayerType =
      playerTypeValue === "goalie" || sourcePosition === "G"
        ? "goalie"
        : "skater";
    const position: ImportedPlayer["position"] | null =
      playerType === "goalie"
        ? "G"
        : sourcePosition === "D" ||
            sourcePosition === "LD" ||
            sourcePosition === "RD"
          ? "D"
          : sourcePosition === "F" ||
              ["C", "LW", "RW", "L", "R"].includes(sourcePosition)
            ? "F"
            : null;
    if (!position) {
      throw new Error(
        `Player ${pick(source, "player_id", "playerId", "id") ?? index} has an unsupported position.`,
      );
    }

    const activeValue = pick(source, "active", "is_active", "isActive");
    return {
      id: text(pick(source, "player_id", "playerId", "id"), "Player ID"),
      name: text(
        pick(source, "name", "player_name", "playerName"),
        "Player name",
      ),
      teamId: nullableText(pick(source, "team_id", "teamId")),
      teamName: nullableText(pick(source, "team_name", "teamName")),
      position,
      playerType,
      active: parseActive(activeValue),
    };
  });

  const playerIds = new Set(players.map(({ id }) => id));
  if (playerIds.size !== players.length) {
    throw new Error("Import contains duplicate player IDs.");
  }

  const typesById = new Map(
    players.map(({ id, playerType }) => [id, playerType]),
  );
  const seasonStats = statsValue.map((item, index) => {
    const source = record(item, `seasonStats[${index}]`);
    const id = text(
      pick(source, "player_id", "playerId", "id"),
      "Season statistic player_id",
    );
    const playerType = typesById.get(id);
    if (!playerType) {
      throw new Error(`Statistics refer to unknown player ID ${id}.`);
    }
    return normalizeStats(source, playerType);
  });
  if (
    new Set(seasonStats.map(({ playerId }) => playerId)).size !==
    seasonStats.length
  ) {
    throw new Error("Import contains duplicate season-stat player IDs.");
  }

  return {
    seasonId: text(pick(metadata, "id", "season_id", "seasonId"), "Season ID"),
    seasonName: text(
      pick(metadata, "name", "season_name", "seasonName"),
      "Season name",
    ),
    priorSeasonId: text(
      pick(metadata, "prior_season_id", "priorSeasonId"),
      "Prior season ID",
    ),
    players,
    seasonStats,
  };
}
