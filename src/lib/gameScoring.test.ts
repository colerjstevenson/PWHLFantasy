import { describe, expect, it } from "vitest";
import { DEFAULT_SCORING_VALUES } from "./catalog";
import { parseFinalGameImport, scoreGameStats } from "./gameScoring";

describe("scoreGameStats", () => {
  it("applies skater base points and short-handed bonuses", () => {
    expect(
      scoreGameStats(
        "skater",
        {
          goals: 1,
          assists: 2,
          shots: 4,
          short_handed_goals: 1,
          short_handed_assists: 1,
          blocked_shots: 2,
          hits: 1,
          plus_minus: -1,
        },
        DEFAULT_SCORING_VALUES,
      ),
    ).toBe(25);
  });

  it("uses goalie-only scoring values", () => {
    expect(
      scoreGameStats(
        "goalie",
        {
          goals: 1,
          assists: 1,
          wins: 1,
          shutouts: 1,
          saves: 20,
          goals_against: 2,
        },
        DEFAULT_SCORING_VALUES,
      ),
    ).toBe(93);
  });

  it("rejects missing or non-finite values instead of treating them as zero", () => {
    expect(() =>
      scoreGameStats("skater", { goals: Number.NaN }, DEFAULT_SCORING_VALUES),
    ).toThrow("missing a valid goals");
  });
});

describe("parseFinalGameImport", () => {
  it("normalizes game records and numeric-string stats", () => {
    expect(
      parseFinalGameImport({
        games: [
          {
            game_id: 365,
            starts_at: "2026-12-05T18:00:00-05:00",
            game_type: "regular",
            status: 4,
            final: true,
            stats: [
              {
                player_id: 23,
                playerType: "skater",
                stats: {
                  goals: "1",
                  assists: "0",
                  shots: "3",
                  short_handed_goals: "0",
                  short_handed_assists: "0",
                  blocked_shots: "1",
                  hits: "2",
                  plus_minus: "-1",
                },
              },
            ],
          },
        ],
      }).games,
    ).toMatchObject([
      {
        gameId: "365",
        startsAt: "2026-12-05T18:00:00-05:00",
        gameType: "regular",
        status: 4,
        final: true,
        stats: [
          {
            playerId: "23",
            playerType: "skater",
            stats: {
              goals: 1,
              assists: 0,
              shots: 3,
              short_handed_goals: 0,
              short_handed_assists: 0,
              blocked_shots: 1,
              hits: 2,
              plus_minus: -1,
            },
          },
        ],
      },
    ]);
  });

  it("requires explicit zeros and rejects duplicate games and players", () => {
    const game = {
      gameId: "g1",
      startsAt: "2026-12-05T23:00:00Z",
      gameType: "regular",
      status: 4,
      final: true,
      stats: [
        {
          playerId: "p1",
          playerType: "goalie",
          stats: {
            goals: 0,
            assists: 0,
            wins: 1,
            shutouts: 0,
            saves: 24,
            goals_against: 1,
          },
        },
      ],
    };
    expect(() =>
      parseFinalGameImport({
        games: [{ ...game, stats: [{ ...game.stats[0], stats: { wins: 1 } }] }],
      }),
    ).toThrow("require a numeric goals");
    expect(() => parseFinalGameImport({ games: [game, game] })).toThrow(
      "Duplicate game ID",
    );
    expect(() =>
      parseFinalGameImport({
        games: [{ ...game, stats: [...game.stats, ...game.stats] }],
      }),
    ).toThrow("duplicate stats");
  });

  it("accepts non-final schedule records with empty stats", () => {
    expect(
      parseFinalGameImport({
        games: [
          {
            gameId: "upcoming",
            startsAt: "2026-12-05T23:00:00Z",
            gameType: "regular",
            status: 1,
            final: false,
            stats: [
              {
                playerId: "live-player",
                playerType: "skater",
                stats: { goals: "1" },
              },
            ],
          },
        ],
      }).games[0].stats,
    ).toEqual([]);
  });

  it("rejects unknown and contradictory source status values", () => {
    const game = {
      gameId: "bad-status",
      startsAt: "2026-12-05T23:00:00Z",
      gameType: "regular",
      status: 4,
      final: true,
      stats: [
        {
          playerId: "p1",
          playerType: "skater",
          stats: {
            goals: 0,
            assists: 0,
            shots: 0,
            short_handed_goals: 0,
            short_handed_assists: 0,
            blocked_shots: 0,
            hits: 0,
            plus_minus: 0,
          },
        },
      ],
    };
    expect(() =>
      parseFinalGameImport({ games: [{ ...game, status: 5 }] }),
    ).toThrow("unknown or contradictory status");
    expect(() =>
      parseFinalGameImport({ games: [{ ...game, final: false }] }),
    ).toThrow("unknown or contradictory status");
  });
});
