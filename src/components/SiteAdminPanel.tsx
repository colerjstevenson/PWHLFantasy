import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import {
  DEFAULT_SCORING_VALUES,
  easternInputToIso,
  isoToEasternInput,
  type ScoringValues,
} from "../lib/catalog";
import { parsePwhlImport, type PwhlImportPayload } from "../lib/pwhlImport";
import {
  parseFinalGameImport,
  type FinalGameImportPayload,
} from "../lib/gameScoring";
import { supabase } from "../lib/supabase";

const SCORING_LABELS: ReadonlyArray<[keyof ScoringValues, string]> = [
  ["skater_goal", "Skater goal"],
  ["skater_assist", "Skater assist"],
  ["skater_shot", "Skater shot"],
  ["skater_short_handed_goal", "Short-handed goal bonus"],
  ["skater_short_handed_assist", "Short-handed assist bonus"],
  ["skater_blocked_shot", "Blocked shot"],
  ["skater_hit", "Hit"],
  ["skater_plus_minus", "Plus/minus"],
  ["goalie_goal", "Goalie goal"],
  ["goalie_assist", "Goalie assist"],
  ["goalie_win", "Goalie win"],
  ["goalie_shutout", "Goalie shutout"],
  ["goalie_save", "Goalie save"],
  ["goalie_goal_against", "Goalie goal against"],
];

type CatalogSeason = {
  id: string;
  name: string;
  prior_season_id: string;
  roster_lock_at: string;
  scoring_values: ScoringValues;
  scoring_version: number;
  frozen_at: string | null;
};

type CatalogPlayer = {
  id: string;
  name: string;
  team_name: string | null;
  position: string;
  active: boolean;
  stats_complete: boolean;
  calculated_projection: number | null;
  projection_override: number | null;
  tier: number | null;
  status: "ready" | "needs_review";
};

type ImportRun = {
  id: number;
  started_at: string;
  completed_at: string | null;
  status: string;
  player_count: number;
  stats_count: number;
  review_count: number;
  error_message: string | null;
};

type GameImportRun = {
  id: number;
  started_at: string;
  completed_at: string | null;
  status: string;
  game_count: number;
  stat_count: number;
  error_message: string | null;
  source: string;
};

type Props = { userId: string };

function getErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The catalog operation failed.";
}

function numberInput(value: string): number {
  if (!value.trim())
    throw new Error("Every scoring value and tier cost is required.");
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error("Enter valid numeric values.");
  return parsed;
}

function formatTimestamp(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

export function SiteAdminPanel({ userId }: Props) {
  const [access, setAccess] = useState<
    "checking" | "owner" | "not-owner" | "error"
  >("checking");
  const [seasonId, setSeasonId] = useState("11");
  const [seasonName, setSeasonName] = useState("2026-27 Regular Season");
  const [priorSeasonId, setPriorSeasonId] = useState("8");
  const [lockAt, setLockAt] = useState("2026-12-05T15:00");
  const [scoring, setScoring] = useState<ScoringValues>(DEFAULT_SCORING_VALUES);
  const [tierCosts, setTierCosts] = useState(["", "", "", "", ""]);
  const [players, setPlayers] = useState<CatalogPlayer[]>([]);
  const [runs, setRuns] = useState<ImportRun[]>([]);
  const [payload, setPayload] = useState<PwhlImportPayload | null>(null);
  const [gamePayload, setGamePayload] = useState<FinalGameImportPayload | null>(
    null,
  );
  const [gameRuns, setGameRuns] = useState<GameImportRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<
    "all" | "needs_review" | "ready"
  >("needs_review");
  const [reviewDrafts, setReviewDrafts] = useState<
    Record<string, { projection: string; tier: string }>
  >({});
  const [frozenAt, setFrozenAt] = useState<string | null>(null);
  const [scoringVersion, setScoringVersion] = useState(1);

  const loadCatalog = useCallback(async (id: string) => {
    if (!supabase) return;
    const [
      seasonResult,
      assignmentsResult,
      playersResult,
      runsResult,
      costsResult,
      gameRunsResult,
    ] = await Promise.all([
      supabase.from("catalog_seasons").select("*").eq("id", id).maybeSingle(),
      supabase
        .from("player_season_assignments")
        .select("*")
        .eq("season_id", id),
      supabase.from("players").select("id, name, team_name, position, active"),
      supabase
        .from("catalog_import_runs")
        .select("*")
        .eq("season_id", id)
        .order("started_at", { ascending: false })
        .limit(20),
      supabase.from("tier_costs").select("*").eq("season_id", id),
      supabase.rpc("get_game_import_runs", { p_season_id: id }),
    ]);
    const failed = [
      seasonResult.error,
      assignmentsResult.error,
      playersResult.error,
      runsResult.error,
      costsResult.error,
      gameRunsResult.error,
    ].find(Boolean);
    if (failed) throw failed;

    if (seasonResult.data) {
      const season = seasonResult.data as CatalogSeason;
      setSeasonName(season.name);
      setPriorSeasonId(season.prior_season_id);
      setLockAt(isoToEasternInput(season.roster_lock_at));
      setScoring(season.scoring_values);
      setScoringVersion(season.scoring_version);
      setFrozenAt(season.frozen_at);
    } else {
      setFrozenAt(null);
    }

    const playerById = new Map(
      (playersResult.data ?? []).map((player) => [player.id, player]),
    );
    setPlayers(
      (assignmentsResult.data ?? []).flatMap((assignment) => {
        const player = playerById.get(assignment.player_id);
        return player
          ? [
              {
                ...player,
                stats_complete: assignment.stats_complete,
                calculated_projection: assignment.calculated_projection,
                projection_override: assignment.projection_override,
                tier: assignment.tier,
                status: assignment.status,
              } as CatalogPlayer,
            ]
          : [];
      }),
    );
    setRuns((runsResult.data ?? []) as ImportRun[]);
    setGameRuns((gameRunsResult.data ?? []) as GameImportRun[]);
    const costsByTier = new Map(
      (costsResult.data ?? []).map((cost) => [
        Number(cost.tier),
        String(cost.cost),
      ]),
    );
    setTierCosts([1, 2, 3, 4, 5].map((tier) => costsByTier.get(tier) ?? ""));
  }, []);

  useEffect(() => {
    let active = true;
    async function checkOwner() {
      if (!supabase) {
        setAccess("error");
        setError("Supabase is not configured.");
        return;
      }
      try {
        const { data, error: rpcError } = await supabase.rpc("is_site_owner");
        if (rpcError) throw rpcError;
        if (!active) return;
        setAccess(data ? "owner" : "not-owner");
        if (data) await loadCatalog(seasonId);
      } catch (caught) {
        if (!active) return;
        setAccess("error");
        setError(getErrorMessage(caught));
      }
    }
    void checkOwner();
    return () => {
      active = false;
    };
  }, [loadCatalog, seasonId]);

  const visiblePlayers = useMemo(
    () =>
      players
        .filter(
          (player) => statusFilter === "all" || player.status === statusFilter,
        )
        .sort(
          (left, right) =>
            (left.status === "needs_review" ? 0 : 1) -
              (right.status === "needs_review" ? 0 : 1) ||
            left.name.localeCompare(right.name),
        ),
    [players, statusFilter],
  );
  const lockHasPassed = (() => {
    try {
      return new Date(easternInputToIso(lockAt)) <= new Date();
    } catch {
      return false;
    }
  })();

  async function saveConfiguration(
    event?: FormEvent<HTMLFormElement>,
    throwOnError = false,
  ) {
    event?.preventDefault();
    if (!supabase) return;
    if (!throwOnError) setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const costs = tierCosts.map((cost, index) => ({
        tier: index + 1,
        cost: numberInput(cost),
      }));
      const scoringValues = Object.fromEntries(
        SCORING_LABELS.map(([key]) => [key, numberInput(String(scoring[key]))]),
      ) as ScoringValues;
      const { error: saveError } = await supabase.rpc(
        "save_catalog_configuration",
        {
          p_season_id: seasonId.trim(),
          p_name: seasonName.trim(),
          p_prior_season_id: priorSeasonId.trim(),
          p_roster_lock_at: easternInputToIso(lockAt),
          p_scoring_values: scoringValues,
          p_tier_costs: costs,
        },
      );
      if (saveError) throw saveError;
      setScoring(scoringValues);
      await loadCatalog(seasonId.trim());
      setNotice("Catalog settings saved.");
    } catch (caught) {
      setError(getErrorMessage(caught));
      if (throwOnError) throw caught;
    } finally {
      if (!throwOnError) setBusy(false);
    }
  }

  async function chooseImport(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    setPayload(null);
    setError(null);
    setNotice(null);
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const normalized = parsePwhlImport(parsed);
      setPayload(normalized);
      setSeasonId(normalized.seasonId);
      setSeasonName(normalized.seasonName);
      setPriorSeasonId(normalized.priorSeasonId);
      setNotice(
        `Validated ${normalized.players.length} players and ${normalized.seasonStats.length} season-stat records.`,
      );
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      input.value = "";
    }
  }

  async function importCatalog() {
    if (!supabase || !payload) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await saveConfiguration(undefined, true);
      const { error: importError } = await supabase.rpc("import_catalog_data", {
        p_season_id: seasonId.trim(),
        p_players: payload.players,
        p_season_stats: payload.seasonStats.map((stat) => ({
          playerId: stat.playerId,
          stats: stat.stats,
          complete: stat.complete,
        })),
      });
      if (importError) {
        const { error: recordError } = await supabase.rpc(
          "record_catalog_import_failure",
          {
            p_season_id: seasonId.trim(),
            p_error_message: importError.message,
          },
        );
        if (recordError) {
          throw new Error(
            `${importError.message} Import failure could not be recorded: ${recordError.message}`,
          );
        }
        throw importError;
      }
      setPayload(null);
      await loadCatalog(seasonId.trim());
      setNotice("Season catalog imported successfully.");
    } catch (caught) {
      setError(getErrorMessage(caught));
      await loadCatalog(seasonId.trim()).catch((loadError: unknown) =>
        setError(
          `${getErrorMessage(caught)} Catalog refresh failed: ${getErrorMessage(loadError)}`,
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  async function chooseGameImport(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    setGamePayload(null);
    setError(null);
    setNotice(null);
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const gameImport = parseFinalGameImport(parsed);
      setGamePayload(gameImport);
      setNotice(
        `Validated ${gameImport.games.length} games; ${gameImport.games.filter((game) => game.status === 4 && game.final).length} are official final.`,
      );
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      input.value = "";
    }
  }

  async function importGameStats() {
    if (!supabase || !gamePayload) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { error: importError } = await supabase.rpc(
        "import_final_game_data",
        {
          p_season_id: seasonId.trim(),
          p_games: gamePayload.games,
          p_schedule_complete: gamePayload.scheduleComplete,
        },
      );
      if (importError) {
        const { error: recordError } = await supabase.rpc(
          "record_game_import_failure",
          {
            p_season_id: seasonId.trim(),
            p_error_message: importError.message,
            p_source: "owner_upload",
          },
        );
        if (recordError) {
          throw new Error(
            `${importError.message} Import failure could not be recorded: ${recordError.message}`,
          );
        }
        throw importError;
      }
      setGamePayload(null);
      await loadCatalog(seasonId.trim());
      setNotice("Game schedule and official final statistics imported.");
    } catch (caught) {
      setError(getErrorMessage(caught));
      await loadCatalog(seasonId.trim()).catch((loadError: unknown) =>
        setError(
          `${getErrorMessage(caught)} Import history refresh failed: ${getErrorMessage(loadError)}`,
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  async function reviewPlayer(player: CatalogPlayer) {
    if (!supabase) return;
    const draft = reviewDrafts[player.id] ?? {
      projection: String(player.projection_override ?? ""),
      tier: String(player.tier ?? 1),
    };
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { error: reviewError } = await supabase.rpc(
        "review_catalog_player",
        {
          p_season_id: seasonId.trim(),
          p_player_id: player.id,
          p_projection: draft.projection.trim()
            ? numberInput(draft.projection)
            : null,
          p_tier: Number(draft.tier),
        },
      );
      if (reviewError) throw reviewError;
      await loadCatalog(seasonId.trim());
      setNotice(`${player.name} assignment approved.`);
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function freezeCatalog() {
    if (!supabase) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { error: freezeError } = await supabase.rpc(
        "freeze_catalog_season",
        { p_season_id: seasonId.trim() },
      );
      if (freezeError) throw freezeError;
      await loadCatalog(seasonId.trim());
      setNotice("The immutable roster-lock catalog snapshot was created.");
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (access === "checking") {
    return (
      <section className="panel admin-panel" aria-labelledby="admin-title">
        <h2 id="admin-title">Site-owner catalog</h2>
        <p role="status">Checking site-owner permissions…</p>
      </section>
    );
  }

  if (access === "not-owner") {
    return (
      <section className="panel admin-panel" aria-labelledby="admin-title">
        <p className="eyebrow">Administration</p>
        <h2 id="admin-title">Site-owner catalog</h2>
        <p>
          This account is not assigned the site-owner role. To bootstrap the
          owner, add this user ID to <code>public.site_owner_roles</code> using
          the Supabase SQL editor:
        </p>
        <pre className="owner-sql">
          insert into public.site_owner_roles (user_id) values ('{userId}');
        </pre>
        <p className="fine-print">
          Do not grant owner access through editable profile metadata or client
          settings.
        </p>
      </section>
    );
  }

  return (
    <section className="panel admin-panel" aria-labelledby="admin-title">
      <div className="admin-heading">
        <div>
          <p className="eyebrow">Site owner</p>
          <h2 id="admin-title">Player catalog &amp; scoring</h2>
          <p className="intro">
            Review the prior-season catalog before roster lock. Scoring version{" "}
            {scoringVersion}; catalog status:{" "}
            {frozenAt
              ? `frozen ${formatTimestamp(frozenAt)}`
              : lockHasPassed
                ? "lock time passed; edits disabled"
                : "editable until Eastern lock"}
            .
          </p>
        </div>
        <button
          className="secondary-button"
          type="button"
          disabled={busy}
          onClick={() =>
            void loadCatalog(seasonId).catch((caught: unknown) =>
              setError(getErrorMessage(caught)),
            )
          }
        >
          Refresh
        </button>
      </div>

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

      <form className="admin-form" onSubmit={saveConfiguration}>
        <h3>Season and global rules</h3>
        <div className="admin-fields">
          <label>
            Season source ID
            <input
              value={seasonId}
              onChange={(event) => setSeasonId(event.target.value)}
              required
              disabled={frozenAt !== null}
            />
          </label>
          <label>
            Season name
            <input
              value={seasonName}
              onChange={(event) => setSeasonName(event.target.value)}
              required
              disabled={lockHasPassed || frozenAt !== null}
            />
          </label>
          <label>
            Prior regular-season source ID
            <input
              value={priorSeasonId}
              onChange={(event) => setPriorSeasonId(event.target.value)}
              required
              disabled={lockHasPassed || frozenAt !== null}
            />
          </label>
          <label>
            Roster lock (Eastern Time)
            <input
              type="datetime-local"
              value={lockAt}
              onChange={(event) => setLockAt(event.target.value)}
              required
              disabled={lockHasPassed || frozenAt !== null}
            />
          </label>
        </div>
        <h4>Scoring values</h4>
        <div className="scoring-grid">
          {SCORING_LABELS.map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                type="number"
                step="0.25"
                value={scoring[key]}
                onChange={(event) =>
                  setScoring((current) => ({
                    ...current,
                    [key]:
                      event.target.value === ""
                        ? 0
                        : Number(event.target.value),
                  }))
                }
                required
                disabled={lockHasPassed || frozenAt !== null}
              />
            </label>
          ))}
        </div>
        <h4>Tier costs</h4>
        <div className="tier-cost-grid">
          {tierCosts.map((cost, index) => (
            <label key={index}>
              Tier {index + 1}
              <input
                type="number"
                min="0"
                step="0.01"
                value={cost}
                onChange={(event) =>
                  setTierCosts((current) =>
                    current.map((value, itemIndex) =>
                      itemIndex === index ? event.target.value : value,
                    ),
                  )
                }
                required
                disabled={lockHasPassed || frozenAt !== null}
              />
            </label>
          ))}
        </div>
        <button
          type="submit"
          disabled={busy || lockHasPassed || frozenAt !== null}
        >
          {busy ? "Saving…" : "Save season, scoring & tier costs"}
        </button>
      </form>

      <div className="admin-section">
        <h3>Import season catalog</h3>
        <p>
          Upload a JSON export containing <code>season</code>,{" "}
          <code>players</code>, and <code>seasonStats</code>. Player IDs are
          preserved as source IDs; missing or blank stats are flagged for owner
          review, not set to zero.
        </p>
        <label className="file-picker">
          Select normalized HockeyTech JSON
          <input
            type="file"
            accept=".json,application/json"
            onChange={chooseImport}
            disabled={busy || lockHasPassed || frozenAt !== null}
          />
        </label>
        {payload && (
          <div className="import-preview">
            <p>
              Ready to import {payload.players.length} players and{" "}
              {payload.seasonStats.length} stat records for season{" "}
              {payload.seasonId}.{" "}
              {payload.players.length - payload.seasonStats.length} players have
              no season-stat record and{" "}
              {payload.seasonStats.filter((stat) => !stat.complete).length} stat
              records have missing fields; those assignments will need review.
            </p>
            <button
              type="button"
              disabled={busy || lockHasPassed || frozenAt !== null}
              onClick={() => void importCatalog()}
            >
              {busy ? "Importing…" : "Save settings and import"}
            </button>
          </div>
        )}
      </div>

      <div className="admin-section">
        <h3>Import game schedule and final statistics</h3>
        <p>
          Upload normalized games with <code>gameId</code>,{" "}
          <code>startsAt</code>, <code>gameType</code>, <code>status</code>,{" "}
          <code>final</code>, and per-player stats. Add{" "}
          <code>regularSeasonScheduleComplete: true</code> only when the file
          contains the full regular-season schedule. Only official final games
          (status 4 and final true) score; the import replaces prior stats for
          each included game so corrections recalculate standings. To retry a
          failed upload, select and import that JSON again; scheduled errors are
          attempted again on the next enabled run.
        </p>
        <label className="file-picker">
          Select game JSON
          <input
            type="file"
            accept=".json,application/json"
            onChange={chooseGameImport}
            disabled={busy}
          />
        </label>
        {gamePayload && (
          <div className="import-preview">
            <p>
              Ready to import {gamePayload.games.length} games, including{" "}
              {
                gamePayload.games.filter(
                  (game) => game.status === 4 && game.final,
                ).length
              }{" "}
              official final games.{" "}
              {gamePayload.scheduleComplete
                ? "This file marks the regular-season schedule complete."
                : "Season completion will remain unconfirmed."}
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void importGameStats()}
            >
              {busy ? "Importing…" : "Import games and recalculate scores"}
            </button>
          </div>
        )}
        <h4>Game import history</h4>
        {gameRuns.length === 0 ? (
          <p className="fine-print">No game imports have been recorded.</p>
        ) : (
          <ul className="member-list">
            {gameRuns.map((run) => (
              <li key={run.id}>
                <span>
                  <strong>
                    {run.status} · {run.game_count} games · {run.stat_count}{" "}
                    player records
                  </strong>
                  <small>
                    {formatTimestamp(run.started_at)} · {run.source}
                    {run.error_message ? ` · ${run.error_message}` : ""}
                  </small>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="admin-section">
        <div className="section-heading">
          <div>
            <h3>Player assignment review</h3>
            <p>
              {players.length} assignments ·{" "}
              {
                players.filter((player) => player.status === "needs_review")
                  .length
              }{" "}
              need review
            </p>
          </div>
          <label>
            Show
            <select
              value={statusFilter}
              onChange={(event) =>
                setStatusFilter(
                  event.target.value as "all" | "needs_review" | "ready",
                )
              }
            >
              <option value="needs_review">Needs review</option>
              <option value="all">All players</option>
              <option value="ready">Approved</option>
            </select>
          </label>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Player</th>
                <th>Pos.</th>
                <th>Prior total</th>
                <th>Tier</th>
                <th>Status</th>
                <th>Review</th>
              </tr>
            </thead>
            <tbody>
              {visiblePlayers.map((player) => {
                const draft = reviewDrafts[player.id] ?? {
                  projection: String(player.projection_override ?? ""),
                  tier: String(player.tier ?? 1),
                };
                return (
                  <tr key={player.id}>
                    <td>
                      <strong>{player.name}</strong>
                      <small>
                        {player.team_name ?? "No team"} · {player.id}
                      </small>
                    </td>
                    <td>{player.position}</td>
                    <td>
                      <input
                        aria-label={`${player.name} approved projection`}
                        type="number"
                        step="0.01"
                        placeholder={
                          player.calculated_projection === null
                            ? "Required if stats missing"
                            : `Calculated ${player.calculated_projection}`
                        }
                        value={draft.projection}
                        onChange={(event) =>
                          setReviewDrafts((current) => ({
                            ...current,
                            [player.id]: {
                              ...draft,
                              projection: event.target.value,
                            },
                          }))
                        }
                      />
                    </td>
                    <td>
                      <select
                        aria-label={`${player.name} tier`}
                        value={draft.tier}
                        onChange={(event) =>
                          setReviewDrafts((current) => ({
                            ...current,
                            [player.id]: { ...draft, tier: event.target.value },
                          }))
                        }
                      >
                        {[1, 2, 3, 4, 5].map((tier) => (
                          <option key={tier} value={tier}>
                            Tier {tier}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <span className={`status-pill ${player.status}`}>
                        {player.status === "ready"
                          ? "Approved"
                          : "Needs review"}
                      </span>
                    </td>
                    <td>
                      <button
                        className="small-button"
                        type="button"
                        disabled={busy || lockHasPassed || frozenAt !== null}
                        onClick={() => void reviewPlayer(player)}
                      >
                        Approve
                      </button>
                    </td>
                  </tr>
                );
              })}
              {visiblePlayers.length === 0 && (
                <tr>
                  <td colSpan={6}>No player assignments match this filter.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="admin-section">
        <h3>Import history</h3>
        {runs.length === 0 ? (
          <p>No imports recorded for this season.</p>
        ) : (
          <ul className="import-runs">
            {runs.map((run) => (
              <li key={run.id}>
                <strong>
                  #{run.id} · {run.status}
                </strong>
                <span>{formatTimestamp(run.started_at)}</span>
                {run.status === "succeeded" ? (
                  <span>
                    {run.player_count} players · {run.stats_count} stats ·{" "}
                    {run.review_count} need review
                  </span>
                ) : run.error_message ? (
                  <span className="error">{run.error_message}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {lockHasPassed && !frozenAt && (
        <div className="admin-section freeze-callout">
          <div>
            <h3>Roster lock has passed</h3>
            <p>
              Capture the immutable scoring, cost, and tier snapshot for the
              season. Catalog edits are already blocked by the database.
            </p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void freezeCatalog()}
          >
            {busy ? "Freezing…" : "Create locked catalog snapshot"}
          </button>
        </div>
      )}
    </section>
  );
}
