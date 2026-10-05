export type LeagueInviteToken = string;

export function readLeagueInviteToken(
  search: string,
): LeagueInviteToken | null {
  return new URLSearchParams(search).get("invite");
}

export function createLeagueInviteToken(): LeagueInviteToken {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function hashLeagueInviteToken(
  token: LeagueInviteToken,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function createLeagueInviteUrl(token: LeagueInviteToken): string {
  const url = new URL(window.location.href);
  url.pathname = "/";
  url.search = new URLSearchParams({ invite: token }).toString();
  url.hash = "";
  return url.toString();
}

export function clearLeagueInviteFromUrl(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete("invite");
  window.history.replaceState(
    {},
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

export function getLeagueNameError(value: string): string | null {
  const name = value.trim();
  if (name.length === 0 || name.length > 80) {
    return "League name must be between 1 and 80 characters.";
  }
  return null;
}

export function getLeagueRosterSizeError(value: string): string | null {
  if (!/^\d+$/.test(value)) return "Enter a whole-number roster size.";
  if (Number(value) < 6) {
    return "Roster size must be at least 6 to meet the position minimums.";
  }
  return null;
}

export function getLeagueBudgetError(value: string): string | null {
  if (!/^(?:\d+)(?:\.\d{1,2})?$/.test(value)) {
    return "Enter a non-negative budget with at most two decimal places.";
  }
  if (!Number.isFinite(Number(value)) || Number(value) > 99999999.99) {
    return "Budget must be no greater than 99,999,999.99.";
  }
  return null;
}
