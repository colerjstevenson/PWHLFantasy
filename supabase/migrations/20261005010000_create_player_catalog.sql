create table public.site_owner_roles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.site_owner_roles enable row level security;
revoke all on table public.site_owner_roles from anon, authenticated;

create function public.is_site_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.site_owner_roles
    where user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_site_owner() from public, anon;
grant execute on function public.is_site_owner() to authenticated;

create table public.catalog_seasons (
  id text primary key check (char_length(id) between 1 and 40),
  name text not null check (char_length(name) between 1 and 120),
  prior_season_id text not null check (char_length(prior_season_id) between 1 and 40),
  roster_lock_at timestamptz not null,
  scoring_values jsonb not null,
  scoring_version integer not null default 1 check (scoring_version > 0),
  frozen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.scoring_rule_versions (
  season_id text not null references public.catalog_seasons (id) on delete cascade,
  version integer not null check (version > 0),
  scoring_values jsonb not null check (jsonb_typeof(scoring_values) = 'object'),
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  primary key (season_id, version)
);

create table public.players (
  id text primary key check (char_length(id) between 1 and 80),
  name text not null check (char_length(name) between 1 and 160),
  team_id text,
  team_name text,
  position text not null check (position in ('F', 'D', 'G')),
  player_type text not null check (player_type in ('skater', 'goalie')),
  active boolean not null default true,
  source_updated_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((position = 'G') = (player_type = 'goalie'))
);

create table public.tier_costs (
  season_id text not null references public.catalog_seasons (id) on delete cascade,
  tier smallint not null check (tier between 1 and 5),
  cost numeric(10, 2) not null check (cost >= 0),
  updated_at timestamptz not null default now(),
  primary key (season_id, tier)
);

create table public.player_season_assignments (
  season_id text not null references public.catalog_seasons (id) on delete cascade,
  player_id text not null references public.players (id) on delete cascade,
  stats jsonb not null default '{}'::jsonb check (jsonb_typeof(stats) = 'object'),
  stats_complete boolean not null default false,
  calculated_projection numeric(12, 2),
  projection_override numeric(12, 2),
  tier smallint check (tier between 1 and 5),
  tier_override smallint check (tier_override between 1 and 5),
  status text not null default 'needs_review'
    check (status in ('ready', 'needs_review')),
  scoring_version integer not null,
  updated_at timestamptz not null default now(),
  primary key (season_id, player_id),
  foreign key (season_id, scoring_version)
    references public.scoring_rule_versions (season_id, version)
);

create table public.catalog_import_runs (
  id bigint generated always as identity primary key,
  season_id text not null references public.catalog_seasons (id),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null check (status in ('running', 'succeeded', 'failed')),
  player_count integer not null default 0 check (player_count >= 0),
  stats_count integer not null default 0 check (stats_count >= 0),
  review_count integer not null default 0 check (review_count >= 0),
  error_message text
);

create table public.catalog_audit_events (
  id bigint generated always as identity primary key,
  season_id text references public.catalog_seasons (id),
  actor_id uuid not null references auth.users (id),
  action text not null,
  entity_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.catalog_snapshots (
  season_id text primary key references public.catalog_seasons (id),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz not null default now()
);

insert into public.catalog_seasons (
  id,
  name,
  prior_season_id,
  roster_lock_at,
  scoring_values
)
values (
  '11',
  '2026-27 Regular Season',
  '8',
  '2026-12-05 20:00:00+00',
  '{
    "skater_goal": 3,
    "skater_assist": 2,
    "skater_shot": 0.5,
    "skater_short_handed_goal": 5,
    "skater_short_handed_assist": 3,
    "skater_blocked_shot": 3,
    "skater_hit": 3,
    "skater_plus_minus": 1,
    "goalie_goal": 50,
    "goalie_assist": 25,
    "goalie_win": 5,
    "goalie_shutout": 10,
    "goalie_save": 0.25,
    "goalie_goal_against": -1
  }'::jsonb
);

insert into public.scoring_rule_versions (
  season_id, version, scoring_values
)
select id, scoring_version, scoring_values
from public.catalog_seasons;

create function public.calculate_catalog_projection(
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
  if jsonb_typeof(p_stats) <> 'object' then
    return null;
  end if;

  if p_player_type = 'goalie' then
    v_fields := array['goals', 'assists', 'wins', 'shutouts', 'saves', 'goals_against'];
  elsif p_player_type = 'skater' then
    v_fields := array[
      'goals', 'assists', 'shots', 'short_handed_goals',
      'short_handed_assists', 'blocked_shots', 'hits', 'plus_minus'
    ];
  else
    return null;
  end if;

  foreach v_field in array v_fields loop
    if jsonb_typeof(p_stats -> v_field) is distinct from 'number' then
      return null;
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

create function public.recalculate_catalog_assignments(p_season_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  with projections as (
    select
      a.player_id,
      public.calculate_catalog_projection(
        a.stats,
        p.player_type,
        s.scoring_values
      ) as projection
    from public.player_season_assignments a
    join public.players p on p.id = a.player_id
    join public.catalog_seasons s on s.id = a.season_id
    where a.season_id = p_season_id
  ),
  projection_groups as (
    select projection, count(*)::numeric as group_size
    from projections
    where projection is not null
    group by projection
  ),
  tier_ranks as (
    select
      projection,
      coalesce(
        sum(group_size) over (
          order by projection desc
          rows between unbounded preceding and 1 preceding
        ),
        0
      ) + (group_size + 1) / 2 as midrank,
      sum(group_size) over () as player_count
    from projection_groups
  ),
  automatic_tiers as (
    select
      projection,
      (1 + least(4, floor(5 * (midrank - 1) / player_count)))::smallint as tier
    from tier_ranks
  )
  update public.player_season_assignments a
  set
    calculated_projection = p.projection,
    tier = coalesce(a.tier_override, t.tier),
    status = case
      when coalesce(a.projection_override, p.projection) is not null
        and coalesce(a.tier_override, t.tier) is not null
      then 'ready'
      else 'needs_review'
    end,
    scoring_version = s.scoring_version,
    updated_at = now()
  from projections p
  join public.catalog_seasons s on s.id = p_season_id
  left join automatic_tiers t on t.projection = p.projection
  where a.season_id = p_season_id
    and a.player_id = p.player_id;
end;
$$;

create function public.assert_catalog_editable(p_season_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lock_at timestamptz;
  v_frozen_at timestamptz;
begin
  if not public.is_site_owner() then
    raise exception using errcode = '42501', message = 'Site-owner access required.';
  end if;

  select roster_lock_at, frozen_at
  into v_lock_at, v_frozen_at
  from public.catalog_seasons
  where id = p_season_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'Catalog season not found.';
  end if;
  if v_frozen_at is not null or clock_timestamp() >= v_lock_at then
    raise exception using errcode = '55000', message = 'The catalog is locked.';
  end if;
end;
$$;

create function public.guard_catalog_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_site_owner() then
    raise exception using errcode = '42501', message = 'Site-owner access required.';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create function public.guard_season_catalog_edit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_catalog_editable(
    case when tg_op = 'DELETE' then old.season_id else new.season_id end
  );
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create function public.guard_catalog_season_edit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_site_owner() then
    raise exception using errcode = '42501', message = 'Site-owner access required.';
  end if;
  if tg_op = 'UPDATE' and (
    old.frozen_at is not null or clock_timestamp() >= old.roster_lock_at
  ) then
    if old.frozen_at is null
      and new.frozen_at is not null
      and (to_jsonb(new) - 'frozen_at') = (to_jsonb(old) - 'frozen_at') then
      return new;
    end if;
    raise exception using errcode = '55000', message = 'The catalog is locked.';
  end if;
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'Catalog seasons cannot be deleted.';
  end if;
  return new;
end;
$$;

create trigger players_owner_guard
  before insert or update or delete on public.players
  for each row execute function public.guard_catalog_owner();

create trigger season_catalog_owner_guard
  before insert or update on public.catalog_seasons
  for each row execute function public.guard_catalog_season_edit();

create trigger tier_costs_owner_guard
  before insert or update or delete on public.tier_costs
  for each row execute function public.guard_season_catalog_edit();

create trigger assignments_owner_guard
  before insert or update or delete on public.player_season_assignments
  for each row execute function public.guard_season_catalog_edit();

create function public.save_catalog_configuration(
  p_season_id text,
  p_name text,
  p_prior_season_id text,
  p_roster_lock_at timestamptz,
  p_scoring_values jsonb,
  p_tier_costs jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_field text;
  v_cost_count integer;
  v_distinct_tiers integer;
  v_scoring_version integer;
begin
  if not public.is_site_owner() then
    raise exception using errcode = '42501', message = 'Site-owner access required.';
  end if;
  if p_season_id is null or btrim(p_season_id) = ''
    or p_name is null or btrim(p_name) = ''
    or p_prior_season_id is null or btrim(p_prior_season_id) = ''
    or p_roster_lock_at is null then
    raise exception using errcode = '22023', message = 'Season settings are incomplete.';
  end if;
  if jsonb_typeof(p_scoring_values) <> 'object' then
    raise exception using errcode = '22023', message = 'Scoring values must be an object.';
  end if;
  foreach v_field in array array[
    'skater_goal', 'skater_assist', 'skater_shot',
    'skater_short_handed_goal', 'skater_short_handed_assist',
    'skater_blocked_shot', 'skater_hit', 'skater_plus_minus',
    'goalie_goal', 'goalie_assist', 'goalie_win', 'goalie_shutout',
    'goalie_save', 'goalie_goal_against'
  ] loop
    if jsonb_typeof(p_scoring_values -> v_field) is distinct from 'number' then
      raise exception using errcode = '22023', message = 'A scoring value is missing or invalid: ' || v_field;
    end if;
  end loop;
  if jsonb_typeof(p_tier_costs) <> 'array'
    or jsonb_array_length(p_tier_costs) <> 5 then
    raise exception using errcode = '22023', message = 'Exactly five tier costs are required.';
  end if;

  select count(*), count(distinct (value ->> 'tier')::integer)
  into v_cost_count, v_distinct_tiers
  from jsonb_array_elements(p_tier_costs);
  if v_cost_count <> 5 or v_distinct_tiers <> 5
    or exists (
      select 1
      from jsonb_array_elements(p_tier_costs) item
      where coalesce((item ->> 'tier')::integer, 0) not between 1 and 5
        or coalesce((item ->> 'cost')::numeric, -1) < 0
        or item ->> 'cost' is null
    ) then
    raise exception using errcode = '22023', message = 'Tier costs must cover tiers 1–5 with nonnegative values.';
  end if;

  if exists (select 1 from public.catalog_seasons where id = p_season_id) then
    perform public.assert_catalog_editable(p_season_id);
    select scoring_version into v_scoring_version
    from public.catalog_seasons where id = p_season_id
    for update;
    perform public.assert_catalog_editable(p_season_id);
    if (select scoring_values from public.catalog_seasons where id = p_season_id)
      is distinct from p_scoring_values then
      v_scoring_version := v_scoring_version + 1;
    end if;
    update public.catalog_seasons
    set name = btrim(p_name),
        prior_season_id = btrim(p_prior_season_id),
        roster_lock_at = p_roster_lock_at,
        scoring_values = p_scoring_values,
        scoring_version = v_scoring_version,
        updated_at = now()
    where id = p_season_id;
  else
    insert into public.catalog_seasons (
      id, name, prior_season_id, roster_lock_at, scoring_values
    ) values (
      btrim(p_season_id), btrim(p_name), btrim(p_prior_season_id),
      p_roster_lock_at, p_scoring_values
    );
    v_scoring_version := 1;
  end if;

  insert into public.scoring_rule_versions (
    season_id, version, scoring_values, created_by
  )
  values (
    p_season_id, v_scoring_version, p_scoring_values, (select auth.uid())
  )
  on conflict (season_id, version) do nothing;

  delete from public.tier_costs where season_id = p_season_id;
  insert into public.tier_costs (season_id, tier, cost)
  select p_season_id, (item ->> 'tier')::smallint, (item ->> 'cost')::numeric
  from jsonb_array_elements(p_tier_costs) item;

  perform public.recalculate_catalog_assignments(p_season_id);
  insert into public.catalog_audit_events (season_id, actor_id, action, details)
  values (
    p_season_id,
    (select auth.uid()),
    'configuration_saved',
    jsonb_build_object(
      'scoring_version', v_scoring_version,
      'scoring_values', p_scoring_values,
      'tier_costs', p_tier_costs,
      'roster_lock_at', p_roster_lock_at
    )
  );
end;
$$;

create function public.import_catalog_data(
  p_season_id text,
  p_players jsonb,
  p_season_stats jsonb
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_import_id bigint;
  v_player jsonb;
  v_stat jsonb;
  v_player_id text;
  v_stats jsonb;
  v_player_type text;
  v_player_count integer := 0;
  v_stats_count integer := 0;
  v_review_count integer;
begin
  perform public.assert_catalog_editable(p_season_id);
  perform 1
  from public.catalog_seasons
  where id = p_season_id
  for update;
  perform public.assert_catalog_editable(p_season_id);
  if jsonb_typeof(p_players) <> 'array'
    or jsonb_array_length(p_players) = 0
    or jsonb_typeof(p_season_stats) <> 'array' then
    raise exception using errcode = '22023', message = 'Import requires player and season-stat arrays.';
  end if;
  if jsonb_array_length(p_players) > 1000
    or jsonb_array_length(p_season_stats) > 1000 then
    raise exception using errcode = '22023', message = 'Import exceeds the 1,000-record limit.';
  end if;
  if (
    select count(*) <> count(distinct item ->> 'id')
    from jsonb_array_elements(p_players) item
  ) then
    raise exception using errcode = '22023', message = 'Import contains duplicate player IDs.';
  end if;
  if (
    select count(*) <> count(distinct item ->> 'playerId')
    from jsonb_array_elements(p_season_stats) item
  ) then
    raise exception using errcode = '22023', message = 'Import contains duplicate season-stat player IDs.';
  end if;

  insert into public.catalog_import_runs (season_id, status)
  values (p_season_id, 'running')
  returning id into v_import_id;

  for v_player in select value from jsonb_array_elements(p_players) loop
    if coalesce(v_player ->> 'id', '') = ''
      or coalesce(v_player ->> 'name', '') = ''
      or coalesce(v_player ->> 'position', '') not in ('F', 'D', 'G')
      or coalesce(v_player ->> 'playerType', '') not in ('skater', 'goalie')
      or ((v_player ->> 'position') = 'G') <> ((v_player ->> 'playerType') = 'goalie') then
      raise exception using errcode = '22023', message = 'Import contains an invalid player record.';
    end if;

    insert into public.players (
      id, name, team_id, team_name, position, player_type, active, source_updated_at, updated_at
    ) values (
      v_player ->> 'id',
      v_player ->> 'name',
      nullif(v_player ->> 'teamId', ''),
      nullif(v_player ->> 'teamName', ''),
      v_player ->> 'position',
      v_player ->> 'playerType',
      coalesce((v_player ->> 'active')::boolean, true),
      now(),
      now()
    )
    on conflict (id) do update set
      name = excluded.name,
      team_id = excluded.team_id,
      team_name = excluded.team_name,
      position = excluded.position,
      player_type = excluded.player_type,
      active = excluded.active,
      source_updated_at = now(),
      updated_at = now();

    insert into public.player_season_assignments (
      season_id, player_id, stats, stats_complete,
      calculated_projection, projection_override, tier, tier_override,
      status, scoring_version, updated_at
    )
    select p_season_id, v_player ->> 'id', '{}'::jsonb, false,
      null, null, null, null, 'needs_review', s.scoring_version, now()
    from public.catalog_seasons s
    where s.id = p_season_id
    on conflict (season_id, player_id) do update set
      stats = '{}'::jsonb,
      stats_complete = false,
      calculated_projection = null,
      tier = null,
      status = 'needs_review',
      scoring_version = excluded.scoring_version,
      updated_at = now();

    v_player_count := v_player_count + 1;
  end loop;

  for v_stat in select value from jsonb_array_elements(p_season_stats) loop
    v_player_id := v_stat ->> 'playerId';
    v_stats := coalesce(v_stat -> 'stats', '{}'::jsonb);
    if v_player_id is null or jsonb_typeof(v_stats) <> 'object' then
      raise exception using errcode = '22023', message = 'Import contains an invalid season-stat record.';
    end if;

    select player_type into v_player_type
    from public.players where id = v_player_id;
    if not found or not exists (
      select 1 from public.player_season_assignments
      where season_id = p_season_id and player_id = v_player_id
    ) then
      raise exception using errcode = '22023', message = 'Statistics refer to a player outside this import.';
    end if;

    if exists (
      select 1
      from jsonb_each(v_stats) stat
      where jsonb_typeof(stat.value) <> 'number'
    ) then
      raise exception using errcode = '22023', message = 'Season-stat values must be numeric.';
    end if;

    update public.player_season_assignments
    set stats = v_stats,
        stats_complete = public.calculate_catalog_projection(
          v_stats,
          v_player_type,
          (select scoring_values from public.catalog_seasons where id = p_season_id)
        ) is not null,
        updated_at = now()
    where season_id = p_season_id and player_id = v_player_id;
    v_stats_count := v_stats_count + 1;
  end loop;

  perform public.recalculate_catalog_assignments(p_season_id);
  select count(*) into v_review_count
  from public.player_season_assignments
  where season_id = p_season_id and status = 'needs_review';

  update public.catalog_import_runs
  set status = 'succeeded',
      completed_at = now(),
      player_count = v_player_count,
      stats_count = v_stats_count,
      review_count = v_review_count
  where id = v_import_id;

  insert into public.catalog_audit_events (season_id, actor_id, action, entity_id, details)
  values (
    p_season_id,
    (select auth.uid()),
    'catalog_imported',
    v_import_id::text,
    jsonb_build_object(
      'player_count', v_player_count,
      'stats_count', v_stats_count,
      'review_count', v_review_count
    )
  );

  return v_import_id;
end;
$$;

create function public.record_catalog_import_failure(
  p_season_id text,
  p_error_message text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_import_id bigint;
begin
  if not public.is_site_owner() then
    raise exception using errcode = '42501', message = 'Site-owner access required.';
  end if;
  if not exists (select 1 from public.catalog_seasons where id = p_season_id) then
    raise exception using errcode = 'P0002', message = 'Catalog season not found.';
  end if;
  insert into public.catalog_import_runs (
    season_id, completed_at, status, error_message
  )
  values (
    p_season_id, now(), 'failed',
    left(coalesce(nullif(btrim(p_error_message), ''), 'Import failed without an error message.'), 1000)
  )
  returning id into v_import_id;
  insert into public.catalog_audit_events (season_id, actor_id, action, entity_id, details)
  values (
    p_season_id,
    (select auth.uid()),
    'catalog_import_failed',
    v_import_id::text,
    jsonb_build_object('error_message', left(p_error_message, 1000))
  );
  return v_import_id;
end;
$$;

create function public.review_catalog_player(
  p_season_id text,
  p_player_id text,
  p_projection numeric,
  p_tier smallint
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stats_complete boolean;
begin
  perform public.assert_catalog_editable(p_season_id);
  perform 1
  from public.catalog_seasons
  where id = p_season_id
  for update;
  perform public.assert_catalog_editable(p_season_id);
  if p_tier is null or p_tier not between 1 and 5 then
    raise exception using errcode = '22023', message = 'Tier must be between 1 and 5.';
  end if;
  select stats_complete into v_stats_complete
  from public.player_season_assignments
  where season_id = p_season_id and player_id = p_player_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Player assignment not found.';
  end if;
  if not v_stats_complete and p_projection is null then
    raise exception using errcode = '22023', message = 'A projection is required when prior-season statistics are unavailable.';
  end if;

  update public.player_season_assignments
  set projection_override = p_projection,
      tier_override = p_tier,
      tier = p_tier,
      status = 'ready',
      updated_at = now()
  where season_id = p_season_id and player_id = p_player_id;
  insert into public.catalog_audit_events (season_id, actor_id, action, entity_id, details)
  values (
    p_season_id,
    (select auth.uid()),
    'player_assignment_reviewed',
    p_player_id,
    jsonb_build_object('projection_override', p_projection, 'tier_override', p_tier)
  );
end;
$$;

create function public.freeze_catalog_season(p_season_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_snapshot jsonb;
  v_lock_at timestamptz;
begin
  if not public.is_site_owner() then
    raise exception using errcode = '42501', message = 'Site-owner access required.';
  end if;
  perform 1
  from public.catalog_seasons
  where id = p_season_id
  for update;
  select roster_lock_at into v_lock_at
  from public.catalog_seasons where id = p_season_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Catalog season not found.';
  end if;
  if clock_timestamp() < v_lock_at then
    raise exception using errcode = '55000', message = 'The roster-lock time has not arrived.';
  end if;
  if (select count(*) from public.tier_costs where season_id = p_season_id) <> 5
    or not exists (
      select 1
      from public.player_season_assignments
      where season_id = p_season_id
    )
    or exists (
      select 1
      from public.player_season_assignments
      where season_id = p_season_id and status <> 'ready'
    ) then
    raise exception using errcode = '55000',
      message = 'Set all five tier costs and review every player assignment before freezing.';
  end if;

  select jsonb_build_object(
    'season',
    (select to_jsonb(s) from public.catalog_seasons s where s.id = p_season_id),
    'tierCosts',
    coalesce((
      select jsonb_agg(to_jsonb(c) order by c.tier)
      from public.tier_costs c where c.season_id = p_season_id
    ), '[]'::jsonb),
    'players',
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'player', to_jsonb(p),
          'assignment', to_jsonb(a)
        ) order by p.name, p.id
      )
      from public.players p
      join public.player_season_assignments a on a.player_id = p.id
      where a.season_id = p_season_id
    ), '[]'::jsonb)
  )
  into v_snapshot;

  insert into public.catalog_snapshots (season_id, snapshot)
  values (p_season_id, v_snapshot)
  on conflict (season_id) do nothing;
  update public.catalog_seasons set frozen_at = coalesce(frozen_at, clock_timestamp())
  where id = p_season_id;
  insert into public.catalog_audit_events (season_id, actor_id, action)
  values (p_season_id, (select auth.uid()), 'catalog_frozen');

  return (select snapshot from public.catalog_snapshots where season_id = p_season_id);
end;
$$;

alter table public.catalog_seasons enable row level security;
alter table public.scoring_rule_versions enable row level security;
alter table public.players enable row level security;
alter table public.tier_costs enable row level security;
alter table public.player_season_assignments enable row level security;
alter table public.catalog_import_runs enable row level security;
alter table public.catalog_audit_events enable row level security;
alter table public.catalog_snapshots enable row level security;

revoke all on table
  public.catalog_seasons,
  public.scoring_rule_versions,
  public.players,
  public.tier_costs,
  public.player_season_assignments,
  public.catalog_import_runs,
  public.catalog_audit_events,
  public.catalog_snapshots
from anon, authenticated;

grant select on table
  public.catalog_seasons,
  public.scoring_rule_versions,
  public.players,
  public.tier_costs,
  public.player_season_assignments,
  public.catalog_import_runs,
  public.catalog_audit_events,
  public.catalog_snapshots
to authenticated;

create policy "Authenticated users can read catalog seasons"
  on public.catalog_seasons for select to authenticated using (true);
create policy "Authenticated users can read scoring rule versions"
  on public.scoring_rule_versions for select to authenticated using (true);
create policy "Authenticated users can read players"
  on public.players for select to authenticated using (true);
create policy "Authenticated users can read tier costs"
  on public.tier_costs for select to authenticated using (true);
create policy "Authenticated users can read assignments"
  on public.player_season_assignments for select to authenticated using (true);
create policy "Site owners can read import runs"
  on public.catalog_import_runs for select to authenticated
  using ((select public.is_site_owner()));
create policy "Site owners can read catalog audit"
  on public.catalog_audit_events for select to authenticated
  using ((select public.is_site_owner()));
create policy "Authenticated users can read catalog snapshots"
  on public.catalog_snapshots for select to authenticated using (true);

revoke all on function public.calculate_catalog_projection(jsonb, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.recalculate_catalog_assignments(text)
  from public, anon, authenticated;
revoke all on function public.assert_catalog_editable(text)
  from public, anon, authenticated;
revoke all on function public.guard_catalog_owner()
  from public, anon, authenticated;
revoke all on function public.guard_season_catalog_edit()
  from public, anon, authenticated;
revoke all on function public.guard_catalog_season_edit()
  from public, anon, authenticated;
revoke all on function public.save_catalog_configuration(text, text, text, timestamptz, jsonb, jsonb)
  from public, anon;
revoke all on function public.import_catalog_data(text, jsonb, jsonb)
  from public, anon;
revoke all on function public.record_catalog_import_failure(text, text)
  from public, anon;
revoke all on function public.review_catalog_player(text, text, numeric, smallint)
  from public, anon;
revoke all on function public.freeze_catalog_season(text)
  from public, anon;

grant execute on function public.save_catalog_configuration(text, text, text, timestamptz, jsonb, jsonb)
  to authenticated;
grant execute on function public.import_catalog_data(text, jsonb, jsonb)
  to authenticated;
grant execute on function public.record_catalog_import_failure(text, text)
  to authenticated;
grant execute on function public.review_catalog_player(text, text, numeric, smallint)
  to authenticated;
grant execute on function public.freeze_catalog_season(text)
  to authenticated;
