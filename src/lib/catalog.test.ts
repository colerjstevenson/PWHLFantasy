import { describe, expect, it } from "vitest";
import {
  assignTiers,
  calculateProjection,
  DEFAULT_SCORING_VALUES,
  easternInputToIso,
  isoToEasternInput,
} from "./catalog";

describe("calculateProjection", () => {
  it("calculates the confirmed skater projection", () => {
    expect(
      calculateProjection("skater", {
        goals: 16,
        assists: 17,
        shots: 58,
        short_handed_goals: 0,
        short_handed_assists: 0,
        blocked_shots: 33,
        hits: 7,
        plus_minus: 13,
      }),
    ).toBe(244);
  });

  it("calculates the confirmed goalie projection", () => {
    expect(
      calculateProjection("goalie", {
        goals: 0,
        assists: 0,
        wins: 19,
        shutouts: 8,
        saves: 631,
        goals_against: 31,
      }),
    ).toBe(301.75);
  });

  it("applies short-handed bonuses in addition to base scoring", () => {
    expect(
      calculateProjection("skater", {
        goals: 1,
        assists: 1,
        shots: 0,
        short_handed_goals: 1,
        short_handed_assists: 1,
        blocked_shots: 0,
        hits: 0,
        plus_minus: 0,
      }),
    ).toBe(
      DEFAULT_SCORING_VALUES.skater_goal +
        DEFAULT_SCORING_VALUES.skater_assist +
        DEFAULT_SCORING_VALUES.skater_short_handed_goal +
        DEFAULT_SCORING_VALUES.skater_short_handed_assist,
    );
  });
});

describe("assignTiers", () => {
  it("assigns descending quintile tiers and keeps equal totals together", () => {
    expect(assignTiers([5, 4, 3, 2, 1]).map(({ tier }) => tier)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    const result = assignTiers([100, 90, 80, 70, 60, 50, 50]);
    expect(result.map(({ tier }) => tier)).toEqual([1, 1, 2, 3, 3, 4, 4]);
  });

  it("handles uneven ties and a one-player catalog", () => {
    expect(assignTiers([10, 10, 10]).map(({ tier }) => tier)).toEqual([
      2, 2, 2,
    ]);
    expect(assignTiers([42])).toEqual([{ projection: 42, tier: 1 }]);
    expect(assignTiers([])).toEqual([]);
  });

  it("rejects non-finite projections", () => {
    expect(() => assignTiers([1, Number.NaN])).toThrow(
      "Projection totals must be finite numbers.",
    );
  });
});

describe("Eastern roster-lock time conversion", () => {
  it("uses the correct Eastern offset on the 2026 lock date", () => {
    expect(easternInputToIso("2026-12-05T15:00")).toBe(
      "2026-12-05T20:00:00.000Z",
    );
    expect(isoToEasternInput("2026-12-05T20:00:00.000Z")).toBe(
      "2026-12-05T15:00",
    );
  });

  it("uses the daylight-saving offset during Eastern summer time", () => {
    expect(easternInputToIso("2026-07-01T12:00")).toBe(
      "2026-07-01T16:00:00.000Z",
    );
  });

  it("rejects local times skipped by the daylight-saving transition", () => {
    expect(() => easternInputToIso("2026-03-08T02:30")).toThrow(
      "That local time does not exist in Eastern Time",
    );
  });
});
