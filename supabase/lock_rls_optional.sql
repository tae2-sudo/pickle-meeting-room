-- ──────────────────────────────────────────────────────────────
--  🔒 비서 통합 회의실 · 선택 적용용 RLS 잠금 SQL
--  프로젝트: pickle-meeting-room (fbmgkbspiswuekvlhpth)
--
--  ⚠️ 이 파일은 schema.sql / api_quotas.sql 을 덮어쓰지 않는 '별도 선택 파일'입니다.
--     필요한 부분만 골라 Supabase SQL Editor 에 붙여넣어 실행하세요. 실행 전에
--     아래 0번(현재 상태 확인)을 먼저 돌려 무엇이 열려 있는지 보는 것을 권합니다.
--
--  이 파일이 다루는 것
--    1) anon 키로 테이블을 '지우는' 권한(delete) 없애기
--    2) (선택) 사용량 테이블 쓰기를 service_role 전용으로 좁히기
--    3) 되돌리기(rollback)
--
--  무엇이 잠기고 무엇이 그대로인지
--    · 이 SQL 을 실행해도 화면(app.js)의 조회·메시지 전송·초대 참여·사용량 카드 표시는
--      그대로 동작합니다. delete 만 막히므로, 앱의 '비서 삭제'·'회의실 삭제' 버튼은
--      실패합니다(필요하면 1번을 건너뛰거나, 삭제만 service_role 로 처리하도록 바꿔야 합니다).
--    · anon 키로 '읽기(select)'는 여전히 열려 있습니다. 이 앱은 로그인 없는 공개 회의실이라
--      읽기를 막으면 화면이 동작하지 않습니다. 읽기까지 잠그려면 Supabase Auth 도입이 필요하고,
--      그건 이 파일의 범위 밖입니다.
--    · Edge Function 3종(check-api-quotas · get-upload-calendar · get-youtube-dashboard)의
--      외부 호출 차단은 이 파일이 아니라 각 함수의 CORS + APP_ACCESS_KEY 로 처리합니다.
-- ──────────────────────────────────────────────────────────────

-- ── 0) 현재 상태 확인 (읽기 전용 · 먼저 실행해 보기) ─────────────
-- 어떤 정책이 열려 있는지
select schemaname, tablename, policyname, cmd, roles
  from pg_policies
 where schemaname = 'public'
 order by tablename, cmd, policyname;

-- anon/authenticated 가 실제로 가진 테이블 권한
select table_name, grantee, string_agg(privilege_type, ', ' order by privilege_type) as privileges
  from information_schema.role_table_grants
 where table_schema = 'public'
   and grantee in ('anon', 'authenticated')
 group by table_name, grantee
 order by table_name, grantee;


-- ── 1) anon 으로 '지우기(delete)' 금지 ─────────────────────────
-- 화면에서 쓰지 않는 delete 를 권한과 정책 양쪽에서 없앱니다(둘 다 필요).
-- ※ 앱의 '비서 삭제'·'회의실 삭제' 버튼은 이 뒤로 실패합니다.
revoke delete on public.messages   from anon, authenticated;
revoke delete on public.assistants from anon, authenticated;
revoke delete on public.rooms      from anon, authenticated;
revoke delete on public.invites    from anon, authenticated;

drop policy if exists "messages delete"   on public.messages;
drop policy if exists "assistants delete" on public.assistants;

-- 앞으로 SQL Editor 로 새로 만드는 테이블에도 delete 를 자동으로 주지 않게 한다.
alter default privileges in schema public revoke delete on tables from anon, authenticated;


-- ── 2) (선택) 사용량 테이블 쓰기를 service_role 전용으로 ───────
-- api_quotas / api_quota_runs 는 Edge Function check-api-quotas 가 채웁니다.
-- 그 함수에 SUPABASE_SERVICE_ROLE_KEY 시크릿이 설정돼 있을 때만 아래를 켜세요.
--   (시크릿이 없으면 함수가 anon 키로 쓰기를 시도해 '한도 실측'이 실패합니다)
--
-- Supabase 대시보드 → Project Settings → Edge Functions → Secrets 에
--   SUPABASE_SERVICE_ROLE_KEY = <service_role 키>
-- 를 넣고 함수를 다시 배포한 뒤에 실행하세요.
--
-- drop policy if exists "api_quotas insert" on public.api_quotas;
-- drop policy if exists "api_quotas update" on public.api_quotas;
-- drop policy if exists "api_quota_runs insert" on public.api_quota_runs;
-- revoke insert, update on public.api_quotas     from anon, authenticated;
-- revoke insert, update on public.api_quota_runs from anon, authenticated;
-- grant  select, insert, update on public.api_quotas     to service_role;
-- grant  select, insert, update on public.api_quota_runs to service_role;


-- ── 3) 되돌리기 (1번을 되돌려 delete 를 다시 열기) ──────────────
-- grant delete on public.messages, public.assistants, public.rooms, public.invites
--   to anon, authenticated;
-- create policy "messages delete"   on public.messages   for delete to anon, authenticated using (true);
-- create policy "assistants delete" on public.assistants for delete to anon, authenticated using (true);
-- alter default privileges in schema public grant delete on tables to anon, authenticated;
