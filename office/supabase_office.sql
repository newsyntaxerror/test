-- =============================================================
--  달콩 비서실 — Supabase 1회 설정
-- =============================================================
--  프로젝트: qqaogodxzfiuxhkkfjwt  ('우리끼리'와 같은 프로젝트, 표만 새로 추가)
--  실행 위치: Supabase Dashboard → SQL Editor → 붙여넣고 RUN
--
--  · 만드는 것: office_messages · office_tasks · office_memos · office_members
--  · 켜는 것: RLS + anon 접근 정책 + Realtime(구독) + 5초 폴링은 앱이 알아서
--  · 기존 our-map(친구·위치·채팅) 표는 절대 건드리지 않습니다.
--  · 여러 번 실행해도 안전합니다(if not exists / drop policy if exists).
-- =============================================================

-- 0) 방 코드 기본값 ------------------------------------------------
--    앱(config.js)의 ROOM 과 같은 값이어야 합니다.
--    두 기기가 같은 방 코드를 쓰면 같은 비서실이 됩니다.

-- 1) 표 ----------------------------------------------------------
create table if not exists public.office_messages (
  id          text primary key,
  room        text not null default 'dalkong',
  channel     text not null check (char_length(channel) between 1 and 40),
  author_id   text,
  author_name text not null default '비서',
  author_kind text not null default 'ai' check (author_kind in ('leader', 'ai', 'pickle', 'system')),
  body        text not null check (char_length(body) between 1 and 4000),
  kind        text not null default 'chat' check (kind in ('chat', 'debate', 'system')),
  meta        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists office_messages_room_idx
  on public.office_messages (room, channel, created_at desc);

create table if not exists public.office_tasks (
  id         text primary key,
  room       text not null default 'dalkong',
  title      text not null check (char_length(title) between 1 and 300),
  assignee   text,
  status     text not null default 'todo' check (status in ('todo', 'doing', 'done')),
  note       text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists office_tasks_room_idx on public.office_tasks (room, created_at desc);

create table if not exists public.office_memos (
  id         text primary key,
  room       text not null default 'dalkong',
  title      text not null default '',
  body       text not null default '',
  pinned     boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists office_memos_room_idx on public.office_memos (room, pinned desc, updated_at desc);

create table if not exists public.office_members (
  id         text primary key,
  room       text not null default 'dalkong',
  name       text not null default '비서',
  role       text not null default '',
  model      text not null default '',
  status     text not null default '대기',
  emoji      text not null default '🙂',
  provider   text not null default 'none' check (provider in ('none', 'openai', 'anthropic', 'gemini')),
  kind       text not null default 'ai' check (kind in ('leader', 'ai', 'pickle')),
  channels   text[] not null default '{}',
  sort       integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists office_members_room_idx on public.office_members (room, sort);

-- 2) RLS ---------------------------------------------------------
--    개인용 비서실입니다. anon 공개 키로 접근하는 표이므로
--    비밀번호·주민번호 같은 민감한 내용은 적지 마세요.
alter table public.office_messages enable row level security;
alter table public.office_tasks    enable row level security;
alter table public.office_memos    enable row level security;
alter table public.office_members  enable row level security;

grant select, insert, update, delete on public.office_messages to anon, authenticated;
grant select, insert, update, delete on public.office_tasks    to anon, authenticated;
grant select, insert, update, delete on public.office_memos    to anon, authenticated;
grant select, insert, update, delete on public.office_members  to anon, authenticated;

drop policy if exists office_messages_all on public.office_messages;
create policy office_messages_all on public.office_messages
  for all to anon, authenticated using (true) with check (true);

drop policy if exists office_tasks_all on public.office_tasks;
create policy office_tasks_all on public.office_tasks
  for all to anon, authenticated using (true) with check (true);

drop policy if exists office_memos_all on public.office_memos;
create policy office_memos_all on public.office_memos
  for all to anon, authenticated using (true) with check (true);

drop policy if exists office_members_all on public.office_members;
create policy office_members_all on public.office_members
  for all to anon, authenticated using (true) with check (true);

-- 3) Realtime ----------------------------------------------------
--    update/delete 도 온전한 행을 받도록 replica identity 를 채웁니다.
alter table public.office_messages replica identity full;
alter table public.office_tasks    replica identity full;
alter table public.office_memos    replica identity full;
alter table public.office_members  replica identity full;

do $$
begin
  begin
    alter publication supabase_realtime add table public.office_messages;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.office_tasks;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.office_memos;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.office_members;
  exception when duplicate_object then null;
  end;
end $$;

-- 4) 확인 --------------------------------------------------------
select table_name
  from information_schema.tables
 where table_schema = 'public'
   and table_name like 'office_%'
 order by table_name;

-- 끝. 이제 앱을 새로고침하면 배지가 '실시간 동기화'로 바뀝니다.
