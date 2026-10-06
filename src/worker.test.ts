import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./worker";
import { fetchSourceCatalog } from "./lib/pwhlSource";

vi.mock("./lib/pwhlSource", () => ({ fetchSourceCatalog: vi.fn() }));

const env = {
  ASSETS: { fetch: vi.fn().mockResolvedValue(new Response("assets")) },
  PWHL_AUTOMATION_ENABLED: "false",
  PWHL_CATALOG_ENABLED: "true",
  PWHL_FEED_KEY: "test-key",
  PWHL_SEASON_ID: "11",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "",
  SUPABASE_ANON_KEY: "test-public-key",
};

function request(body = '{"seasonId":"11"}', token = "test-token") {
  return new Request("https://app.example/api/catalog/preview", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body,
  });
}

function mockAuth(owner = true, userStatus = 200, ownerStatus = 200) {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(Response.json({}, { status: userStatus }))
    .mockResolvedValueOnce(Response.json(owner, { status: ownerStatus }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("owner-only catalog preview endpoint", () => {
  it("requires authentication and checks owner status before upstream requests", async () => {
    expect((await worker.fetch(request("{}", ""), env)).status).toBe(401);
    const calls = mockAuth(false);
    expect((await worker.fetch(request(), env)).status).toBe(403);
    expect(calls).toHaveBeenCalledTimes(2);
    expect(calls.mock.calls[1][0]).toContain("/rpc/is_site_owner");
    expect(calls.mock.calls[1][1].headers.authorization).toBe(
      "Bearer test-token",
    );
    expect(fetchSourceCatalog).not.toHaveBeenCalled();
  });

  it("rejects expired sessions, bad JSON, oversized requests and disabled fetching", async () => {
    mockAuth(true, 401);
    expect((await worker.fetch(request(), env)).status).toBe(401);
    mockAuth();
    expect((await worker.fetch(request("bad"), env)).status).toBe(400);
    mockAuth();
    expect(
      (await worker.fetch(request('{"seasonId":"https://bad"}'), env)).status,
    ).toBe(400);
    mockAuth();
    expect((await worker.fetch(request("x".repeat(1025)), env)).status).toBe(
      413,
    );
    mockAuth();
    expect(
      (await worker.fetch(request(), { ...env, PWHL_CATALOG_ENABLED: "false" }))
        .status,
    ).toBe(503);
    expect(fetchSourceCatalog).not.toHaveBeenCalled();
  });

  it("returns only a no-store preview, never writes to Supabase", async () => {
    const calls = mockAuth();
    const preview = {
      payload: {
        seasonId: "11",
        seasonName: "2026-27 Regular Season",
        priorSeasonId: "8",
        players: [],
        seasonStats: [],
      },
      rosterSeasonId: "8",
      rosterSeasonName: "2025-26 Regular Season",
      usedPriorRosterFallback: true,
    };
    vi.mocked(fetchSourceCatalog).mockResolvedValueOnce(preview);
    const response = await worker.fetch(request(), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      ...preview,
      warning: expect.stringContaining("no total-record count"),
    });
    expect(fetchSourceCatalog).toHaveBeenCalledWith("test-key", "11");
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it("surfaces source and authorization outages without writing or retrying", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mockAuth(true, 503);
    expect((await worker.fetch(request(), env)).status).toBe(502);
    expect(fetchSourceCatalog).not.toHaveBeenCalled();
    const calls = mockAuth();
    vi.mocked(fetchSourceCatalog).mockRejectedValueOnce(
      new Error("Roster is empty."),
    );
    const response = await worker.fetch(request(), env);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Roster is empty." });
    expect(calls).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });

  it("preserves asset routing, rejects GET and leaves scheduled games disabled", async () => {
    await worker.fetch(new Request("https://app.example/"), env);
    expect(env.ASSETS.fetch).toHaveBeenCalledTimes(1);
    expect(
      (
        await worker.fetch(
          new Request("https://app.example/api/catalog/preview"),
          env,
        )
      ).status,
    ).toBe(405);
    const calls = vi.fn();
    vi.stubGlobal("fetch", calls);
    await worker.scheduled({}, env);
    expect(calls).not.toHaveBeenCalled();
    expect(fetchSourceCatalog).not.toHaveBeenCalled();
  });
});
