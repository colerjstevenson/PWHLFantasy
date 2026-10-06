import { afterEach, describe, expect, it, vi } from "vitest";
import excerpts from "../../fixtures/catalog-source-excerpts.json";
import {
  fetchSourceCatalog,
  parseSourceResponse,
  selectSourceSeasons,
  sourceRosterRows,
  sourceStatRows,
} from "./pwhlSource";

afterEach(() => vi.unstubAllGlobals());

function mockSource(
  options: {
    emptyRoster?: boolean;
    missingField?: boolean;
    missingActive?: boolean;
    wrongSeason?: boolean;
    noMatch?: boolean;
    duplicate?: boolean;
    unavailable?: boolean;
    typeMismatch?: boolean;
    previousRosterEmpty?: boolean;
  } = {},
) {
  const fetchMock = vi.fn(async (input: URL | string) => {
    const url = new URL(input);
    expect(url.hostname).toBe("lscluster.hockeytech.com");
    const view = url.searchParams.get("view");
    let result: unknown;
    if (view === "seasons") result = excerpts.seasons;
    else if (view === "teamsbyseason") {
      const teams = structuredClone(excerpts.teams);
      teams.SiteKit.Parameters.season_id = Number(
        url.searchParams.get("season_id"),
      );
      result = teams;
    } else if (view === "roster") {
      const rosterSeason = url.searchParams.get("season_id");
      if (
        (options.emptyRoster && rosterSeason === "11") ||
        (options.previousRosterEmpty && rosterSeason === "8")
      ) {
        result =
          rosterSeason === "8"
            ? {
                SiteKit: {
                  Parameters: {
                    view: "roster",
                    season_id: 8,
                    team_id: url.searchParams.get("team_id"),
                  },
                  Roster: [[]],
                },
              }
            : excerpts.emptyCurrentRoster;
      } else if (rosterSeason === "8") {
        const roster = structuredClone(excerpts.historicalRoster);
        roster.SiteKit.Parameters.team_id =
          url.searchParams.get("team_id") ?? "";
        result = roster;
      } else {
        // Synthetic current roster exercises joins, new players and staff handling.
        const players = [
          {
            id: "23",
            player_id: "23",
            name: "Kelly Pannek",
            position: "F",
            active: "1",
            team_id: "1",
          },
          {
            id: "6",
            player_id: "6",
            name: "Aerin Frankel",
            position: "G",
            active: "1",
            team_id: "1",
          },
          {
            id: "new",
            player_id: "new",
            name: "New player",
            position: "D",
            active: "0",
            team_id: "1",
          },
        ];
        if (options.missingActive) Reflect.deleteProperty(players[0], "active");
        if (options.noMatch) players.splice(0, 2);
        if (options.duplicate) players.push(players[0]);
        if (options.typeMismatch) players[0].position = "G";
        result = {
          SiteKit: {
            Parameters: {
              view: "roster",
              season_id: options.wrongSeason ? 8 : Number(rosterSeason),
              team_id: "1",
            },
            Roster: [...players, [{ team_id: "1", role_id: "2" }]],
          },
        };
      }
    } else {
      expect(url.searchParams.get("season")).toBe("8");
      expect(url.searchParams.get("first")).toBe("0");
      expect(url.searchParams.get("limit")).toBe("500");
      result = structuredClone(
        url.searchParams.get("position") === "skaters"
          ? excerpts.skaters
          : excerpts.goalies,
      );
      if (
        options.missingField &&
        url.searchParams.get("position") === "skaters"
      ) {
        const missing = structuredClone(excerpts.skaters);
        Reflect.deleteProperty(missing[0].sections[0].data[0].row, "hits");
        result = missing;
      }
      return new Response(`(${JSON.stringify(result)})`, {
        status: options.unavailable ? 429 : 200,
      });
    }
    return Response.json(result);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("HockeyTech catalog adapter", () => {
  it("parses JSON, bare parentheses and named JSONP without executing code", () => {
    for (const text of ['{"ok":1}', '({"ok":1})', 'callback.name({"ok":1});']) {
      expect(parseSourceResponse(text)).toEqual({ ok: 1 });
    }
    expect(() => parseSourceResponse('callback({}); alert("bad")')).toThrow();
    expect(() => parseSourceResponse("<html>Unavailable</html>")).toThrow();
  });

  it("selects the prior regular season from dates, not ID order", () => {
    const result = selectSourceSeasons(excerpts.seasons, "11");
    expect(result.prior.id).toBe("8");
    expect(() => selectSourceSeasons(excerpts.seasons, "10")).toThrow(
      "regular-season",
    );
    expect(() => selectSourceSeasons(excerpts.seasons, "8")).toThrow(
      "prior regular season",
    );
    const changed = structuredClone(excerpts.seasons);
    changed.SiteKit.Seasons[0].season_id = "42";
    expect(selectSourceSeasons(changed, "42").prior.id).toBe("8");
  });

  it("rejects invalid, overlapping and ambiguous season dates", () => {
    const invalid = structuredClone(excerpts.seasons);
    invalid.SiteKit.Seasons[0].start_date = "2026-02-31";
    expect(() => selectSourceSeasons(invalid, "11")).toThrow(
      "dates are invalid",
    );
    const overlap = structuredClone(excerpts.seasons);
    overlap.SiteKit.Seasons[3].end_date = "2026-12-05";
    expect(() => selectSourceSeasons(overlap, "11")).toThrow(
      "identified reliably",
    );
    const duplicate = structuredClone(excerpts.seasons);
    duplicate.SiteKit.Seasons.push({
      ...duplicate.SiteKit.Seasons[3],
      season_id: "88",
    });
    expect(() => selectSourceSeasons(duplicate, "11")).toThrow(
      "identified reliably",
    );
  });

  it("separates the captured staff array and recognizes an empty roster", () => {
    const roster = sourceRosterRows(
      excerpts.historicalRoster.SiteKit.Roster,
      "1",
    );
    expect(roster.map((row) => row.player_id)).toEqual(["12", "6"]);
    expect(
      sourceStatRows(excerpts.goalies).some(
        (row) => row.player_id === roster[1].player_id,
      ),
    ).toBe(true);
    expect(sourceRosterRows([[]], "1")).toEqual([]);
    expect(() =>
      sourceRosterRows([[{ player_id: "6", team_id: "1" }]], "1"),
    ).toThrow("staff");
  });

  it("normalizes required scoring fields while preserving genuine no-history review", async () => {
    const requests = mockSource();
    const result = await fetchSourceCatalog("test-key", "11");
    expect(requests).toHaveBeenCalledTimes(5);
    expect(result.payload.priorSeasonId).toBe("8");
    expect(result.rosterSeasonId).toBe("11");
    expect(result.usedPriorRosterFallback).toBe(false);
    expect(result.payload.players.map((player) => player.position)).toEqual([
      "F",
      "G",
      "D",
    ]);
    expect(result.payload.players[2].active).toBe(false);
    expect(result.payload.seasonStats.map((stat) => stat.playerId)).toEqual([
      "23",
      "6",
    ]);
    expect(result.payload.seasonStats.every((stat) => stat.complete)).toBe(
      true,
    );
    expect(result.payload.seasonStats[0].stats.blocked_shots).toBe(33);
    expect(result.payload.seasonStats[1].stats.goals).toBe(0);
  });

  it("falls back to the complete prior-season roster set when the upcoming roster is empty", async () => {
    const requests = mockSource({ emptyRoster: true });
    const result = await fetchSourceCatalog("test-key", "11");
    expect(requests).toHaveBeenCalledTimes(7);
    expect(
      requests.mock.calls.map(
        ([input]) =>
          new URL(input).searchParams.get("season_id") ??
          new URL(input).searchParams.get("season"),
      ),
    ).toEqual([null, "11", "11", "8", "8", "8", "8"]);
    expect(result.usedPriorRosterFallback).toBe(true);
    expect(result.rosterSeasonId).toBe("8");
    expect(result.rosterSeasonName).toBe("2025-26 Regular Season");
    expect(result.payload.players.map((player) => player.id)).toEqual([
      "12",
      "6",
    ]);
    expect(result.payload.seasonStats.map((stat) => stat.playerId)).toEqual([
      "6",
    ]);
  });

  it.each([
    [{ missingField: true }, "missing scoring fields"],
    [{ missingActive: true }, "active status"],
    [{ wrongSeason: true }, "requested season/team"],
    [{ duplicate: true }, "duplicate IDs"],
    [{ noMatch: true }, "share no player IDs"],
    [{ unavailable: true }, "HTTP 429"],
    [{ typeMismatch: true }, "types disagree"],
    [{ emptyRoster: true, previousRosterEmpty: true }, "Both current-season"],
  ])("fails closed for invalid source data: %j", async (options, error) => {
    const requests = mockSource(options);
    await expect(fetchSourceCatalog("test-key", "11")).rejects.toThrow(error);
    expect(requests.mock.calls.length).toBeLessThanOrEqual(40);
  });

  it("rejects missing ranks, mismatched links, duplicate IDs, and page-limit responses", () => {
    const changed = structuredClone(excerpts.goalies);
    changed[0].sections[0].data[1].row.rank = 3;
    expect(() => sourceStatRows(changed)).toThrow("ranks");
    changed[0].sections[0].data[1].row.rank = 2;
    changed[0].sections[0].data[1].prop.name.playerLink = "bad";
    expect(() => sourceStatRows(changed)).toThrow("link disagree");
    const entry = excerpts.skaters[0].sections[0].data[0];
    expect(() =>
      sourceStatRows([{ sections: [{ data: [entry, entry] }] }]),
    ).toThrow("duplicate IDs");
    expect(() =>
      sourceStatRows([{ sections: [{ data: Array(500).fill(entry) }] }]),
    ).toThrow("page limit");
  });

  it("rejects oversized responses and invalid configuration without retrying", async () => {
    const requests = vi
      .fn()
      .mockResolvedValue(
        new Response("{}", { headers: { "content-length": "5000001" } }),
      );
    vi.stubGlobal("fetch", requests);
    await expect(fetchSourceCatalog("test-key", "11")).rejects.toThrow("5 MB");
    expect(requests).toHaveBeenCalledTimes(1);
    await expect(fetchSourceCatalog("", "11")).rejects.toThrow(
      "not configured",
    );
    await expect(
      fetchSourceCatalog("test-key", "https://example.com"),
    ).rejects.toThrow("numeric");
    expect(requests).toHaveBeenCalledTimes(1);
  });

  it("enforces the streamed byte limit even without content-length", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5_000_001));
      },
      cancel() {
        cancelled = true;
      },
    });
    const requests = vi.fn().mockResolvedValue(new Response(body));
    vi.stubGlobal("fetch", requests);
    await expect(fetchSourceCatalog("test-key", "11")).rejects.toThrow("5 MB");
    expect(cancelled).toBe(true);
    expect(requests).toHaveBeenCalledTimes(1);
  });

  it("reports network failures without exposing the credential-bearing URL", async () => {
    const requests = vi
      .fn()
      .mockRejectedValue(
        new Error("Fetch failed: https://source.example/?key=sensitive-value"),
      );
    vi.stubGlobal("fetch", requests);
    await expect(fetchSourceCatalog("test-key", "11")).rejects.toThrow(
      "check availability and feed configuration",
    );
    expect(requests).toHaveBeenCalledTimes(1);
    requests.mockRejectedValueOnce(
      new DOMException("Timed out", "TimeoutError"),
    );
    await expect(fetchSourceCatalog("test-key", "11")).rejects.toThrow(
      "timed out",
    );
  });
});
