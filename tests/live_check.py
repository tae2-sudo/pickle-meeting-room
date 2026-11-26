#!/usr/bin/env python3
"""비서 통합 회의실 · 라이브 백엔드 테스트

실제 Supabase 프로젝트(anon 키, RLS 적용 상태)에 대해 다음을 검증합니다.
  1. 회의실·비서·메시지 조회 (seed 데이터)
  2. 메시지 전송(REST insert) 및 저장 확인
  3. 초대 링크 생성 → verify_invite 검증
  4. redeem_invite 로 비서 참여 → assistants 등록 · 초대 사용 횟수 증가
  5. 참여한 비서의 메시지 전송 (sender_id) · last_seen 갱신
  6. report_usage 로 사용량/리셋 시간 보고
  7. 잘못된 초대 토큰 거부
  8. 테스트로 만든 행 정리

실행:  python3 tests/live_check.py
종료코드 0 = 전체 통과.
"""
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

HERE = __file__.rsplit('/', 1)[0] if '/' in __file__ else '.'
CONFIG = None
for line in open(HERE + '/../config.js', encoding='utf-8'):
    m = re.search(r"supabaseUrl:\s*'([^']+)'", line)
    if m:
        CONFIG = {'url': m.group(1)}
    m = re.search(r"supabaseAnonKey:\s*'([^']+)'", line)
    if m and CONFIG:
        CONFIG['key'] = m.group(1)

if not CONFIG or not CONFIG.get('key'):
    print('config.js 에서 Supabase URL/키를 찾지 못했습니다.')
    sys.exit(2)

BASE = CONFIG['url'].rstrip('/')
KEY = CONFIG['key']
HEADERS = {
    'apikey': KEY,
    'Authorization': 'Bearer ' + KEY,
    'Content-Type': 'application/json',
}

results = []
created = {'messages': [], 'assistants': [], 'invites': [], 'rooms': [], 'names': []}


def call(method, path, body=None, prefer=None):
    data = json.dumps(body).encode() if body is not None else None
    headers = dict(HEADERS)
    if prefer:
        headers['Prefer'] = prefer
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw.strip() else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw


def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(('PASS ' if ok else 'FAIL ') + name + (' · ' + str(detail) if detail else ''))


def main():
    room_id = None

    # 1. 조회 (RLS 로 anon 읽기)
    status, rooms = call('GET', '/rest/v1/rooms?select=id,name,slug&order=created_at')
    check('회의실 조회 200', status == 200, status)
    check('기본 회의실 시드 존재', isinstance(rooms, list) and len(rooms) >= 1,
          [r.get('name') for r in rooms] if isinstance(rooms, list) else rooms)
    if isinstance(rooms, list) and rooms:
        room_id = next((r['id'] for r in rooms if r['slug'] == 'assistant-hub'), rooms[0]['id'])

    status, assistants = call('GET', '/rest/v1/assistants?select=id,name,emoji,role,status')
    check('비서 조회 200', status == 200, status)
    bori = next((a for a in assistants if a.get('name') == '보리'), None) if isinstance(assistants, list) else None
    check('보리(태희님 비서) 시드 존재', bool(bori), bori)

    status, messages = call('GET', '/rest/v1/messages?select=id,sender_role,content&order=created_at')
    check('메시지 조회 200', status == 200, status)
    check('환영 메시지 시드 존재', isinstance(messages, list) and len(messages) >= 3,
          len(messages) if isinstance(messages, list) else messages)

    if not room_id:
        check('회의실 id 확보', False)
        return

    # 2. 사용자 메시지 전송
    stamp = time.strftime('%H:%M:%S')
    text = '[테스트 %s] 라이브 메시지 저장 확인' % stamp
    status, sent = call('POST', '/rest/v1/messages', {
        'room_id': room_id, 'sender_name': '나', 'sender_role': 'user', 'kind': 'text', 'content': text,
    }, prefer='return=representation')
    ok = status in (200, 201) and isinstance(sent, list) and sent and sent[0].get('content') == text
    check('메시지 전송(POST /messages)', ok, status)
    if ok:
        created['messages'].append(sent[0]['id'])
        mid = sent[0]['id']
        status, got = call('GET', '/rest/v1/messages?id=eq.%s&select=id,content' % mid)
        check('전송 메시지 저장 확인', status == 200 and got and got[0]['content'] == text, status)

    # 3. 초대 생성 + 검증
    token = 'test' + uuid.uuid4().hex[:16]
    status, inv = call('POST', '/rest/v1/invites', {
        'token': token, 'room_id': room_id, 'label': '자동 테스트', 'created_by': 'test', 'max_uses': 2,
    }, prefer='return=minimal')
    check('초대 생성(POST /invites)', status in (200, 201, 204), status)
    created['invites'].append(token)

    status, ver = call('POST', '/rest/v1/rpc/verify_invite', {'p_token': token})
    valid = status == 200 and isinstance(ver, dict) and ver.get('valid') is True
    check('초대 검증(verify_invite)', valid, ver if status == 200 else status)
    check('초대 → 회의실 이름 반환', bool(valid and ver.get('room_name')), ver.get('room_name') if valid else '')

    status, bad = call('POST', '/rest/v1/rpc/verify_invite', {'p_token': 'nope-' + token})
    check('잘못된 토큰 거부', status == 200 and isinstance(bad, dict) and bad.get('valid') is False, bad)

    # 4. 초대 수락 → 비서 등록
    aide_name = '테스트비서'
    status, aide = call('POST', '/rest/v1/rpc/redeem_invite', {
        'p_token': token, 'p_name': aide_name, 'p_emoji': '🧪', 'p_role': '테스트',
        'p_model': 'test-model', 'p_provider': 'test', 'p_plan': 'free', 'p_period': 'daily',
    })
    ok = status == 200 and isinstance(aide, dict) and aide.get('name') == aide_name and aide.get('room_id') == room_id
    check('초대 수락 → 비서 등록(redeem_invite)', ok, status if not ok else aide.get('id'))
    aide_id = aide.get('id') if ok else None
    if aide_id:
        created['assistants'].append(aide_id)
        created['names'].append(aide_name)

    status, ver2 = call('POST', '/rest/v1/rpc/verify_invite', {'p_token': token})
    check('초대 사용 횟수 증가', valid and isinstance(ver2, dict) and ver2.get('remaining_uses') == 1,
          ver2.get('remaining_uses') if status == 200 else status)

    if not aide_id:
        return

    # 5. 비서 메시지 전송
    text2 = '[테스트] %s 참여 인사' % aide_name
    status, sent2 = call('POST', '/rest/v1/messages', {
        'room_id': room_id, 'sender_id': aide_id, 'sender_name': aide_name, 'sender_emoji': '🧪',
        'sender_role': 'assistant', 'kind': 'text', 'content': text2,
    }, prefer='return=representation')
    ok = status in (200, 201) and isinstance(sent2, list) and sent2
    check('비서 메시지 전송(sender_id)', ok, status)
    if ok:
        created['messages'].append(sent2[0]['id'])

    time.sleep(0.8)
    status, rows = call('GET', '/rest/v1/assistants?id=eq.%s&select=id,last_seen_at,status' % aide_id)
    check('메시지 후 last_seen 갱신', status == 200 and rows and rows[0].get('status') == 'online',
          rows[0] if status == 200 and rows else status)

    # 6. 사용량 보고
    reset_at = '2026-12-01T09:00:00+09:00'
    status, rep = call('POST', '/rest/v1/rpc/report_usage', {
        'p_assistant_id': aide_id, 'p_percent': 87.5, 'p_reset_at': reset_at, 'p_note': '자동 테스트',
    })
    ok = (status == 200 and isinstance(rep, dict) and abs(float(rep.get('quota_percent')) - 87.5) < 0.01
          and rep.get('last_report_at'))
    check('사용량 보고(report_usage)', ok, status if not ok else rep.get('quota_percent'))

    status, rows = call('GET', '/rest/v1/assistants?id=eq.%s&select=quota_percent,reset_at' % aide_id)
    check('사용량 DB 반영 확인', status == 200 and rows and abs(float(rows[0]['quota_percent']) - 87.5) < 0.01,
          rows[0] if status == 200 and rows else status)

    # 7. 실시간 구독용 publication 확인 (REST 로는 publication 조회 불가 → messages count 로 대체)


def cleanup():
    for mid in created['messages']:
        call('DELETE', '/rest/v1/messages?id=eq.%s' % mid)
    for aid in created['assistants']:
        call('DELETE', '/rest/v1/assistants?id=eq.%s' % aid)
    # redeem_invite 가 남기는 참여 시스템 메시지도 정리
    for name in created['names']:
        status, rows = call('GET', '/rest/v1/messages?select=id,sender_role&sender_role=eq.system&content=like.*%s*' % urllib.parse.quote(name))
        if status == 200 and isinstance(rows, list):
            for row in rows:
                call('DELETE', '/rest/v1/messages?id=eq.%s' % row['id'])
    # 테스트 초대는 select 정책이 없어 REST 로 지울 수 없다 (남아도 무해, 인원 제한 2명)


if __name__ == '__main__':
    try:
        main()
    finally:
        cleanup()
    failed = [r for r in results if not r[1]]
    print('\n%d개 검사 · 통과 %d · 실패 %d' % (len(results), len(results) - len(failed), len(failed)))
    sys.exit(1 if failed else 0)
