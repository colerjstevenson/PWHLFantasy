export type RosterPosition = "F" | "D" | "G";

export type RosterPlayer = {
  id: string;
  name: string;
  position: RosterPosition;
  teamName: string | null;
  tier: number;
  cost: number;
  active: boolean;
  ready: boolean;
};

export type RosterRules = {
  rosterSize: number;
  budget: number;
};

export type RosterAssessment = {
  selectedPlayers: RosterPlayer[];
  totalCost: number;
  remainingBudget: number;
  remainingSlots: number;
  positions: Record<RosterPosition, number>;
  issues: string[];
  valid: boolean;
};

function toCents(amount: number): number {
  return Math.round(amount * 100);
}

export function assessRoster(
  selectedIds: readonly string[],
  players: readonly RosterPlayer[],
  rules: RosterRules,
): RosterAssessment {
  const playerById = new Map(players.map((player) => [player.id, player]));
  const selectedPlayers: RosterPlayer[] = [];
  const issues: string[] = [];
  const positions: Record<RosterPosition, number> = { F: 0, D: 0, G: 0 };
  const seen = new Set<string>();

  for (const id of selectedIds) {
    if (seen.has(id)) {
      issues.push("A player can only be selected once.");
      continue;
    }
    seen.add(id);
    const player = playerById.get(id);
    if (!player) {
      issues.push("A selected player is no longer in the catalog.");
      continue;
    }
    selectedPlayers.push(player);
    if (!player.active) issues.push(`${player.name} is inactive.`);
    if (!player.ready) issues.push(`${player.name} needs catalog review.`);
    if (!Number.isFinite(player.cost) || player.cost < 0) {
      issues.push(`${player.name} has an invalid cost.`);
      continue;
    }
    positions[player.position] += 1;
  }

  const totalCost = selectedPlayers.reduce(
    (total, player) =>
      total +
      (Number.isFinite(player.cost) && player.cost >= 0
        ? toCents(player.cost)
        : 0),
    0,
  );
  const rosterSize = selectedIds.length;
  const budget = Number.isFinite(rules.budget) ? toCents(rules.budget) : 0;

  if (rosterSize !== rules.rosterSize) {
    issues.push(`Select exactly ${rules.rosterSize} players.`);
  }
  if (positions.F < 3) issues.push(`Add ${3 - positions.F} more forward(s).`);
  if (positions.D < 2)
    issues.push(`Add ${2 - positions.D} more defence player(s).`);
  if (positions.G < 1) issues.push("Add a goalie.");
  if (totalCost > budget) issues.push("The roster exceeds the league budget.");

  return {
    selectedPlayers,
    totalCost,
    remainingBudget: budget - totalCost,
    remainingSlots: rules.rosterSize - rosterSize,
    positions,
    issues,
    valid: issues.length === 0,
  };
}

export function getRosterDraftKey(userId: string, teamId: string): string {
  return `pwhl-fantasy-roster-draft:${userId}:${teamId}`;
}
