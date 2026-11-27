-- ──────────────────────────────────────────────────────────────
--  📺 유튜브-대시보드 채널방 · Supabase seed
--  프로젝트: pickle-meeting-room (fbmgkbspiswuekvlhpth)
--  SQL Editor 에 그대로 붙여넣어 실행합니다. 여러 번 실행해도 안전합니다.
--  · rooms 에 '# 📺 유튜브-대시보드' 채널방(slug = youtube-dashboard)을 넣습니다.
--  · 통계 자체는 저장하지 않습니다 — 화면이 Edge Function
--    get-youtube-dashboard 로 두 채널(별별해외이슈 · ショッと見て)을 그때그때 읽습니다.
-- ──────────────────────────────────────────────────────────────

insert into public.rooms (id, slug, name, description) values
  ('66666666-6666-4666-8666-666666666666', 'youtube-dashboard', '📺 유튜브-대시보드',
   '별별해외이슈 · ショッと見て 두 채널의 구독자·조회수·최근 영상 성과·미응답 댓글을 한 화면에서 보는 전용 채널방')
on conflict (id) do update
  set slug = excluded.slug,
      name = excluded.name,
      description = excluded.description;

insert into public.messages (id, room_id, sender_name, sender_role, kind, content, created_at)
select 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2',
       '66666666-6666-4666-8666-666666666666',
       'system', 'system', 'system',
       '# 📺 유튜브-대시보드 채널방이 열렸습니다. 이 방의 통계는 YouTube Data·Analytics API를 Edge Function이 직접 읽어 채웁니다(피클 토큰 미소모).',
       now()
where not exists (select 1 from public.messages where id = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2');
