import { describe, expect, it } from "vitest";
import {
  getLeagueBudgetError,
  getLeagueNameError,
  getLeagueRosterSizeError,
  readLeagueInviteToken,
} from "./league";

describe("league input validation", () => {
  it("requires a trimmed league name within the database limit", () => {
    expect(getLeagueNameError("   ")).not.toBeNull();
    expect(getLeagueNameError("  North Stars  ")).toBeNull();
    expect(getLeagueNameError("x".repeat(81))).not.toBeNull();
  });

  it("requires enough roster slots for the minimum positions", () => {
    expect(getLeagueRosterSizeError("5")).not.toBeNull();
    expect(getLeagueRosterSizeError("6")).toBeNull();
    expect(getLeagueRosterSizeError("6.5")).not.toBeNull();
  });

  it("accepts non-negative budgets with no more than two decimals", () => {
    expect(getLeagueBudgetError("0")).toBeNull();
    expect(getLeagueBudgetError("120.50")).toBeNull();
    expect(getLeagueBudgetError("-1")).not.toBeNull();
    expect(getLeagueBudgetError("1.234")).not.toBeNull();
    expect(getLeagueBudgetError("100000000")).not.toBeNull();
  });

  it("reads the invite token from a link query", () => {
    expect(readLeagueInviteToken("?invite=abc123")).toBe("abc123");
    expect(readLeagueInviteToken("?other=value")).toBeNull();
  });
});
