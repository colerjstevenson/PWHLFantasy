import { parsePwhlImport, type PwhlImportPayload } from "./pwhlImport";

const FEED_URL = "https://lscluster.hockeytech.com/feed/index.php";
const STAT_LIMIT = 500;
const MAX_BYTES = 5_000_000;

type SourceRecord = Record<string, unknown>;
type SourceSeason = { id: string; name: string; start: string; end: string };

export type SourceCatalogPreview = {
  payload: PwhlImportPayload;
  rosterSeasonId: string;
  rosterSeasonName: string;
  usedPriorRosterFallback: boolean;
};

export function parseSourceResponse(text: string): unknown {
  const trimmed = text.trim();
  // LeagueStat also returns bare parentheses when no callback is supplied.
  const wrapped = trimmed.match(
    /^(?:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)?\s*\(([\s\S]*)\)\s*;?$/,
  );
  try {
    return JSON.parse(wrapped ? wrapped[1] : trimmed);
  } catch {
    throw new Error("PWHL source did not return valid JSON or JSONP.");
  }
}

function object(value: unknown, label: string): SourceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} has an unexpected response shape.`);
  }
  return value as SourceRecord;
}

function rows(value: unknown, label: string): SourceRecord[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      `${label} is empty or unavailable; catalog was not changed.`,
    );
  }
  return value.map((item) => object(item, label));
}

function requiredText(value: unknown, label: string): string {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    !String(value).trim()
  ) {
    throw new Error(`${label} is missing.`);
  }
  return String(value).trim();
}

function unique(records: SourceRecord[], field: string, label: string) {
  const ids = records.map((row) => requiredText(row[field], `${label} ID`));
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${label} contains duplicate IDs.`);
  }
}

export function selectSourceSeasons(
  value: unknown,
  seasonId: string,
): { season: SourceSeason; prior: SourceSeason } {
  const site = object(object(value, "Seasons").SiteKit, "Season SiteKit");
  const records = rows(site.Seasons, "Seasons");
  unique(records, "season_id", "Seasons");
  const regular = records
    .filter(
      (row) =>
        String(row.playoff) === "0" &&
        typeof row.season_name === "string" &&
        /regular season/i.test(row.season_name),
    )
    .map((row): SourceSeason => {
      const start = requiredText(row.start_date, "Season start");
      const end = requiredText(row.end_date, "Season end");
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(start) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(end) ||
        !Number.isFinite(Date.parse(start)) ||
        !Number.isFinite(Date.parse(end)) ||
        new Date(start).toISOString().slice(0, 10) !== start ||
        new Date(end).toISOString().slice(0, 10) !== end ||
        end < start
      ) {
        throw new Error("Season dates are invalid.");
      }
      return {
        id: requiredText(row.season_id, "Season ID"),
        name: requiredText(row.season_name, "Season name"),
        start,
        end,
      };
    });
  const season = regular.find((row) => row.id === seasonId);
  if (!season) throw new Error("Select a known regular-season source ID.");
  const candidates = regular
    .filter((row) => row.start < season.start)
    .sort((left, right) => right.start.localeCompare(left.start));
  const prior = candidates[0];
  if (
    !prior ||
    prior.end >= season.start ||
    candidates[1]?.start === prior.start ||
    regular.filter((row) => row.start === season.start).length !== 1
  ) {
    throw new Error(
      "The prior regular season could not be identified reliably.",
    );
  }
  return { season, prior };
}

function moduleRows(
  value: unknown,
  view: string,
  field: string,
  seasonId: string,
  teamId?: string,
): SourceRecord[] {
  const site = object(object(value, view).SiteKit, `${view} SiteKit`);
  const parameters = object(site.Parameters, `${view} parameters`);
  if (
    parameters.view !== view ||
    String(parameters.season_id) !== seasonId ||
    (teamId !== undefined && String(parameters.team_id) !== teamId)
  ) {
    throw new Error(
      `${view} response does not match the requested season/team.`,
    );
  }
  if (field === "Roster" && teamId) {
    return sourceRosterRows(site[field], teamId);
  }
  return rows(site[field], field);
}

export function sourceRosterRows(
  value: unknown,
  teamId: string,
): SourceRecord[] {
  if (!Array.isArray(value)) throw new Error("Roster has an unexpected shape.");
  const entries: unknown[] = [...value];
  const last = entries[entries.length - 1];
  // ModuleKit appends team staff as a nested array, even for an empty roster.
  if (Array.isArray(last)) {
    entries.pop();
    for (const item of last) {
      const staff = object(item, "Roster staff");
      if (
        staff.player_id !== undefined ||
        staff.role_id === undefined ||
        String(staff.team_id) !== teamId
      ) {
        throw new Error("Roster staff has an unexpected shape.");
      }
    }
  }
  return entries.map((item) => object(item, `Roster for team ${teamId}`));
}

export function sourceStatRows(value: unknown): SourceRecord[] {
  const tables = rows(value, "Statistics");
  if (tables.length !== 1) {
    throw new Error("Statistics contain unexpected tables.");
  }
  const sections = rows(tables[0].sections, "Statistic sections");
  if (sections.length !== 1) {
    throw new Error("Statistics contain unexpected sections.");
  }
  const data = rows(sections[0].data, "Statistic records").map((entry) => {
    const row = object(entry.row, "Statistic row");
    const prop = object(entry.prop, "Statistic properties");
    const link = object(prop.name, "Statistic player link");
    if (String(link.playerLink) !== String(row.player_id)) {
      throw new Error("Statistic player ID and link disagree.");
    }
    return row;
  });
  if (data.length >= STAT_LIMIT) {
    throw new Error(
      "Statistics reached the page limit; completeness is unknown.",
    );
  }
  unique(data, "player_id", "Statistics");
  if (data.some((row, index) => Number(row.rank) !== index + 1)) {
    throw new Error("Statistics have missing or reordered ranks.");
  }
  return data;
}

async function readSource(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new Error(
      `PWHL source returned HTTP ${response.status}; no retry was made.`,
    );
  }
  if (Number(response.headers.get("content-length")) > MAX_BYTES) {
    throw new Error("PWHL source exceeded the 5 MB response limit.");
  }
  if (!response.body)
    throw new Error("PWHL source returned an empty response.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new Error("PWHL source exceeded the 5 MB response limit.");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return parseSourceResponse(text);
}

export async function fetchSourceCatalog(
  key: string,
  seasonId: string,
): Promise<SourceCatalogPreview> {
  if (!key) throw new Error("PWHL_FEED_KEY is not configured.");
  if (!/^\d+$/.test(seasonId))
    throw new Error("Season source ID must be numeric.");
  let requestCount = 0;
  const request = async (params: Record<string, string>) => {
    requestCount += 1;
    if (requestCount > 40) {
      throw new Error("Catalog fetch exceeded the 40-request safety limit.");
    }
    const url = new URL(FEED_URL);
    url.search = new URLSearchParams({
      key,
      client_code: "pwhl",
      ...params,
    }).toString();
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch (caught) {
      const timedOut =
        caught instanceof Error &&
        ["TimeoutError", "AbortError"].includes(caught.name);
      throw new Error(
        timedOut
          ? "PWHL source request timed out; no retry was made."
          : "PWHL source request failed; check availability and feed configuration. No retry was made.",
      );
    }
    return readSource(response);
  };
  const { season, prior } = selectSourceSeasons(
    await request({ feed: "modulekit", view: "seasons" }),
    seasonId,
  );
  if (prior.end >= new Date().toISOString().slice(0, 10)) {
    throw new Error("The prior regular season has not finished.");
  }
  async function teamsFor(sourceSeason: SourceSeason) {
    const teams = moduleRows(
      await request({
        feed: "modulekit",
        view: "teamsbyseason",
        season_id: sourceSeason.id,
      }),
      "teamsbyseason",
      "Teamsbyseason",
      sourceSeason.id,
    );
    unique(teams, "id", "Teams");
    if (teams.length > 32)
      throw new Error("Unexpected team count; fetch stopped.");
    return teams;
  }
  async function rostersFor(
    sourceSeason: SourceSeason,
    teams: SourceRecord[],
  ): Promise<SourceRecord[] | null> {
    const players: SourceRecord[] = [];
    // A valid empty roster signals that the season's roster set is not published yet.
    for (const team of teams) {
      const teamId = requiredText(team.id, "Team ID");
      const teamName = requiredText(team.name, "Team name");
      const roster = moduleRows(
        await request({
          feed: "modulekit",
          view: "roster",
          season_id: sourceSeason.id,
          team_id: teamId,
        }),
        "roster",
        "Roster",
        sourceSeason.id,
        teamId,
      );
      if (roster.length === 0) return null;
      for (const player of roster) {
        if (
          String(player.team_id) !== teamId ||
          String(player.player_id) !== String(player.id)
        ) {
          throw new Error("Roster player/team identifiers disagree.");
        }
        if (player.active === undefined || player.active === null) {
          throw new Error("Roster player active status is missing.");
        }
        players.push({ ...player, team_name: teamName });
      }
    }
    unique(players, "player_id", "Rosters");
    return players;
  }
  // Prefer the selected season's roster set. If any team roster is valid but
  // empty, discard the partial set and use the complete prior-season roster set.
  const currentTeams = await teamsFor(season);
  let rosterSeason = season;
  let players = await rostersFor(season, currentTeams);
  let usedPriorRosterFallback = false;
  if (players === null) {
    const priorTeams = await teamsFor(prior);
    players = await rostersFor(prior, priorTeams);
    if (players === null) {
      throw new Error(
        "Both current-season and prior-season rosters are empty; catalog was not changed.",
      );
    }
    rosterSeason = prior;
    usedPriorRosterFallback = true;
  }
  const stats: SourceRecord[] = [];
  const statPlayers: SourceRecord[] = [];
  for (const position of ["skaters", "goalies"]) {
    const records = sourceStatRows(
      await request({
        feed: "statviewfeed",
        view: "players",
        season: prior.id,
        team: "all",
        position,
        rookies: "0",
        statsType: "standard",
        rosterstatus: "undefined",
        site_id: "0",
        league_id: "1",
        first: "0",
        limit: String(STAT_LIMIT),
        sort: position === "goalies" ? "gaa" : "points",
        qualified: "all",
        lang: "en",
        division: "-1",
        conference: "-1",
      }),
    );
    stats.push(...records);
    statPlayers.push(
      ...records.map((row) => ({
        ...row,
        position: position === "goalies" ? "G" : row.position,
        type: position === "goalies" ? "goalie" : "skater",
      })),
    );
  }
  const metadata = {
    id: season.id,
    name: season.name,
    priorSeasonId: prior.id,
  };
  const historical = parsePwhlImport({
    season: metadata,
    players: statPlayers,
    seasonStats: stats,
  });
  if (historical.seasonStats.some((stat) => !stat.complete)) {
    throw new Error("Prior-season statistics have missing scoring fields.");
  }
  const ids = new Set(players.map((player) => String(player.player_id)));
  const normalized = parsePwhlImport({
    season: metadata,
    players,
    seasonStats: stats.filter((row) => ids.has(String(row.player_id))),
  });
  if (normalized.seasonStats.length === 0) {
    throw new Error("Roster and prior-season statistics share no player IDs.");
  }
  const historicalTypes = new Map(
    historical.players.map((player) => [player.id, player.playerType]),
  );
  if (
    normalized.players.some(
      (player) =>
        historicalTypes.has(player.id) &&
        historicalTypes.get(player.id) !== player.playerType,
    )
  ) {
    throw new Error("Roster and prior-season player types disagree.");
  }
  return {
    payload: normalized,
    rosterSeasonId: rosterSeason.id,
    rosterSeasonName: rosterSeason.name,
    usedPriorRosterFallback,
  };
}
