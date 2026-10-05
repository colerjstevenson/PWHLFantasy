import { describe, expect, it } from "vitest";
import { parsePwhlImport } from "./pwhlImport";

const payload = {
  season: { id: "11", name: "2026-27 Regular Season", priorSeasonId: "8" },
  players: [
    {
      player_id: "23",
      name: "Kelly Pannek",
      position: "F",
      team_id: "",
      type: "skater",
    },
    {
      player_id: "6",
      name: "Aerin Frankel",
      position_analysis: "G",
      type: "goalie",
    },
  ],
  seasonStats: [
    {
      player_id: "23",
      goals: "16",
      assists: "17",
      shots: "58",
      plusminus: "13",
      short_handed_goals: "0",
      short_handed_assists: "0",
      shots_blocked_by_player: "33",
      hits: "7",
    },
    {
      player_id: "6",
      goals: "0",
      assists: "0",
      wins: "19",
      shutouts: "8",
      saves: "631",
      goals_against: "31",
    },
  ],
};

describe("parsePwhlImport", () => {
  it("normalizes documented PWHL records and numeric strings", () => {
    const result = parsePwhlImport(payload);
    expect(result.seasonId).toBe("11");
    expect(result.players.map(({ position }) => position)).toEqual(["F", "G"]);
    expect(result.players[0].teamId).toBeNull();
    expect(result.seasonStats).toEqual([
      {
        playerId: "23",
        stats: {
          goals: 16,
          assists: 17,
          shots: 58,
          short_handed_goals: 0,
          short_handed_assists: 0,
          blocked_shots: 33,
          hits: 7,
          plus_minus: 13,
        },
        complete: true,
      },
      {
        playerId: "6",
        stats: {
          goals: 0,
          assists: 0,
          wins: 19,
          shutouts: 8,
          saves: 631,
          goals_against: 31,
        },
        complete: true,
      },
    ]);
  });

  it("marks missing fields for review instead of treating them as zero", () => {
    const input = {
      ...payload,
      seasonStats: [{ player_id: "23", goals: "1", assists: "2" }],
    };
    expect(parsePwhlImport(input).seasonStats[0]).toEqual({
      playerId: "23",
      stats: { goals: 1, assists: 2 },
      complete: false,
    });
  });

  it("rejects duplicate players, unknown stat references, and unsupported positions", () => {
    expect(() =>
      parsePwhlImport({
        ...payload,
        players: [payload.players[0], payload.players[0]],
      }),
    ).toThrow("duplicate player IDs");
    expect(() =>
      parsePwhlImport({
        ...payload,
        seasonStats: [{ player_id: "unknown" }],
      }),
    ).toThrow("unknown player ID");
    expect(() =>
      parsePwhlImport({
        ...payload,
        players: [{ player_id: "x", name: "Unknown", position: "?" }],
      }),
    ).toThrow("unsupported position");
    expect(() =>
      parsePwhlImport({
        ...payload,
        players: [{ ...payload.players[0], active: "unknown" }],
      }),
    ).toThrow("active status must be");
  });
});
