import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

type Standing = {
  team_id: string;
  manager_name: string;
  points: number;
  games_played: number;
  standing_rank: number;
  is_winner: boolean;
  season_complete: boolean;
};

function parseStandings(value: unknown): Standing[] {
  if (!Array.isArray(value)) {
    throw new Error("Standings returned an invalid response.");
  }
  return value.map((row) => {
    if (
      typeof row !== "object" ||
      row === null ||
      typeof row.team_id !== "string" ||
      typeof row.manager_name !== "string" ||
      !Number.isFinite(Number(row.points)) ||
      typeof row.games_played !== "number" ||
      typeof row.standing_rank !== "number" ||
      typeof row.is_winner !== "boolean" ||
      typeof row.season_complete !== "boolean"
    ) {
      throw new Error("Standings returned an invalid response.");
    }
    return {
      team_id: row.team_id,
      manager_name: row.manager_name,
      points: Number(row.points),
      games_played: row.games_played,
      standing_rank: row.standing_rank,
      is_winner: row.is_winner,
      season_complete: row.season_complete,
    };
  });
}

export function StandingsPanel({ leagueId }: { leagueId: string }) {
  const [standings, setStandings] = useState<Standing[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadStandings = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    setError(null);
    try {
      const result = await supabase.rpc("get_league_standings", {
        p_league_id: leagueId,
      });
      if (result.error) throw result.error;
      setStandings(parseStandings(result.data));
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to load standings.",
      );
    } finally {
      setLoading(false);
    }
  }, [leagueId]);

  useEffect(() => {
    void loadStandings();
  }, [loadStandings]);

  return (
    <section
      className="admin-section standings-section"
      aria-labelledby="standings-title"
    >
      <div className="section-heading">
        <div>
          <h4 id="standings-title">Regular-season standings</h4>
          <p className="fine-print">
            Scores include official final regular-season games only.
          </p>
        </div>
        <button
          className="secondary-button small-button"
          type="button"
          disabled={loading}
          onClick={() => void loadStandings()}
        >
          Refresh
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <p role="status">Loading standings…</p>
      ) : standings.length === 0 ? (
        <p className="fine-print">
          No eligible locked rosters are available yet.
        </p>
      ) : (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>Manager</th>
                  <th>Points</th>
                  <th>Games scored</th>
                </tr>
              </thead>
              <tbody>
                {standings.map((standing) => (
                  <tr key={standing.team_id}>
                    <td>{standing.standing_rank}</td>
                    <td>
                      {standing.manager_name}
                      {standing.is_winner && (
                        <strong className="winner-label"> · Co-winner</strong>
                      )}
                    </td>
                    <td>{standing.points.toFixed(2)}</td>
                    <td>{standing.games_played}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!standings[0].season_complete && (
            <p className="fine-print">
              Standings are provisional until every scheduled regular-season
              game has an official final result.
            </p>
          )}
        </>
      )}
    </section>
  );
}
