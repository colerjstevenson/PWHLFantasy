begin;

create extension if not exists pgtap with schema extensions;
select plan(7);

insert into auth.users (id, aud, role, email, created_at, updated_at)
values
  (
    '00000000-0000-0000-0000-000000000001',
    'authenticated',
    'authenticated',
    'profile-one@example.test',
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000002',
    'authenticated',
    'authenticated',
    'profile-two@example.test',
    now(),
    now()
  );

select ok(
  not has_table_privilege('anon', 'public.profiles', 'select'),
  'anonymous role cannot read profiles'
);

select ok(
  not has_table_privilege('anon', 'public.profiles', 'update'),
  'anonymous role cannot update profiles'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000001',
  true
);

select is(
  (select count(*)::integer from public.profiles),
  1,
  'a user can read exactly their own profile'
);

select is(
  (
    with changed as (
      update public.profiles
      set display_name = 'Manager One'
      where id = '00000000-0000-0000-0000-000000000001'
      returning 1
    )
    select count(*)::integer from changed
  ),
  1,
  'a user can update their own profile'
);

select is(
  (
    with changed as (
      update public.profiles
      set display_name = 'Not Manager Two'
      where id = '00000000-0000-0000-0000-000000000002'
      returning 1
    )
    select count(*)::integer from changed
  ),
  0,
  'a user cannot update another profile'
);

select is(
  (select display_name from public.profiles where id = '00000000-0000-0000-0000-000000000002'),
  null,
  'another profile remains unchanged'
);

select throws_ok(
  $$update public.profiles set id = '00000000-0000-0000-0000-000000000002'
    where id = '00000000-0000-0000-0000-000000000001'$$,
  '42501',
  null,
  'a user cannot change their profile identity'
);

select * from finish();
rollback;
