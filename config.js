/* 비서 통합 회의실 — Supabase 연결 설정
   공개용 anon(publishable) 키만 들어 있습니다. service_role 키는 절대 넣지 마세요. */
window.PICKLE_ROOM_CONFIG = {
  supabaseUrl: 'https://fbmgkbspiswuekvlhpth.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZibWdrYnNwaXN3dWVrdmxocHRoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU2NzMyNjcsImV4cCI6MjExMTI0OTI2N30.ftVWRn_MyS4pk0gSU9HULUvS-vmjbvgWa2LPENv_1JY',
  publicBase: 'https://tae2-sudo.github.io/pickle-meeting-room/',
  /* 📊 AI-API-사용량 방의 '실시간 실측 새로고침' 버튼이 호출하는 Supabase Edge Function.
     API 키는 이 함수의 Secrets 에만 있고 브라우저에는 없습니다(피클 토큰도 쓰지 않음). */
  quotaFunctionUrl: 'https://fbmgkbspiswuekvlhpth.supabase.co/functions/v1/check-api-quotas',
  appVersion: '1.3.0'
};
