# PWHL Fantasy

## Product goal

Build a simple, mobile-first fantasy hockey web app for private PWHL leagues. A user creates a league, shares an invitation link, and league members build budget-constrained rosters from a shared player pool. Managers earn points only for player statistics recorded while those players are on their roster. The manager (or managers) with the most points at the end of the regular season wins.

This document records the agreed product behavior and a proposed implementation sequence. Technical choices described as recommendations can be revisited before implementation.

## Confirmed product decisions

| Area                    | Decision                                                                                                                                                                                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| League creation         | Any authenticated user can create a league; its creator is its commissioner.                                                                                                                                                                                                                        |
| League membership       | Anyone with the invitation link can join until the global roster-lock deadline. The commissioner can close the link earlier.                                                                                                                                                                        |
| Managers and teams      | Each league member manages exactly one fantasy team.                                                                                                                                                                                                                                                |
| Roster size and budget  | The commissioner sets both when creating a league.                                                                                                                                                                                                                                                  |
| Minimum positions       | Each roster must contain at least 3 forwards, 2 defence, and 1 goalie.                                                                                                                                                                                                                              |
| Player ownership        | The same real-world player may appear on multiple fantasy teams, including teams in the same league.                                                                                                                                                                                                |
| Tiers and prices        | There are five global tiers. Prior-season totals under the global scoring rules generate an initial tier assignment; the site owner reviews and can correct assignments. The site owner sets the cost of each tier. Tier assignments and costs are shared by all leagues and freeze at roster lock. |
| Scoring                 | One site-wide set of stat point values applies to all leagues. Use the confirmed Phase 1 rubric below; only the site owner can edit it, and it becomes read-only at roster lock.                                                                                                                    |
| Roster deadline         | The confirmed global deadline is December 5, 2026, at 3:00 p.m. Eastern, tied to the first 2026-27 regular-season game. Only the site owner can adjust it. Represent Eastern Time as `America/New_York` so daylight-saving changes are handled correctly.                                           |
| Transfers               | A transfer swaps one player for another. Each manager gets 3 transfers per calendar month; unused transfers do not roll over. A transfer uses the month in which it is confirmed.                                                                                                                   |
| Transfer effective time | A confirmed transfer takes effect at the next midnight Eastern Time.                                                                                                                                                                                                                                |
| Scoring updates         | Count only completed/final games. If official stats are corrected later, recalculate affected fantasy points and standings.                                                                                                                                                                         |
| Season result           | Score regular-season games only. A tie for first place is a shared win.                                                                                                                                                                                                                             |
| Authentication          | Supabase email magic-link sign-in.                                                                                                                                                                                                                                                                  |
| Hosting and data        | Host on Cloudflare; use Supabase for authentication and Postgres. Use [PWHL-Data-Reference](https://github.com/IsabelleLefebvre97/PWHL-Data-Reference) as the documented guide to PWHL data sources and formats.                                                                                    |

### Phase 1 scoring rubric

The site owner confirmed these values on October 5, 2026. Short-handed goals and assists are bonuses in addition to the base goal/assist values. The goalie formula uses the goalie-specific values below (including goalie goals and assists); skater-only categories are not added to goalie totals.

| Statistic                   | Skater points | Goalie points |
| --------------------------- | ------------: | ------------: |
| Goal                        |             3 |            50 |
| Assist                      |             2 |            25 |
| Shot                        |           0.5 |             — |
| Short-handed goal (bonus)   |             5 |             — |
| Short-handed assist (bonus) |             3 |             — |
| Blocked shot                |             3 |             — |
| Hit                         |             3 |             — |
| Plus/minus                  |             1 |             — |
| Win                         |             — |             5 |
| Shutout                     |             — |            10 |
| Save                        |             — |          0.25 |
| Goal against                |             — |            -1 |

## User roles and permissions

- **Site owner:** Manages the global roster-lock deadline, scoring values, tier costs, tier review/corrections, and the platform-wide player catalog. Can inspect data-import status and retry a failed import.
- **Commissioner:** Creates a league, chooses its budget and roster size, shares or closes its invite link, and manages league membership as defined during implementation. Does not change global scoring or player prices.
- **Manager:** Joins a league, builds and manages their own roster, makes eligible transfers, and views league standings.
- **Unauthenticated visitor:** Can open an invitation link and proceed through sign-in before joining. Private league data is not exposed before membership.

All privileged actions must be authorized on the server/database, not merely hidden in the interface.

## Product behavior and rules

### 1. Account and onboarding

1. A user requests an email magic link and returns to the app through Supabase Auth.
2. The user can create a league or join one through a valid invitation link.
3. A successful join creates one membership and one fantasy team for that user in that league.
4. The app presents a mobile-friendly league home with roster status, remaining budget, transfers remaining, current points, and standings.

### 2. League setup and invitations

1. The commissioner creates a league with a name, roster size, and budget.
2. The app verifies that the selected roster size can satisfy all three positional minimums.
3. The app creates a high-entropy invitation token. Store only a hash of the token; allow the commissioner to rotate or close the link.
4. The link accepts a member only while it is valid, the league is accepting members, and the global roster-lock deadline has not passed.
5. Joining a league is idempotent: following the same valid link again must not create duplicate memberships or teams.

### 3. Player catalog, projections, and tiers

1. Maintain a canonical player record with a stable source identifier, name, team, position, and active/availability status.
2. Import prior-season player statistics and calculate each player's initial projection as the prior-season total using the global scoring values.
3. Convert projected output into five ordered tiers. The tier-boundary method must be deterministic and documented as part of the implementation; the site owner reviews and may correct assignments before roster lock.
4. Players without usable prior-season totals require site-owner review and assignment before they can be selected.
5. The site owner sets one cost for each tier. All leagues use the same player tier and cost.
6. Freeze player assignments and tier costs at the global roster-lock deadline. Preserve the season's final tier snapshot for auditability.

### 4. Roster construction

1. Before roster lock, a manager can assemble a current-device-only, unsaved draft and see the total cost, remaining budget, roster size, and counts by position update immediately.
2. A roster is valid only when:
   - Its player count does not exceed the league's configured roster size.
   - Its total tier cost does not exceed the league budget.
   - It has at least 3 forwards, 2 defence, and 1 goalie.
3. Persist a roster only when it is valid. Managers can continue editing their unsaved draft until it meets every rule; clearly identify what remains to make it valid.
4. At roster lock, each team must have a valid saved roster to compete. The app must not silently fill missing slots or change a roster. Show an actionable validation message before the deadline.
5. At roster lock, managers can no longer edit their initial roster. The transfer workflow is available only during the regular season and after the roster has been validly locked.

### 5. Transfers

1. The manager selects one rostered player to remove and one eligible replacement.
2. Before confirming, validate the monthly allowance, budget, roster size, and all minimum positions against the resulting roster.
3. Save a successful transfer atomically so concurrent requests cannot exceed the allowance or leave an invalid roster.
4. Count the transfer against the Eastern calendar month in which it is confirmed. Reset the allowance to 3 at the start of each Eastern calendar month, with no carryover.
5. Record confirmation time and effective time separately. Effective time is the next midnight in `America/New_York`.
6. Preserve roster history: the outgoing player's points earned before the effective time stay with the manager; the incoming player's earlier points do not transfer to the manager.
7. The interface shows the remaining allowance, the transfer's effective time, and a history of completed transfers.

### 6. Data imports, scoring, and standings

1. Begin with an integration spike against the documented PWHL sources and included CSV data. Confirm stable player/game identifiers, final-game status, supported stat fields, update behavior, and source rate limits before choosing production endpoints.
2. Build an ingestion adapter that normalizes source records into players, seasons, games, and per-player game statistics. Make imports idempotent and retain source IDs and import timestamps.
3. Use a scheduled Cloudflare Worker to refresh data automatically. Make failures visible to the site owner and support a controlled retry; do not mark a partial import as successful.
4. Only include statistics for games marked final. Re-importing a corrected final game replaces the prior source statistics and recalculates impacted fantasy scores.
5. Calculate points from the global scoring configuration and the player's per-game statistics. Credit the game to the roster that owns the player at the game's Eastern calendar-day boundary, respecting the recorded transfer effective time.
6. Keep an auditable link between source game stats, scoring-rule version, roster ownership interval, and calculated fantasy points. Recompute derived totals from these records rather than treating displayed standings as the only source of truth.
7. Display team totals and a descending regular-season leaderboard. Declare managers tied for the highest final total as co-winners.

## Proposed technical architecture

These implementation choices fit the requested Cloudflare and Supabase hosting while keeping privileged operations out of the browser.

- **Web client:** React, TypeScript, and Vite, designed mobile-first and served as static assets by a Cloudflare Worker.
- **Server operations:** Cloudflare Worker endpoints for trusted operations and scheduled data imports. Store the Supabase service-role key and other secrets only as Cloudflare Worker secrets; never ship them to the browser.
- **Identity and database:** Supabase Auth for magic links and Supabase Postgres for application data.
- **Authorization:** Postgres row-level security (RLS) for user- and league-scoped reads/writes, with database constraints and transactional functions for roster and transfer invariants. Validate server-side even when the client performs the same checks for responsive feedback.
- **Data source boundary:** A replaceable adapter between the documented PWHL source formats and the app's normalized tables, so a change in upstream API does not require rewriting scoring or roster logic.
- **Automation:** Cloudflare Cron Triggers for imports and maintenance work. Select the polling frequency during the source integration spike, based on upstream update cadence and rate limits.

### Initial database concepts

- `profiles`: Supabase Auth user ID and display name.
- `leagues`: commissioner, name, roster size, budget, invite state, and season.
- `league_members`: one row per user per league, with membership role and join time.
- `fantasy_teams`: one team per league member, with a unique constraint on `(league_id, user_id)`.
- `players`, `seasons`, `games`, and `player_game_stats`: normalized source catalog and final game-level statistics.
- `tier_costs` and `player_season_tiers`: global per-season tier costs, projection inputs, reviewed assignments, and freeze state.
- `scoring_rule_versions`: global stat values and the version effective before roster lock.
- `roster_periods` or equivalent ownership intervals: player, fantasy team, start time, and end time for historical scoring attribution.
- `transfers`: outgoing/incoming players, confirmation/effective timestamps, month charged, and validation/audit details.
- `data_import_runs`: source, start/end time, outcome, and actionable error details.
- Derived score records or views: per-game fantasy points and season totals, recomputable from source stats, scoring rules, and roster history.

Schema names are provisional; constraints and transaction boundaries are requirements regardless of final naming.

## Implementation plan

### Phase 1: Validate data and lock the rules

- Inspect the referenced repository's source documentation and representative CSV/API records.
- Verify player/game identifiers, positions, stat coverage, completed-game markers, correction behavior, and update limits.
- Write fixtures from representative source records, including a goalie, a skater, a postponed game, and a corrected final game.
- Specify deterministic tier boundaries and document how players with no prior-season data are handled.
- Confirm official season dates and how the site owner updates the global roster-lock timestamp.

**Exit criteria:** The app can reliably identify a player and final game, derive the global-scoring prior-season total, and identify data conditions that need owner review.

#### Phase 1 validation findings (October 5, 2026)

This is a research spike only; no application or production importer has been built. The findings below are based on the [unofficial PWHL-Data-Reference](https://github.com/IsabelleLefebvre97/PWHL-Data-Reference) at commit `937890772f351ee603afaa428814354ffdbf091d`, its included data dictionary/CSV files, direct reads of the documented HockeyTech endpoints, and the [official PWHL opening-weekend announcement](https://www.thepwhl.com/en/news/2026/september/28/pwhl-opening-weekend-scheduled-for-december-5-6).

| Area                          | Verified evidence                                                                                                                                                                                                                                                                                                                                                  | Implementation consequence                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reference data freshness      | The reference data README says its last full update was April 8, 2025. Its CSV collection contains 2024/2025 season data, not a current 2025-26 season catalog.                                                                                                                                                                                                    | Use the CSVs as historical examples/fixtures only. Do not use them as the app's live catalog or assume they represent the current prior season.                                                                                                                                                                                                                                                                                     |
| Season IDs and schedule       | The documented seasons endpoint currently identifies season `8` as 2025-26 Regular Season and season `11` as 2026-27 Regular Season. The 2026-27 season metadata says `start_date=2026-12-04`; its schedule's first regular-season game is December 5, 2026 at 3:00 p.m. Eastern. The official announcement confirms that opening game and time.                   | Select the prior regular season by season metadata (`playoff=0` and regular-season identity), not by a hard-coded season ID or by preseason/playoff data. Base the roster-lock instant on the confirmed first scheduled regular-season game, not the metadata `start_date`.                                                                                                                                                         |
| Schedule timestamp            | For the first 2026-27 game, the schedule response includes `GameDateISO8601=2026-12-05T15:00:00-05:00` and `date_time_played=2026-12-05T15:00:00Z`. The latter conflicts with the official 3:00 p.m. Eastern announcement by five hours if interpreted as UTC.                                                                                                     | The owner confirmed the lock instant as December 5, 2026, 3:00 p.m. Eastern (20:00 UTC). Represent it using `America/New_York`; do not derive it from the conflicting `date_time_played` field unless the source discrepancy is clarified.                                                                                                                                                                                          |
| Player and game identifiers   | Player game-by-game responses include player ID, season ID, and game ID; the schedule exposes both `id` and `game_id`. The same player IDs appear in the reference player catalog. Example live records included skater `player_id=32` in game `214` (season `8`) and goalie `player_id=6` in game `213` (season `8`).                                             | Normalize source IDs as strings and use source IDs—not names, jersey numbers, or team—as identity. Use season/game/player IDs together as the player-game-stat key; verify all IDs exist before importing.                                                                                                                                                                                                                          |
| Positions                     | The player CSV distinguishes `type` (`skater`/`goalie`), specific positions such as `C`, `LD`, `RW`, and `position_analysis` such as `F`/`D`/`G`; some `team_id` values are empty.                                                                                                                                                                                 | Map roster eligibility from a validated normalized position (`F`, `D`, or `G`) while retaining the source position/type. Do not require a current team ID to identify a player.                                                                                                                                                                                                                                                     |
| Player-game stat fields       | Live skater logs expose fields including goals, assists, points, shots, hits, blocked shots, plus/minus, and faceoffs. Goalie logs expose saves, shots against, goals against, wins/losses, shutouts, and time played. Values may be numeric or numeric strings; absent values may be empty strings. The skater sample contains both `plusminus` and `plus_minus`. | Define a source-to-canonical field map per player type. Parse only explicitly supported values, preserve the raw source payload for diagnosis, and distinguish zero from missing/blank. Resolve duplicate/legacy fields such as `plusminus` versus `plus_minus` before relying on them for scoring.                                                                                                                                 |
| Game finality                 | The reference dictionary defines status `1` as upcoming, `2` as in progress, `3` as final/not official, and `4` as final/official. Live schedule data for upcoming game `365` has `status=1`, `started=0`, `final=0`; a completed 2025-26 schedule record reports `status=4`, `final=1`.                                                                           | Count only records confirmed as official final (`status=4` and `final=1`), not merely a display label or a provisional final. Treat unknown or contradictory combinations as review/error cases.                                                                                                                                                                                                                                    |
| Postponements and corrections | The static schedule contains upcoming/TBD rows, but no captured before-and-after corrected final-stat snapshots. The documented API returns current game-by-game records; the inspected documentation does not describe a revision feed or publish correction history.                                                                                             | Scheduled/non-final records provide a fixture for exclusion, but a genuine postponement and an actual correction remain unverified. Re-imports should be idempotent by `(season_id, game_id, player_id)` and retain import timestamps/raw snapshots so a changed source value can be detected and audited. Do not claim correction behavior is validated until two source snapshots or an official correction example are captured. |
| Request limits                | The inspected reference documents endpoint shapes but no supported rate limit, service guarantee, or published polling allowance.                                                                                                                                                                                                                                  | Avoid production polling until a conservative refresh cadence is tested and the provider's usage limits/terms are confirmed. Make cadence configurable and back off on errors rather than assuming an undocumented quota.                                                                                                                                                                                                           |

#### Scoring and projection check

The supplied rubric was applied to the live 2025-26 regular-season aggregate statistics (season `8`), using the documented skater and goalie stat-view endpoints. This is a reproducible source snapshot check, not yet an approved production calculation. The calculation used:

- Skater: `3*goals + 2*assists + 0.5*shots + 5*short_handed_goals + 3*short_handed_assists + 3*shots_blocked_by_player + 3*hits + plus_minus`.
- Goalie: `5*wins + 10*shutouts + 0.25*saves - goals_against + 50*goals + 25*assists`.

| Sample                            | Season total input                                                                                          | Calculated total |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------: |
| Skater Kelly Pannek (player `23`) | 16 goals, 17 assists, 58 shots, 0 short-handed goals, 0 short-handed assists, 33 blocked shots, 7 hits, +13 |              244 |
| Goalie Aerin Frankel (player `6`) | 19 wins, 8 shutouts, 631 saves, 31 goals against, 0 goals, 0 assists                                        |           301.75 |

Across the source response's 187 skaters and 20 goalies with prior-season statistics:

| Comparison                                                      |          Skaters |      Goalies |
| --------------------------------------------------------------- | ---------------: | -----------: |
| Median season total                                             |            128.5 |         77.5 |
| Maximum season total                                            |            358.5 |          310 |
| Share assigned to combined Tier 1 by the proposed global method | 39 / 187 (20.9%) | 3 / 20 (15%) |

With the revised goalie values, the combined tiers contained 42, 42, 41, 41, and 41 players, respectively. Goalies are 20 of the 207 players (9.7%) with season totals and account for 3 of 42 Tier 1 assignments (7.1%). The goalie median is 0.60 times the skater median and the highest goalie total is 0.86 times the highest skater total. The revised weights remove the prior upper-tier goalie premium in this sample; no further goalie multiplier is recommended from these data.

#### Confirmed deterministic tier and no-history rules

The site owner approved these rules on October 5, 2026. The season-8 comparison above is a validation sample; assignments must be recomputed from the selected prior season before use.

1. Calculate each eligible player's prior regular-season total using the agreed global scoring rubric.
2. Sort players by total descending and group equal totals together.
3. For each equal-total group, compute its 1-based midrank `r` and assign tier `1 + min(4, floor(5 * (r - 1) / N))`, where `N` is the number of players with usable totals. Tier 1 is the highest-output tier and tier 5 the lowest. This keeps equal totals together; ties may make tier sizes uneven or leave a tier empty.
4. Mark players with no usable prior-season total as `needs_review`; exclude them from selection until the site owner supplies and approves a projection/tier. Never silently treat missing statistics as zero.
5. Store the input season, scoring-rule version, computed total, tier, and any owner override so assignments can be reproduced and audited.

#### Accepted non-blocking source risks

- A historical correction example and a genuine postponed-game status are not available in the inspected snapshots. The owner accepted this evidence gap as non-blocking. Preserve the requirement to exclude non-final games, detect changed source statistics, and recalculate affected scores; monitor unknown statuses and corrections during operation rather than treating the upstream behavior as proven.
- Source usage limits and terms remain unverified. The owner accepted this gap as non-blocking for proceeding to Phase 2; this does not establish permission or a supported request quota. Before enabling production automation, review applicable usage terms and configure conservative polling, error visibility, and backoff.

**Phase 1 status:** Complete with accepted evidence gaps. The owner approved the scoring rules, revised goalie weights, December 5, 2026, 3:00 p.m. Eastern lock deadline, and quintile/midrank tier method. The scoring was applied to a 2025-26 sample, a tier comparison was calculated, and representative source fixtures were saved. Correction/postponement semantics and source usage limits remain unproven but are no longer Phase 1 blockers. Phase 2 can proceed; no application code, production data importer, or scheduled job was added as part of this spike.

### Phase 2: Scaffold the application and security foundation

- Create the React/TypeScript/Vite app and Cloudflare Worker configuration.
- Configure Supabase project environments, schema migrations, magic-link authentication, and local development.
- Establish RLS policies, role checks, secret handling, and database-level uniqueness/validation constraints.
- Add automated formatting, type-checking, and test commands.

**Exit criteria:** A user can sign in, sign out, and access only their own profile; deployment secrets are not present in client assets.

**Implementation status (October 5, 2026):** The repository now contains the Vite/React/TypeScript client, hosted-Supabase magic-link and self-profile flow, profile migration with RLS, CI checks, and Cloudflare static-asset configuration. Remote Supabase projects, Auth redirect allowlists, Cloudflare sites/secrets, and production deployment still require owner configuration; do not treat Phase 2 as deployed until those environment-specific steps and the RLS integration test have been verified.

### Phase 3: Build the player and site-owner administration

- Implement player, season, and stat ingestion through a normalized adapter.
- Build site-owner tools for the global lock date, scoring values, five tier costs, projected assignments, corrections, and import status.
- Generate initial projections from prior-season totals using the global scoring configuration.
- Freeze the scoring configuration and tier catalog at roster lock.

**Exit criteria:** A site owner can review a complete season catalog, fix player/tier data, and verify the exact scoring and cost values that managers will use.

**Implementation status (October 5, 2026):** The repository now has a normalized HockeyTech JSON adapter, tested projection and midrank-tier logic, a database-backed catalog with owner-only transactional configuration/import/review/freeze functions, audit/import history, and a site-owner console. The first catalog is seeded with the verified 2026-27 / prior-season source IDs, lock instant, and Phase 1 scoring values; the owner must set all five tier costs and bootstrap their account in `site_owner_roles`. Catalog input is currently a validated JSON export uploaded by the owner. Automated live endpoint fetching and scheduled imports remain deferred until the source terms, limits, and production request cadence have been confirmed; this phase does not claim those upstream operational details are resolved.

### Phase 4: Build league creation and joining

- Implement league creation with commissioner, roster size, and budget.
- Implement invite-link creation, rotation, early closure, validation, and automatic expiry at roster lock.
- Implement one membership and one team per user per league.
- Add league and member views with clear commissioner/member permissions.

**Exit criteria:** Two test accounts can create and join a league without duplicate membership or cross-league data exposure.

### Phase 5: Build the mobile roster experience

- Create a searchable/filterable player list with position, team, tier, and cost.
- Implement add/remove interactions and live budget, roster-size, and position feedback.
- Keep progressive edits in a current-device-only unsaved draft and show which rules remain unmet.
- Persist only valid rosters; validate the complete roster atomically in the database when saving and locking.

**Exit criteria:** Managers can assemble valid rosters on a phone-sized viewport, and invalid budget/position/size combinations are rejected by trusted server-side logic.

### Phase 6: Implement roster lock and transfers

- Apply the global lock consistently using `America/New_York`.
- Validate and snapshot every roster at lock; show teams that are not eligible to compete without mutating them.
- Implement atomic player swaps, monthly allowance accounting, next-midnight effective times, and ownership history.
- Add transfer confirmation, remaining allowance, and history interfaces.

**Exit criteria:** Boundary tests cover a transfer immediately before midnight, month-end, a monthly reset, insufficient budget, each positional minimum, and concurrent transfer requests.

### Phase 7: Automate final-stat scoring and league standings

- Schedule imports through Cloudflare Cron Triggers using the cadence selected in Phase 1.
- Ingest only final games for scoring; surface failures and retries in site-owner tools.
- Calculate per-game points against the roster ownership interval and global scoring version.
- Recalculate affected points after official stat corrections and update standings.
- Stop regular-season scoring at the end of the regular season and display shared winners for tied scores.

**Exit criteria:** Fixture-based tests prove that players receive only points earned while rostered, corrections update totals, non-final games do not count, and tied first-place teams share the win.

### Phase 8: Test, deploy, and operate

- Run unit tests for rules and calculations, integration tests for RLS/transactions/imports, and end-to-end tests for sign-in, joining, roster building, transfers, and standings.
- Verify responsive behavior and keyboard/accessibility basics on common phone and desktop viewports.
- Deploy a staging environment to Cloudflare and Supabase, run migrations, and test a complete sample league.
- Add production monitoring for Worker errors, import freshness, failed imports, and database authorization failures.
- Document owner operations: setting the season deadline, approving tiers, setting scoring/costs, and recovering a failed import.

**Exit criteria:** A staging season can be run end-to-end, operational errors are visible, and the owner can safely perform all required global setup.

## Core acceptance tests

- A league member cannot read or modify another private league's roster or settings.
- Two league members can select the same real-world player without conflict.
- A roster cannot be locked unless it meets the configured size, budget, and positional minimums.
- Any scoring or tier/cost change is rejected after the global roster-lock deadline.
- A transfer is rejected if it exceeds budget, violates a positional minimum, exceeds three confirmed transfers in that Eastern calendar month, or occurs after the applicable window.
- A successful transfer is charged to its confirmation month and changes scoring ownership at the next Eastern midnight.
- Only final regular-season games contribute points; no points earned before joining a roster are credited.
- Corrected official stats update affected fantasy points and standings without duplicating game records.
- A tie for the highest regular-season score produces shared winners.
- Expired, closed, or malformed invite links cannot add league members.

## Items to settle during implementation

- Verify the upstream data source's usage terms, rate limits, and appropriate automated refresh cadence before enabling live imports.
- Define membership removal/league deletion behavior and data retention before building commissioner controls.
