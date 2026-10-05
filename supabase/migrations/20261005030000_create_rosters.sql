create table public.fantasy_roster_players (
  team_id uuid not null references public.fantasy_teams (id) on delete cascade,
  player_id text not null references public.players (id),
  added_at timestamptz not null default now(),
  primary key (team_id, player_id)
);

create index fantasy_roster_players_player_idx
  on public.fantasy_roster_players (player_id);

alter table public.fantasy_roster_players enable row level security;
revoke all on table public.fantasy_roster_players from anon, authenticated;
grant select on table public.fantasy_roster_players to authenticated;

create policy "Managers can read their active team's roster"
  on public.fantasy_roster_players for select to authenticated
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

create function public.save_fantasy_roster(
  p_team_id uuid,
  p_player_ids text[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_season_id text;
  v_roster_size integer;
  v_budget numeric(10, 2);
  v_lock_at timestamptz;
  v_player_count integer;
  v_forward_count integer;
  v_defence_count integer;
  v_goalie_count integer;
  v_total_cost numeric(12, 2);
begin
  if p_player_ids is null then
    raise exception using errcode = '22023', message = 'Choose players for the roster.';
  end if;

  select l.season_id, l.roster_size, l.budget, s.roster_lock_at
  into v_season_id, v_roster_size, v_budget, v_lock_at
  from public.fantasy_teams t
  join public.leagues l on l.id = t.league_id
  join public.league_members m
    on m.league_id = t.league_id and m.user_id = t.user_id
  join public.catalog_seasons s on s.id = l.season_id
  where t.id = p_team_id
    and t.user_id = (select auth.uid())
    and m.status = 'active'
  for update of t, s;

  if not found then
    raise exception using errcode = '42501', message = 'Active team access required.';
  end if;
  if clock_timestamp() >= v_lock_at then
    raise exception using errcode = '55000', message = 'Roster changes are closed at the season lock.';
  end if;
  if cardinality(p_player_ids) <> v_roster_size then
    raise exception using errcode = '22023', message = 'Select exactly the required number of players.';
  end if;
  if exists (
    select 1 from unnest(p_player_ids) as selected(player_id)
    where selected.player_id is null or btrim(selected.player_id) = ''
  ) or cardinality(p_player_ids) <> (
    select count(distinct selected.player_id)
    from unnest(p_player_ids) as selected(player_id)
  ) then
    raise exception using errcode = '22023', message = 'A roster cannot contain blank or duplicate players.';
  end if;

  select
    count(*)::integer,
    count(*) filter (where p.position = 'F')::integer,
    count(*) filter (where p.position = 'D')::integer,
    count(*) filter (where p.position = 'G')::integer,
    coalesce(sum(c.cost), 0)::numeric(12, 2)
  into
    v_player_count,
    v_forward_count,
    v_defence_count,
    v_goalie_count,
    v_total_cost
  from unnest(p_player_ids) as selected(player_id)
  join public.players p
    on p.id = selected.player_id and p.active
  join public.player_season_assignments a
    on a.season_id = v_season_id
    and a.player_id = p.id
    and a.status = 'ready'
  join public.tier_costs c
    on c.season_id = a.season_id
    and c.tier = coalesce(a.tier_override, a.tier);

  if v_player_count <> v_roster_size then
    raise exception using errcode = '22023', message = 'One or more selected players are unavailable or need catalog review.';
  end if;
  if v_forward_count < 3 or v_defence_count < 2 or v_goalie_count < 1 then
    raise exception using errcode = '22023', message = 'The roster needs at least 3 forwards, 2 defence, and 1 goalie.';
  end if;
  if v_total_cost > v_budget then
    raise exception using errcode = '22023', message = 'The roster exceeds the league budget.';
  end if;

  delete from public.fantasy_roster_players
  where team_id = p_team_id;

  insert into public.fantasy_roster_players (team_id, player_id)
  select p_team_id, selected.player_id
  from unnest(p_player_ids) as selected(player_id);
end;
$$;

revoke all on function public.save_fantasy_roster(uuid, text[])
  from public, anon;
grant execute on function public.save_fantasy_roster(uuid, text[])
  to authenticated;
