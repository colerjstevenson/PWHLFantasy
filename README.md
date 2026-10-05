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

The database RLS integration test is in
`supabase/tests/profile_rls.test.sql`. It can be run against a disposable local
Supabase database with `npx supabase test db`; never run test fixtures against
production data.

## Phase 2 scope

This foundation includes magic-link authentication, a self-only profile,
versioned schema migrations, RLS, test/build tooling, and Cloudflare static
hosting configuration. League, roster, transfer, import, and scoring features
are intentionally deferred to their later phases.
