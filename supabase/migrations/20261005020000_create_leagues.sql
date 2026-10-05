create extension if not exists pgcrypto with schema extensions;

create table public.leagues (
  id uuid primary key default gen_random_uuid(),
  season_id text not null references public.catalog_seasons (id),
  commissioner_id uuid not null references auth.users (id),
  name text not null check (
    char_length(name) between 1 and 80 and name = btrim(name)
  ),
  roster_size integer not null check (roster_size >= 6),
  budget numeric(10, 2) not null check (budget >= 0),
  created_at timestamptz not null default now()
);

create table public.league_members (
  league_id uuid not null references public.leagues (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('commissioner', 'manager')),
  status text not null default 'active' check (status in ('active', 'removed')),
  joined_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by uuid references auth.users (id),
  primary key (league_id, user_id),
  check (
    (status = 'active' and removed_at is null and removed_by is null)
    or (status = 'removed' and removed_at is not null and removed_by is not null)
  )
);

create table public.fantasy_teams (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  unique (league_id, user_id),
  foreign key (league_id, user_id)
    references public.league_members (league_id, user_id) on delete cascade
);

create table public.league_invites (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues (id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by uuid references auth.users (id),
  check ((closed_at is null) = (closed_by is null))
);

create unique index league_invites_one_open_per_league
  on public.league_invites (league_id)
  where closed_at is null;
create index league_members_user_status_idx
  on public.league_members (user_id, status);

create function public.is_active_league_member(p_league_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.league_members m
    where m.league_id = p_league_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
  );
$$;

create function public.is_league_commissioner(p_league_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.leagues l
    where l.id = p_league_id
      and l.commissioner_id = (select auth.uid())
  );
$$;

create function public.create_league(
  p_season_id text,
  p_name text,
  p_roster_size integer,
  p_budget numeric,
  p_invite_token_hash text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_league_id uuid;
  v_lock_at timestamptz;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Sign-in is required.';
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 80
    or p_roster_size is null or p_roster_size < 6
    or p_budget is null or p_budget < 0
    or p_invite_token_hash is null
    or p_invite_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'League settings are invalid.';
  end if;

  select roster_lock_at into v_lock_at
  from public.catalog_seasons
  where id = p_season_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Season not found.';
  end if;
  if clock_timestamp() >= v_lock_at then
    raise exception using errcode = '55000', message = 'League creation is closed for this season.';
  end if;

  insert into public.leagues (season_id, commissioner_id, name, roster_size, budget)
  values (p_season_id, v_user_id, btrim(p_name), p_roster_size, p_budget)
  returning id into v_league_id;

  insert into public.league_members (league_id, user_id, role)
  values (v_league_id, v_user_id, 'commissioner');

  insert into public.fantasy_teams (league_id, user_id)
  values (v_league_id, v_user_id);

  insert into public.league_invites (league_id, token_hash, created_by)
  values (v_league_id, p_invite_token_hash, v_user_id);

  return v_league_id;
end;
$$;

create function public.join_league_by_invite(p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_invite public.league_invites%rowtype;
  v_lock_at timestamptz;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Sign-in is required.';
  end if;
  if p_token is null or char_length(p_token) < 32 or char_length(p_token) > 128 then
    raise exception using errcode = '22023', message = 'Invitation link is invalid.';
  end if;

  select i.* into v_invite
  from public.league_invites i
  where i.token_hash = encode(
    extensions.digest(convert_to(p_token, 'UTF8'), 'sha256'),
    'hex'
  )
    and i.closed_at is null
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Invitation link is invalid or closed.';
  end if;

  select s.roster_lock_at into v_lock_at
  from public.leagues l
  join public.catalog_seasons s on s.id = l.season_id
  where l.id = v_invite.league_id;
  if clock_timestamp() >= v_lock_at then
    raise exception using errcode = '55000', message = 'This invitation has expired at roster lock.';
  end if;

  insert into public.league_members (league_id, user_id, role)
  values (v_invite.league_id, v_user_id, 'manager')
  on conflict (league_id, user_id) do update
  set status = 'active',
      joined_at = case
        when public.league_members.status = 'removed' then now()
        else public.league_members.joined_at
      end,
      removed_at = null,
      removed_by = null;

  insert into public.fantasy_teams (league_id, user_id)
  values (v_invite.league_id, v_user_id)
  on conflict (league_id, user_id) do nothing;

  return v_invite.league_id;
end;
$$;

create function public.rotate_league_invite(
  p_league_id uuid,
  p_token_hash text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lock_at timestamptz;
begin
  if not public.is_league_commissioner(p_league_id) then
    raise exception using errcode = '42501', message = 'Commissioner access required.';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Invitation token is invalid.';
  end if;

  select s.roster_lock_at into v_lock_at
  from public.leagues l
  join public.catalog_seasons s on s.id = l.season_id
  where l.id = p_league_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'League not found.';
  end if;
  if clock_timestamp() >= v_lock_at then
    raise exception using errcode = '55000', message = 'Invitations are closed at roster lock.';
  end if;

  update public.league_invites
  set closed_at = now(), closed_by = (select auth.uid())
  where league_id = p_league_id and closed_at is null;

  insert into public.league_invites (league_id, token_hash, created_by)
  values (p_league_id, p_token_hash, (select auth.uid()));
end;
$$;

create function public.close_league_invite(p_league_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_league_commissioner(p_league_id) then
    raise exception using errcode = '42501', message = 'Commissioner access required.';
  end if;
  update public.league_invites
  set closed_at = now(), closed_by = (select auth.uid())
  where league_id = p_league_id and closed_at is null;
end;
$$;

create function public.get_league_invite_status(p_league_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_league_commissioner(p_league_id) then
    raise exception using errcode = '42501', message = 'Commissioner access required.';
  end if;
  return exists (
    select 1
    from public.league_invites i
    join public.leagues l on l.id = i.league_id
    join public.catalog_seasons s on s.id = l.season_id
    where i.league_id = p_league_id
      and i.closed_at is null
      and clock_timestamp() < s.roster_lock_at
  );
end;
$$;

create function public.remove_league_member(
  p_league_id uuid,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
begin
  if not public.is_league_commissioner(p_league_id) then
    raise exception using errcode = '42501', message = 'Commissioner access required.';
  end if;

  select role into v_role
  from public.league_members
  where league_id = p_league_id and user_id = p_user_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'League member not found.';
  end if;
  if v_role = 'commissioner' then
    raise exception using errcode = '22023', message = 'The commissioner cannot be removed.';
  end if;

  update public.league_members
  set status = 'removed',
      removed_at = now(),
      removed_by = (select auth.uid())
  where league_id = p_league_id and user_id = p_user_id and status = 'active';
end;
$$;

create function public.get_league_members(p_league_id uuid)
returns table (
  user_id uuid,
  display_name text,
  role text,
  joined_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_active_league_member(p_league_id) then
    raise exception using errcode = '42501', message = 'Active league membership required.';
  end if;
  return query
  select m.user_id, p.display_name, m.role, m.joined_at
  from public.league_members m
  left join public.profiles p on p.id = m.user_id
  where m.league_id = p_league_id and m.status = 'active'
  order by (m.role = 'commissioner') desc, m.joined_at, m.user_id;
end;
$$;

alter table public.leagues enable row level security;
alter table public.league_members enable row level security;
alter table public.fantasy_teams enable row level security;
alter table public.league_invites enable row level security;

revoke all on table
  public.leagues,
  public.league_members,
  public.fantasy_teams,
  public.league_invites
from anon, authenticated;

grant select on table
  public.leagues,
  public.league_members,
  public.fantasy_teams
to authenticated;

create policy "League members can read their leagues"
  on public.leagues for select to authenticated
  using (
    commissioner_id = (select auth.uid())
    or (select public.is_active_league_member(id))
  );

create policy "Users can read their active memberships"
  on public.league_members for select to authenticated
  using (
    (user_id = (select auth.uid()) and status = 'active')
    or (
      status = 'active'
      and (select public.is_active_league_member(league_id))
    )
  );

create policy "League members can read league teams"
  on public.fantasy_teams for select to authenticated
  using ((select public.is_active_league_member(league_id)));

revoke all on function public.is_active_league_member(uuid)
  from public, anon;
grant execute on function public.is_active_league_member(uuid) to authenticated;
revoke all on function public.is_league_commissioner(uuid)
  from public, anon;
grant execute on function public.is_league_commissioner(uuid) to authenticated;

revoke all on function public.create_league(text, text, integer, numeric, text)
  from public, anon;
grant execute on function public.create_league(text, text, integer, numeric, text)
  to authenticated;
revoke all on function public.join_league_by_invite(text) from public, anon;
grant execute on function public.join_league_by_invite(text) to authenticated;
revoke all on function public.rotate_league_invite(uuid, text) from public, anon;
grant execute on function public.rotate_league_invite(uuid, text) to authenticated;
revoke all on function public.close_league_invite(uuid) from public, anon;
grant execute on function public.close_league_invite(uuid) to authenticated;
revoke all on function public.get_league_invite_status(uuid) from public, anon;
grant execute on function public.get_league_invite_status(uuid) to authenticated;
revoke all on function public.remove_league_member(uuid, uuid) from public, anon;
grant execute on function public.remove_league_member(uuid, uuid) to authenticated;
revoke all on function public.get_league_members(uuid) from public, anon;
grant execute on function public.get_league_members(uuid) to authenticated;
