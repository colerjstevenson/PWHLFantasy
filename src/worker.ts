import {
  parseFinalGameImport,
  type FinalGameImportPayload,
} from "./lib/gameScoring";

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  PWHL_AUTOMATION_ENABLED: string;
  PWHL_STATS_URL?: string;
  PWHL_SEASON_ID: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

const MAX_IMPORT_BYTES = 5_000_000;

export default {
  fetch(request: Request, env: Env): Promise<Response> {
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
