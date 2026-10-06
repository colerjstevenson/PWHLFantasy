import {
  parseFinalGameImport,
  type FinalGameImportPayload,
} from "./lib/gameScoring";
import { fetchSourceCatalog } from "./lib/pwhlSource";

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  PWHL_AUTOMATION_ENABLED: string;
  PWHL_STATS_URL?: string;
  PWHL_SEASON_ID: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  VITE_SUPABASE_ANON_KEY?: string;
  SUPABASE_ANON_KEY?: string;
  PWHL_CATALOG_ENABLED?: string;
  PWHL_FEED_KEY?: string;
}

const MAX_IMPORT_BYTES = 5_000_000;

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === "/api/catalog/preview") {
      return previewCatalog(request, env);
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(_event: unknown, env: Env): Promise<void> {
    if (env.PWHL_AUTOMATION_ENABLED !== "true") {
      console.info("Scheduled PWHL import is disabled by configuration.");
      return;
    }

    try {
      const importDocument = await fetchGames(env);
      await callSupabaseRpc(env, "import_final_game_data", {
        p_season_id: env.PWHL_SEASON_ID,
        p_games: importDocument.games,
        p_schedule_complete: importDocument.scheduleComplete,
      });
    } catch (caught) {
      const message =
        caught instanceof Error
          ? caught.message
          : "Unknown scheduled import failure.";
      console.error("Scheduled PWHL import failed.", message);
      if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error(
          `${message} Import failure could not be recorded because Supabase service configuration is missing.`,
        );
      }
      await callSupabaseRpc(env, "record_game_import_failure", {
        p_season_id: env.PWHL_SEASON_ID,
        p_error_message: message,
        p_source: "scheduled",
      });
    }
  },
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

async function previewCatalog(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed.", {
      status: 405,
      headers: { allow: "POST" },
    });
  }
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return json(
      { error: "Sign in as a site owner to fetch the catalog." },
      401,
    );
  }
  try {
    const key = env.SUPABASE_ANON_KEY ?? env.VITE_SUPABASE_ANON_KEY;
    if (!env.SUPABASE_URL || !key) {
      return json(
        { error: "Supabase owner authorization is not configured." },
        503,
      );
    }
    const base = env.SUPABASE_URL.replace(/\/$/, "");
    const headers = { apikey: key, authorization };
    const user = await fetch(`${base}/auth/v1/user`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (user.status === 401 || user.status === 403) {
      return json({ error: "Your sign-in session has expired." }, 401);
    }
    if (!user.ok)
      throw new Error("Supabase session verification is unavailable.");
    const owner = await fetch(`${base}/rest/v1/rpc/is_site_owner`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(10_000),
    });
    if (!owner.ok)
      throw new Error("Supabase owner verification is unavailable.");
    if ((await owner.json()) !== true) {
      return json({ error: "Only site owners can fetch the catalog." }, 403);
    }
    if (env.PWHL_CATALOG_ENABLED !== "true") {
      return json(
        { error: "Manual catalog fetching is disabled by configuration." },
        503,
      );
    }
    const text = await request.text();
    if (text.length > 1024)
      return json({ error: "Catalog request is too large." }, 413);
    let input: unknown;
    try {
      input = JSON.parse(text);
    } catch {
      return json({ error: "Catalog request must be JSON." }, 400);
    }
    if (
      !input ||
      typeof input !== "object" ||
      !("seasonId" in input) ||
      typeof input.seasonId !== "string" ||
      !/^\d{1,10}$/.test(input.seasonId)
    ) {
      return json({ error: "Provide a numeric seasonId." }, 400);
    }
    const preview = await fetchSourceCatalog(
      env.PWHL_FEED_KEY ?? "",
      input.seasonId,
    );
    return json({
      ...preview,
      fetchedAt: new Date().toISOString(),
      warning:
        "The source publishes no total-record count. Page limits, ranks, team coverage and required fields were checked, but upstream omissions cannot be ruled out. Verify roster coverage before confirming.",
    });
  } catch (caught) {
    const message =
      caught instanceof Error ? caught.message : "Catalog fetch failed.";
    console.error("Manual catalog preview failed.", message);
    return json({ error: message }, 502);
  }
}

async function fetchGames(env: Env): Promise<FinalGameImportPayload> {
  if (!env.PWHL_STATS_URL) {
    throw new Error("PWHL_STATS_URL is not configured.");
  }
  const sourceUrl = new URL(env.PWHL_STATS_URL);
  if (sourceUrl.protocol !== "https:") {
    throw new Error("PWHL_STATS_URL must use HTTPS.");
  }
  const response = await fetch(sourceUrl, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`PWHL source returned HTTP ${response.status}.`);
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_IMPORT_BYTES) {
    throw new Error("PWHL source response exceeded the 5 MB import limit.");
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_IMPORT_BYTES) {
    throw new Error("PWHL source response exceeded the 5 MB import limit.");
  }
  const parsed: unknown = JSON.parse(text);
  return parseFinalGameImport(parsed);
}

async function callSupabaseRpc(
  env: Env,
  functionName: string,
  body: Record<string, unknown>,
): Promise<void> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "Supabase scheduled-import credentials are not configured.",
    );
  }
  const response = await fetch(
    `${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/${functionName}`,
    {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1000);
    throw new Error(
      `Supabase ${functionName} failed with HTTP ${response.status}: ${detail}`,
    );
  }
}
