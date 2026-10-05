begin;

create extension if not exists pgtap with schema extensions;
select plan(17);

insert into auth.users (id, aud, role, email, created_at, updated_at)
values
  (
    '00000000-0000-0000-0000-000000000011',
    'authenticated',
    'authenticated',
    'catalog-owner@example.test',
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000012',
    'authenticated',
    'authenticated',
    'catalog-member@example.test',
    now(),
    now()
  );

insert into public.site_owner_roles (user_id)
values ('00000000-0000-0000-0000-000000000011');

select ok(
  not has_function_privilege(
    'anon',
    'public.import_catalog_data(text,jsonb,jsonb)',
    'execute'
  ),
  'anonymous users cannot execute catalog imports'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000011',
  true
);

select is(public.is_site_owner(), true, 'the seeded user has the owner role');

select is(
  (
    select count(*)::integer
    from public.scoring_rule_versions
    where season_id = '11' and version = 1
  ),
  1,
  'the seeded catalog has an auditable initial scoring-rule version'
);

select lives_ok(
  $$
    select public.save_catalog_configuration(
      'phase3-test',
      'Phase 3 test season',
      'prior-test',
      '2099-12-05 20:00:00+00',
      '{
        "skater_goal": 3, "skater_assist": 2, "skater_shot": 0.5,
        "skater_short_handed_goal": 5, "skater_short_handed_assist": 3,
        "skater_blocked_shot": 3, "skater_hit": 3, "skater_plus_minus": 1,
        "goalie_goal": 50, "goalie_assist": 25, "goalie_win": 5,
        "goalie_shutout": 10, "goalie_save": 0.25, "goalie_goal_against": -1
      }'::jsonb,
      '[{"tier":1,"cost":10},{"tier":2,"cost":8},{"tier":3,"cost":6},{"tier":4,"cost":4},{"tier":5,"cost":2}]'::jsonb
    )
  $$,
  'site owner can save catalog settings'
);

select lives_ok(
  $$
    select public.import_catalog_data(
      'phase3-test',
      '[
        {"id":"skater-23","name":"Test Skater","teamId":"1","teamName":"Test","position":"F","playerType":"skater","active":true},
        {"id":"goalie-6","name":"Test Goalie","teamId":"1","teamName":"Test","position":"G","playerType":"goalie","active":true},
        {"id":"new-99","name":"No History","teamId":null,"teamName":null,"position":"D","playerType":"skater","active":true}
      ]'::jsonb,
      '[
        {"playerId":"skater-23","complete":true,"stats":{"goals":16,"assists":17,"shots":58,"short_handed_goals":0,"short_handed_assists":0,"blocked_shots":33,"hits":7,"plus_minus":13}},
        {"playerId":"goalie-6","complete":true,"stats":{"goals":0,"assists":0,"wins":19,"shutouts":8,"saves":631,"goals_against":31}}
      ]'::jsonb
    )
  $$,
  'site owner can import a normalized catalog atomically'
);

select is(
  (
    select calculated_projection
    from public.player_season_assignments
    where season_id = 'phase3-test' and player_id = 'skater-23'
  ),
  244::numeric,
  'skater projection uses the confirmed scoring formula'
);

select is(
  (
    select calculated_projection
    from public.player_season_assignments
    where season_id = 'phase3-test' and player_id = 'goalie-6'
  ),
  301.75::numeric,
  'goalie projection uses goalie-specific scoring'
);

select is(
  (
    select count(*)::integer
    from public.player_season_assignments
    where season_id = 'phase3-test' and status = 'needs_review'
  ),
  1,
  'players with no prior-season stats remain in review'
);

select throws_ok(
  $$select public.review_catalog_player('phase3-test', 'new-99', null, 3)$$,
  '22023',
  'A projection is required when prior-season statistics are unavailable.',
  'a missing-history player cannot be approved without a projection'
);

select lives_ok(
  $$select public.review_catalog_player('phase3-test', 'new-99', 42.5, 3)$$,
  'owner can approve a manually projected player'
);

select is(
  (
    select count(*)::integer
    from public.player_season_assignments
    where season_id = 'phase3-test' and status = 'ready'
  ),
  3,
  'reviewed player assignment becomes ready'
);

select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000012',
  true
);

select is(public.is_site_owner(), false, 'ordinary members are not site owners');

select throws_ok(
  $$
    select public.import_catalog_data('phase3-test', '[]'::jsonb, '[]'::jsonb)
  $$,
  '42501',
  'Site-owner access required.',
  'ordinary members cannot execute catalog imports'
);

select is(
  (select count(*)::integer from public.catalog_import_runs),
  0,
  'ordinary members cannot read owner-only import history'
);

reset role;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000011',
  true
);
update public.catalog_seasons
set roster_lock_at = now() - interval '1 minute'
where id = 'phase3-test';

set local role authenticated;
select lives_ok(
  $$select public.freeze_catalog_season('phase3-test')$$,
  'owner can create a snapshot after roster lock'
);

select is(
  (select count(*)::integer from public.catalog_snapshots where season_id = 'phase3-test'),
  1,
  'freezing persists one immutable catalog snapshot'
);

select throws_ok(
  $$select public.review_catalog_player('phase3-test', 'new-99', 42.5, 3)$$,
  '55000',
  'The catalog is locked.',
  'catalog assignments cannot change after freeze'
);

select * from finish();
rollback;
