#!/usr/bin/env python3
""": 비서 통합 회의실 · 🏛️ AI 팀 회의실 배포 점검

배포한 Edge Function `run-ai-meeting` 이 살아 있는지, 다섯 팀장의 API 키(Secrets)가
모두 꽂혔는지 확인합니다. GET 만 쓰므로 **AI 한도를 소모하지 않습니다.**

  python3 tests/ai_meeting_check.py            # 배포·Secret 점검 (한도 0)
  python3 tests/ai_meeting_check.py --round "테스트 소재"
                                               # 실제 R1 1라운드 호출 (팀장 5명 각 1회 = 한도 소모)

종료코드 0 = 모두 정상, 1 = 함수 응답 이상, 2 = Secret 누락, 3 = CORS 차단.
"""
import json
import re
import sys
import urllib.error
import urllib.request

HERE = __file__.rsplit('/', 1)[0] if '/' in __file__ else '.'
FUNCTION_URL = None
ANON_KEY = None
for line in open(HERE + '/../config.js', encoding='utf-8'):
    m = re.search(r"aiMeetingFunctionUrl:\s*'([^']+)'", line)
    if m:
        FUNCTION_URL = m.group(1)
    m = re.search(r"supabaseAnonKey:\s*'([^']+)'", line)
    if m:
        ANON_KEY = m.group(1)

ORIGIN = 'https://tae2-sudo.github.io'
results = []


def check(label, ok, detail=''):
    results.append((label, ok))
    print(('PASS  ' if ok else 'FAIL  ') + label + ('' if ok else ' :: ' + str(detail)))


def call(method='GET', body=None, headers=None):
    h = {'Origin': ORIGIN, 'apikey': ANON_KEY or '', 'Authorization': 'Bearer ' + (ANON_KEY or '')}
    if body is not None:
        h['Content-Type'] = 'application/json'
    if headers:
        h.update(headers)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(FUNCTION_URL, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read().decode()
            try:
                parsed = json.loads(raw)
            except ValueError:
                parsed = None
            return r.status, parsed, dict(r.headers)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            parsed = json.loads(raw)
        except ValueError:
            parsed = None
        return e.code, parsed, dict(e.headers)
    except Exception as exc:  # noqa: BLE001
        return 0, {'error': str(exc)}, {}


def main():
    if not FUNCTION_URL:
        print('config.js 에서 aiMeetingFunctionUrl 을 찾지 못했습니다.')
        sys.exit(1)
    print('함수:', FUNCTION_URL)

    # 1) OPTIONS 프리플라이트
    status, _, headers = call('OPTIONS')
    acao = (headers.get('Access-Control-Allow-Origin') or headers.get('access-control-allow-origin') or '')
    check('OPTIONS 프리플라이트', status in (200, 204), status)
    check('허용 Origin CORS 헤더', acao in (ORIGIN, '*'), acao or '(없음)')
    if status == 403:
        print('\n403 — 허용되지 않은 Origin 입니다. 함수 Secrets 의 APP_ALLOWED_ORIGINS 를 확인하세요.')
        sys.exit(3)

    # 2) GET 명단
    status, data, _ = call('GET')
    if status == 401:
        print('\n401 — APP_ACCESS_KEY 가 설정돼 있습니다. 화면 설정 → 보안 → 앱 접근 키 값을 넣고')
        print('      이 스크립트의 headers 에 x-app-key 로 넘기거나, 점검용으로는 Secret 을 잠시 비워 두세요.')
        sys.exit(1)
    check('GET /run-ai-meeting 응답', status == 200 and isinstance(data, dict) and data.get('ok'), status)
    if not isinstance(data, dict):
        sys.exit(1)

    leaders = data.get('leaders') or []
    check('팀장 5명 정의', len(leaders) == 5, len(leaders))
    for l in leaders:
        print('  %s %-6s %-9s %-26s %s' % (
            l.get('emoji', ''), l.get('name', ''), l.get('provider', ''), l.get('model', ''),
            '키 있음' if l.get('secretSet') else 'Secret 없음 (' + str(l.get('secret')) + ')'))
    missing = [l.get('secret') for l in leaders if not l.get('secretSet')]
    check('모든 팀장의 Secret 설정', not missing, ', '.join(missing))

    modes = data.get('modes') or {}
    check('모드 fast=2 / full=5 라운드',
          (modes.get('fast') or {}).get('totalRounds') == 2 and (modes.get('full') or {}).get('totalRounds') == 5,
          modes)

    # 3) 선택: 실제 1라운드 (한도 소모)
    if '--round' in sys.argv:
        topic = sys.argv[sys.argv.index('--round') + 1] if len(sys.argv) > sys.argv.index('--round') + 1 else '배포 점검용 소재'
        print('\n실제 R1 호출 — 팀장 5명 API 를 1회씩 사용합니다:', topic)
        status, data, _ = call('POST', {'topic': topic, 'mode': 'fast', 'round': 1, 'notes': '', 'history': []})
        check('R1 응답', status == 200 and isinstance(data, dict) and data.get('ok'), status)
        if isinstance(data, dict):
            for r in data.get('results') or []:
                state = '완료 %sms' % r.get('ms') if r.get('ok') else '실패: ' + str(r.get('error'))
                print('  %s %-6s %s' % (r.get('emoji', ''), r.get('name', ''), state))
            check('응답 팀장 1명 이상', (data.get('okCount') or 0) > 0, data.get('okCount'))

    failed = [r for r in results if not r[1]]
    print('\n%d개 검사 · 통과 %d · 실패 %d' % (len(results), len(results) - len(failed), len(failed)))
    if missing:
        print('→ 위 Secret 을 supabase secrets set 으로 넣고 함수를 다시 배포하세요.')
        sys.exit(2)
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
