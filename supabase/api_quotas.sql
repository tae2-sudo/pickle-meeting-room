-- ──────────────────────────────────────────────────────────────
--  📊 AI-API-사용량 채널방 · Supabase schema
--  프로젝트: pickle-meeting-room (fbmgkbspiswuekvlhpth)
--  SQL Editor 에 그대로 붙여넣어 실행합니다. 여러 번 실행해도 안전합니다.
--  · api_quotas      : 제공자별 마지막 실측 결과 (1제공자 = 1행)
--  · api_quota_runs  : 실측 실행 기록 (마지막 실측 시각 · 성공/한도/오류 개수)
--  · rooms           : '# 📊 AI-API-사용량' 채널방 (비서 회의실과 분리)
-- ──────────────────────────────────────────────────────────────

create table if not exists public.api_quotas (
  provider       text primary key,
  label          text not null,
  emoji          text,
  category       text,                                  -- LLM / 라우터 / 스톡 / TTS
  status         text not null default 'unknown'
                 check (status in ('ok', 'limited', 'error', 'unknown')),
  available      boolean,                               -- 실제 호출 성공 여부
  http_status    integer,
  remaining_pct  numeric(5, 1),                         -- 실측 잔여 % (알 수 있을 때만)
  remaining_text text,                                  -- '무료 모델 49/50회 남음'
  limit_text     text,                                  -- '무료 모델 1일 50회'
  used_text      text,                                  -- '누적 $0.0013'
  reset_at       timestamptz,                           -- 다음 리셋/재시도 시각
  detail         jsonb not null default '{}'::jsonb,    -- 응답에서 뽑은 원시 수치(키 없음)
  guide          text,                                  -- 가이드상 무료 한도 안내
  models         text,
  notes          text,
  latency_ms     integer,
  sort_order     integer not null default 100,
  checked_at     timestamptz not null default now()
);

create table if not exists public.api_quota_runs (
  id            bigserial primary key,
  started_at    timestamptz not null,
  finished_at   timestamptz not null default now(),
  ok_count      integer not null default 0,
  limited_count integer not null default 0,
  error_count   integer not null default 0,
  unknown_count integer not null default 0,
  total_count   integer not null default 0,
  source        text not null default 'script',
  notes         text
);

create index if not exists api_quota_runs_finished_idx on public.api_quota_runs (finished_at desc);

alter table public.api_quotas     enable row level security;
alter table public.api_quota_runs enable row level security;

drop policy if exists "api_quotas read" on public.api_quotas;
drop policy if exists "api_quotas insert" on public.api_quotas;
drop policy if exists "api_quotas update" on public.api_quotas;
create policy "api_quotas read"   on public.api_quotas for select to anon, authenticated using (true);
create policy "api_quotas insert" on public.api_quotas for insert to anon, authenticated with check (true);
create policy "api_quotas update" on public.api_quotas for update to anon, authenticated using (true) with check (true);

drop policy if exists "api_quota_runs read" on public.api_quota_runs;
drop policy if exists "api_quota_runs insert" on public.api_quota_runs;
create policy "api_quota_runs read"   on public.api_quota_runs for select to anon, authenticated using (true);
create policy "api_quota_runs insert" on public.api_quota_runs for insert to anon, authenticated with check (true);

grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update on public.api_quotas     to anon, authenticated, service_role;
grant select, insert, update on public.api_quota_runs to anon, authenticated, service_role;
grant usage, select on sequence public.api_quota_runs_id_seq to anon, authenticated, service_role;

-- ── Realtime: 실측 결과가 바뀌면 열려 있는 화면에 즉시 반영 ──
alter table public.api_quotas     replica identity full;
alter table public.api_quota_runs replica identity full;

do $$
begin
  alter publication supabase_realtime add table public.api_quotas;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.api_quota_runs;
exception when duplicate_object then null;
end $$;

-- ── 채널방: '# 📊 AI-API-사용량' (비서 회의실과 완전히 분리) ──
insert into public.rooms (id, slug, name, description) values
  ('44444444-4444-4444-8444-444444444444', 'api-usage', '📊 AI-API-사용량',
   'AI·스톡 API의 실측 사용량과 남은 무료 한도를 모아 보는 전용 채널방')
on conflict (id) do nothing;

insert into public.messages (id, room_id, sender_name, sender_role, kind, content, created_at)
select 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6',
       '44444444-4444-4444-8444-444444444444',
       'system', 'system', 'system',
       '# 📊 AI-API-사용량 채널방이 열렸습니다. 이 방의 카드는 서버 실측 스크립트가 채우고, 화면은 Supabase Realtime으로 자동 갱신됩니다.',
       now() - interval '1 minute'
where not exists (select 1 from public.messages where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6');

-- ── 화면 순서용 기본 정렬값 (실측 전에도 카드가 보이도록) ──
insert into public.api_quotas (provider, label, emoji, category, status, sort_order, guide)
values
  ('openrouter',    'OpenRouter',         '🌐', '라우터', 'unknown', 10, '무료 모델(:free) 1일 50회 · 유료 모델은 크레딧 필요'),
  ('groq',          'Groq',               '⚡', 'LLM',    'unknown', 20, '무료 등급 · 분당 요청/토큰 한도(헤더로 확인)'),
  ('gemini',        'Gemini (기본)',      '✨', 'LLM',    'unknown', 30, 'AI Studio 무료 등급 · TTS 무료 한도'),
  ('gemini_backup', 'Gemini (백업)',      '✨', 'TTS',    'unknown', 40, 'AI Studio 무료 등급 · TTS 무료 한도'),
  ('gemini_free_3', 'Gemini (3호)',       '✨', 'TTS',    'unknown', 50, 'AI Studio 무료 등급 · TTS 무료 한도'),
  ('gemini_free_4', 'Gemini (4호)',       '✨', 'LLM',    'unknown', 55, 'AI Studio 무료 등급 · 텍스트 무료 한도'),
  ('cohere',        'Cohere',             '🧭', 'LLM',    'unknown', 60, 'Trial 무료 · 월 1,000회'),
  ('upstage',       'Upstage',            '🌞', 'LLM',    'unknown', 70, '무료 크레딧 $10 (약 1.2만 회, ~2027-02-20)'),
  ('zai',           'Z.AI (GLM)',         '🧩', 'LLM',    'unknown', 80, '무료 등급 · 동시 호출 제한(flash 1~2건)'),
  ('exaone',        'EXAONE',             '🧠', 'LLM',    'unknown', 90, '비상업용 1일 100회 · 2026-12-19 만료'),
  ('requesty',      'Requesty',           '🔀', '라우터', 'unknown', 100, '카드 없이 1일 200회 무료'),
  ('cloudflare',    'Cloudflare Workers AI', '☁️', 'LLM', 'unknown', 110, '무료 등급 · 1일 10,000 Neuron'),
  ('pixabay',       'Pixabay',            '🖼️', '스톡',   'unknown', 120, '무료 스톡 이미지/영상 · 60초당 100회'),
  ('gcloud_tts',    'Google Cloud TTS',   '🔊', 'TTS',    'unknown', 130, '월 100만 자 무료(Standard) · 서비스 계정')
on conflict (provider) do nothing;
