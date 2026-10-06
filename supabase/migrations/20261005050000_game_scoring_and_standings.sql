alter table public.catalog_seasons
  add column regular_season_schedule_complete boolean not null default false;

create table public.season_games (
  id bigint generated always as identity primary key,
  season_id text not null references public.catalog_seasons (id) on delete cascade,
  source_game_id text not null check (char_length(source_game_id) between 1 and 80),
  starts_at timestamptz not null,
  game_type text not null check (game_type in ('regular', 'playoff')),
  source_status integer not null,
  source_final boolean not null,
  source_payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(source_payload) = 'object'),
  imported_at timestamptz not null default now(),
  unique (season_id, source_game_id)
);

create index season_games_season_date_idx
  on public.season_games (season_id, starts_at);

create table public.game_import_runs (
  id bigint generated always as identity primary key,
  season_id text not null references public.catalog_seasons (id),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null check (status in ('running', 'succeeded', 'failed')),
  game_count integer not null default 0 check (game_count >= 0),
  stat_count integer not null default 0 check (stat_count >= 0),
  error_message text,
  source text not null default 'owner_upload'
);

create table public.player_game_stats (
  id bigint generated always as identity primary key,
  game_id bigint not null references public.season_games (id) on delete cascade,
  player_id text not null references public.players (id),
  stats jsonb not null check (jsonb_typeof(stats) = 'object'),
  source_payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(source_payload) = 'object'),
  import_run_id bigint not null references public.game_import_runs (id),
  imported_at timestamptz not null default now(),
  unique (game_id, player_id)
);

create table public.player_game_stat_revisions (
  id bigint generated always as identity primary key,
  game_id bigint not null references public.season_games (id) on delete cascade,
  player_id text not null references public.players (id),
  stats jsonb not null check (jsonb_typeof(stats) = 'object'),
  import_run_id bigint not null references public.game_import_runs (id),
  recorded_at timestamptz not null default now()
);

create index player_game_stat_revisions_game_idx
  on public.player_game_stat_revisions (game_id, player_id, recorded_at);

create table public.fantasy_game_scores (
  id bigint generated always as identity primary key,
  season_id text not null references public.catalog_seasons (id) on delete cascade,
  game_id bigint not null references public.season_games (id) on delete cascade,
  stat_id bigint not null references public.player_game_stats (id) on delete cascade,
  ownership_id bigint not null references public.fantasy_player_ownership (id),
  team_id uuid not null references public.fantasy_teams (id) on delete cascade,
  player_id text not null references public.players (id),
  scoring_version integer not null,
  points numeric(14, 4) not null,
  scored_at timestamptz not null default now(),
  unique (game_id, team_id, player_id),
  foreign key (season_id, scoring_version)
    references public.scoring_rule_versions (season_id, version)
);

create index fantasy_game_scores_team_idx
  on public.fantasy_game_scores (team_id, game_id);

alter table public.season_games enable row level security;
alter table public.game_import_runs enable row level security;
alter table public.player_game_stats enable row level security;
alter table public.player_game_stat_revisions enable row level security;
alter table public.fantasy_game_scores enable row level security;

revoke all on table public.season_games,
  public.game_import_runs,
  public.player_game_stats,
  public.player_game_stat_revisions,
  public.fantasy_game_scores
  from anon, authenticated;

create function public.calculate_game_points(
  p_stats jsonb,
  p_player_type text,
  p_scoring_values jsonb
)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_field text;
  v_fields text[];
begin
  if jsonb_typeof(p_stats) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'Game statistics must be an object.';
  end if;

  if p_player_type = 'goalie' then
    v_fields := array['goals', 'assists', 'wins', 'shutouts', 'saves', 'goals_against'];
  elsif p_player_type = 'skater' then
    v_fields := array[
      'goals', 'assists', 'shots', 'short_handed_goals',
      'short_handed_assists', 'blocked_shots', 'hits', 'plus_minus'
    ];
  else
    raise exception using errcode = '22023', message = 'Unsupported player type.';
  end if;

  foreach v_field in array v_fields loop
    if jsonb_typeof(p_stats -> v_field) is distinct from 'number' then
      raise exception using errcode = '22023', message = 'Missing numeric game statistic: ' || v_field;
    end if;
  end loop;

  if p_player_type = 'goalie' then
    return
      (p_stats ->> 'goals')::numeric * (p_scoring_values ->> 'goalie_goal')::numeric +
      (p_stats ->> 'assists')::numeric * (p_scoring_values ->> 'goalie_assist')::numeric +
      (p_stats ->> 'wins')::numeric * (p_scoring_values ->> 'goalie_win')::numeric +
      (p_stats ->> 'shutouts')::numeric * (p_scoring_values ->> 'goalie_shutout')::numeric +
      (p_stats ->> 'saves')::numeric * (p_scoring_values ->> 'goalie_save')::numeric +
      (p_stats ->> 'goals_against')::numeric * (p_scoring_values ->> 'goalie_goal_against')::numeric;
  end if;

  return
    (p_stats ->> 'goals')::numeric * (p_scoring_values ->> 'skater_goal')::numeric +
    (p_stats ->> 'assists')::numeric * (p_scoring_values ->> 'skater_assist')::numeric +
    (p_stats ->> 'shots')::numeric * (p_scoring_values ->> 'skater_shot')::numeric +
    (p_stats ->> 'short_handed_goals')::numeric * (p_scoring_values ->> 'skater_short_handed_goal')::numeric +
    (p_stats ->> 'short_handed_assists')::numeric * (p_scoring_values ->> 'skater_short_handed_assist')::numeric +
    (p_stats ->> 'blocked_shots')::numeric * (p_scoring_values ->> 'skater_blocked_shot')::numeric +
    (p_stats ->> 'hits')::numeric * (p_scoring_values ->> 'skater_hit')::numeric +
    (p_stats ->> 'plus_minus')::numeric * (p_scoring_values ->> 'skater_plus_minus')::numeric;
end;
$$;

create function public.refresh_fantasy_game_scores(
  p_season_id text,
  p_game_ids bigint[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scoring_version integer;
  v_scoring_values jsonb;
begin
  select s.scoring_version, rules.scoring_values
  into v_scoring_version, v_scoring_values
  from public.catalog_seasons s
  join public.scoring_rule_versions rules
    on rules.season_id = s.id and rules.version = s.scoring_version
  where s.id = p_season_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Season not found.';
  end if;

  delete from public.fantasy_game_scores score
  using public.season_games game
  where score.game_id = game.id
    and game.season_id = p_season_id
    and (p_game_ids is null or game.id = any(p_game_ids));

  insert into public.fantasy_game_scores (
    season_id, game_id, stat_id, ownership_id, team_id, player_id,
    scoring_version, points
  )
  select
    p_season_id,
    game.id,
    stat.id,
    ownership.id,
    ownership.team_id,
    stat.player_id,
    v_scoring_version,
    public.calculate_game_points(stat.stats, player.player_type, v_scoring_values)
  from public.season_games game
  join public.player_game_stats stat on stat.game_id = game.id
  join public.players player on player.id = stat.player_id
  join public.fantasy_player_ownership ownership
    on ownership.player_id = stat.player_id
    and ownership.valid_from <= (
      date_trunc('day', timezone('America/New_York', game.starts_at))
        at time zone 'America/New_York'
    )
    and (
      ownership.valid_until is null
      or ownership.valid_until > (
        date_trunc('day', timezone('America/New_York', game.starts_at))
          at time zone 'America/New_York'
      )
    )
  join public.fantasy_teams team on team.id = ownership.team_id
  join public.leagues league
    on league.id = team.league_id and league.season_id = p_season_id
  where game.season_id = p_season_id
    and game.game_type = 'regular'
    and game.source_status = 4
    and game.source_final
    and (p_game_ids is null or game.id = any(p_game_ids));
end;
$$;

create function public.import_final_game_data(
  p_season_id text,
  p_games jsonb,
  p_schedule_complete boolean default false
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run_id bigint;
  v_game jsonb;
  v_stat jsonb;
  v_game_row_id bigint;
  v_game_ids bigint[] := '{}';
  v_game_count integer := 0;
  v_stat_count integer := 0;
  v_player_type text;
  v_player_id text;
  v_game_type text;
  v_status integer;
  v_final boolean;
  v_roster_lock_at timestamptz;
  v_team_id uuid;
  v_needs_roster_lock boolean;
  v_ownership_changed boolean := false;
  v_source_game_id text;
  v_stats jsonb;
  v_existing_stats jsonb;
  v_has_existing_stats boolean;
  v_imported_player_ids text[];
  v_required_fields text[];
  v_field text;
begin
  if auth.uid() is not null and not public.is_site_owner() then
    raise exception using errcode = '42501', message = 'Site-owner access required.';
  end if;
  if auth.uid() is null and coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Privileged import access required.';
  end if;
  select s.roster_lock_at into v_roster_lock_at
  from public.catalog_seasons s where s.id = p_season_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Season not found.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_season_id, 743638562));
  if jsonb_typeof(p_games) is distinct from 'array'
    or jsonb_array_length(p_games) < 1
    or jsonb_array_length(p_games) > 100 then
    raise exception using errcode = '22023', message = 'Import must contain 1–100 games.';
  end if;
  if (
    select count(*) <> count(distinct coalesce(item ->> 'gameId', item ->> 'game_id'))
    from jsonb_array_elements(p_games) item
  ) then
    raise exception using errcode = '22023', message = 'Import contains duplicate game IDs.';
  end if;

  for v_game in select value from jsonb_array_elements(p_games) loop
    v_source_game_id := coalesce(v_game ->> 'gameId', v_game ->> 'game_id');
    v_game_type := coalesce(v_game ->> 'gameType', v_game ->> 'game_type');
    if v_source_game_id is null or char_length(v_source_game_id) not between 1 and 80
      or v_game_type not in ('regular', 'playoff')
      or not (v_game ? 'startsAt' or v_game ? 'starts_at')
      or not (v_game ? 'status')
      or not (v_game ? 'final')
      or jsonb_typeof(v_game -> 'stats') is distinct from 'array' then
      raise exception using errcode = '22023', message = 'Import contains an invalid game record.';
    end if;
    v_status := (v_game ->> 'status')::integer;
    v_final := (v_game ->> 'final')::boolean;
    if v_status is null or v_final is null or v_status not between 1 and 4
      or (v_status in (1, 2) and v_final)
      or (v_status = 4 and not v_final) then
      raise exception using errcode = '22023', message = 'Game has an unknown or contradictory status.';
    end if;
    if v_status = 4 and v_final and jsonb_array_length(v_game -> 'stats') = 0 then
      raise exception using errcode = '22023', message = 'Official final games require player statistics.';
    end if;
    if v_status = 4 and v_final then
      if (
        select count(*) <> count(distinct coalesce(item ->> 'playerId', item ->> 'player_id'))
        from jsonb_array_elements(v_game -> 'stats') item
      ) then
        raise exception using errcode = '22023', message = 'Game contains duplicate player statistics.';
      end if;

      for v_stat in select value from jsonb_array_elements(v_game -> 'stats') loop
        v_player_id := coalesce(v_stat ->> 'playerId', v_stat ->> 'player_id');
        v_stats := v_stat -> 'stats';
        select p.player_type into v_player_type
        from public.players p where p.id = v_player_id;
        if not found or v_stats is null or jsonb_typeof(v_stats) <> 'object'
          or v_player_type is distinct from (v_stat ->> 'playerType') then
          raise exception using errcode = '22023', message = 'Game stats reference an unknown player or invalid player type.';
        end if;
        if v_player_type = 'goalie' then
          v_required_fields := array['goals', 'assists', 'wins', 'shutouts', 'saves', 'goals_against'];
        else
          v_required_fields := array[
            'goals', 'assists', 'shots', 'short_handed_goals',
            'short_handed_assists', 'blocked_shots', 'hits', 'plus_minus'
          ];
        end if;
        foreach v_field in array v_required_fields loop
          if jsonb_typeof(v_stats -> v_field) is distinct from 'number' then
            raise exception using errcode = '22023', message = 'Missing numeric game statistic: ' || v_field;
          end if;
        end loop;
      end loop;
    end if;
  end loop;

  insert into public.game_import_runs (season_id, status, source)
  values (p_season_id, 'running',
    case when auth.role() = 'service_role' then 'scheduled' else 'owner_upload' end)
  returning id into v_run_id;

  for v_game in select value from jsonb_array_elements(p_games) loop
    v_source_game_id := coalesce(v_game ->> 'gameId', v_game ->> 'game_id');
    insert into public.season_games (
      season_id, source_game_id, starts_at, game_type,
      source_status, source_final, source_payload, imported_at
    )
    values (
      p_season_id,
      v_source_game_id,
      coalesce(v_game ->> 'startsAt', v_game ->> 'starts_at')::timestamptz,
      coalesce(v_game ->> 'gameType', v_game ->> 'game_type'),
      (v_game ->> 'status')::integer,
      (v_game ->> 'final')::boolean,
      coalesce(v_game -> 'sourcePayload', v_game -> 'source_payload', v_game - 'stats'),
      now()
    )
    on conflict (season_id, source_game_id) do update set
      starts_at = excluded.starts_at,
      game_type = excluded.game_type,
      source_status = excluded.source_status,
      source_final = excluded.source_final,
      source_payload = excluded.source_payload,
      imported_at = excluded.imported_at
    returning id into v_game_row_id;

    v_game_ids := array_append(v_game_ids, v_game_row_id);
    v_game_count := v_game_count + 1;
    if (v_game ->> 'status')::integer = 4 and (v_game ->> 'final')::boolean then
      v_imported_player_ids := '{}';
      for v_stat in select value from jsonb_array_elements(v_game -> 'stats') loop
        v_player_id := coalesce(v_stat ->> 'playerId', v_stat ->> 'player_id');
        v_stats := v_stat -> 'stats';
        select current_stats.stats
        into v_existing_stats
        from public.player_game_stats current_stats
        where current_stats.game_id = v_game_row_id
          and current_stats.player_id = v_player_id;
        v_has_existing_stats := found;
        if not v_has_existing_stats or v_existing_stats is distinct from v_stats then
          insert into public.player_game_stat_revisions (
            game_id, player_id, stats, import_run_id
          )
          values (v_game_row_id, v_player_id, v_stats, v_run_id);
        end if;
        insert into public.player_game_stats as current_stat (
          game_id, player_id, stats, source_payload, import_run_id
        )
        values (
          v_game_row_id, v_player_id, v_stats,
          coalesce(v_stat -> 'sourcePayload', v_stat -> 'source_payload', v_stat),
          v_run_id
        )
        on conflict (game_id, player_id) do update set
          stats = excluded.stats,
          source_payload = excluded.source_payload,
          import_run_id = excluded.import_run_id,
          imported_at = now()
        where current_stat.stats is distinct from excluded.stats
          or current_stat.source_payload is distinct from excluded.source_payload;
        v_imported_player_ids := array_append(v_imported_player_ids, v_player_id);
        v_stat_count := v_stat_count + 1;
      end loop;
      delete from public.player_game_stats current_stats
      where current_stats.game_id = v_game_row_id
        and not (current_stats.player_id = any(v_imported_player_ids));
    else
      delete from public.player_game_stats where game_id = v_game_row_id;
    end if;
  end loop;

  if clock_timestamp() >= v_roster_lock_at then
    select exists (
      select 1
      from public.fantasy_teams t
      join public.leagues l on l.id = t.league_id
      where l.season_id = p_season_id
        and not exists (
          select 1 from public.roster_lock_snapshots snapshot
          where snapshot.team_id = t.id
        )
    )
    into v_needs_roster_lock;
    perform public.lock_rosters_for_season(p_season_id);
    v_ownership_changed := v_needs_roster_lock;

    for v_team_id in
      select distinct team.id
      from public.fantasy_transfers transfer
      join public.fantasy_teams team on team.id = transfer.team_id
      join public.leagues league on league.id = team.league_id
      where league.season_id = p_season_id
        and transfer.status = 'pending'
        and transfer.effective_at <= clock_timestamp()
      order by team.id
    loop
      perform 1 from public.fantasy_teams team
      where team.id = v_team_id
      for update;
      if found then
        perform public.apply_due_fantasy_transfers(v_team_id);
        v_ownership_changed := true;
      end if;
    end loop;
  end if;

  if v_ownership_changed then
    perform public.refresh_fantasy_game_scores(p_season_id, null);
  else
    perform public.refresh_fantasy_game_scores(p_season_id, v_game_ids);
  end if;
  update public.catalog_seasons
  set regular_season_schedule_complete =
    regular_season_schedule_complete or p_schedule_complete
  where id = p_season_id;
  update public.game_import_runs
  set status = 'succeeded',
      completed_at = now(),
      game_count = v_game_count,
      stat_count = v_stat_count
  where id = v_run_id;
  return v_run_id;
end;
$$;

create function public.record_game_import_failure(
  p_season_id text,
  p_error_message text,
  p_source text default 'owner_upload'
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run_id bigint;
begin
  if auth.uid() is not null and not public.is_site_owner() then
    raise exception using errcode = '42501', message = 'Site-owner access required.';
  end if;
  if auth.uid() is null and coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Privileged import access required.';
  end if;
  if p_error_message is null or btrim(p_error_message) = '' then
    raise exception using errcode = '22023', message = 'Import error details are required.';
  end if;
  insert into public.game_import_runs (
    season_id, status, completed_at, error_message, source
  )
  values (
    p_season_id, 'failed', now(), left(p_error_message, 4000),
    coalesce(nullif(p_source, ''), 'owner_upload')
  )
  returning id into v_run_id;
  return v_run_id;
end;
$$;

create function public.get_game_import_runs(p_season_id text)
returns table (
  id bigint,
  started_at timestamptz,
  completed_at timestamptz,
  status text,
  game_count integer,
  stat_count integer,
  error_message text,
  source text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_site_owner() then
    raise exception using errcode = '42501', message = 'Site-owner access required.';
  end if;
  return query
  select r.id, r.started_at, r.completed_at, r.status,
    r.game_count, r.stat_count, r.error_message, r.source
  from public.game_import_runs r
  where r.season_id = p_season_id
  order by r.started_at desc
  limit 20;
end;
$$;

create function public.get_league_standings(p_league_id uuid)
returns table (
  team_id uuid,
  manager_name text,
  points numeric,
  games_played integer,
  standing_rank integer,
  is_winner boolean,
  season_complete boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_season_id text;
  v_season_complete boolean;
begin
  if not public.is_active_league_member(p_league_id) then
    raise exception using errcode = '42501', message = 'Active league membership required.';
  end if;
  select l.season_id into v_season_id
  from public.leagues l where l.id = p_league_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'League not found.';
  end if;
  select
    s.regular_season_schedule_complete
    and exists (
      select 1 from public.season_games g
      where g.season_id = v_season_id and g.game_type = 'regular'
    )
    and not exists (
      select 1 from public.season_games g
      where g.season_id = v_season_id
        and g.game_type = 'regular'
        and (g.source_status <> 4 or not g.source_final)
    )
  into v_season_complete
  from public.catalog_seasons s
  where s.id = v_season_id;

  return query
  with totals as (
    select
      t.id as team_id,
      coalesce(p.display_name, 'Manager') as manager_name,
      coalesce(sum(score.points), 0)::numeric as points,
      count(distinct score.game_id)::integer as games_played
    from public.fantasy_teams t
    join public.league_members m
      on m.league_id = t.league_id and m.user_id = t.user_id
    left join public.profiles p on p.id = t.user_id
    left join public.fantasy_game_scores score
      on score.team_id = t.id and score.season_id = v_season_id
    where t.league_id = p_league_id
      and m.status = 'active'
      and exists (
        select 1 from public.roster_lock_snapshots locked
        where locked.team_id = t.id and locked.eligible
      )
    group by t.id, p.display_name
  )
  select
    totals.team_id,
    totals.manager_name,
    totals.points,
    totals.games_played,
    dense_rank() over (order by totals.points desc)::integer,
    v_season_complete and totals.points = max(totals.points) over (),
    v_season_complete
  from totals
  order by totals.points desc, totals.manager_name, totals.team_id;
end;
$$;

revoke all on function public.calculate_game_points(jsonb, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.refresh_fantasy_game_scores(text, bigint[])
  from public, anon, authenticated;
revoke all on function public.import_final_game_data(text, jsonb, boolean)
  from public, anon;
grant execute on function public.import_final_game_data(text, jsonb, boolean)
  to authenticated, service_role;
revoke all on function public.record_game_import_failure(text, text, text)
  from public, anon;
grant execute on function public.record_game_import_failure(text, text, text)
  to authenticated, service_role;
revoke all on function public.get_game_import_runs(text)
  from public, anon;
grant execute on function public.get_game_import_runs(text)
  to authenticated;
revoke all on function public.get_league_standings(uuid)
  from public, anon;
grant execute on function public.get_league_standings(uuid)
  to authenticated;
