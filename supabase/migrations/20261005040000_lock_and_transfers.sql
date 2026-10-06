create table public.roster_lock_snapshots (
  team_id uuid primary key references public.fantasy_teams (id) on delete cascade,
  season_id text not null references public.catalog_seasons (id),
  eligible boolean not null,
  ineligible_reasons text[] not null default '{}',
  roster jsonb not null check (jsonb_typeof(roster) = 'array'),
  locked_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index roster_lock_snapshots_season_idx
  on public.roster_lock_snapshots (season_id, eligible);

create table public.fantasy_transfers (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.fantasy_teams (id) on delete cascade,
  outgoing_player_id text not null references public.players (id),
  incoming_player_id text not null references public.players (id),
  confirmed_at timestamptz not null,
  confirmation_month date not null,
  effective_at timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending', 'effective', 'cancelled')),
  cancelled_at timestamptz,
  check (outgoing_player_id <> incoming_player_id),
  check ((status = 'cancelled') = (cancelled_at is not null))
);

create unique index fantasy_transfers_one_pending_per_team
  on public.fantasy_transfers (team_id)
  where status = 'pending';
create index fantasy_transfers_effective_idx
  on public.fantasy_transfers (effective_at)
  where status = 'pending';
create index fantasy_transfers_team_month_idx
  on public.fantasy_transfers (team_id, confirmation_month)
  where status <> 'cancelled';

create table public.fantasy_player_ownership (
  id bigint generated always as identity primary key,
  team_id uuid not null references public.fantasy_teams (id) on delete cascade,
  player_id text not null references public.players (id),
  valid_from timestamptz not null,
  valid_until timestamptz,
  check (valid_until is null or valid_until >= valid_from)
);

create index fantasy_player_ownership_team_player_idx
  on public.fantasy_player_ownership (team_id, player_id, valid_from);
create unique index fantasy_player_ownership_one_current_idx
  on public.fantasy_player_ownership (team_id, player_id)
  where valid_until is null;

create function public.phase6_next_eastern_midnight(p_instant timestamptz)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select (
    date_trunc('day', timezone('America/New_York', p_instant))
      + interval '1 day'
  ) at time zone 'America/New_York';
$$;

create function public.phase6_eastern_month_start(p_instant timestamptz)
returns date
language sql
immutable
set search_path = ''
as $$
  select date_trunc(
    'month',
    timezone('America/New_York', p_instant)
  )::date;
$$;

alter table public.roster_lock_snapshots enable row level security;
alter table public.fantasy_transfers enable row level security;
alter table public.fantasy_player_ownership enable row level security;

revoke all on table public.roster_lock_snapshots,
  public.fantasy_transfers,
  public.fantasy_player_ownership
  from anon, authenticated;
grant select on table public.roster_lock_snapshots,
  public.fantasy_transfers,
  public.fantasy_player_ownership
  to authenticated;

create policy "Managers can read their roster lock result"
  on public.roster_lock_snapshots for select to authenticated
  using (
    exists (
      select 1
      from public.fantasy_teams t
      join public.league_members m
        on m.league_id = t.league_id and m.user_id = t.user_id
      where t.id = team_id
        and t.user_id = (select auth.uid())
        and m.status = 'active'
    )
  );

create policy "Managers can read their active team's transfers"
  on public.fantasy_transfers for select to authenticated
  using (
    exists (
      select 1
      from public.fantasy_teams t
      join public.league_members m
        on m.league_id = t.league_id and m.user_id = t.user_id
      where t.id = team_id
        and t.user_id = (select auth.uid())
        and m.status = 'active'
    )
  );

create policy "Managers can read their active team's ownership history"
  on public.fantasy_player_ownership for select to authenticated
  using (
    exists (
      select 1
      from public.fantasy_teams t
      join public.league_members m
        on m.league_id = t.league_id and m.user_id = t.user_id
      where t.id = team_id
        and t.user_id = (select auth.uid())
        and m.status = 'active'
    )
  );

create function public.lock_rosters_for_season(p_season_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lock_at timestamptz;
begin
  select s.roster_lock_at
  into v_lock_at
  from public.catalog_seasons s
  where s.id = p_season_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'Season not found.';
  end if;
  if clock_timestamp() < v_lock_at then
    raise exception using errcode = '55000', message = 'The season has not reached roster lock.';
  end if;
  if not exists (
    select 1
    from public.fantasy_teams t
    join public.leagues l on l.id = t.league_id
    where l.season_id = p_season_id
      and not exists (
        select 1
        from public.roster_lock_snapshots s
        where s.team_id = t.id
      )
  ) then
    return;
  end if;

  with roster_facts as (
    select
      t.id as team_id,
      t.league_id,
      l.roster_size,
      l.budget,
      s.id as season_id,
      s.roster_lock_at,
      count(r.player_id)::integer as player_count,
      count(r.player_id) filter (where p.position = 'F')::integer as forwards,
      count(r.player_id) filter (where p.position = 'D')::integer as defence,
      count(r.player_id) filter (where p.position = 'G')::integer as goalies,
      count(r.player_id) filter (
        where p.id is null
          or not p.active
          or a.player_id is null
          or a.status <> 'ready'
          or c.tier is null
      )::integer as unavailable_count,
      coalesce(sum(c.cost), 0)::numeric(12, 2) as total_cost,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'player_id', r.player_id,
            'name', p.name,
            'position', p.position,
            'team_name', p.team_name,
            'tier', coalesce(a.tier_override, a.tier),
            'cost', c.cost
          )
          order by p.name, r.player_id
        ) filter (where r.player_id is not null),
        '[]'::jsonb
      ) as roster
    from public.fantasy_teams t
    join public.leagues l on l.id = t.league_id
    join public.catalog_seasons s on s.id = l.season_id
    left join public.fantasy_roster_players r on r.team_id = t.id
    left join public.players p on p.id = r.player_id
    left join public.player_season_assignments a
      on a.season_id = s.id and a.player_id = r.player_id
    left join public.tier_costs c
      on c.season_id = s.id
      and c.tier = coalesce(a.tier_override, a.tier)
    where s.id = p_season_id
    group by t.id, t.league_id, l.roster_size, l.budget, s.id, s.roster_lock_at
  ),
  assessed as (
    select
      f.*,
      array_remove(array[
        case when f.player_count <> f.roster_size
          then format(
            'Roster must contain exactly %s players (found %s).',
            f.roster_size,
            f.player_count
          )
        end,
        case when f.unavailable_count > 0
          then 'One or more selected players were inactive, unreviewed, or missing a tier cost.'
        end,
        case when f.forwards < 3 or f.defence < 2 or f.goalies < 1
          then 'Roster must include at least 3 forwards, 2 defence players, and 1 goalie.'
        end,
        case when f.total_cost > f.budget
          then 'Roster exceeded the league budget.'
        end
      ], null) as reasons
    from roster_facts f
  ),
  inserted as (
    insert into public.roster_lock_snapshots (
      team_id, season_id, eligible, ineligible_reasons, roster, locked_at
    )
    select
      a.team_id,
      a.season_id,
      cardinality(a.reasons) = 0,
      a.reasons,
      a.roster,
      a.roster_lock_at
    from assessed a
    on conflict (team_id) do nothing
    returning team_id
  )
  insert into public.fantasy_player_ownership (
    team_id, player_id, valid_from
  )
  select r.team_id, r.player_id, s.roster_lock_at
  from inserted i
  join public.fantasy_roster_players r on r.team_id = i.team_id
  join public.roster_lock_snapshots snapshot
    on snapshot.team_id = i.team_id and snapshot.eligible
  join public.fantasy_teams t on t.id = r.team_id
  join public.leagues l on l.id = t.league_id
  join public.catalog_seasons s on s.id = l.season_id;
end;
$$;

create function public.apply_due_fantasy_transfers(p_team_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transfer public.fantasy_transfers%rowtype;
begin
  for v_transfer in
    select *
    from public.fantasy_transfers
    where team_id = p_team_id
      and status = 'pending'
      and effective_at <= clock_timestamp()
    order by effective_at, confirmed_at, id
    for update
  loop
    delete from public.fantasy_roster_players
    where team_id = p_team_id
      and player_id = v_transfer.outgoing_player_id;

    if not found then
      raise exception using errcode = '23514', message = 'The pending transfer no longer matches the saved roster.';
    end if;

    insert into public.fantasy_roster_players (team_id, player_id)
    values (p_team_id, v_transfer.incoming_player_id);

    update public.fantasy_player_ownership
    set valid_until = v_transfer.effective_at
    where team_id = p_team_id
      and player_id = v_transfer.outgoing_player_id
      and valid_until is null;

    if not found then
      raise exception using errcode = '23514', message = 'The outgoing player has no active ownership interval.';
    end if;

    insert into public.fantasy_player_ownership (
      team_id, player_id, valid_from
    )
    values (
      p_team_id, v_transfer.incoming_player_id, v_transfer.effective_at
    );

    update public.fantasy_transfers
    set status = 'effective'
    where id = v_transfer.id;
  end loop;
end;
$$;

create function public.request_fantasy_transfer(
  p_team_id uuid,
  p_outgoing_player_id text,
  p_incoming_player_id text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_season_id text;
  v_roster_lock_at timestamptz;
  v_eligible boolean;
  v_month_start date;
  v_monthly_count integer;
  v_effective_at timestamptz;
  v_now timestamptz;
  v_transfer_id uuid;
  v_player_count integer;
  v_forwards integer;
  v_defence integer;
  v_goalies integer;
  v_total_cost numeric(12, 2);
  v_budget numeric(10, 2);
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Sign-in is required.';
  end if;
  if p_outgoing_player_id is null or btrim(p_outgoing_player_id) = ''
    or p_incoming_player_id is null or btrim(p_incoming_player_id) = ''
    or p_outgoing_player_id = p_incoming_player_id then
    raise exception using errcode = '22023', message = 'Choose two different players.';
  end if;

  select l.season_id, s.roster_lock_at, l.budget
  into v_season_id, v_roster_lock_at, v_budget
  from public.fantasy_teams t
  join public.leagues l on l.id = t.league_id
  join public.league_members m
    on m.league_id = t.league_id and m.user_id = t.user_id
  join public.catalog_seasons s on s.id = l.season_id
  where t.id = p_team_id
    and t.user_id = v_user_id
    and m.status = 'active'
  for update of t;

  if not found then
    raise exception using errcode = '42501', message = 'Active team access required.';
  end if;

  perform public.apply_due_fantasy_transfers(p_team_id);

  if clock_timestamp() < v_roster_lock_at then
    raise exception using errcode = '55000', message = 'Transfers open after the global roster lock.';
  end if;

  perform public.lock_rosters_for_season(v_season_id);

  select eligible into v_eligible
  from public.roster_lock_snapshots
  where team_id = p_team_id;
  if v_eligible is distinct from true then
    raise exception using errcode = '55000', message = 'Only a roster eligible at lock can make transfers.';
  end if;

  if exists (
    select 1 from public.fantasy_transfers
    where team_id = p_team_id and status = 'pending'
  ) then
    raise exception using errcode = '55000', message = 'A transfer is already pending for this team.';
  end if;

  if not exists (
    select 1
    from public.fantasy_roster_players
    where team_id = p_team_id and player_id = p_outgoing_player_id
  ) then
    raise exception using errcode = '22023', message = 'The outgoing player is not on your current roster.';
  end if;
  if exists (
    select 1
    from public.fantasy_roster_players
    where team_id = p_team_id and player_id = p_incoming_player_id
  ) then
    raise exception using errcode = '22023', message = 'The incoming player is already on your current roster.';
  end if;

  select
    count(*)::integer,
    count(*) filter (where p.position = 'F')::integer,
    count(*) filter (where p.position = 'D')::integer,
    count(*) filter (where p.position = 'G')::integer,
    coalesce(sum(c.cost), 0)::numeric(12, 2)
  into v_player_count, v_forwards, v_defence, v_goalies, v_total_cost
  from (
    select r.player_id
    from public.fantasy_roster_players r
    where r.team_id = p_team_id and r.player_id <> p_outgoing_player_id
    union all
    select p_incoming_player_id
  ) roster
  join public.players p on p.id = roster.player_id and p.active
  join public.player_season_assignments a
    on a.season_id = v_season_id
    and a.player_id = p.id
    and a.status = 'ready'
  join public.tier_costs c
    on c.season_id = v_season_id
    and c.tier = coalesce(a.tier_override, a.tier);

  if v_player_count <> (
    select l.roster_size
    from public.fantasy_teams t
    join public.leagues l on l.id = t.league_id
    where t.id = p_team_id
  ) then
    raise exception using errcode = '22023', message = 'The transfer includes an unavailable player.';
  end if;
  if v_forwards < 3 then
    raise exception using errcode = '22023', message = 'The transfer would leave fewer than 3 forwards.';
  end if;
  if v_defence < 2 then
    raise exception using errcode = '22023', message = 'The transfer would leave fewer than 2 defence players.';
  end if;
  if v_goalies < 1 then
    raise exception using errcode = '22023', message = 'The transfer would leave no goalie.';
  end if;
  if v_total_cost > v_budget then
    raise exception using errcode = '22023', message = 'The transfer would exceed the league budget.';
  end if;

  v_now := clock_timestamp();
  v_month_start := public.phase6_eastern_month_start(v_now);
  select count(*)::integer into v_monthly_count
  from public.fantasy_transfers
  where team_id = p_team_id
    and confirmation_month = v_month_start
    and status <> 'cancelled';
  if v_monthly_count >= 3 then
    raise exception using errcode = '54000', message = 'The monthly transfer limit has been reached.';
  end if;

  v_effective_at := public.phase6_next_eastern_midnight(v_now);

  insert into public.fantasy_transfers (
    team_id,
    outgoing_player_id,
    incoming_player_id,
    confirmed_at,
    confirmation_month,
    effective_at
  )
  values (
    p_team_id,
    p_outgoing_player_id,
    p_incoming_player_id,
    v_now,
    v_month_start,
    v_effective_at
  )
  returning id into v_transfer_id;

  return v_transfer_id;
end;
$$;

create function public.cancel_fantasy_transfer(
  p_team_id uuid,
  p_transfer_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_status text;
  v_effective_at timestamptz;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Sign-in is required.';
  end if;

  perform 1
  from public.fantasy_teams t
  join public.league_members m
    on m.league_id = t.league_id and m.user_id = t.user_id
  where t.id = p_team_id
    and t.user_id = v_user_id
    and m.status = 'active'
  for update of t;
  if not found then
    raise exception using errcode = '42501', message = 'Active team access required.';
  end if;

  perform public.apply_due_fantasy_transfers(p_team_id);

  select status, effective_at
  into v_status, v_effective_at
  from public.fantasy_transfers
  where id = p_transfer_id and team_id = p_team_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Pending transfer not found.';
  end if;
  if v_status = 'cancelled' then
    return;
  end if;
  if v_status <> 'pending' or v_effective_at <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'A transfer cannot be cancelled after its effective time.';
  end if;

  update public.fantasy_transfers
  set status = 'cancelled', cancelled_at = clock_timestamp()
  where id = p_transfer_id;
end;
$$;

create function public.get_my_transfer_state(p_team_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_season_id text;
  v_league_id uuid;
  v_roster_lock_at timestamptz;
  v_eligible boolean;
  v_reasons text[];
  v_month_start date;
begin
  select l.season_id, l.id, s.roster_lock_at
  into v_season_id, v_league_id, v_roster_lock_at
  from public.fantasy_teams t
  join public.leagues l on l.id = t.league_id
  join public.league_members m
    on m.league_id = t.league_id and m.user_id = t.user_id
  join public.catalog_seasons s on s.id = l.season_id
  where t.id = p_team_id
    and t.user_id = (select auth.uid())
    and m.status = 'active';
  if not found then
    raise exception using errcode = '42501', message = 'Active team access required.';
  end if;

  perform 1 from public.fantasy_teams where id = p_team_id for update;
  perform public.apply_due_fantasy_transfers(p_team_id);
  if clock_timestamp() >= v_roster_lock_at then
    perform public.lock_rosters_for_season(v_season_id);
  end if;

  select eligible, ineligible_reasons
  into v_eligible, v_reasons
  from public.roster_lock_snapshots
  where team_id = p_team_id;

  v_month_start := public.phase6_eastern_month_start(clock_timestamp());

  return jsonb_build_object(
    'locked', clock_timestamp() >= v_roster_lock_at,
    'server_now', clock_timestamp(),
    'roster_lock_at', v_roster_lock_at,
    'next_effective_at', public.phase6_next_eastern_midnight(clock_timestamp()),
    'eligible', v_eligible,
    'ineligible_reasons', coalesce(to_jsonb(v_reasons), '[]'::jsonb),
    'player_ids', coalesce((
      select jsonb_agg(r.player_id order by p.name, r.player_id)
      from public.fantasy_roster_players r
      join public.players p on p.id = r.player_id
      where r.team_id = p_team_id
    ), '[]'::jsonb),
    'used_this_month', (
      select count(*)::integer
      from public.fantasy_transfers x
      where x.team_id = p_team_id
        and x.confirmation_month = v_month_start
        and x.status <> 'cancelled'
    ),
    'monthly_limit', 3,
    'pending', (
      select jsonb_build_object(
        'id', x.id,
        'outgoing_player_id', x.outgoing_player_id,
        'incoming_player_id', x.incoming_player_id,
        'confirmed_at', x.confirmed_at,
        'effective_at', x.effective_at,
        'status', x.status
      )
      from public.fantasy_transfers x
      where x.team_id = p_team_id and x.status = 'pending'
    ),
    'history', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', x.id,
          'outgoing_player_id', x.outgoing_player_id,
          'incoming_player_id', x.incoming_player_id,
          'confirmed_at', x.confirmed_at,
          'effective_at', x.effective_at,
          'status', x.status,
          'cancelled_at', x.cancelled_at
        )
        order by x.confirmed_at desc
      )
      from public.fantasy_transfers x
      where x.team_id = p_team_id
    ), '[]'::jsonb)
  );
end;
$$;

create function public.get_league_roster_lock_status(p_league_id uuid)
returns table (
  team_id uuid,
  manager_name text,
  eligible boolean,
  ineligible_reasons text[],
  locked_at timestamptz
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
  select
    t.id,
    coalesce(p.display_name, 'Manager'),
    s.eligible,
    case when t.user_id = (select auth.uid())
      then s.ineligible_reasons
      else '{}'::text[]
    end,
    s.locked_at
  from public.fantasy_teams t
  join public.league_members m
    on m.league_id = t.league_id and m.user_id = t.user_id
  join public.roster_lock_snapshots s on s.team_id = t.id
  left join public.profiles p on p.id = t.user_id
  where t.league_id = p_league_id
    and m.status = 'active'
  order by coalesce(p.display_name, 'Manager'), t.id;
end;
$$;

create function public.process_phase6_scheduled_events()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_season_id text;
  v_team_id uuid;
begin
  if not pg_try_advisory_xact_lock(7436385621942) then
    return;
  end if;

  for v_season_id in
    select id
    from public.catalog_seasons
    where roster_lock_at <= clock_timestamp()
  loop
    perform public.lock_rosters_for_season(v_season_id);
  end loop;

  for v_team_id in
    select distinct x.team_id
    from public.fantasy_transfers x
    where x.status = 'pending'
      and x.effective_at <= clock_timestamp()
  loop
    perform 1
    from public.fantasy_teams t
    where t.id = v_team_id
    for update;
    if found then
      perform public.apply_due_fantasy_transfers(v_team_id);
    end if;
  end loop;
end;
$$;

revoke all on function public.lock_rosters_for_season(text)
  from public, anon, authenticated;
revoke all on function public.apply_due_fantasy_transfers(uuid)
  from public, anon, authenticated;
revoke all on function public.process_phase6_scheduled_events()
  from public, anon, authenticated;
revoke all on function public.phase6_next_eastern_midnight(timestamptz)
  from public, anon, authenticated;
revoke all on function public.phase6_eastern_month_start(timestamptz)
  from public, anon, authenticated;
grant execute on function public.phase6_next_eastern_midnight(timestamptz)
  to authenticated;
grant execute on function public.phase6_eastern_month_start(timestamptz)
  to authenticated;
grant execute on function public.process_phase6_scheduled_events()
  to postgres;

revoke all on function public.request_fantasy_transfer(uuid, text, text)
  from public, anon;
grant execute on function public.request_fantasy_transfer(uuid, text, text)
  to authenticated;
revoke all on function public.cancel_fantasy_transfer(uuid, uuid)
  from public, anon;
grant execute on function public.cancel_fantasy_transfer(uuid, uuid)
  to authenticated;
revoke all on function public.get_my_transfer_state(uuid)
  from public, anon;
grant execute on function public.get_my_transfer_state(uuid)
  to authenticated;
revoke all on function public.get_league_roster_lock_status(uuid)
  from public, anon;
grant execute on function public.get_league_roster_lock_status(uuid)
  to authenticated;

create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule(
  'pwhl-fantasy-phase6-events',
  '* * * * *',
  'select public.process_phase6_scheduled_events();'
);
