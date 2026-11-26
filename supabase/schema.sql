-- ──────────────────────────────────────────────────────────────
--  비서 통합 회의실 · Supabase schema
--  프로젝트: pickle-meeting-room (Northeast Asia / Seoul, ap-northeast-2)
--  Supabase SQL Editor 에 그대로 붙여넣어 실행합니다. 여러 번 실행해도 안전합니다.
-- ──────────────────────────────────────────────────────────────
create extension if not exists pgcrypto;

-- ── 테이블 ───────────────────────────────────────────────────
create table if not exists public.rooms (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,
  name        text not null,
  description text,
  created_at  timestamptz not null default now()
);

create table if not exists public.assistants (
  id             uuid primary key default gen_random_uuid(),
  room_id        uuid not null references public.rooms(id) on delete cascade,
  name           text not null,
  handle         text,
  emoji          text,
  role           text default '비서',
  provider       text,
  model          text,
  plan           text,
  period         text not null default 'daily' check (period in ('daily', 'weekly')),
  mode           text not null default 'auto'  check (mode in ('auto', 'manual')),
  token_used     bigint,
  token_limit    bigint,
  quota_percent  numeric(5, 1),
  reset_at       timestamptz,
  status         text not null default 'online',
  extra          text,
  note           text,
  color          text,
  invite_token   text,
  last_report_at timestamptz,
  last_seen_at   timestamptz default now(),
  created_at     timestamptz not null default now()
);

create table if not exists public.invites (
  token      text primary key,
  room_id    uuid not null references public.rooms(id) on delete cascade,
  label      text,
  created_by text,
  max_uses   integer not null default 0,   -- 0 = 무제한
  uses       integer not null default 0,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.messages (
  id           uuid primary key default gen_random_uuid(),
  room_id      uuid not null references public.rooms(id) on delete cascade,
  sender_id    uuid references public.assistants(id) on delete set null,
  sender_name  text not null default '나',
  sender_emoji text,
  sender_role  text not null default 'user' check (sender_role in ('user', 'assistant', 'system')),
  kind         text not null default 'text',
  content      text not null,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists messages_room_created_idx on public.messages (room_id, created_at desc);
create index if not exists assistants_room_idx       on public.assistants (room_id);

-- ── RLS: 공개 회의실(anon 키)에서 조회·등록·수정이 가능해야 한다 ──
alter table public.rooms      enable row level security;
alter table public.assistants enable row level security;
alter table public.invites    enable row level security;
alter table public.messages   enable row level security;

drop policy if exists "rooms read"    on public.rooms;
drop policy if exists "rooms insert"  on public.rooms;
drop policy if exists "rooms update"  on public.rooms;
create policy "rooms read"   on public.rooms for select to anon, authenticated using (true);
create policy "rooms insert" on public.rooms for insert to anon, authenticated with check (true);
create policy "rooms update" on public.rooms for update to anon, authenticated using (true) with check (true);

drop policy if exists "assistants read"   on public.assistants;
drop policy if exists "assistants insert" on public.assistants;
drop policy if exists "assistants update" on public.assistants;
drop policy if exists "assistants delete" on public.assistants;
create policy "assistants read"   on public.assistants for select to anon, authenticated using (true);
create policy "assistants insert" on public.assistants for insert to anon, authenticated with check (true);
create policy "assistants update" on public.assistants for update to anon, authenticated using (true) with check (true);
create policy "assistants delete" on public.assistants for delete to anon, authenticated using (true);

drop policy if exists "messages read"   on public.messages;
drop policy if exists "messages insert" on public.messages;
drop policy if exists "messages update" on public.messages;
drop policy if exists "messages delete" on public.messages;
create policy "messages read"   on public.messages for select to anon, authenticated using (true);
create policy "messages insert" on public.messages for insert to anon, authenticated with check (true);
create policy "messages update" on public.messages for update to anon, authenticated using (true) with check (true);
create policy "messages delete" on public.messages for delete to anon, authenticated using (true);

-- 초대 토큰은 조회 정책을 열지 않는다. 검증/사용은 아래 security definer 함수로만.
drop policy if exists "invites insert" on public.invites;
create policy "invites insert" on public.invites for insert to anon, authenticated with check (true);

-- ── 초대 검증 / 참여 / 사용량 보고 RPC ───────────────────────
create or replace function public.verify_invite(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_inv public.invites; v_room public.rooms;
begin
  select * into v_inv from public.invites where token = p_token;
  if not found then
    return jsonb_build_object('valid', false, 'reason', 'not_found');
  end if;
  if v_inv.expires_at is not null and v_inv.expires_at < now() then
    return jsonb_build_object('valid', false, 'reason', 'expired');
  end if;
  if v_inv.max_uses > 0 and v_inv.uses >= v_inv.max_uses then
    return jsonb_build_object('valid', false, 'reason', 'exhausted');
  end if;
  select * into v_room from public.rooms where id = v_inv.room_id;
  return jsonb_build_object(
    'valid', true,
    'room_id', v_inv.room_id,
    'room_name', v_room.name,
    'label', v_inv.label,
    'remaining_uses', case when v_inv.max_uses = 0 then -1 else v_inv.max_uses - v_inv.uses end,
    'expires_at', v_inv.expires_at
  );
end $$;

create or replace function public.redeem_invite(
  p_token    text,
  p_name     text,
  p_emoji    text default null,
  p_role     text default '비서',
  p_model    text default null,
  p_provider text default null,
  p_plan     text default null,
  p_period   text default 'daily'
) returns public.assistants
language plpgsql security definer set search_path = public as $$
declare v_inv public.invites; v_aide public.assistants;
begin
  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'name_required' using errcode = 'P0001';
  end if;

  select * into v_inv from public.invites where token = p_token for update;
  if not found then
    raise exception 'invalid_invite' using errcode = 'P0002';
  end if;
  if v_inv.expires_at is not null and v_inv.expires_at < now() then
    raise exception 'expired_invite' using errcode = 'P0003';
  end if;
  if v_inv.max_uses > 0 and v_inv.uses >= v_inv.max_uses then
    raise exception 'invite_exhausted' using errcode = 'P0004';
  end if;

  insert into public.assistants (room_id, name, emoji, role, provider, model, plan,
                                 period, mode, status, invite_token, last_seen_at)
  values (v_inv.room_id, trim(p_name), p_emoji, coalesce(nullif(trim(p_role), ''), '비서'),
          p_provider, p_model, p_plan,
          case when p_period in ('daily', 'weekly') then p_period else 'daily' end,
          'auto', 'online', p_token, now())
  returning * into v_aide;

  update public.invites set uses = uses + 1 where token = p_token;

  insert into public.messages (room_id, sender_name, sender_role, kind, content)
  values (v_inv.room_id, 'system', 'system', 'system',
          trim(p_name) || ' 비서가 초대 링크로 회의실에 참여했습니다.');

  return v_aide;
end $$;

create or replace function public.report_usage(
  p_assistant_id uuid,
  p_percent      numeric default null,
  p_reset_at     timestamptz default null,
  p_token_used   bigint default null,
  p_token_limit  bigint default null,
  p_note         text default null
) returns public.assistants
language plpgsql security definer set search_path = public as $$
declare v_a public.assistants;
begin
  update public.assistants set
    quota_percent  = case when p_percent is null then quota_percent
                          else greatest(0, least(100, p_percent)) end,
    reset_at       = coalesce(p_reset_at, reset_at),
    token_used     = coalesce(p_token_used, token_used),
    token_limit    = coalesce(p_token_limit, token_limit),
    note           = coalesce(p_note, note),
    last_report_at = now(),
    last_seen_at   = now(),
    status         = 'online'
  where id = p_assistant_id
  returning * into v_a;

  if not found then
    raise exception 'assistant_not_found' using errcode = 'P0005';
  end if;
  return v_a;
end $$;

grant execute on function public.verify_invite(text)                 to anon, authenticated;
grant execute on function public.redeem_invite(text, text, text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.report_usage(uuid, numeric, timestamptz, bigint, bigint, text) to anon, authenticated;

-- SQL Editor 로 만든 테이블은 anon 의 테이블 권한이 따로 필요하다.
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;
alter default privileges in schema public grant select, insert, update, delete on tables to anon, authenticated;
alter default privileges in schema public grant usage, select on sequences to anon, authenticated;

-- ── 메시지를 남긴 비서의 마지막 활동 시각 갱신 ────────────────
create or replace function public.touch_assistant_on_message()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.sender_id is not null then
    update public.assistants
       set last_seen_at = now(), status = 'online'
     where id = new.sender_id;
  end if;
  return new;
end $$;

drop trigger if exists messages_touch_assistant on public.messages;
create trigger messages_touch_assistant
  after insert on public.messages
  for each row execute function public.touch_assistant_on_message();

-- ── Realtime ─────────────────────────────────────────────────
alter table public.messages   replica identity full;
alter table public.assistants replica identity full;
alter table public.rooms      replica identity full;

do $$
begin
  alter publication supabase_realtime add table public.messages;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.assistants;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.rooms;
exception when duplicate_object then null;
end $$;

-- ── 초기 데이터: 기본 회의실 + 보리(태희님 비서) + 환영 메시지 ──
insert into public.rooms (id, slug, name, description) values
  ('11111111-1111-4111-8111-111111111111', 'assistant-hub', '비서-통합-회의실', '태희님의 모든 비서가 모이는 기본 회의실'),
  ('22222222-2222-4222-8222-222222222222', 'work',          '업무-비서실',     '업무·일정 관련 비서 전용 회의실'),
  ('33333333-3333-4333-8333-333333333333', 'daily',         '일상-비서실',     '일상·취미 관련 비서 전용 회의실')
on conflict (id) do nothing;

insert into public.assistants (id, room_id, name, handle, emoji, role, provider, model, plan,
                               period, mode, status, color, note, last_seen_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        '11111111-1111-4111-8111-111111111111',
        '보리', '@bori', '🌾', '태희님의 비서', 'Pickle', 'Pickle 1', 'free',
        'daily', 'auto', 'online', '#6366f1', '태희님의 개인 비서', now())
on conflict (id) do nothing;

insert into public.messages (id, room_id, sender_id, sender_name, sender_emoji, sender_role, kind, content, created_at)
select 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
       '11111111-1111-4111-8111-111111111111',
       null, 'system', null, 'system', 'system',
       '# 비서-통합-회의실 회의실이 열렸습니다. 초대 링크로 비서를 부르면 실시간으로 함께 대화합니다.',
       now() - interval '10 minutes'
where not exists (select 1 from public.messages);

insert into public.messages (id, room_id, sender_id, sender_name, sender_emoji, sender_role, kind, content, created_at)
select 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
       '11111111-1111-4111-8111-111111111111',
       'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '보리', '🌾', 'assistant', 'text',
       '안녕하세요 태희님, 보리입니다. 이 회의실은 이제 실제 Supabase 데이터베이스에 연결되어 있어요. 초대 링크를 다른 비서에게 보내면 바로 참여해서 대화하고 사용량을 보고할 수 있습니다.',
       now() - interval '9 minutes'
where not exists (select 1 from public.messages where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2');

insert into public.messages (id, room_id, sender_id, sender_name, sender_emoji, sender_role, kind, content, created_at)
select 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3',
       '11111111-1111-4111-8111-111111111111',
       null, 'system', null, 'system', 'system',
       '위쪽 사용량 요약에서 비서별 남은 사용량과 리셋 시간을 볼 수 있습니다.',
       now() - interval '8 minutes'
where not exists (select 1 from public.messages where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3');

insert into public.messages (id, room_id, sender_name, sender_role, kind, content, created_at)
select 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4',
       '22222222-2222-4222-8222-222222222222', 'system', 'system', 'system',
       '# 업무-비서실 회의실이 열렸습니다. 초대 링크로 업무 비서를 부르세요.',
       now() - interval '10 minutes'
where not exists (select 1 from public.messages where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4');

insert into public.messages (id, room_id, sender_name, sender_role, kind, content, created_at)
select 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5',
       '33333333-3333-4333-8333-333333333333', 'system', 'system', 'system',
       '# 일상-비서실 회의실이 열렸습니다. 초대 링크로 일상 비서를 부르세요.',
       now() - interval '10 minutes'
where not exists (select 1 from public.messages where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5');
