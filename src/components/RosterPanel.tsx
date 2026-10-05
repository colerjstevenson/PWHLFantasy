import { useCallback, useEffect, useMemo, useState } from "react";
import {
  assessRoster,
  getRosterDraftKey,
  type RosterPlayer,
  type RosterPosition,
} from "../lib/roster";
import { supabase } from "../lib/supabase";

type League = {
  id: string;
  season_id: string;
  roster_size: number;
  budget: number;
};

type CatalogPlayer = {
  id: string;
  name: string;
  team_name: string | null;
  position: RosterPosition;
  active: boolean;
};

type Assignment = {
  player_id: string;
  tier: number | null;
  tier_override: number | null;
  status: "ready" | "needs_review";
};

type Props = {
  league: League;
  userId: string;
};

function messageOf(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The roster operation failed.";
}

function formatCredits(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function RosterPanel({ league, userId }: Props) {
  const [teamId, setTeamId] = useState<string | null>(null);
  const [players, setPlayers] = useState<RosterPlayer[]>([]);
  const [savedIds, setSavedIds] = useState<string[]>([]);
  const [draftIds, setDraftIds] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [positionFilter, setPositionFilter] = useState<"all" | RosterPosition>(
    "all",
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const assessment = useMemo(
    () =>
      assessRoster(draftIds, players, {
        rosterSize: league.roster_size,
        budget: Number(league.budget),
      }),
    [draftIds, league.budget, league.roster_size, players],
  );

  const loadRoster = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    setError(null);
    try {
      const teamResult = await supabase
        .from("fantasy_teams")
        .select("id")
        .eq("league_id", league.id)
        .eq("user_id", userId)
        .maybeSingle();
      if (teamResult.error) throw teamResult.error;
      if (!teamResult.data) throw new Error("Your league team was not found.");
      const nextTeamId = teamResult.data.id;

      const [playerResult, assignmentResult, costResult, rosterResult] =
        await Promise.all([
          supabase
            .from("players")
            .select("id, name, team_name, position, active")
            .order("name"),
          supabase
            .from("player_season_assignments")
            .select("player_id, tier, tier_override, status")
            .eq("season_id", league.season_id),
          supabase
            .from("tier_costs")
            .select("tier, cost")
            .eq("season_id", league.season_id),
          supabase
            .from("fantasy_roster_players")
            .select("player_id")
            .eq("team_id", nextTeamId),
        ]);
      if (playerResult.error) throw playerResult.error;
      if (assignmentResult.error) throw assignmentResult.error;
      if (costResult.error) throw costResult.error;
      if (rosterResult.error) throw rosterResult.error;

      const assignments = new Map(
        ((assignmentResult.data ?? []) as Assignment[]).map((assignment) => [
          assignment.player_id,
          assignment,
        ]),
      );
      const costs = new Map(
        (costResult.data ?? []).map((cost) => [cost.tier, Number(cost.cost)]),
      );
      const catalog = ((playerResult.data ?? []) as CatalogPlayer[]).map(
        (player): RosterPlayer => {
          const assignment = assignments.get(player.id);
          const tier = assignment?.tier_override ?? assignment?.tier ?? 0;
          const cost = costs.get(tier);
          return {
            id: player.id,
            name: player.name,
            teamName: player.team_name,
            position: player.position,
            tier,
            cost: cost ?? Number.NaN,
            active: player.active,
            ready: assignment?.status === "ready" && cost !== undefined,
          };
        },
      );
      const currentSavedIds = (rosterResult.data ?? []).map(
        (row) => row.player_id,
      );
      const key = getRosterDraftKey(userId, nextTeamId);
      let initialDraft = currentSavedIds;
      try {
        const storedDraft = window.localStorage.getItem(key);
        if (storedDraft !== null) {
          const parsed: unknown = JSON.parse(storedDraft);
          if (
            !Array.isArray(parsed) ||
            !parsed.every((id): id is string => typeof id === "string")
          ) {
            throw new Error("The saved roster draft has an invalid format.");
          }
          initialDraft = parsed;
        }
      } catch (storageError) {
        setError(
          `Could not restore this device's roster draft: ${messageOf(storageError)}`,
        );
      }

      setTeamId(nextTeamId);
      setPlayers(catalog);
      setSavedIds(currentSavedIds);
      setDraftIds(initialDraft);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setLoading(false);
    }
  }, [league.id, league.season_id, userId]);

  useEffect(() => {
    void loadRoster();
  }, [loadRoster]);

  const visiblePlayers = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase();
    return players.filter((player) => {
      const matchesPosition =
        positionFilter === "all" || player.position === positionFilter;
      const matchesSearch =
        !normalizedSearch ||
        player.name.toLocaleLowerCase().includes(normalizedSearch) ||
        (player.teamName ?? "").toLocaleLowerCase().includes(normalizedSearch);
      return matchesPosition && matchesSearch;
    });
  }, [players, positionFilter, search]);

  function updateDraft(nextIds: string[]) {
    setDraftIds(nextIds);
    setError(null);
    setNotice(null);
    if (!teamId) return;
    try {
      window.localStorage.setItem(
        getRosterDraftKey(userId, teamId),
        JSON.stringify(nextIds),
      );
    } catch (caught) {
      setError(
        `Draft changes are only in memory because this device could not save them: ${messageOf(caught)}`,
      );
    }
  }

  function togglePlayer(player: RosterPlayer) {
    if (!player.active || !player.ready) return;
    updateDraft(
      draftIds.includes(player.id)
        ? draftIds.filter((id) => id !== player.id)
        : [...draftIds, player.id],
    );
  }

  async function saveRoster() {
    if (!supabase || !teamId || !assessment.valid) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const { error: saveError } = await supabase.rpc("save_fantasy_roster", {
        p_team_id: teamId,
        p_player_ids: draftIds,
      });
      if (saveError) throw saveError;
      setSavedIds([...draftIds]);
      try {
        window.localStorage.removeItem(getRosterDraftKey(userId, teamId));
      } catch (storageError) {
        setError(
          `Roster saved, but this device could not clear its local draft: ${messageOf(storageError)}`,
        );
      }
      setNotice("Your roster was saved.");
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setSaving(false);
    }
  }

  const savedAssessment = assessRoster(savedIds, players, {
    rosterSize: league.roster_size,
    budget: Number(league.budget),
  });
  const hasUnsavedChanges =
    [...savedIds].sort().join("\0") !== [...draftIds].sort().join("\0");

  return (
    <section className="roster-workspace" aria-labelledby="roster-title">
      <div className="section-heading">
        <div>
          <h3 id="roster-title">Your roster</h3>
          <p>
            Search the player pool and build a {league.roster_size}-player team.
            Draft changes stay on this device until you save.
          </p>
        </div>
        <button
          type="button"
          disabled={
            loading || saving || !assessment.valid || !hasUnsavedChanges
          }
          onClick={() => void saveRoster()}
        >
          {saving ? "Saving…" : "Save roster"}
        </button>
      </div>

      {loading ? (
        <p role="status">Loading your roster and the player catalog…</p>
      ) : (
        <>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="success" role="status">
              {notice}
            </p>
          )}
          {savedIds.length > 0 && !savedAssessment.valid && (
            <div className="roster-warning" role="status">
              <strong>Your saved roster needs attention.</strong>
              <p>
                The catalog or league rules changed. The saved roster has not
                been altered; update it and save a valid roster before lock.
              </p>
            </div>
          )}
          <div className="roster-summary" aria-live="polite">
            <span>
              Roster <strong>{draftIds.length}</strong> / {league.roster_size}
            </span>
            <span>
              Budget used <strong>{formatCredits(assessment.totalCost)}</strong>{" "}
              / {Number(league.budget).toFixed(2)}
            </span>
            <span>
              Remaining{" "}
              <strong>{formatCredits(assessment.remainingBudget)}</strong>
            </span>
            <span>
              F {assessment.positions.F}/3 · D {assessment.positions.D}/2 · G{" "}
              {assessment.positions.G}/1
            </span>
          </div>

          <div className="roster-layout">
            <section aria-labelledby="selected-roster-title">
              <h4 id="selected-roster-title">Selected players</h4>
              {draftIds.length === 0 ? (
                <p className="fine-print">No players selected yet.</p>
              ) : (
                <ul className="selected-player-list">
                  {draftIds.map((id, index) => {
                    const player = players.find((item) => item.id === id);
                    return (
                      <li key={`${id}-${index}`}>
                        <span>
                          <strong>
                            {player?.name ?? "Unavailable player"}
                          </strong>
                          <small>
                            {player
                              ? `${player.position} · ${player.teamName ?? "No team"} · $${Number.isFinite(player.cost) ? player.cost.toFixed(2) : "unavailable"}`
                              : `Catalog ID ${id}`}
                          </small>
                        </span>
                        <button
                          type="button"
                          className="secondary-button small-button"
                          aria-label={`Remove ${player?.name ?? "unavailable player"}`}
                          onClick={() =>
                            updateDraft(
                              draftIds.filter((playerId) => playerId !== id),
                            )
                          }
                        >
                          Remove
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              {assessment.issues.length > 0 ? (
                <ul className="roster-issues" aria-label="Roster requirements">
                  {assessment.issues.map((issue, index) => (
                    <li key={`${issue}-${index}`}>{issue}</li>
                  ))}
                </ul>
              ) : (
                <p className="roster-valid" role="status">
                  Roster meets all requirements.
                </p>
              )}
            </section>

            <section aria-labelledby="player-pool-title">
              <div className="section-heading player-pool-heading">
                <h4 id="player-pool-title">Player pool</h4>
                <label>
                  Position
                  <select
                    value={positionFilter}
                    onChange={(event) =>
                      setPositionFilter(
                        event.target.value as "all" | RosterPosition,
                      )
                    }
                  >
                    <option value="all">All positions</option>
                    <option value="F">Forward</option>
                    <option value="D">Defence</option>
                    <option value="G">Goalie</option>
                  </select>
                </label>
              </div>
              <label className="player-search">
                Search by player or team
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search players"
                />
              </label>
              {visiblePlayers.length === 0 ? (
                <p className="fine-print">No players match this search.</p>
              ) : (
                <ul className="player-pool">
                  {visiblePlayers.map((player) => {
                    const selected = draftIds.includes(player.id);
                    const disabled =
                      (!selected &&
                        (!player.active ||
                          !player.ready ||
                          draftIds.length >= league.roster_size)) ||
                      saving;
                    return (
                      <li key={player.id}>
                        <div>
                          <strong>{player.name}</strong>
                          <small>
                            {player.position} · {player.teamName ?? "No team"} ·
                            Tier {player.tier || "—"} ·{" "}
                            {Number.isFinite(player.cost)
                              ? `$${player.cost.toFixed(2)}`
                              : "Cost unavailable"}
                          </small>
                          {!player.active && (
                            <small className="player-unavailable">
                              Inactive
                            </small>
                          )}
                          {player.active && !player.ready && (
                            <small className="player-unavailable">
                              Needs catalog review
                            </small>
                          )}
                        </div>
                        <button
                          type="button"
                          className={
                            selected
                              ? "secondary-button small-button"
                              : "small-button"
                          }
                          disabled={disabled}
                          aria-pressed={selected}
                          onClick={() => togglePlayer(player)}
                        >
                          {selected ? "Remove" : "Add"}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </section>
  );
}
