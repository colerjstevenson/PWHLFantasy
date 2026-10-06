import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  createLeagueInviteToken,
  createLeagueInviteUrl,
  getLeagueBudgetError,
  getLeagueNameError,
  getLeagueRosterSizeError,
  hashLeagueInviteToken,
  clearLeagueInviteFromUrl,
} from "../lib/league";
import { supabase } from "../lib/supabase";
import { formatEastern } from "../lib/dates";
import { RosterPanel } from "./RosterPanel";
import { StandingsPanel } from "./StandingsPanel";

type Season = {
  id: string;
  name: string;
  roster_lock_at: string;
};

type League = {
  id: string;
  name: string;
  season_id: string;
  roster_size: number;
  budget: number;
  commissioner_id: string;
};

type LeagueMember = {
  user_id: string;
  display_name: string | null;
  role: "commissioner" | "manager";
  joined_at: string;
};

type Props = {
  userId: string;
  inviteToken: string | null;
};

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The league operation failed.";
}

export function LeaguePanel({ userId, inviteToken }: Props) {
  const [season, setSeason] = useState<Season | null>(null);
  const [leagues, setLeagues] = useState<League[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [members, setMembers] = useState<LeagueMember[]>([]);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [revealedInvite, setRevealedInvite] = useState<{
    leagueId: string;
    url: string;
  } | null>(null);
  const [leagueName, setLeagueName] = useState("");
  const [rosterSize, setRosterSize] = useState("18");
  const [budget, setBudget] = useState("100");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [inviteHandled, setInviteHandled] = useState<string | null>(null);
  const handlingInvite = useRef(false);

  const selectedLeague = useMemo(
    () => leagues.find((league) => league.id === selectedId) ?? null,
    [leagues, selectedId],
  );
  const isCommissioner = selectedLeague?.commissioner_id === userId;

  const loadLeagues = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    setError(null);
    try {
      const membershipsResult = await supabase
        .from("league_members")
        .select("league_id")
        .eq("user_id", userId)
        .eq("status", "active");
      if (membershipsResult.error) throw membershipsResult.error;

      const leagueIds = (membershipsResult.data ?? []).map(
        (membership) => membership.league_id,
      );
      if (leagueIds.length === 0) {
        setLeagues([]);
        setMembers([]);
        setSelectedId(null);
        return;
      }

      const leagueResult = await supabase
        .from("leagues")
        .select("id, name, season_id, roster_size, budget, commissioner_id")
        .in("id", leagueIds)
        .order("created_at", { ascending: false });
      if (leagueResult.error) throw leagueResult.error;
      const nextLeagues = (leagueResult.data ?? []) as League[];
      setLeagues(nextLeagues);
      setSelectedId((current) =>
        current && nextLeagues.some((league) => league.id === current)
          ? current
          : (nextLeagues[0]?.id ?? null),
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [userId]);

  const loadMembers = useCallback(
    async (
      leagueId: string,
      commissioner: boolean,
    ): Promise<{ members: LeagueMember[]; inviteOpen: boolean }> => {
      if (!supabase) return { members: [], inviteOpen: false };
      const membersResult = await supabase.rpc("get_league_members", {
        p_league_id: leagueId,
      });
      if (membersResult.error) throw membersResult.error;
      const members = (membersResult.data ?? []) as LeagueMember[];

      if (commissioner) {
        const inviteResult = await supabase.rpc("get_league_invite_status", {
          p_league_id: leagueId,
        });
        if (inviteResult.error) throw inviteResult.error;
        return { members, inviteOpen: Boolean(inviteResult.data) };
      }
      return { members, inviteOpen: false };
    },
    [],
  );

  useEffect(() => {
    if (!supabase) return;
    let active = true;
    async function loadSeason() {
      const { data, error: seasonError } = await supabase!
        .from("catalog_seasons")
        .select("id, name, roster_lock_at")
        .gt("roster_lock_at", new Date().toISOString())
        .order("roster_lock_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (!active) return;
      if (seasonError) {
        setError(seasonError.message);
      } else {
        setSeason(data as Season | null);
      }
    }
    void loadSeason().catch((caught: unknown) => {
      if (active) setError(errorMessage(caught));
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    void loadLeagues();
  }, [loadLeagues]);

  useEffect(() => {
    if (!selectedId) {
      setMembers([]);
      setInviteOpen(false);
      return;
    }
    let active = true;
    setMembers([]);
    setInviteOpen(false);
    void loadMembers(selectedId, isCommissioner)
      .then((result) => {
        if (!active) return;
        setMembers(result.members);
        setInviteOpen(result.inviteOpen);
      })
      .catch((caught: unknown) => {
        if (active) setError(errorMessage(caught));
      });
    return () => {
      active = false;
    };
  }, [isCommissioner, loadMembers, selectedId]);

  useEffect(() => {
    if (
      !inviteToken ||
      inviteHandled === inviteToken ||
      handlingInvite.current
    ) {
      return;
    }
    if (!supabase) return;
    handlingInvite.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    void (async () => {
      try {
        const { data: joinedLeagueId, error: joinError } = await supabase.rpc(
          "join_league_by_invite",
          {
            p_token: inviteToken,
          },
        );
        if (joinError) throw joinError;
        if (typeof joinedLeagueId !== "string") {
          throw new Error(
            "Invitation acceptance returned no league identifier.",
          );
        }
        setInviteHandled(inviteToken);
        clearLeagueInviteFromUrl();
        setNotice(
          "You joined the league. Your team is ready for roster setup.",
        );
        await loadLeagues();
        setSelectedId(joinedLeagueId);
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        handlingInvite.current = false;
        setBusy(false);
      }
    })();
  }, [inviteHandled, inviteToken, loadLeagues]);

  async function createLeague(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !season) return;
    const nameError = getLeagueNameError(leagueName);
    const rosterError = getLeagueRosterSizeError(rosterSize);
    const budgetError = getLeagueBudgetError(budget);
    const validationError = nameError ?? rosterError ?? budgetError;
    if (validationError) {
      setError(validationError);
      return;
    }

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const token = createLeagueInviteToken();
      const tokenHash = await hashLeagueInviteToken(token);
      const { data, error: createError } = await supabase.rpc("create_league", {
        p_season_id: season.id,
        p_name: leagueName.trim(),
        p_roster_size: Number(rosterSize),
        p_budget: Number(budget),
        p_invite_token_hash: tokenHash,
      });
      if (createError) throw createError;
      if (typeof data !== "string") {
        throw new Error("League creation returned no league identifier.");
      }
      setRevealedInvite({
        leagueId: data,
        url: createLeagueInviteUrl(token),
      });
      setNotice("League created. Share the invite link before roster lock.");
      setLeagueName("");
      await loadLeagues();
      setSelectedId(data);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function rotateInvite(leagueId: string) {
    if (!supabase) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const token = createLeagueInviteToken();
      const tokenHash = await hashLeagueInviteToken(token);
      const { error: rotateError } = await supabase.rpc(
        "rotate_league_invite",
        {
          p_league_id: leagueId,
          p_token_hash: tokenHash,
        },
      );
      if (rotateError) throw rotateError;
      setRevealedInvite({ leagueId, url: createLeagueInviteUrl(token) });
      setInviteOpen(true);
      setNotice(
        "A new invite link is ready. The previous link no longer works.",
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function closeInvite(leagueId: string) {
    if (!supabase) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { error: closeError } = await supabase.rpc("close_league_invite", {
        p_league_id: leagueId,
      });
      if (closeError) throw closeError;
      setInviteOpen(false);
      setRevealedInvite((current) =>
        current?.leagueId === leagueId ? null : current,
      );
      setNotice("The invite link has been closed.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function removeMember(member: LeagueMember) {
    if (!supabase || !selectedLeague) return;
    if (
      !window.confirm(
        `Remove ${member.display_name || "this manager"} from ${selectedLeague.name}? They can rejoin using an open invite link.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { error: removeError } = await supabase.rpc(
        "remove_league_member",
        {
          p_league_id: selectedLeague.id,
          p_user_id: member.user_id,
        },
      );
      if (removeError) throw removeError;
      const result = await loadMembers(selectedLeague.id, true);
      setMembers(result.members);
      setInviteOpen(result.inviteOpen);
      setNotice(
        "The manager was removed. Their team history has been preserved.",
      );
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function copyInvite(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setNotice("Invite link copied.");
    } catch (caught) {
      setError(
        `Could not copy the invite link: ${errorMessage(caught)} Select and copy it manually.`,
      );
    }
  }

  return (
    <section className="panel league-panel" aria-labelledby="league-title">
      <div className="league-heading">
        <div>
          <p className="eyebrow">Your leagues</p>
          <h2 id="league-title">League hub</h2>
          <p className="intro">
            Create a private league or accept an invitation. League membership
            and team creation are handled securely by the database.
          </p>
        </div>
      </div>

      {inviteToken && (
        <p className="invite-notice" role="status">
          {error
            ? "The invitation could not be accepted. See the error above."
            : inviteHandled === inviteToken
              ? "Invite accepted."
              : busy
                ? "Joining the league…"
                : "Processing your invitation…"}
        </p>
      )}

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

      <div className="league-layout">
        <section
          className="league-create"
          aria-labelledby="create-league-title"
        >
          <h3 id="create-league-title">Create a league</h3>
          {season ? (
            <>
              <p className="fine-print">
                {season.name} · invitation and roster setup close at{" "}
                {formatEastern(season.roster_lock_at)}.
              </p>
              <form onSubmit={createLeague}>
                <label htmlFor="league-name">League name</label>
                <input
                  id="league-name"
                  required
                  maxLength={80}
                  value={leagueName}
                  onChange={(event) => setLeagueName(event.target.value)}
                  placeholder="Northern Lights"
                />
                <label htmlFor="league-roster-size">Roster size</label>
                <input
                  id="league-roster-size"
                  type="number"
                  min="6"
                  step="1"
                  required
                  value={rosterSize}
                  onChange={(event) => setRosterSize(event.target.value)}
                />
                <label htmlFor="league-budget">Budget</label>
                <input
                  id="league-budget"
                  type="number"
                  min="0"
                  step="0.01"
                  required
                  value={budget}
                  onChange={(event) => setBudget(event.target.value)}
                />
                <button type="submit" disabled={busy}>
                  {busy ? "Working…" : "Create league"}
                </button>
              </form>
            </>
          ) : (
            <p className="fine-print">
              {loading
                ? "Checking for an open season…"
                : "League creation is unavailable because there is no season before roster lock."}
            </p>
          )}
        </section>

        <section className="league-list" aria-labelledby="my-leagues-title">
          <h3 id="my-leagues-title">Your active leagues</h3>
          {loading ? (
            <p role="status">Loading leagues…</p>
          ) : leagues.length === 0 ? (
            <p className="fine-print">
              You have not joined a league yet. Create one or open an invitation
              link while signed in.
            </p>
          ) : (
            <div className="league-select-list">
              {leagues.map((league) => (
                <button
                  className={`league-select${selectedId === league.id ? " selected" : ""}`}
                  type="button"
                  key={league.id}
                  onClick={() => setSelectedId(league.id)}
                  aria-pressed={selectedId === league.id}
                >
                  <strong>{league.name}</strong>
                  <span>
                    {league.roster_size} roster slots · budget{" "}
                    {Number(league.budget).toFixed(2)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>

      {selectedLeague && (
        <section
          className="league-detail"
          aria-labelledby="league-detail-title"
        >
          <div className="section-heading">
            <div>
              <h3 id="league-detail-title">{selectedLeague.name}</h3>
              <p>
                {isCommissioner ? "Commissioner" : "Manager"} ·{" "}
                {selectedLeague.roster_size} roster slots · budget{" "}
                {Number(selectedLeague.budget).toFixed(2)}
              </p>
            </div>
          </div>

          <StandingsPanel
            key={`standings-${selectedLeague.id}`}
            leagueId={selectedLeague.id}
          />

          <h4>Members</h4>
          {members.length === 0 ? (
            <p className="fine-print">Loading member list…</p>
          ) : (
            <ul className="member-list">
              {members.map((member) => (
                <li key={member.user_id}>
                  <span>
                    <strong>
                      {member.display_name?.trim() ||
                        `Manager ${member.user_id.slice(0, 8)}`}
                    </strong>
                    <small>
                      {member.role}
                      {member.user_id === userId ? " · you" : ""}
                    </small>
                  </span>
                  {isCommissioner && member.role !== "commissioner" && (
                    <button
                      className="secondary-button small-button"
                      type="button"
                      disabled={busy}
                      onClick={() => void removeMember(member)}
                    >
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {isCommissioner && (
            <div className="invite-controls">
              <h4>Invitation link</h4>
              <p className="fine-print">
                Anyone with the link can join until the season roster lock.
                Rotating it immediately invalidates the previous link.
              </p>
              {revealedInvite?.leagueId === selectedLeague.id && (
                <div className="invite-link">
                  <input
                    aria-label="League invitation link"
                    readOnly
                    value={revealedInvite.url}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <button
                    className="small-button"
                    type="button"
                    onClick={() => void copyInvite(revealedInvite.url)}
                  >
                    Copy link
                  </button>
                </div>
              )}
              <div className="invite-actions">
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busy}
                  onClick={() => void rotateInvite(selectedLeague.id)}
                >
                  {inviteOpen ? "Rotate invite link" : "Create invite link"}
                </button>
                {inviteOpen && (
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={busy}
                    onClick={() => void closeInvite(selectedLeague.id)}
                  >
                    Close invite link
                  </button>
                )}
              </div>
              {!inviteOpen && (
                <p className="fine-print">
                  The invitation link is closed or the season roster-lock
                  deadline has passed.
                </p>
              )}
            </div>
          )}
          <RosterPanel
            key={selectedLeague.id}
            league={selectedLeague}
            userId={userId}
          />
        </section>
      )}
    </section>
  );
}
