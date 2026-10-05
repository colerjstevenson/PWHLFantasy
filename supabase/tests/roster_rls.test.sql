begin;

create extension if not exists pgtap with schema extensions;
select plan(18);

insert into auth.users (id, aud, role, email, created_at, updated_at)
values
  (
    '00000000-0000-0000-0000-000000000031',
    'authenticated',
    'authenticated',
    'roster-owner@example.test',
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000032',
    'authenticated',
    'authenticated',
    'roster-manager@example.test',
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000033',
    'authenticated',
    'authenticated',
    'roster-outsider@example.test',
    now(),
    now()
  );

insert into public.site_owner_roles (user_id)
values ('00000000-0000-0000-0000-000000000031');

select ok(
  not has_table_privilege('anon', 'public.fantasy_roster_players', 'select'),
  'anonymous users cannot read saved rosters'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.save_fantasy_roster(uuid,text[])',
    'execute'
  ),
  'anonymous users cannot save rosters'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000031',
  true
);
select lives_ok(
  $$
    select public.save_catalog_configuration(
      'phase5-roster-test',
      'Phase 5 roster test season',
      'prior-test',
      '2099-12-05 20:00:00+00',
      '{
        "skater_goal": 3, "skater_assist": 2, "skater_shot": 0.5,
        "skater_short_handed_goal": 5, "skater_short_handed_assist": 3,
        "skater_blocked_shot": 3, "skater_hit": 3, "skater_plus_minus": 1,
        "goalie_goal": 50, "goalie_assist": 25, "goalie_win": 5,
        "goalie_shutout": 10, "goalie_save": 0.25, "goalie_goal_against": -1
      }'::jsonb,
      '[{"tier":1,"cost":10},{"tier":2,"cost":10},{"tier":3,"cost":10},{"tier":4,"cost":10},{"tier":5,"cost":10}]'::jsonb
    )
  $$,
  'site owner can configure the test roster season'
);
select lives_ok(
  $$
    select public.import_catalog_data(
      'phase5-roster-test',
      '[
        {"id":"r-f1","name":"Forward One","teamId":"1","teamName":"North","position":"F","playerType":"skater","active":true},
        {"id":"r-f2","name":"Forward Two","teamId":"1","teamName":"North","position":"F","playerType":"skater","active":true},
        {"id":"r-f3","name":"Forward Three","teamId":"1","teamName":"North","position":"F","playerType":"skater","active":true},
        {"id":"r-f4","name":"Forward Four","teamId":"1","teamName":"North","position":"F","playerType":"skater","active":true},
        {"id":"r-d1","name":"Defence One","teamId":"2","teamName":"South","position":"D","playerType":"skater","active":true},
        {"id":"r-d2","name":"Defence Two","teamId":"2","teamName":"South","position":"D","playerType":"skater","active":true},
        {"id":"r-d3","name":"Defence Three","teamId":"2","teamName":"South","position":"D","playerType":"skater","active":true},
        {"id":"r-g1","name":"Goalie One","teamId":"3","teamName":"East","position":"G","playerType":"goalie","active":true}
      ]'::jsonb,
      '[
        {"playerId":"r-f1","complete":true,"stats":{"goals":1,"assists":1}},
        {"playerId":"r-f2","complete":true,"stats":{"goals":2,"assists":1}},
        {"playerId":"r-f3","complete":true,"stats":{"goals":3,"assists":1}},
        {"playerId":"r-f4","complete":true,"stats":{"goals":4,"assists":1}},
        {"playerId":"r-d1","complete":true,"stats":{"goals":1,"assists":1}},
        {"playerId":"r-d2","complete":true,"stats":{"goals":2,"assists":1}},
        {"playerId":"r-d3","complete":true,"stats":{"goals":3,"assists":1}},
        {"playerId":"r-g1","complete":true,"stats":{"goals":0,"assists":0,"wins":1}}
      ]'::jsonb
    )
  $$,
  'site owner can provide reviewed player assignments'
);
select set_config(
  'test.roster_league_id',
  public.create_league(
    'phase5-roster-test',
    'Roster Test League',
    6,
    60,
    encode(
      extensions.digest(convert_to(repeat('d', 64), 'UTF8'), 'sha256'),
      'hex'
    )
  )::text,
  true
);

select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000032',
  true
);
select lives_ok(
  $$select public.join_league_by_invite(repeat('d', 64))$$,
  'manager can join the roster test league'
);
select set_config(
  'test.roster_team_id',
  (
    select id::text
    from public.fantasy_teams
    where league_id = current_setting('test.roster_league_id')::uuid
      and user_id = auth.uid()
  ),
  true
);

select throws_ok(
  $$
    select public.save_fantasy_roster(
      current_setting('test.roster_team_id')::uuid,
      array['r-f1','r-f2','r-d1','r-d2','r-g1','r-f3','r-f4']
    )
  $$,
  '22023',
  'Select exactly the required number of players.',
  'a roster with too many players is rejected'
);
select throws_ok(
  $$
    select public.save_fantasy_roster(
      current_setting('test.roster_team_id')::uuid,
      array['r-f1','r-f2','r-d1','r-d2','r-d3','r-g1']
    )
  $$,
  '22023',
  'The roster needs at least 3 forwards, 2 defence, and 1 goalie.',
  'a roster below a positional minimum is rejected'
);
select throws_ok(
  $$
    select public.save_fantasy_roster(
      current_setting('test.roster_team_id')::uuid,
      array['r-f1','r-f2','r-f3','r-d1','r-d2','r-missing']
    )
  $$,
  '22023',
  'One or more selected players are unavailable or need catalog review.',
  'unknown or unreviewed players are rejected'
);
select throws_ok(
  $$
    select public.save_fantasy_roster(
      current_setting('test.roster_team_id')::uuid,
      array['r-f1','r-f1','r-f3','r-d1','r-d2','r-g1']
    )
  $$,
  '22023',
  'A roster cannot contain blank or duplicate players.',
  'duplicate selections are rejected'
);
reset role;
update public.leagues
set budget = 59.99
where id = current_setting('test.roster_league_id')::uuid;
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000032',
  true
);
select throws_ok(
  $$
    select public.save_fantasy_roster(
      current_setting('test.roster_team_id')::uuid,
      array['r-f1','r-f2','r-f3','r-d1','r-d2','r-g1']
    )
  $$,
  '22023',
  'The roster exceeds the league budget.',
  'rosters over budget are rejected'
);
reset role;
update public.leagues
set budget = 60
where id = current_setting('test.roster_league_id')::uuid;
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000032',
  true
);
select lives_ok(
  $$
    select public.save_fantasy_roster(
      current_setting('test.roster_team_id')::uuid,
      array['r-f1','r-f2','r-f3','r-d1','r-d2','r-g1']
    )
  $$,
  'a valid complete roster saves'
);
select is(
  (
    select count(*)::integer
    from public.fantasy_roster_players
    where team_id = current_setting('test.roster_team_id')::uuid
  ),
  6,
  'successful save persists the complete roster'
);
select throws_ok(
  $$
    select public.save_fantasy_roster(
      current_setting('test.roster_team_id')::uuid,
      array['r-f1','r-f2','r-f3','r-d1','r-d2','r-missing']
    )
  $$,
  '22023',
  'One or more selected players are unavailable or need catalog review.',
  'a rejected save does not replace the previously saved roster'
);
select is(
  (
    select count(*)::integer
    from public.fantasy_roster_players
    where team_id = current_setting('test.roster_team_id')::uuid
  ),
  6,
  'the previous complete roster remains intact after rejection'
);

select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000031',
  true
);
select is(
  (
    select count(*)::integer
    from public.fantasy_roster_players
    where team_id = (
      select id
      from public.fantasy_teams
      where league_id = current_setting('test.roster_league_id')::uuid
        and user_id = '00000000-0000-0000-0000-000000000032'
    )
  ),
  0,
  'a league member cannot read another manager roster'
);
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000033',
  true
);
select throws_ok(
  $$
    select public.save_fantasy_roster(
      current_setting('test.roster_team_id')::uuid,
      array['r-f1','r-f2','r-f3','r-d1','r-d2','r-g1']
    )
  $$,
  '42501',
  'Active team access required.',
  'another user cannot save a manager roster'
);

reset role;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000031',
  true
);
update public.catalog_seasons
set roster_lock_at = now() - interval '1 second'
where id = 'phase5-roster-test';
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000032',
  true
);
select throws_ok(
  $$
    select public.save_fantasy_roster(
      current_setting('test.roster_team_id')::uuid,
      array['r-f1','r-f2','r-f3','r-d1','r-d2','r-g1']
    )
  $$,
  '55000',
  'Roster changes are closed at the season lock.',
  'roster saves stop at the global season lock'
);
select is(
  (
    select count(*)::integer
    from public.fantasy_roster_players
    where team_id = current_setting('test.roster_team_id')::uuid
  ),
  6,
  'the locked roster is not changed by a rejected save'
);

select * from finish();
rollback;
