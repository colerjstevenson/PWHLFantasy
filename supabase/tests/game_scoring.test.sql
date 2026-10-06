begin;

create extension if not exists pgtap with schema extensions;
select plan(18);

insert into auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values
  (
    '00000000-0000-0000-0000-000000000071',
    'authenticated',
    'authenticated',
    'phase7-manager-one@example.test',
    '{"display_name":"Manager One"}',
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000072',
    'authenticated',
    'authenticated',
    'phase7-manager-two@example.test',
    '{"display_name":"Manager Two"}',
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000073',
    'authenticated',
    'authenticated',
    'phase7-outsider@example.test',
    '{"display_name":"Outsider"}',
    now(),
    now()
  );

insert into public.catalog_seasons (
  id, name, prior_season_id, roster_lock_at, scoring_values, scoring_version
)
values (
  'phase7-scoring-test',
  'Phase 7 scoring test',
  'phase7-prior-test',
  '2026-12-05 20:00:00+00',
  '{
    "skater_goal": 3, "skater_assist": 2, "skater_shot": 0.5,
    "skater_short_handed_goal": 5, "skater_short_handed_assist": 3,
    "skater_blocked_shot": 3, "skater_hit": 3, "skater_plus_minus": 1,
    "goalie_goal": 50, "goalie_assist": 25, "goalie_win": 5,
    "goalie_shutout": 10, "goalie_save": 0.25, "goalie_goal_against": -1
  }'::jsonb,
  1
);
insert into public.scoring_rule_versions (season_id, version, scoring_values)
select id, scoring_version, scoring_values
from public.catalog_seasons
where id = 'phase7-scoring-test';

insert into public.players (id, name, position, player_type, active)
values
  ('phase7-player', 'Phase 7 Skater', 'F', 'skater', true),
  ('phase7-unowned', 'Phase 7 Unowned', 'F', 'skater', true);

insert into public.leagues (
  id, season_id, commissioner_id, name, roster_size, budget
)
values
  (
    '00000000-0000-0000-0000-000000000171',
    'phase7-scoring-test',
    '00000000-0000-0000-0000-000000000071',
    'Phase 7 Test League',
    6,
    100
  );
insert into public.league_members (league_id, user_id, role)
values
  (
    '00000000-0000-0000-0000-000000000171',
    '00000000-0000-0000-0000-000000000071',
    'commissioner'
  ),
  (
    '00000000-0000-0000-0000-000000000171',
    '00000000-0000-0000-0000-000000000072',
    'manager'
  );
insert into public.fantasy_teams (id, league_id, user_id)
values
  (
    '00000000-0000-0000-0000-000000000271',
    '00000000-0000-0000-0000-000000000171',
    '00000000-0000-0000-0000-000000000071'
  ),
  (
    '00000000-0000-0000-0000-000000000272',
    '00000000-0000-0000-0000-000000000171',
    '00000000-0000-0000-0000-000000000072'
  );
insert into public.roster_lock_snapshots (
  team_id, season_id, eligible, ineligible_reasons, roster, locked_at
)
values
  (
    '00000000-0000-0000-0000-000000000271',
    'phase7-scoring-test',
    true,
    '{}',
    '[]',
    '2026-12-05 20:00:00+00'
  ),
  (
    '00000000-0000-0000-0000-000000000272',
    'phase7-scoring-test',
    true,
    '{}',
    '[]',
    '2026-12-05 20:00:00+00'
  );
insert into public.fantasy_player_ownership (
  team_id, player_id, valid_from, valid_until
)
values
  (
    '00000000-0000-0000-0000-000000000271',
    'phase7-player',
    '2026-12-05 05:00:00+00',
    '2026-12-06 05:00:00+00'
  ),
  (
    '00000000-0000-0000-0000-000000000272',
    'phase7-player',
    '2026-12-06 05:00:00+00',
    null
  );

select is(
  public.calculate_game_points(
    '{
      "goals":1,"assists":2,"shots":4,"short_handed_goals":1,
      "short_handed_assists":1,"blocked_shots":2,"hits":1,"plus_minus":-1
    }'::jsonb,
    'skater',
    (select scoring_values from public.catalog_seasons where id = 'phase7-scoring-test')
  ),
  25::numeric,
  'skater scoring applies base categories and short-handed bonuses'
);
select is(
  public.calculate_game_points(
    '{"goals":1,"assists":1,"wins":1,"shutouts":1,"saves":20,"goals_against":2}'::jsonb,
    'goalie',
    (select scoring_values from public.catalog_seasons where id = 'phase7-scoring-test')
  ),
  93::numeric,
  'goalie scoring uses goalie-only categories'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select lives_ok(
  $$
    select public.import_final_game_data(
      'phase7-scoring-test',
      '[
        {
          "gameId":"phase7-g1",
          "startsAt":"2026-12-05T18:00:00-05:00",
          "gameType":"regular","status":4,"final":true,
          "stats":[{"playerId":"phase7-player","playerType":"skater","stats":{
            "goals":1,"assists":0,"shots":0,"short_handed_goals":0,
            "short_handed_assists":0,"blocked_shots":0,"hits":0,"plus_minus":0
          }}]
        },
        {
          "gameId":"phase7-g2",
          "startsAt":"2026-12-06T18:00:00-05:00",
          "gameType":"regular","status":4,"final":true,
          "stats":[{"playerId":"phase7-player","playerType":"skater","stats":{
            "goals":2,"assists":0,"shots":0,"short_handed_goals":0,
            "short_handed_assists":0,"blocked_shots":0,"hits":0,"plus_minus":0
          }}]
        },
        {
          "gameId":"phase7-g3",
          "startsAt":"2026-12-07T18:00:00-05:00",
          "gameType":"regular","status":1,"final":false,"stats":[]
        },
        {
          "gameId":"phase7-g4",
          "startsAt":"2026-12-07T20:00:00-05:00",
          "gameType":"playoff","status":4,"final":true,
          "stats":[{"playerId":"phase7-player","playerType":"skater","stats":{
            "goals":9,"assists":0,"shots":0,"short_handed_goals":0,
            "short_handed_assists":0,"blocked_shots":0,"hits":0,"plus_minus":0
          }}]
        }
      ]'::jsonb,
      false
    )
  $$,
  'the trusted importer accepts an idempotent game batch'
);
reset role;

select is(
  (select count(*)::integer from public.season_games where season_id = 'phase7-scoring-test'),
  4,
  'the source game identifiers are persisted once'
);
select is(
  (select count(*)::integer from public.fantasy_game_scores where season_id = 'phase7-scoring-test'),
  2,
  'only owned players in final regular-season games receive scores'
);
select is(
  (select sum(points) from public.fantasy_game_scores
   where team_id = '00000000-0000-0000-0000-000000000271'),
  3::numeric,
  'the game on the first Eastern roster date is credited to the outgoing owner'
);
select is(
  (select sum(points) from public.fantasy_game_scores
   where team_id = '00000000-0000-0000-0000-000000000272'),
  6::numeric,
  'the game on the next Eastern roster date is credited to the incoming owner'
);
select is(
  (select count(*)::integer
   from public.fantasy_game_scores score
   join public.season_games game on game.id = score.game_id
   where game.source_game_id in ('phase7-g3', 'phase7-g4')),
  0,
  'non-final and playoff games do not contribute regular-season points'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000071',
  true
);
select is(
  (select count(*)::integer
   from public.get_league_standings('00000000-0000-0000-0000-000000000171')
   where is_winner),
  0,
  'a partial regular-season schedule does not declare a winner'
);
reset role;

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select lives_ok(
  $$
    select public.import_final_game_data(
      'phase7-scoring-test',
      '[{
        "gameId":"phase7-g1",
        "startsAt":"2026-12-05T18:00:00-05:00",
        "gameType":"regular","status":4,"final":true,
        "stats":[{"playerId":"phase7-player","playerType":"skater","stats":{
          "goals":2,"assists":0,"shots":0,"short_handed_goals":0,
          "short_handed_assists":0,"blocked_shots":0,"hits":0,"plus_minus":0
        }}]
      }]'::jsonb,
      false
    )
  $$,
  'a corrected final game is re-imported'
);
select lives_ok(
  $$
    select public.import_final_game_data(
      'phase7-scoring-test',
      '[{
        "gameId":"phase7-g1",
        "startsAt":"2026-12-05T18:00:00-05:00",
        "gameType":"regular","status":4,"final":true,
        "stats":[{"playerId":"phase7-player","playerType":"skater","stats":{
          "goals":2,"assists":0,"shots":0,"short_handed_goals":0,
          "short_handed_assists":0,"blocked_shots":0,"hits":0,"plus_minus":0
        }}]
      }]'::jsonb,
      false
    )
  $$,
  'an unchanged final game can be safely re-imported'
);
select lives_ok(
  $$
    select public.import_final_game_data(
      'phase7-scoring-test',
      '[{
        "gameId":"phase7-g3",
        "startsAt":"2026-12-07T18:00:00-05:00",
        "gameType":"regular","status":4,"final":true,
        "stats":[{"playerId":"phase7-unowned","playerType":"skater","stats":{
          "goals":0,"assists":0,"shots":0,"short_handed_goals":0,
          "short_handed_assists":0,"blocked_shots":0,"hits":0,"plus_minus":0
        }}]
      }]'::jsonb,
      true
    )
  $$,
  'the complete regular-season schedule can be marked after final results arrive'
);
reset role;

select is(
  (select sum(points) from public.fantasy_game_scores
   where team_id = '00000000-0000-0000-0000-000000000271'),
  6::numeric,
  'a corrected source stat replaces the prior score'
);
select is(
  (select count(*)::integer
   from public.player_game_stat_revisions revision
   join public.season_games game on game.id = revision.game_id
   where game.source_game_id = 'phase7-g1'
     and revision.player_id = 'phase7-player'),
  2,
  'the previous final-stat version remains auditable'
);
select is(
  (select count(*)::integer
   from public.player_game_stat_revisions revision
   join public.season_games game on game.id = revision.game_id
   where game.source_game_id = 'phase7-g1'
     and revision.player_id = 'phase7-player'),
  2,
  'unchanged re-imports do not create duplicate statistic revisions'
);
select is(
  (select count(*)::integer from public.fantasy_game_scores
   where team_id in (
     '00000000-0000-0000-0000-000000000271',
     '00000000-0000-0000-0000-000000000272'
   )
   and points = 6),
  2,
  'equal final totals are retained for both teams'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000071',
  true
);
select is(
  (select count(*)::integer
   from public.get_league_standings('00000000-0000-0000-0000-000000000171')
   where is_winner and season_complete),
  2,
  'tied leaders are both declared co-winners after schedule completion'
);
reset role;

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000073',
  true
);
select throws_ok(
  $$select * from public.get_league_standings('00000000-0000-0000-0000-000000000171')$$,
  '42501',
  'Active league membership required.',
  'standings are private to active league members'
);

select * from finish();
rollback;
