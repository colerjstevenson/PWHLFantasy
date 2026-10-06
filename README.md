# PWHL Fantasy

Mobile-first fantasy hockey for private PWHL leagues.

## Requirements

- Node.js 22 or newer
- npm
- A hosted Supabase development project
- Wrangler authentication for Cloudflare deployment

## Local development

1. Install dependencies with `npm ci`.
2. Copy `.env.example` to `.env` and set `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_ANON_KEY` from the **development** Supabase project.
3. Link the Supabase CLI to the development project and run
   `npx supabase db push` to apply the versioned migration. Repeat against
   staging and production only when you are ready to promote the schema.
4. In Supabase Auth settings, allow the local app URL (for example,
   `http://localhost:5173`) as a redirect URL and enable email sign-in.
5. Run `npm run dev`.

The app sends magic links back to the current app origin. Email confirmation
and delivery settings are managed in the Supabase dashboard. The browser uses
only the project's public anon key; never put a service-role key in a `VITE_`
environment variable.

## Environments and deployments

Create separate hosted Supabase projects for development, staging, and
production. Configure each project's Auth site URL and allowed redirect URLs
for its corresponding Cloudflare URL. Keep project refs, database credentials,
and Cloudflare secrets out of the repository. The public Supabase URL and anon
key are client configuration, not privileged credentials.

For local development, set the development project values in `.env.local`.
For deployment, put each hosted project's public values in the corresponding
ignored `.env.staging.local` or `.env.production.local` file. Deploy staging
and production with:

```sh
npm run deploy:staging
npm run deploy
```

The staging command builds with Vite's `staging` mode and deploys a separate
`pwhl-fantasy-staging` Worker; the production command builds with production
mode and deploys `pwhl-fantasy`. Both serve the SPA assets using
`wrangler.jsonc`. Configure each Supabase Auth redirect allowlist with its
deployed origin. Wrangler must be authenticated to the target Cloudflare
account before deployment.

## Quality checks

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

The database RLS integration tests are in `supabase/tests/`. They can be run
against a disposable local Supabase database with `npx supabase test db`; never
run test fixtures against production data.

## Phase 4: leagues and invitations

Apply the versioned database migrations to the development project before
using league features. Signed-in users can create leagues for the next season
before its roster-lock deadline. Creation atomically creates the commissioner
membership, fantasy team, and first invitation. Roster sizes must be at least
six to fit the required position minimums.

Invitation tokens are generated in the browser using cryptographic randomness;
only their SHA-256 hashes are stored in Postgres. A commissioner can copy the
new link, rotate it to invalidate the old one, or close it early. Invites stop
working automatically at roster lock. A visitor can sign in from an invite
link and is joined after authentication. Joining is idempotent.

Commissioners can remove managers. Removal revokes access but preserves the
membership and team records; a removed manager can rejoin through an open
invitation, restoring the existing team. The commissioner cannot remove
themselves. League data reads are scoped to active members, and trusted
database functions enforce membership, invite, and commissioner operations.

For local authorization and lifecycle coverage, start the local Supabase stack
and run `npx supabase test db`. The tests are transactional and use disposable
fixtures; do not direct them at production.

## Phase 3: player catalog and site-owner administration

Apply the Phase 3 migration with the normal database migration process. The
catalog is initially seeded for source season `11` / prior season `8`, with the
confirmed Eastern roster-lock instant and scoring values. In the Supabase SQL
editor, assign the first site owner using the authenticated user's UUID:

```sql
insert into public.site_owner_roles (user_id)
values ('<authenticated-user-uuid>');
```

The owner role table has no browser write policy; bootstrap and later owner-role
changes must be performed by a trusted database administrator. Sign in, then
use the **Site owner** console to set all five tier costs, review scoring and
lock settings, and upload a source export.

The import JSON is an envelope with `season`, `players`, and `seasonStats`
properties. `season` contains `id`, `name`, and `priorSeasonId`. Player entries
use source fields such as `player_id`, `name`, `team_id`, `team_name`, `type`,
`position`, and/or `position_analysis`. Season-stat entries use `player_id` and
the documented HockeyTech aggregate fields. Numeric strings are normalized;
blank or absent required stats stay incomplete and require owner review. The
adapter also accepts already normalized camel-case IDs and nested `stats`
objects.

Imports and configuration changes are transactional and authorized in
Postgres. Only authenticated users can read the shared catalog; import history
and audit records are visible only to site owners. Scoring values, tiers, and
costs are frozen by database checks at the Eastern roster-lock instant.
Scoring changes create versioned records and configuration changes are audited.
After lock, the owner can create an immutable catalog snapshot from the console,
provided all five costs are set and all imported player assignments are
reviewed.

### Manual source catalog preview

The site owner confirmed on October 5, 2026 that automated third-party source
usage is permitted. No numeric quota or service guarantee has been established.
Catalog fetching is **owner-triggered only**: no cron, automatic retry, or
background refresh. The existing scheduled **game** importer is separate and
still disabled by `PWHL_AUTOMATION_ENABLED=false`.

Configure `PWHL_FEED_KEY` as a Worker secret using
`npx wrangler secret put PWHL_FEED_KEY` (add `--name pwhl-fantasy-staging` for
staging). Use the provider-approved feed credential; do not put it in the
browser, a `VITE_` variable, or version control. The Worker verifies the caller's
Supabase session and `is_site_owner` using `SUPABASE_URL` and
`SUPABASE_ANON_KEY` (or the existing `VITE_SUPABASE_ANON_KEY` Worker variable).
This path does not use the service-role credential. Set
`PWHL_CATALOG_ENABLED=false` to disable manual fetching.

In the owner console, select a regular-season source ID and click **Fetch
source catalog preview**. The Worker selects the immediately preceding
regular season from metadata, fetches every team's roster, then fetches the
two prior-season aggregate tables. It returns a preview, never a database
write. Review per-team counts, player types, and players without history,
check the confirmation box, then use **Save settings and import**. This reuses
the existing owner-authorized transactional import, scoring, tier rules and
roster-lock enforcement. Keep JSON upload as the fallback.

If any target-season team returns a valid but empty roster, the Worker discards
the partial target-season roster set and fetches all teams and rosters from the
prior regular season instead. The preview identifies that roster season and
requires explicit confirmation that the temporary catalog may omit expansion
teams and new signings. Team, player membership and active status are therefore
last-season values, not claims about upcoming-season eligibility. Fetch the
target season again after its rosters are published to replace the temporary
roster snapshot.

Malformed, mismatched, capped, or missing-field responses do not produce a
usable preview and leave the catalog unchanged. An empty upcoming-season roster
triggers the documented prior-season roster fallback; if that roster set is
also empty, fetching fails visibly. An unsuccessful new fetch clears an older
preview so it cannot be imported by mistake. New rostered players absent from
the prior-season stat tables retain the existing no-history review behavior;
missing scoring fields in an existing source stat row abort fetching rather
than becoming zero. HTTP 429 and other failures are visible and are not
automatically retried. Fetch-only failures are reported in the console and
Worker logs, not recorded as database import attempts.

For local fetch testing, build the assets, configure the Worker variables and
secret in ignored `.dev.vars`, and run `npx wrangler dev --port 8787`. Vite
proxies `/api/catalog` to that Worker when using `npm run dev`. JSON upload
continues to work without a local Worker.

#### Validated endpoint/data map

Base: `https://lscluster.hockeytech.com/feed/index.php`. All calls are HTTPS GET
with `client_code=pwhl` and the configured `key`. Request URL construction is
fixed in the Worker adapter; owners cannot supply an arbitrary upstream URL.
The [PWHL-Data-Reference](https://github.com/IsabelleLefebvre97/PWHL-Data-Reference)
is an unofficial technical guide, not a supported API contract.

| Data          | Request selectors                                                                                                                                                     | Response shape and mapping                                                                                                                                                                                                                                                                                                                                           |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seasons       | `feed=modulekit&view=seasons`                                                                                                                                         | `SiteKit.Seasons[]`: `season_id`, `season_name`, `playoff`, `start_date`, `end_date`. Require regular-season name and `playoff=0`; choose the latest regular season starting before the selected season starts, require it to end before that start date, and do not infer season relationships from numeric IDs.                                                    |
| Teams         | `feed=modulekit&view=teamsbyseason&season_id=<target>`                                                                                                                | `SiteKit.Teamsbyseason[]`: `id`, `name`. Require unique IDs and matching response season.                                                                                                                                                                                                                                                                            |
| Players       | `feed=modulekit&view=roster&season_id=<target>&team_id=<each team>`; if any target roster is valid but empty, discard that set and fetch teams/rosters for `<prior>`. | `SiteKit.Roster[]`: `player_id`/`id`, `name`, `team_id`, `position`, `active`. A final nested array contains staff, not players. Require all rosters in the chosen season to be nonempty, active status explicit, player/team IDs matching and positions supported; team display name comes from that season's teams response. Preview identifies the roster season. |
| Prior skaters | `feed=statviewfeed&view=players&season=<prior>&position=skaters&sort=points`                                                                                          | Bare-parenthesized JSON array: `[0].sections[0].data[].row`; cross-check `prop.name.playerLink` against `row.player_id`. Map `goals`, `assists`, `shots`, `short_handed_goals`, `short_handed_assists`, `shots_blocked_by_player` → `blocked_shots`, `hits`, `plus_minus`.                                                                                           |
| Prior goalies | Same aggregate endpoint with `position=goalies&sort=gaa&qualified=all`                                                                                                | Same shape/ID checks. Map `goals`, `assists`, `wins`, `shutouts`, `saves`, `goals_against`. Never infer goalie goals/assists as zero.                                                                                                                                                                                                                                |

Aggregate calls also specify `team=all`, `rookies=0`, `statsType=standard`,
`rosterstatus=undefined`, `site_id=0`, `league_id=1`, `first=0`, `limit=500`,
`lang=en`, `division=-1`, `conference=-1`, and `qualified=all`. The adapter
accepts plain JSON, bare parentheses and a named JSONP callback without
executing JavaScript. Responses have a 30-second timeout and a streamed 5 MB
limit; redirects fail. Requests are sequential, with a maximum of 32 teams in
either roster season and an overall cap of 40 upstream requests per owner
action, including the fallback roster set. The request sequence stops on the
first error. There is no assumed requests-per-second allowance.

Sparse checks on October 5, 2026 observed 187 skaters and 20 goalies in season
`8`, with contiguous ranks and all scoring fields, and 12 teams in season
`11`. The season-8 Boston roster contained 27 players plus a nested staff
array; 24 skaters and 3 goalies shared IDs with the aggregate feeds.
The sampled season-11 Boston roster returned `[[]]`. The adapter now uses the
complete prior-season team/roster set in this case and explicitly labels the
result as a temporary roster fallback. It has not probed other current-season
rosters; the source may publish partial target-season rosters, so a fallback
can omit new or expansion teams and players. Representative, reduced field
excerpts are in `fixtures/catalog-source-excerpts.json`; they are not complete
catalogs.

Completeness checks reject duplicate IDs, missing/reordered ranks, multiple
unexpected tables/sections, responses reaching the 500-row cap, missing teams,
missing scoring fields, player-type conflicts, and a join with no shared IDs.
If both target and prior-season rosters are empty, fetching fails. Historical
players no longer in the chosen roster season are excluded.
The feeds do **not** publish a total record count in the observed responses:
these checks cannot prove that the provider has not omitted rows or entire
teams. The preview explicitly discloses that limitation and requires owner
coverage confirmation. Do not claim a guaranteed complete provider catalog
or enable unattended catalog imports on this evidence.

Provider attribution is displayed with fetched previews: Official statistics
provided by Professional Women's Hockey League;
[LeagueStat](http://leaguestat.com);
[Powered by HockeyTech.com](http://hockeytech.com).

## Phase 2 foundation

The initial foundation includes magic-link authentication, a self-only
profile, versioned schema migrations, RLS, test/build tooling, and Cloudflare
static hosting configuration. League, roster, and transfer features remain
deferred to their later phases.

## Phase 5: roster building

Apply the versioned migrations to the development Supabase project before
building a roster. In an active league, use **Your roster** to search the
season's player catalog by player/team and filter by position. Only active
players with a reviewed season assignment and a configured tier cost can be
added. The roster view shows selected players, budget, roster slots, and
forward/defence/goalie minimums as you make changes.

Unsaved changes are stored in browser local storage on the current device,
scoped to the signed-in manager and their league team. Saving sends the entire
roster to a trusted database function, which atomically validates ownership,
league membership, active player eligibility, exact roster size, budget,
position minimums, and the global roster-lock deadline. A rejected save leaves
the previous saved roster unchanged. Direct roster writes are not granted to
authenticated clients, and a manager can read only their own saved roster.

If a site-owner catalog update makes a saved roster invalid, the app flags it
without silently changing the saved selections. Managers must correct and save
the roster before lock. Client rules are covered by `npm test`; database
authorization and roster validation are covered by
`npx supabase test db` against a disposable local Supabase database. Never run
database test fixtures against production.

## Phase 6: roster lock and transfers

The Phase 6 migration snapshots every team’s saved roster at the global lock
and records whether it met the roster-size, position, player-eligibility, and
budget rules. The snapshot is immutable and does not repair or rewrite a
manager’s saved roster. League members can see team eligibility; only a
manager can see their own roster and detailed ineligibility reasons.

The migration installs a `pg_cron` job that checks for due locks and transfers
every minute. The lock is stored as an absolute instant and displayed using
`America/New_York`; monthly allowance periods and next-midnight transfer
effective times are also calculated in that time zone. The lock snapshot is
created idempotently by the scheduled job and by the manager transfer-status
flow if the scheduled run is delayed.

Managers whose team was eligible at lock can confirm up to three swaps per
Eastern calendar month. A swap is validated transactionally against the
current roster, active/reviewed catalog, budget, and positional minimums. It
becomes effective at the next Eastern midnight and updates the saved roster
and effective-dated ownership history together. Only one swap can be pending
per team. A pending swap can be cancelled before its effective time; a
cancellation restores that month’s allowance. A transfer cannot be cancelled
once it is effective.

The manager interface shows lock eligibility, current allowance, eligible
swap candidates, pending cancellation, and transfer history. The database
functions remain authoritative if catalog state or concurrent requests make
the displayed assessment stale. Database coverage includes lock snapshots,
eligibility visibility, daylight-saving/month-boundary calculations,
budget/position checks, allowance accounting, cancellation/refund, ownership
history updates, and conflicting pending requests. Apply and test migrations
with `npx supabase db push` and `npx supabase test db` against a disposable
development database only. Confirm that the scheduler job exists with:

```sql
select jobname, schedule
from cron.job
where jobname = 'pwhl-fantasy-phase6-events';
```
