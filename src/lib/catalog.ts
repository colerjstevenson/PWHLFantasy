export type PlayerType = "skater" | "goalie";

export type ProjectionStats = {
  goals: number;
  assists: number;
  shots?: number;
  short_handed_goals?: number;
  short_handed_assists?: number;
  blocked_shots?: number;
  hits?: number;
  plus_minus?: number;
  wins?: number;
  shutouts?: number;
  saves?: number;
  goals_against?: number;
};

export type ScoringValues = {
  skater_goal: number;
  skater_assist: number;
  skater_shot: number;
  skater_short_handed_goal: number;
  skater_short_handed_assist: number;
  skater_blocked_shot: number;
  skater_hit: number;
  skater_plus_minus: number;
  goalie_goal: number;
  goalie_assist: number;
  goalie_win: number;
  goalie_shutout: number;
  goalie_save: number;
  goalie_goal_against: number;
};

export const DEFAULT_SCORING_VALUES: ScoringValues = {
  skater_goal: 3,
  skater_assist: 2,
  skater_shot: 0.5,
  skater_short_handed_goal: 5,
  skater_short_handed_assist: 3,
  skater_blocked_shot: 3,
  skater_hit: 3,
  skater_plus_minus: 1,
  goalie_goal: 50,
  goalie_assist: 25,
  goalie_win: 5,
  goalie_shutout: 10,
  goalie_save: 0.25,
  goalie_goal_against: -1,
};

export type TierAssignment = {
  projection: number;
  tier: number;
};

export function calculateProjection(
  type: PlayerType,
  stats: ProjectionStats,
  scoring: ScoringValues = DEFAULT_SCORING_VALUES,
): number {
  if (type === "goalie") {
    return (
      (stats.wins ?? 0) * scoring.goalie_win +
      (stats.shutouts ?? 0) * scoring.goalie_shutout +
      (stats.saves ?? 0) * scoring.goalie_save +
      (stats.goals_against ?? 0) * scoring.goalie_goal_against +
      stats.goals * scoring.goalie_goal +
      stats.assists * scoring.goalie_assist
    );
  }

  return (
    stats.goals * scoring.skater_goal +
    stats.assists * scoring.skater_assist +
    (stats.shots ?? 0) * scoring.skater_shot +
    (stats.short_handed_goals ?? 0) * scoring.skater_short_handed_goal +
    (stats.short_handed_assists ?? 0) * scoring.skater_short_handed_assist +
    (stats.blocked_shots ?? 0) * scoring.skater_blocked_shot +
    (stats.hits ?? 0) * scoring.skater_hit +
    (stats.plus_minus ?? 0) * scoring.skater_plus_minus
  );
}

export function assignTiers(projections: readonly number[]): TierAssignment[] {
  if (projections.length === 0) return [];

  const sortedGroups = new Map<number, number>();
  for (const projection of projections) {
    if (!Number.isFinite(projection)) {
      throw new Error("Projection totals must be finite numbers.");
    }
    sortedGroups.set(projection, (sortedGroups.get(projection) ?? 0) + 1);
  }

  const descending = [...sortedGroups.entries()].sort(
    ([left], [right]) => right - left,
  );
  const midrankTiers = new Map<number, number>();
  let precedingCount = 0;
  for (const [projection, groupSize] of descending) {
    const rank = precedingCount + (groupSize + 1) / 2;
    const tier =
      1 + Math.min(4, Math.floor((5 * (rank - 1)) / projections.length));
    midrankTiers.set(projection, tier);
    precedingCount += groupSize;
  }

  return projections.map((projection) => ({
    projection,
    tier: midrankTiers.get(projection)!,
  }));
}

export function easternInputToIso(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error("Enter a valid Eastern date and time.");
  const [, year, month, day, hour, minute] = match.map(Number);
  const requestedUtc = Date.UTC(year, month - 1, day, hour, minute);
  let instant = requestedUtc;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(instant));
    const local = Object.fromEntries(
      parts.map(({ type, value }) => [type, value]),
    );
    const displayedUtc = Date.UTC(
      Number(local.year),
      Number(local.month) - 1,
      Number(local.day),
      Number(local.hour),
      Number(local.minute),
    );
    instant += requestedUtc - displayedUtc;
  }

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const local = Object.fromEntries(
    parts.map(({ type, value }) => [type, value]),
  );
  const formatted = `${local.year}-${local.month}-${local.day}T${local.hour}:${local.minute}`;
  if (formatted !== value) {
    throw new Error(
      "That local time does not exist in Eastern Time because of the daylight-saving change.",
    );
  }

  return new Date(instant).toISOString();
}

export function isoToEasternInput(value: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const local = Object.fromEntries(
    parts.map(({ type, value }) => [type, value]),
  );
  return `${local.year}-${local.month}-${local.day}T${local.hour}:${local.minute}`;
}
