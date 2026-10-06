import { useCallback, useEffect, useMemo, useState } from "react";
import { assessRoster, type RosterPlayer } from "../lib/roster";
import { supabase } from "../lib/supabase";
import { formatEastern } from "../lib/dates";

type TransferRecord = {
  id: string;
  outgoing_player_id: string;
  incoming_player_id: string;
  confirmed_at: string;
  effective_at: string;
  status: "pending" | "effective" | "cancelled";
  cancelled_at: string | null;
};

type TransferState = {
  locked: boolean;
  serverNow: string;
  rosterLockAt: string;
  nextEffectiveAt: string;
  eligible: boolean | null;
  ineligibleReasons: string[];
  playerIds: string[];
  usedThisMonth: number;
  monthlyLimit: number;
  pending: TransferRecord | null;
  history: TransferRecord[];
};

type CompetitionStatus = {
  team_id: string;
  manager_name: string;
  eligible: boolean;
  ineligible_reasons: string[];
  locked_at: string;
};

type Props = {
  leagueId: string;
  teamId: string;
  rosterSize: number;
  budget: number;
  players: RosterPlayer[];
  onLockState: (locked: boolean, playerIds: string[]) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTransferRecord(value: unknown): TransferRecord | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.outgoing_player_id !== "string" ||
    typeof value.incoming_player_id !== "string" ||
    typeof value.confirmed_at !== "string" ||
    typeof value.effective_at !== "string" ||
    (value.status !== "pending" &&
      value.status !== "effective" &&
      value.status !== "cancelled") ||
    (value.cancelled_at !== null && typeof value.cancelled_at !== "string")
  ) {
    return null;
  }
  return {
    id: value.id,
    outgoing_player_id: value.outgoing_player_id,
    incoming_player_id: value.incoming_player_id,
    confirmed_at: value.confirmed_at,
    effective_at: value.effective_at,
    status: value.status,
    cancelled_at: value.cancelled_at,
  };
}

function parseTransferState(value: unknown): TransferState {
  if (!isRecord(value)) {
    throw new Error("Transfer status returned an invalid response.");
  }
  const playerIds = value.player_ids;
  const reasons = value.ineligible_reasons;
  const history = value.history;
  const pending =
    value.pending === null ? null : parseTransferRecord(value.pending);
  const parsedHistory: TransferRecord[] = [];
  if (Array.isArray(history)) {
    for (const item of history) {
      const record = parseTransferRecord(item);
      if (!record) {
        throw new Error("Transfer status returned an invalid response.");
      }
      parsedHistory.push(record);
    }
  }
  if (
    typeof value.locked !== "boolean" ||
    typeof value.server_now !== "string" ||
    typeof value.roster_lock_at !== "string" ||
    typeof value.next_effective_at !== "string" ||
    (value.eligible !== null && typeof value.eligible !== "boolean") ||
    !Array.isArray(reasons) ||
    !reasons.every((reason) => typeof reason === "string") ||
    !Array.isArray(playerIds) ||
    !playerIds.every((playerId) => typeof playerId === "string") ||
    typeof value.used_this_month !== "number" ||
    typeof value.monthly_limit !== "number" ||
    !Array.isArray(history) ||
    (value.pending !== null && pending === null)
  ) {
    throw new Error("Transfer status returned an invalid response.");
  }
  return {
    locked: value.locked,
    serverNow: value.server_now,
    rosterLockAt: value.roster_lock_at,
    nextEffectiveAt: value.next_effective_at,
    eligible: value.eligible,
    ineligibleReasons: reasons,
    playerIds,
    usedThisMonth: value.used_this_month,
    monthlyLimit: value.monthly_limit,
    pending,
    history: parsedHistory,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The transfer failed.";
}

export function TransferPanel({
  leagueId,
  teamId,
  rosterSize,
  budget,
  players,
  onLockState,
}: Props) {
  const [state, setState] = useState<TransferState | null>(null);
  const [competition, setCompetition] = useState<CompetitionStatus[]>([]);
  const [outgoingId, setOutgoingId] = useState("");
  const [incomingId, setIncomingId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadState = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    setError(null);
    try {
      const result = await supabase.rpc("get_my_transfer_state", {
        p_team_id: teamId,
      });
      if (result.error) throw result.error;
      const nextState = parseTransferState(result.data);
      setState(nextState);
      setOutgoingId((current) =>
        nextState.playerIds.includes(current)
          ? current
          : (nextState.playerIds[0] ?? ""),
      );
      const availablePlayers = players.filter(
        (player) =>
          player.active &&
          player.ready &&
          Number.isFinite(player.cost) &&
          !nextState.playerIds.includes(player.id),
      );
      setIncomingId((current) =>
        availablePlayers.some((player) => player.id === current)
          ? current
          : (availablePlayers[0]?.id ?? ""),
      );

      if (nextState.locked) {
        const statusResult = await supabase.rpc(
          "get_league_roster_lock_status",
          { p_league_id: leagueId },
        );
        if (statusResult.error) throw statusResult.error;
        const rows = statusResult.data as unknown;
        if (!Array.isArray(rows)) {
          throw new Error("League lock status returned an invalid response.");
        }
        setCompetition(
          rows.map((row): CompetitionStatus => {
            if (
              !isRecord(row) ||
              typeof row.team_id !== "string" ||
              typeof row.manager_name !== "string" ||
              typeof row.eligible !== "boolean" ||
              typeof row.locked_at !== "string" ||
              !Array.isArray(row.ineligible_reasons) ||
              !row.ineligible_reasons.every(
                (reason) => typeof reason === "string",
              )
            ) {
              throw new Error(
                "League lock status returned an invalid response.",
              );
            }
            return {
              team_id: row.team_id,
              manager_name: row.manager_name,
              eligible: row.eligible,
              ineligible_reasons: row.ineligible_reasons,
              locked_at: row.locked_at,
            };
          }),
        );
      } else {
        setCompetition([]);
      }
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [leagueId, players, teamId]);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  useEffect(() => {
    if (state) onLockState(state.locked, state.playerIds);
  }, [onLockState, state]);

  useEffect(() => {
    if (!state) return;
    const nextRefreshAt =
      state.pending?.effective_at ??
      (state.locked ? state.nextEffectiveAt : state.rosterLockAt);
    if (!nextRefreshAt) return;
    const remaining =
      new Date(nextRefreshAt).getTime() - new Date(state.serverNow).getTime();
    const delay = Math.min(2_000_000_000, Math.max(0, remaining + 1000));
    const timeoutId = window.setTimeout(() => void loadState(), delay);
    return () => window.clearTimeout(timeoutId);
  }, [loadState, state]);

  const proposedAssessment = useMemo(() => {
    if (!state || !outgoingId || !incomingId) return null;
    return assessRoster(
      [
        ...state.playerIds.filter((playerId) => playerId !== outgoingId),
        incomingId,
      ],
      players,
      { rosterSize, budget },
    );
  }, [budget, incomingId, outgoingId, players, rosterSize, state]);

  async function confirmTransfer() {
    if (!supabase || !outgoingId || !incomingId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { error: transferError } = await supabase.rpc(
        "request_fantasy_transfer",
        {
          p_team_id: teamId,
          p_outgoing_player_id: outgoingId,
          p_incoming_player_id: incomingId,
        },
      );
      if (transferError) throw transferError;
      setNotice(
        "Transfer confirmed. It takes effect at the next Eastern midnight.",
      );
      await loadState();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function cancelTransfer(transferId: string) {
    if (!supabase) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { error: cancelError } = await supabase.rpc(
        "cancel_fantasy_transfer",
        { p_team_id: teamId, p_transfer_id: transferId },
      );
      if (cancelError) throw cancelError;
      setNotice(
        "Pending transfer cancelled. Your monthly allowance was restored.",
      );
      await loadState();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const playerById = useMemo(
    () => new Map(players.map((player) => [player.id, player])),
    [players],
  );

  return (
    <section className="transfer-workspace" aria-labelledby="transfer-title">
      <div className="section-heading">
        <div>
          <h3 id="transfer-title">Transfers and roster lock</h3>
          <p>
            Transfers take effect at the next midnight in America/New_York. You
            may confirm 3 per calendar month; a cancelled pending transfer
            restores its allowance. Only one transfer may be pending at a time.
          </p>
        </div>
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
      {loading || !state ? (
        <p role="status">Loading roster lock and transfer status…</p>
      ) : (
        <>
          {!state.locked ? (
            <p className="lock-callout" role="status">
              Rosters lock {formatEastern(state.rosterLockAt)}. Transfers are
              unavailable until then.
            </p>
          ) : (
            <>
              <div className="roster-warning">
                <strong>
                  {state.eligible
                    ? "Your roster was eligible at lock."
                    : "Your team is not eligible to compete."}
                </strong>
                {state.ineligibleReasons.length > 0 && (
                  <ul>
                    {state.ineligibleReasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                )}
                <p>
                  The lock snapshot is preserved; transfers never rewrite it.
                </p>
              </div>
              <div className="roster-summary" aria-live="polite">
                <span>
                  Monthly transfers{" "}
                  <strong>
                    {state.usedThisMonth} / {state.monthlyLimit}
                  </strong>
                </span>
                <span>
                  Available{" "}
                  <strong>{state.monthlyLimit - state.usedThisMonth}</strong>
                </span>
              </div>

              {state.eligible && state.pending && (
                <div className="pending-transfer">
                  <div>
                    <strong>Transfer pending</strong>
                    <p>
                      {playerById.get(state.pending.outgoing_player_id)?.name ??
                        state.pending.outgoing_player_id}{" "}
                      →{" "}
                      {playerById.get(state.pending.incoming_player_id)?.name ??
                        state.pending.incoming_player_id}
                    </p>
                    <p>Effective {formatEastern(state.pending.effective_at)}</p>
                  </div>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy}
                    onClick={() =>
                      state.pending && void cancelTransfer(state.pending.id)
                    }
                  >
                    Cancel transfer
                  </button>
                </div>
              )}

              {state.eligible && !state.pending && (
                <div className="transfer-form">
                  <label>
                    Replace
                    <select
                      value={outgoingId}
                      onChange={(event) => setOutgoingId(event.target.value)}
                      disabled={busy || state.playerIds.length === 0}
                    >
                      <option value="" disabled>
                        Select a player
                      </option>
                      {state.playerIds.map((playerId) => (
                        <option key={playerId} value={playerId}>
                          {playerById.get(playerId)?.name ?? playerId}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    With
                    <select
                      value={incomingId}
                      onChange={(event) => setIncomingId(event.target.value)}
                      disabled={
                        busy ||
                        !players.some(
                          (player) =>
                            player.active &&
                            player.ready &&
                            !state.playerIds.includes(player.id),
                        )
                      }
                    >
                      <option value="" disabled>
                        Select a player
                      </option>
                      {players
                        .filter(
                          (player) =>
                            player.active &&
                            player.ready &&
                            Number.isFinite(player.cost) &&
                            !state.playerIds.includes(player.id),
                        )
                        .map((player) => (
                          <option key={player.id} value={player.id}>
                            {player.name} · {player.position} · $
                            {player.cost.toFixed(2)}
                          </option>
                        ))}
                    </select>
                  </label>
                  {outgoingId && incomingId && (
                    <p className="transfer-preview">
                      Confirm{" "}
                      <strong>
                        {playerById.get(outgoingId)?.name ?? outgoingId}
                      </strong>{" "}
                      for{" "}
                      <strong>
                        {playerById.get(incomingId)?.name ?? incomingId}
                      </strong>
                      . If confirmed now, it takes effect{" "}
                      <strong>{formatEastern(state.nextEffectiveAt)}</strong>.
                    </p>
                  )}
                  {proposedAssessment?.issues.length ? (
                    <ul
                      className="roster-issues"
                      aria-label="Transfer requirements"
                    >
                      {proposedAssessment.issues.map((issue, index) => (
                        <li key={`${issue}-${index}`}>{issue}</li>
                      ))}
                    </ul>
                  ) : null}
                  <button
                    type="button"
                    disabled={
                      busy ||
                      !outgoingId ||
                      !incomingId ||
                      state.usedThisMonth >= state.monthlyLimit ||
                      !proposedAssessment?.valid
                    }
                    onClick={() => void confirmTransfer()}
                  >
                    {busy ? "Processing…" : "Confirm transfer"}
                  </button>
                </div>
              )}

              {competition.length > 0 && (
                <div className="competition-status">
                  <h4>Competition eligibility at lock</h4>
                  <ul className="member-list">
                    {competition.map((team) => (
                      <li key={team.team_id}>
                        <span>
                          <strong>{team.manager_name}</strong>
                          <small>
                            {team.eligible
                              ? "Eligible"
                              : "Not eligible to compete"}
                          </small>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="transfer-history">
                <h4>Transfer history</h4>
                {state.history.length === 0 ? (
                  <p className="fine-print">No transfers yet.</p>
                ) : (
                  <ul className="member-list">
                    {state.history.map((transfer) => (
                      <li key={transfer.id}>
                        <span>
                          <strong>
                            {playerById.get(transfer.outgoing_player_id)
                              ?.name ?? transfer.outgoing_player_id}{" "}
                            →{" "}
                            {playerById.get(transfer.incoming_player_id)
                              ?.name ?? transfer.incoming_player_id}
                          </strong>
                          <small>
                            Confirmed {formatEastern(transfer.confirmed_at)} ·{" "}
                            {transfer.status === "pending"
                              ? `Effective ${formatEastern(transfer.effective_at)}`
                              : transfer.status === "cancelled" &&
                                  transfer.cancelled_at
                                ? `Cancelled ${formatEastern(transfer.cancelled_at)}`
                                : transfer.status}
                          </small>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
