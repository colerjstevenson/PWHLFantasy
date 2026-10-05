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
Live upstream fetching and scheduled refresh are not enabled until the
documented source usage terms and request limits are confirmed.

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
