import { describe, expect, it } from "vitest";
import { assessRoster, getRosterDraftKey, type RosterPlayer } from "./roster";

const players: RosterPlayer[] = [
  {
    id: "f1",
    name: "Forward One",
    position: "F",
    teamName: "North",
    tier: 1,
    cost: 10.1,
    active: true,
    ready: true,
  },
  {
    id: "f2",
    name: "Forward Two",
    position: "F",
    teamName: "North",
    tier: 1,
    cost: 10.1,
    active: true,
    ready: true,
  },
  {
    id: "f3",
    name: "Forward Three",
    position: "F",
    teamName: "North",
    tier: 1,
    cost: 10.1,
    active: true,
    ready: true,
  },
  {
    id: "d1",
    name: "Defence One",
    position: "D",
    teamName: "South",
    tier: 2,
    cost: 10.1,
    active: true,
    ready: true,
  },
  {
    id: "d2",
    name: "Defence Two",
    position: "D",
    teamName: "South",
    tier: 2,
    cost: 10.1,
    active: true,
    ready: true,
  },
  {
    id: "g1",
    name: "Goalie One",
    position: "G",
    teamName: "East",
    tier: 3,
    cost: 10.1,
    active: true,
    ready: true,
  },
];
const fullRoster = players.map(({ id }) => id);

describe("assessRoster", () => {
  it("accepts the exact roster size, positional minimums, and budget", () => {
    const result = assessRoster(fullRoster, players, {
      rosterSize: 6,
      budget: 60.6,
    });

    expect(result.valid).toBe(true);
    expect(result.totalCost).toBe(6060);
    expect(result.remainingBudget).toBe(0);
    expect(result.remainingSlots).toBe(0);
  });

  it("rejects a roster that exceeds budget by one cent", () => {
    const result = assessRoster(fullRoster, players, {
      rosterSize: 6,
      budget: 60.59,
    });

    expect(result.issues).toContain("The roster exceeds the league budget.");
  });

  it("reports too few slots and missing positional minimums", () => {
    const result = assessRoster(["f1", "f2", "d1", "g1"], players, {
      rosterSize: 6,
      budget: 100,
    });

    expect(result.remainingSlots).toBe(2);
    expect(result.issues).toContain("Select exactly 6 players.");
    expect(result.issues).toContain("Add 1 more forward(s).");
    expect(result.issues).toContain("Add 1 more defence player(s).");
  });

  it("rejects duplicate, unavailable, inactive, and unreviewed selections", () => {
    const invalidPlayers = [
      ...players,
      { ...players[0], id: "inactive", name: "Inactive Player", active: false },
      { ...players[1], id: "review", name: "Review Player", ready: false },
    ];
    const result = assessRoster(
      ["f1", "f1", "missing", "inactive", "review", "g1"],
      invalidPlayers,
      { rosterSize: 6, budget: 100 },
    );

    expect(result.issues).toContain("A player can only be selected once.");
    expect(result.issues).toContain(
      "A selected player is no longer in the catalog.",
    );
    expect(result.issues).toContain("Inactive Player is inactive.");
    expect(result.issues).toContain("Review Player needs catalog review.");
  });

  it("scopes drafts to both the manager and team", () => {
    expect(getRosterDraftKey("manager-a", "team-a")).not.toBe(
      getRosterDraftKey("manager-b", "team-a"),
    );
    expect(getRosterDraftKey("manager-a", "team-a")).not.toBe(
      getRosterDraftKey("manager-a", "team-b"),
    );
  });
});
