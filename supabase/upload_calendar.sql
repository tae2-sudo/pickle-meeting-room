-- ──────────────────────────────────────────────────────────────
--  📅 업로드-캘린더 채널방 · Supabase seed
--  프로젝트: pickle-meeting-room (fbmgkbspiswuekvlhpth)
--  SQL Editor 에 그대로 붙여넣어 실행합니다. 여러 번 실행해도 안전합니다.
--  · rooms 에 '# 📅 업로드-캘린더' 채널방(slug = upload-calendar)을 넣습니다.
--  · 일정 데이터 자체는 저장하지 않습니다 — 화면이 Edge Function
--    get-upload-calendar 로 노션 '📅 06 - 업로드 캘린더'(42384f0c-…)를 그때그때 읽습니다.
-- ──────────────────────────────────────────────────────────────

insert into public.rooms (id, slug, name, description) values
  ('55555555-5555-4555-8555-555555555555', 'upload-calendar', '📅 업로드-캘린더',
   '노션 📅 06 - 업로드 캘린더의 쇼츠 업로드 일정을 채널별로 모아 보는 전용 채널방')
on conflict (id) do update
  set slug = excluded.slug,
      name = excluded.name,
      description = excluded.description;

insert into public.messages (id, room_id, sender_name, sender_role, kind, content, created_at)
select 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
       '55555555-5555-4555-8555-555555555555',
       'system', 'system', 'system',
       '# 📅 업로드-캘린더 채널방이 열렸습니다. 이 방의 달력은 노션 캘린더 페이지를 실시간으로 읽어 채웁니다(피클 토큰 미소모).',
       now()
where not exists (select 1 from public.messages where id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1');
