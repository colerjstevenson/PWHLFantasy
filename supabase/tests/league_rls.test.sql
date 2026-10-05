begin;

create extension if not exists pgtap with schema extensions;
select plan(33);

insert into auth.users (id, aud, role, email, created_at, updated_at)
values
  (
    '00000000-0000-0000-0000-000000000021',
    'authenticated',
    'authenticated',
    'league-commissioner@example.test',
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000022',
    'authenticated',
    'authenticated',
    'league-manager@example.test',
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000023',
    'authenticated',
    'authenticated',
    'league-outsider@example.test',
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000024',
    'authenticated',
    'authenticated',
    'league-test-owner@example.test',
    now(),
    now()
  );

insert into public.site_owner_roles (user_id)
values ('00000000-0000-0000-0000-000000000024');

reset role;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000024',
  true
);
update public.catalog_seasons
set roster_lock_at = now() + interval '1 day'
where id = '11';

select ok(
  not has_table_privilege('anon', 'public.league_invites', 'select'),
  'anonymous users cannot read invitation hashes'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.create_league(text,text,integer,numeric,text)',
    'execute'
  ),
  'anonymous users cannot create leagues'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.join_league_by_invite(text)',
    'execute'
  ),
  'anonymous users cannot join leagues'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000021',
  true
);
select lives_ok(
  $$
    select set_config(
      'test.league_id',
      public.create_league(
        '11',
        'Northern Lights',
        18,
        100,
        encode(extensions.digest(convert_to(repeat('a', 64), 'UTF8'), 'sha256'), 'hex')
      )::text,
      true
    )
  $$,
  'a commissioner creates a league, membership, team, and invite atomically'
);
select ok(
  not has_table_privilege('anon', 'public.leagues', 'select'),
  'anonymous users cannot read leagues'
);
select is(
  (
    select count(*)::integer
    from public.league_members
    where league_id = current_setting('test.league_id')::uuid
      and user_id = '00000000-0000-0000-0000-000000000021'
      and role = 'commissioner'
      and status = 'active'
  ),
  1,
  'the creator becomes the active commissioner'
);
select is(
  (
    select count(*)::integer
    from public.fantasy_teams
    where league_id = current_setting('test.league_id')::uuid
      and user_id = '00000000-0000-0000-0000-000000000021'
  ),
  1,
  'the commissioner receives exactly one fantasy team'
);

select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000022',
  true
);
select lives_ok(
  $$
    select public.join_league_by_invite(repeat('a', 64))
  $$,
  'a manager can join through the invitation token'
);
select is(
  (
    select count(*)::integer
    from public.league_members
    where league_id = current_setting('test.league_id')::uuid
      and user_id = '00000000-0000-0000-0000-000000000022'
      and status = 'active'
  ),
  1,
  'joining creates one active membership'
);
select is(
  (
    select count(*)::integer
    from public.fantasy_teams
    where league_id = current_setting('test.league_id')::uuid
      and user_id = '00000000-0000-0000-0000-000000000022'
  ),
  1,
  'joining creates one fantasy team'
);
select lives_ok(
  $$select public.join_league_by_invite(repeat('a', 64))$$,
  'repeating a valid join is idempotent'
);
select is(
  (
    select count(*)::integer
    from public.league_members
    where league_id = current_setting('test.league_id')::uuid
      and user_id = '00000000-0000-0000-0000-000000000022'
  ),
  1,
  'repeated joining does not duplicate membership'
);
select is(
  (
    select count(*)::integer
    from public.fantasy_teams
    where league_id = current_setting('test.league_id')::uuid
      and user_id = '00000000-0000-0000-0000-000000000022'
  ),
  1,
  'repeated joining does not duplicate the team'
);
select throws_ok(
  $$
    update public.leagues
    set name = 'Unauthorized edit'
    where id = current_setting('test.league_id')::uuid
  $$,
  '42501',
  null,
  'members cannot modify league settings directly'
);
select throws_ok(
  $$select public.rotate_league_invite(current_setting('test.league_id')::uuid, repeat('b', 64))$$,
  '42501',
  'Commissioner access required.',
  'a manager cannot rotate an invitation'
);
select throws_ok(
  $$select public.remove_league_member(current_setting('test.league_id')::uuid, auth.uid())$$,
  '42501',
  'Commissioner access required.',
  'a manager cannot remove a member'
);

select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000023',
  true
);
select is(
  (
    select count(*)::integer
    from public.leagues
    where id = current_setting('test.league_id')::uuid
  ),
  0,
  'an outsider cannot read a private league'
);
select is(
  (
    select count(*)::integer
    from public.fantasy_teams
    where league_id = current_setting('test.league_id')::uuid
  ),
  0,
  'an outsider cannot read private league teams'
);

select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000021',
  true
);
select throws_ok(
  $$select public.remove_league_member(current_setting('test.league_id')::uuid, auth.uid())$$,
  '22023',
  'The commissioner cannot be removed.',
  'a commissioner cannot remove their own membership'
);
select lives_ok(
  $$
    select public.remove_league_member(
      current_setting('test.league_id')::uuid,
      '00000000-0000-0000-0000-000000000022'
    )
  $$,
  'the commissioner can remove a manager'
);
select is(
  (
    select count(*)::integer
    from public.get_league_members(current_setting('test.league_id')::uuid)
  ),
  1,
  'removed members are excluded from the active member list'
);
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000022',
  true
);
select is(
  (
    select count(*)::integer
    from public.leagues
    where id = current_setting('test.league_id')::uuid
  ),
  0,
  'a removed member can no longer read the league'
);
select is(
  (
    select count(*)::integer
    from public.fantasy_teams
    where league_id = current_setting('test.league_id')::uuid
  ),
  0,
  'a removed member can no longer read league teams'
);
select lives_ok(
  $$select public.join_league_by_invite(repeat('a', 64))$$,
  'a removed manager can rejoin using an open invitation'
);
select is(
  (
    select count(*)::integer
    from public.fantasy_teams
    where league_id = current_setting('test.league_id')::uuid
      and user_id = auth.uid()
  ),
  1,
  'rejoining preserves the existing fantasy team'
);

select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000021',
  true
);
select lives_ok(
  $$
    select public.close_league_invite(current_setting('test.league_id')::uuid)
  $$,
  'the commissioner can close the invitation'
);
select lives_ok(
  $$
    select public.rotate_league_invite(
      current_setting('test.league_id')::uuid,
      encode(extensions.digest(convert_to(repeat('b', 64), 'UTF8'), 'sha256'), 'hex')
    )
  $$,
  'the commissioner can rotate an invitation'
);
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000023',
  true
);
select throws_ok(
  $$select public.join_league_by_invite(repeat('a', 64))$$,
  'P0002',
  'Invitation link is invalid or closed.',
  'a rotated invitation token is rejected'
);
select lives_ok(
  $$select public.join_league_by_invite(repeat('b', 64))$$,
  'the replacement invitation token can be used'
);

reset role;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000024',
  true
);
update public.catalog_seasons
set roster_lock_at = now() - interval '1 second'
where id = '11';

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000021',
  true
);
select is(
  public.get_league_invite_status(current_setting('test.league_id')::uuid),
  false,
  'an open invitation is expired automatically at roster lock'
);
select throws_ok(
  $$select public.create_league('11', 'Too Small', 5, 100, repeat('c', 64))$$,
  '22023',
  'League settings are invalid.',
  'a roster smaller than six is rejected'
);
select throws_ok(
  $$select public.join_league_by_invite(repeat('b', 64))$$,
  '55000',
  'This invitation has expired at roster lock.',
  'joining after roster lock is rejected'
);
select throws_ok(
  $$select public.create_league('11', 'Too Late', 18, 100, repeat('c', 64))$$,
  '55000',
  'League creation is closed for this season.',
  'league creation after roster lock is rejected'
);

select * from finish();
rollback;
