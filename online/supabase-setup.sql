-- =====================================================================================================
-- TACOCRAFT online accounts: TacoMail (player messages), leaderboards, blocking and reports.
-- Paste ALL of this into your Supabase project's SQL Editor and press Run. It is safe to run again.
--
-- What the safety rules (RLS) allow:
--   * Anyone can see usernames and the leaderboards.
--   * You can only change YOUR OWN scores, and scores can only go up.
--   * You can only read messages sent to you or by you. Only the person a message was sent to can mark it
--     read, delete it, block the sender or report it.
--   * Max 5 messages a minute, 300 characters each. Blocked players can't message you.
--   * Reports are only visible to you (the owner) in Table Editor > reports.
-- =====================================================================================================

-- ---------- Profiles: one per account, holding the username ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null check (username ~ '^[A-Za-z0-9_]{3,16}$'),
  created_at timestamptz not null default now()
);
create unique index if not exists profiles_username_lower on public.profiles (lower(username));
alter table public.profiles enable row level security;
drop policy if exists "profiles are public" on public.profiles;
create policy "profiles are public" on public.profiles for select using (true);

-- a new account gets its profile automatically (the username comes from sign-up)
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username) values (new.id, new.raw_user_meta_data->>'username');
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- ---------- Leaderboards ----------
create table if not exists public.scores (
  user_id uuid primary key default auth.uid() references public.profiles(id) on delete cascade,
  username text not null default '',
  bosses integer not null default 0 check (bosses between 0 and 100000),
  kills integer not null default 0 check (kills between 0 and 10000000),
  coins bigint not null default 0 check (coins between 0 and 1000000000),
  playtime integer not null default 0 check (playtime between 0 and 1000000000),
  updated_at timestamptz not null default now()
);
alter table public.scores enable row level security;
drop policy if exists "scores are public" on public.scores;
drop policy if exists "insert own score" on public.scores;
drop policy if exists "update own score" on public.scores;
create policy "scores are public" on public.scores for select using (true);
create policy "insert own score" on public.scores for insert with check (user_id = auth.uid());
create policy "update own score" on public.scores for update using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function public.scores_fill() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.user_id := auth.uid();
  new.username := (select username from public.profiles where id = auth.uid());
  if tg_op = 'UPDATE' then
    -- scores only ever go up, and play time can't grow faster than the clock (plus a little slack)
    new.bosses := greatest(new.bosses, old.bosses);
    new.kills := greatest(new.kills, old.kills);
    new.coins := greatest(new.coins, old.coins);
    new.playtime := least(greatest(new.playtime, old.playtime), old.playtime + extract(epoch from (now() - old.updated_at))::int + 120);
  else
    new.playtime := least(new.playtime, 36000);                   -- (a brand-new account starts with at most 10 hours)
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists scores_fill on public.scores;
create trigger scores_fill before insert or update on public.scores for each row execute function public.scores_fill();

-- ---------- Blocking ----------
create table if not exists public.blocks (
  blocker uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  blocked uuid not null references public.profiles(id) on delete cascade,
  primary key (blocker, blocked)
);
alter table public.blocks enable row level security;
drop policy if exists "own blocks" on public.blocks;
create policy "own blocks" on public.blocks for all using (blocker = auth.uid()) with check (blocker = auth.uid());

-- ---------- TacoMail: messages between players ----------
create table if not exists public.messages (
  id bigint generated always as identity primary key,
  from_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  from_name text not null default '',
  to_id uuid references public.profiles(id) on delete cascade,
  to_name text not null,
  body text not null check (char_length(body) between 1 and 300),
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists messages_to on public.messages (to_id, created_at desc);
create index if not exists messages_from on public.messages (from_id, created_at desc);
alter table public.messages enable row level security;
drop policy if exists "see own messages" on public.messages;
drop policy if exists "send messages" on public.messages;
drop policy if exists "recipient marks read" on public.messages;
drop policy if exists "recipient deletes" on public.messages;
create policy "see own messages" on public.messages for select using (auth.uid() = from_id or auth.uid() = to_id);
create policy "send messages" on public.messages for insert with check (from_id = auth.uid());
create policy "recipient marks read" on public.messages for update using (to_id = auth.uid()) with check (to_id = auth.uid());
create policy "recipient deletes" on public.messages for delete using (to_id = auth.uid());
revoke update on public.messages from anon, authenticated;
grant update (read) on public.messages to authenticated;          -- (the recipient can only change "read", never the text)

create or replace function public.messages_fill() returns trigger
language plpgsql security definer set search_path = public as $$
declare tid uuid; tname text;
begin
  if auth.uid() is null then raise exception 'Sign in to send messages.'; end if;
  new.from_id := auth.uid();
  new.from_name := (select username from public.profiles where id = auth.uid());
  select id, username into tid, tname from public.profiles where lower(username) = lower(trim(new.to_name));
  if tid is null then raise exception 'There is no player called "%".', new.to_name; end if;
  if tid = new.from_id then raise exception 'You can''t send a message to yourself.'; end if;
  if exists (select 1 from public.blocks where blocker = tid and blocked = new.from_id) then
    raise exception 'That player isn''t accepting messages from you.'; end if;
  if (select count(*) from public.messages where from_id = new.from_id and created_at > now() - interval '1 minute') >= 5 then
    raise exception 'Slow down! You can send 5 messages a minute.'; end if;
  new.to_id := tid; new.to_name := tname; new.read := false; new.created_at := now();
  return new;
end $$;
drop trigger if exists messages_fill on public.messages;
create trigger messages_fill before insert on public.messages for each row execute function public.messages_fill();

-- ---------- Reports (only you, the owner, can read these: Table Editor > reports) ----------
create table if not exists public.reports (
  id bigint generated always as identity primary key,
  reporter uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  message_id bigint,
  reported_name text,
  body text,
  reason text check (char_length(reason) <= 200),
  created_at timestamptz not null default now()
);
alter table public.reports enable row level security;
drop policy if exists "file reports" on public.reports;
create policy "file reports" on public.reports for insert with check (reporter = auth.uid());

create or replace function public.reports_fill() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.reporter := auth.uid();
  select from_name, body into new.reported_name, new.body from public.messages where id = new.message_id and to_id = auth.uid();
  if new.body is null then raise exception 'You can only report messages sent to you.'; end if;
  new.created_at := now();
  return new;
end $$;
drop trigger if exists reports_fill on public.reports;
create trigger reports_fill before insert on public.reports for each row execute function public.reports_fill();
