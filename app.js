/* ──────────────────────────────────────────────────────────────
   비서 통합 회의실 — app logic (vanilla JS + Supabase Realtime)
   회의실 · 비서 · 메시지는 Supabase Postgres 에 저장되고
   postgres_changes 로 실시간 동기화됩니다.
   ────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var CFG = window.PICKLE_ROOM_CONFIG || {};
  var APP_VERSION = CFG.appVersion || '1.1.0';
  var INVITE_BASE = CFG.publicBase || (location.origin + location.pathname);
  var MIN = 60000, HOUR = 3600000, DAY = 86400000;
  var ONLINE_MS = 60 * 60 * 1000;

  var COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899',
    '#8b5cf6', '#14b8a6', '#ef4444', '#3b82f6', '#84cc16'];

  var SETTINGS_KEY = 'pickle-meeting-room.settings.v2';
  var DEFAULT_SETTINGS = { risk: 10, soon: 30, staleHours: 6, startDash: false, enterSend: true };

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /* ── helpers ─────────────────────────────────────────────── */
  function uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function fmtPct(v) {
    if (v == null || isNaN(v)) return '—';
    var n = Number(v);
    if (Math.abs(n - Math.round(n)) < 0.05) return String(Math.round(n));
    return n.toFixed(1);
  }
  function fmtClock(ts) {
    var d = new Date(ts);
    var h = d.getHours();
    var ampm = h < 12 ? '오전' : '오후';
    var hh = h % 12; if (hh === 0) hh = 12;
    return ampm + ' ' + hh + ':' + pad2(d.getMinutes());
  }
  function dayKey(ts) { var d = new Date(ts); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function dayLabel(ts) {
    var d = new Date(ts), n = new Date();
    if (dayKey(ts) === dayKey(n.getTime())) return '오늘';
    var y = new Date(n.getTime() - DAY);
    if (dayKey(ts) === dayKey(y.getTime())) return '어제';
    return (d.getMonth() + 1) + '월 ' + d.getDate() + '일 (' + '일월화수목금토'[d.getDay()] + ')';
  }
  function relTime(ts) {
    if (!ts) return '기록 없음';
    var diff = Date.now() - ts;
    if (diff < 0) return '방금';
    if (diff < 45 * 1000) return '방금';
    var m = Math.floor(diff / MIN);
    if (m < 60) return m + '분 전';
    var h = Math.floor(diff / HOUR);
    if (h < 24) return h + '시간 전';
    var d = Math.floor(diff / DAY);
    if (d < 8) return d + '일 전';
    var dt = new Date(ts);
    return (dt.getMonth() + 1) + '월 ' + dt.getDate() + '일';
  }
  function relUntil(ts) {
    if (!ts) return '';
    var diff = ts - Date.now();
    if (diff <= 0) return '리셋 지남';
    var m = Math.floor(diff / MIN);
    if (m < 1) return '리셋 곧';
    if (m < 60) return '리셋 ' + m + '분 후';
    var h = Math.floor(diff / HOUR);
    if (h < 24) {
      var rm = Math.floor((diff % HOUR) / MIN);
      return '리셋 ' + h + '시간' + (rm ? ' ' + rm + '분' : '') + ' 후';
    }
    var d = Math.floor(diff / DAY);
    var rh = Math.floor((diff % DAY) / HOUR);
    return '리셋 ' + d + '일' + (rh ? ' ' + rh + '시간' : '') + ' 후';
  }
  function toLocalInput(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function randomToken() {
    var bytes = new Uint8Array(10);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  /* ── settings (기기별 환경 설정만 로컬에 저장) ─────────────── */
  function loadSettings() {
    var out = {};
    Object.keys(DEFAULT_SETTINGS).forEach(function (k) { out[k] = DEFAULT_SETTINGS[k]; });
    try {
      var raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
      if (raw && typeof raw === 'object') {
        if (isFinite(raw.risk)) out.risk = clamp(Number(raw.risk), 1, 50);
        if (isFinite(raw.soon)) out.soon = clamp(Number(raw.soon), 2, 80);
        if (isFinite(raw.staleHours)) out.staleHours = clamp(Number(raw.staleHours), 1, 72);
        out.startDash = !!raw.startDash;
        out.enterSend = raw.enterSend !== false;
      }
    } catch (e) { /* ignore */ }
    return out;
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch (e) { /* ignore */ }
  }

  /* ── state ───────────────────────────────────────────────── */
  var state = { rooms: [], quotas: [], quotaRuns: [], activeRoomId: null, settings: loadSettings(), updatedAt: 0 };
  var ui = {
    dashboardOpen: !!state.settings.startDash,
    search: '',
    searchOpen: false,
    editingId: null,
    promptHandler: null,
    loaded: false
  };
  var connState = 'connecting';
  var pendingSlug = null;   // ?room=<slug> 딥링크 (예: ?room=upload-calendar)
  var sb = null;
  var channel = null;
  var retryTimer = null;
  var retryScheduled = false;
  var liveOnce = false;

  function scheduleReconnect(delay) {
    if (retryScheduled) return;
    retryScheduled = true;
    retryTimer = setTimeout(function () {
      retryScheduled = false;
      if (navigator.onLine === false) { setConn('offline'); return; }
      connectRealtime();
    }, delay);
  }

  function currentRoom() {
    if (!state.rooms.length) return null;
    var r = state.rooms.find(function (x) { return x.id === state.activeRoomId; });
    return r || state.rooms[0];
  }
  function roomById(id) { return state.rooms.find(function (r) { return r.id === id; }) || null; }
  function assistantById(id) {
    var room = currentRoom();
    if (!room) return null;
    return room.assistants.find(function (a) { return a.id === id; }) || null;
  }
  function statusOf(a) {
    if (a.remaining == null || isNaN(a.remaining)) return 'unknown';
    if (a.remaining < state.settings.risk) return 'risk';
    if (a.remaining < state.settings.soon) return 'soon';
    return 'ok';
  }
  var STATUS_LABEL = { ok: '정상', soon: '임박', risk: '위험', unknown: '미확인' };
  function isReported(a) {
    return !!a.lastReportAt && (Date.now() - a.lastReportAt) < state.settings.staleHours * HOUR;
  }
  function counts() {
    var c = { ok: 0, soon: 0, risk: 0, unknown: 0, total: 0, reported: 0, online: 0 };
    var room = currentRoom();
    if (room) {
      room.assistants.forEach(function (a) {
        c[statusOf(a)]++;
        c.total++;
        if (isReported(a)) c.reported++;
        if (a.online) c.online++;
      });
    }
    return c;
  }

  /* ── mapping rows ────────────────────────────────────────── */
  function mapAssistant(row, idx) {
    var seen = row.last_seen_at ? Date.parse(row.last_seen_at) : 0;
    return {
      id: row.id,
      roomId: row.room_id,
      name: row.name || '비서',
      handle: row.handle || '',
      emoji: row.emoji || '🤖',
      role: row.role || '',
      provider: row.provider || '',
      model: row.model || '',
      plan: row.plan || '',
      period: row.period === 'weekly' ? 'weekly' : 'daily',
      mode: row.mode === 'manual' ? 'manual' : 'auto',
      remaining: row.quota_percent == null ? null : Number(row.quota_percent),
      resetAt: row.reset_at ? Date.parse(row.reset_at) : null,
      lastReportAt: row.last_report_at ? Date.parse(row.last_report_at) : null,
      lastSeenAt: seen || null,
      online: row.status === 'online' && !!seen && (Date.now() - seen) < ONLINE_MS,
      extra: row.extra || '',
      note: row.note || '',
      color: row.color || COLORS[(idx || 0) % COLORS.length]
    };
  }
  function mapMessage(row) {
    return {
      id: row.id,
      roomId: row.room_id,
      type: row.sender_role === 'assistant' ? 'assistant' : (row.sender_role === 'system' ? 'system' : 'user'),
      authorId: row.sender_id || (row.sender_role === 'user' ? 'me' : null),
      text: row.content || '',
      at: row.created_at ? Date.parse(row.created_at) : Date.now(),
      name: row.sender_name || '',
      emoji: row.sender_emoji || ''
    };
  }
  function sortMessages(list) {
    list.sort(function (a, b) { return a.at - b.at; });
    return list;
  }

  /* ── 📊 AI-API-사용량 채널방 (비서 회의실과 분리된 방) ──────── */
  var QUOTA_SLUG = 'api-usage';
  var QUOTA_STATUS_LABEL = { ok: '정상', limited: '한도초과', error: '오류', unknown: '미확인' };

  function quotaRoom() {
    return state.rooms.find(function (r) { return r.slug === QUOTA_SLUG; }) || null;
  }
  function isQuotaRoom() {
    var r = currentRoom();
    return !!(r && r.slug === QUOTA_SLUG);
  }
  function mapQuota(row) {
    return {
      provider: row.provider,
      label: row.label || row.provider,
      emoji: row.emoji || '🔧',
      category: row.category || '기타',
      status: QUOTA_STATUS_LABEL[row.status] ? row.status : 'unknown',
      available: row.available,
      httpStatus: row.http_status,
      remainingPct: row.remaining_pct == null ? null : Number(row.remaining_pct),
      pctSource: (row.detail && row.detail.pct_source) || null,
      usage: (row.detail && row.detail.usage) || null,
      notionSync: (row.detail && row.detail.notion_sync) || null,
      notionUsed: (row.detail && row.detail.usage && row.detail.usage.notion_used != null)
        ? Number(row.detail.usage.notion_used) : 0,
      notionUnit: (row.detail && row.detail.usage && row.detail.usage.unit) || '회',
      remainingText: row.remaining_text || '',
      limitText: row.limit_text || '',
      usedText: row.used_text || '',
      resetAt: row.reset_at ? Date.parse(row.reset_at) : null,
      guide: row.guide || '',
      models: row.models || '',
      notes: row.notes || '',
      latencyMs: row.latency_ms,
      sortOrder: row.sort_order || 100,
      checkedAt: row.checked_at ? Date.parse(row.checked_at) : null
    };
  }
  function mapRun(row) {
    return {
      id: row.id,
      finishedAt: row.finished_at ? Date.parse(row.finished_at) : null,
      ok: row.ok_count || 0,
      limited: row.limited_count || 0,
      error: row.error_count || 0,
      unknown: row.unknown_count || 0,
      total: row.total_count || 0
    };
  }
  function sortQuotas() {
    state.quotas.sort(function (a, b) {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return String(a.label).localeCompare(String(b.label), 'ko');
    });
  }
  function quotaCounts() {
    var c = { ok: 0, limited: 0, error: 0, unknown: 0, total: state.quotas.length };
    state.quotas.forEach(function (q) { c[q.status] = (c[q.status] || 0) + 1; });
    return c;
  }
  function lastMeasuredAt() {
    if (state.quotaRuns.length && state.quotaRuns[0].finishedAt) return state.quotaRuns[0].finishedAt;
    var latest = 0;
    state.quotas.forEach(function (q) { if (q.checkedAt && q.checkedAt > latest) latest = q.checkedAt; });
    return latest || null;
  }
  function applyQuotas(quotaRows, runRows) {
    state.quotas = (quotaRows || []).map(mapQuota);
    sortQuotas();
    state.quotaRuns = (runRows || []).map(mapRun).sort(function (a, b) {
      return (b.finishedAt || 0) - (a.finishedAt || 0);
    }).slice(0, 8);
  }

  function applySnapshot(rooms, assistants, messages) {
    var keepActive = state.activeRoomId;
    var out = rooms.map(function (r) {
      return {
        id: r.id,
        slug: r.slug,
        name: r.name || '회의실',
        description: r.description || '',
        createdAt: r.created_at ? Date.parse(r.created_at) : Date.now(),
        assistants: [],
        messages: []
      };
    });
    var byId = {};
    out.forEach(function (r) { byId[r.id] = r; });
    (assistants || []).forEach(function (row, i) {
      var a = mapAssistant(row, i);
      if (byId[a.roomId]) byId[a.roomId].assistants.push(a);
    });
    (messages || []).forEach(function (row) {
      if (byId[row.room_id]) byId[row.room_id].messages.push(mapMessage(row));
    });
    out.forEach(function (r) {
      sortMessages(r.messages);
      r.assistants.sort(function (a, b) { return (a.name || '').localeCompare(b.name || '', 'ko'); });
    });
    state.rooms = out;
    state.activeRoomId = (keepActive && byId[keepActive]) ? keepActive : (out[0] ? out[0].id : null);
    if (pendingSlug) {
      var target = out.find(function (r) { return r.slug === pendingSlug; });
      if (target) { state.activeRoomId = target.id; pendingSlug = null; }
    }
    state.updatedAt = Date.now();
  }

  /* ── Supabase reads/writes ───────────────────────────────── */
  function setConn(next) {
    connState = next;
    var el = $('#connChip');
    var labels = { connecting: '연결 중…', live: '실시간 연결됨', error: '연결 끊김', offline: '오프라인' };
    if (el) {
      el.dataset.state = next;
      el.title = '실시간 연결 상태 · ' + (labels[next] || next);
    }
    var txt = $('#connText');
    if (txt) txt.textContent = labels[next] || next;
    var sc = $('#setConn');
    if (sc) sc.textContent = labels[next] || next;
  }

  async function loadRemote(opts) {
    opts = opts || {};
    if (!sb) return false;
    if (!opts.silent && connState !== 'live') setConn('connecting');
    var res = await Promise.all([
      sb.from('rooms').select('*').order('created_at', { ascending: true }),
      sb.from('assistants').select('*').order('created_at', { ascending: true }),
      sb.from('messages').select('*').order('created_at', { ascending: false }).limit(400),
      sb.from('api_quotas').select('*').order('sort_order', { ascending: true }),
      sb.from('api_quota_runs').select('*').order('finished_at', { ascending: false }).limit(8)
    ]);
    var err = res[0].error || res[1].error || res[2].error || res[3].error || res[4].error;
    if (err) {
      setConn('error');
      toast('데이터를 불러오지 못했습니다: ' + err.message);
      renderAll();
      return false;
    }
    applySnapshot(res[0].data || [], res[1].data || [], res[2].data || []);
    applyQuotas(res[3].data || [], res[4].data || []);
    ui.loaded = true;
    renderAll();
    if (!ui.dashboardOpen) { renderChat(); settleAtBottom(); }
    return true;
  }

  function reload(silent) {
    loadRemote({ silent: silent }).then(function (ok) {
      if (ok) toast(silent ? '최신 상태로 동기화했습니다.' : '데이터를 새로 불러왔습니다.');
    });
  }

  function dbError(err, what) {
    if (!err) return false;
    toast(what + ' 실패: ' + (err.message || err));
    return true;
  }

  async function insertMessage(row) {
    var res = await sb.from('messages').insert(row).select().single();
    return res;
  }

  /* ── realtime ────────────────────────────────────────────── */
  function connectRealtime() {
    if (!sb) return;
    clearTimeout(retryTimer);
    retryScheduled = false;
    if (channel) { try { sb.removeChannel(channel); } catch (e) { /* ignore */ } channel = null; }
    setConn(navigator.onLine === false ? 'offline' : 'connecting');

    var ch = sb.channel('meeting-room-live');
    ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, function (p) { onMessageInsert(p.new); })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'assistants' }, function (p) { onAssistantUpsert(p.new); })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'assistants' }, function (p) { onAssistantUpsert(p.new); })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'assistants' }, function (p) { onAssistantDelete(p.old); })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'rooms' }, function (p) { onRoomUpsert(p.new); })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rooms' }, function (p) { onRoomUpsert(p.new); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'api_quotas' }, function (p) { onQuotaChange(p); })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'api_quota_runs' }, function (p) { onQuotaRunInsert(p.new); });

    ch.subscribe(function (status) {
      if (ch !== channel) return;   // 이미 교체된 예전 채널의 콜백은 무시
      if (status === 'SUBSCRIBED') {
        setConn('live');
        if (!ui.loaded) loadRemote();
        else if (liveOnce) loadRemote({ silent: true });  // 끊겼던 동안 놓친 변경 보충
        liveOnce = true;
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        setConn('error');
        scheduleReconnect(12000);
      } else if (status === 'CLOSED') {
        setConn('connecting');
        scheduleReconnect(5000);
      }
    });
    channel = ch;
  }

  function onMessageInsert(row) {
    var room = roomById(row.room_id);
    if (!room) { loadRemote({ silent: true }); return; }
    var msg = mapMessage(row);
    if (room.messages.some(function (m) { return m.id === msg.id; })) return;
    room.messages.push(msg);
    sortMessages(room.messages);
    state.updatedAt = Date.now();
    renderTop();
    renderSummary();
    if (room.id === state.activeRoomId) {
      if (ui.dashboardOpen) renderDashboard();
      else { renderChat(); scrollChatIfNearBottom(); }
    }
  }

  function onAssistantUpsert(row) {
    var room = roomById(row.room_id);
    if (!room) { loadRemote({ silent: true }); return; }
    var mapped = mapAssistant(row, room.assistants.length);
    var i = room.assistants.findIndex(function (a) { return a.id === mapped.id; });
    if (i >= 0) room.assistants[i] = mapped;
    else room.assistants.push(mapped);
    state.updatedAt = Date.now();
    renderAll();
    if (!ui.dashboardOpen) { renderChat(); scrollChatIfNearBottom(); }
  }

  function onAssistantDelete(old) {
    if (!old || !old.id) return;
    var touched = false;
    state.rooms.forEach(function (room) {
      if (old.room_id && room.id !== old.room_id) return;
      var before = room.assistants.length;
      room.assistants = room.assistants.filter(function (a) { return a.id !== old.id; });
      if (room.assistants.length !== before) touched = true;
    });
    if (!touched) return;
    renderAll();
    if (!ui.dashboardOpen) { renderChat(); scrollChatIfNearBottom(); }
  }

  function onQuotaChange(payload) {
    var row = payload.new && payload.new.provider ? payload.new : null;
    if (!row) {
      if (payload.old && payload.old.provider) {
        state.quotas = state.quotas.filter(function (q) { return q.provider !== payload.old.provider; });
      }
    } else {
      var mapped = mapQuota(row);
      var i = state.quotas.findIndex(function (q) { return q.provider === mapped.provider; });
      if (i >= 0) state.quotas[i] = mapped; else state.quotas.push(mapped);
      sortQuotas();
    }
    state.updatedAt = Date.now();
    renderTop();
    renderDrawer();
    if (isQuotaRoom()) renderQuota();
  }

  function onQuotaRunInsert(row) {
    if (!row || !row.id) return;
    var mapped = mapRun(row);
    state.quotaRuns = state.quotaRuns.filter(function (r) { return r.id !== mapped.id; });
    state.quotaRuns.unshift(mapped);
    state.quotaRuns = state.quotaRuns.slice(0, 8);
    if (isQuotaRoom()) renderQuota();
    renderTop();
  }

  function onRoomUpsert(row) {
    var room = roomById(row.id);
    if (room) {
      room.name = row.name || room.name;
      room.description = row.description || room.description;
      renderTop();
      renderDrawer();
    } else {
      loadRemote({ silent: true });
    }
  }

  /* ── toast ───────────────────────────────────────────────── */
  var toastTimer = null;
  function toast(msg) {
    var el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2400);
  }

  /* ── rendering: top bar & summary ────────────────────────── */
  function renderTop() {
    var room = currentRoom();
    var c = counts();
    $('#roomTitle').textContent = room ? room.name : '회의실';
    document.title = room ? '# ' + room.name : '# 비서-통합-회의실';
    if (room && room.slug === CAL_SLUG) {
      var cs = calMonthStats();
      $('#roomMeta').textContent = (calState.loading && !calState.items.length)
        ? '노션에서 불러오는 중…'
        : ((calState.error && !calState.items.length)
          ? '노션 읽기 실패'
          : cs.total + '건 · 공개 ' + cs.done +
            (cs.scheduled ? ' · 예약 ' + cs.scheduled : ''));
      $('#memberCount').textContent = String(cs.total);
      return;
    }
    if (room && room.slug === YT_SLUG) {
      var ys = (ytState.data && ytState.data.summary) || null;
      if (ytState.loading && !ys) $('#roomMeta').textContent = '유튜브에서 불러오는 중…';
      else if (ytState.error && !ys) $('#roomMeta').textContent = '유튜브 읽기 실패';
      else if (ys) {
        $('#roomMeta').textContent = '구독 ' + ytNum(ys.subscribers) + ' · 7일 조회 ' + ytNum(ys.views7d) +
          ' · 미응답 댓글 ' + (ys.unanswered || 0) +
          (ytState.fetchedAt ? ' · ' + relTime(ytState.fetchedAt) : '');
      } else $('#roomMeta').textContent = '유튜브 통계를 기다리는 중…';
      $('#memberCount').textContent = ys ? String(ys.unanswered || 0) : '0';
      return;
    }
    if (room && room.slug === QUOTA_SLUG) {
      var qc = quotaCounts();
      var lastAt = lastMeasuredAt();
      $('#roomMeta').textContent = 'API ' + qc.total + '개 · 정상 ' + qc.ok + ' · 한도초과 ' + qc.limited +
        ' · ' + (lastAt ? '마지막 실측 ' + relTime(lastAt) : '실측 기록 없음');
      $('#memberCount').textContent = String(qc.total);
      return;
    }
    if (!room) {
      $('#roomMeta').textContent = ui.loaded ? '회의실이 없습니다' : '불러오는 중…';
      $('#memberCount').textContent = '0';
      return;
    }
    $('#roomMeta').textContent = room.messages.length + '개 메시지 · 온라인 ' + c.online + '/' + (c.total + 1);
    $('#memberCount').textContent = String(c.total + 1);
  }

  function renderSummary() {
    var c = counts();
    $('#sumRisk').textContent = c.risk;
    $('#sumSoon').textContent = c.soon;
    $('#sumOk').textContent = c.ok;
    $('#sumUnknown').textContent = c.unknown;
    [['#sumRisk', c.risk], ['#sumSoon', c.soon], ['#sumOk', c.ok], ['#sumUnknown', c.unknown]].forEach(function (pair) {
      var el = $(pair[0]);
      if (el) el.closest('.sum-count').classList.toggle('has', pair[1] > 0);
    });
    var diff = Date.now() - (state.updatedAt || Date.now());
    var label = !state.updatedAt ? '—' : (diff < 60 * 1000 ? '방금 갱신' : (Math.floor(diff / MIN) + '분 전 갱신'));
    $('#summaryUpdated').textContent = label;
  }

  /* ── rendering: chat ─────────────────────────────────────── */
  function mentionMatcher() {
    var room = currentRoom();
    if (!room) return null;
    var names = ['전체'].concat(room.assistants.map(function (a) { return a.name; }));
    names = names.filter(Boolean).sort(function (a, b) { return b.length - a.length; });
    if (!names.length) return null;
    return new RegExp('@(' + names.map(escapeRegExp).join('|') + ')', 'g');
  }

  function appendHighlighted(parent, text, query) {
    if (!query) { parent.appendChild(document.createTextNode(text)); return; }
    var q = query.toLowerCase();
    var lower = text.toLowerCase();
    var i = 0, idx;
    while ((idx = lower.indexOf(q, i)) !== -1) {
      if (idx > i) parent.appendChild(document.createTextNode(text.slice(i, idx)));
      var mark = document.createElement('mark');
      mark.textContent = text.slice(idx, idx + q.length);
      parent.appendChild(mark);
      i = idx + q.length;
    }
    if (i < text.length) parent.appendChild(document.createTextNode(text.slice(i)));
  }

  function renderMessageText(target, text, query) {
    var matcher = mentionMatcher();
    if (!matcher) { appendHighlighted(target, text, query); return; }
    matcher.lastIndex = 0;
    var last = 0, m;
    while ((m = matcher.exec(text)) !== null) {
      if (m.index > last) appendHighlighted(target, text.slice(last, m.index), query);
      var span = document.createElement('span');
      span.className = 'mention' + (m[1] === '전체' ? ' all' : '');
      span.textContent = '@' + m[1];
      target.appendChild(span);
      last = m.index + m[0].length;
    }
    if (last < text.length) appendHighlighted(target, text.slice(last), query);
  }

  function avatarEl(name, color, emoji, size) {
    var el = document.createElement('div');
    el.className = 'avatar';
    el.style.background = color || '#94a3b8';
    if (size) { el.style.width = size + 'px'; el.style.height = size + 'px'; }
    if (emoji) {
      el.textContent = emoji;
      el.classList.add('emoji');
    } else {
      el.textContent = (name || '?').trim().charAt(0).toUpperCase();
    }
    return el;
  }

  function authorOf(msg) {
    if (msg.type === 'user') return { name: '나', color: '#111827', emoji: '' };
    var a = assistantById(msg.authorId);
    if (a) return { name: a.name, color: a.color, emoji: a.emoji };
    return { name: msg.name || '알 수 없음', color: '#94a3b8', emoji: msg.emoji || '' };
  }

  function renderChat(opts) {
    opts = opts || {};
    if (isQuotaRoom() || isCalendarRoom() || isYoutubeRoom()) return;   // 채널방은 각자의 화면을 따로 쓴다
    var list = $('#chatList');
    var chatEl = $('#chatView');
    var room = currentRoom();
    var prevTop = chatEl.scrollTop;
    var q = ui.search.trim().toLowerCase();

    var msgs = room ? room.messages.slice() : [];
    if (q) {
      msgs = msgs.filter(function (m) {
        if (m.type === 'system') return m.text.toLowerCase().indexOf(q) !== -1;
        var a = m.authorId === 'me' ? { name: '나' } : assistantById(m.authorId);
        var name = (a && a.name) || m.name || '';
        return m.text.toLowerCase().indexOf(q) !== -1 || name.toLowerCase().indexOf(q) !== -1;
      });
    }

    if (q) $('#searchCount').textContent = msgs.length ? msgs.length + '개 일치' : '결과 없음';
    else $('#searchCount').textContent = '';

    list.innerHTML = '';

    if (!room) {
      var ph = document.createElement('div');
      ph.className = 'chat-empty';
      ph.innerHTML = ui.loaded
        ? '<b>회의실이 없습니다</b>왼쪽 메뉴에서 새 회의실을 만들어 보세요.'
        : '<b>회의실을 불러오는 중…</b>Supabase에 연결하고 있습니다.';
      list.appendChild(ph);
      return;
    }

    if (!msgs.length) {
      var empty = document.createElement('div');
      empty.className = 'chat-empty';
      empty.innerHTML = q
        ? '<b>검색 결과가 없습니다</b>다른 단어로 찾아보세요.'
        : '<b>아직 메시지가 없습니다</b>아래에 지시를 입력하거나 @멘션으로 비서를 불러보세요.';
      list.appendChild(empty);
      return;
    }

    var lastDay = null;
    msgs.forEach(function (msg) {
      var label = dayLabel(msg.at);
      if (label !== lastDay) {
        var day = document.createElement('div');
        day.className = 'day';
        day.textContent = label;
        list.appendChild(day);
        lastDay = label;
      }

      if (msg.type === 'system') {
        var sys = document.createElement('div');
        sys.className = 'msg system';
        var pill = document.createElement('div');
        pill.className = 'sys-pill';
        appendHighlighted(pill, msg.text, ui.search.trim());
        sys.appendChild(pill);
        list.appendChild(sys);
        return;
      }

      var isMe = msg.type === 'user';
      var author = authorOf(msg);

      var wrap = document.createElement('div');
      wrap.className = 'msg' + (isMe ? ' me' : '');
      wrap.appendChild(avatarEl(author.name, author.color, author.emoji));

      var body = document.createElement('div');
      body.className = 'msg-body';

      var nameRow = document.createElement('div');
      nameRow.className = 'msg-name';
      var nameSpan = document.createElement('span');
      nameSpan.textContent = author.name;
      var time = document.createElement('span');
      time.className = 'msg-time';
      time.textContent = fmtClock(msg.at);
      time.title = dayLabel(msg.at) + ' ' + fmtClock(msg.at);
      nameRow.appendChild(nameSpan);
      nameRow.appendChild(time);

      var bubble = document.createElement('div');
      bubble.className = 'bubble';
      renderMessageText(bubble, msg.text, ui.search.trim());

      body.appendChild(nameRow);
      body.appendChild(bubble);
      wrap.appendChild(body);
      list.appendChild(wrap);
    });

    if (opts.bottom) requestAnimationFrame(scrollToBottom);
    else if (prevTop) chatEl.scrollTop = prevTop;
  }

  function scrollToBottom() {
    var chatEl = $('#chatView');
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  function settleAtBottom() {
    scrollToBottom();
    requestAnimationFrame(scrollToBottom);
    setTimeout(scrollToBottom, 240);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { scrollToBottom(); }).catch(function () {});
    }
  }

  function scrollChatIfNearBottom() {
    var chatEl = $('#chatView');
    if (chatEl.hidden) return;
    var near = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 200;
    if (near) requestAnimationFrame(scrollToBottom);
  }

  /* ── rendering: dashboard ────────────────────────────────── */
  function cardHTML(a) {
    var st = statusOf(a);
    var pctTxt = fmtPct(a.remaining);
    var w = a.remaining == null ? 0 : clamp(Number(a.remaining), 0, 100);
    var reported = isReported(a);
    var meta = '';

    if (a.resetAt) {
      meta += '<div class="meta-row">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.4"/><path d="M12 7.6V12l3 2"/></svg>' +
        '<span>' + esc(relUntil(a.resetAt)) + '</span></div>';
    }
    if (a.lastReportAt) {
      meta += '<div class="meta-row' + (reported ? '' : ' warn') + '">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.4"/><path d="M12 8v4.4l2.8 1.8"/></svg>' +
        '<span>보고 ' + esc(relTime(a.lastReportAt)) + (reported ? '' : ' · 갱신 필요') + '</span></div>';
    } else {
      meta += '<div class="meta-row">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.4"/><path d="M9 12h6"/></svg>' +
        '<span>보고 기록 없음</span></div>';
    }

    var tags = '';
    if (a.extra) tags += '<span class="tag">추가 ' + esc(a.extra) + '</span>';
    if (a.model) tags += '<span class="tag">' + esc(a.model) + '</span>';
    if (a.note) tags += '<span class="tag" title="' + esc(a.note) + '">' + esc(a.note) + '</span>';

    return '' +
      '<article class="card" data-id="' + esc(a.id) + '">' +
      '<div class="card-top">' +
      '<span class="dot" data-state="' + st + '"></span>' +
      '<span class="card-name">' + esc(a.emoji) + ' ' + esc(a.name) + '</span>' +
      '<span class="badge' + (a.mode === 'manual' ? ' manual' : '') + '">' + (a.mode === 'manual' ? '수동' : '자동') + '</span>' +
      '</div>' +
      '<div class="pct-row">' +
      (st === 'unknown'
        ? '<span class="pct unknown">—</span><span class="pct-label">미보고</span>'
        : '<span class="pct">' + pctTxt + '<small>%</small></span><span class="pct-label">남음</span>') +
      '</div>' +
      '<div class="bar"><i data-state="' + st + '" style="width:' + w + '%"></i></div>' +
      '<span class="status-pill" data-state="' + st + '"><i></i>' + STATUS_LABEL[st] + '</span>' +
      (meta ? '<div class="card-meta">' + meta + '</div>' : '') +
      (tags ? '<div class="tags">' + tags + '</div>' : '') +
      '<button class="card-btn" data-act="edit" data-id="' + esc(a.id) + '">잔여 입력</button>' +
      '</article>';
  }

  function sectionHTML(title, list) {
    if (!list.length) return '';
    return '<section class="dash-section">' +
      '<div class="section-head">' + title + ' <span class="section-count">' + list.length + '명</span></div>' +
      '<div class="card-grid">' + list.map(cardHTML).join('') + '</div>' +
      '</section>';
  }

  function renderDashboard() {
    var room = currentRoom();
    var c = counts();
    $('#dashMeta').textContent = c.total + '명 · ' + c.reported + '명 보고 · 위험 <' +
      state.settings.risk + '% · 임박 <' + state.settings.soon + '% · ' +
      state.settings.staleHours + '시간 지나면 갱신 필요';

    if (!room) {
      $('#dashBody').innerHTML = '<div class="dash-empty">회의실을 불러오는 중입니다.</div>';
      return;
    }
    var daily = room.assistants.filter(function (a) { return a.period === 'daily'; });
    var weekly = room.assistants.filter(function (a) { return a.period === 'weekly'; });

    var html = '';
    if (!room.assistants.length) {
      html = '<div class="dash-empty">아직 등록된 비서가 없습니다.<br>＋ 버튼으로 비서를 초대해 보세요.</div>';
    } else {
      html += sectionHTML('일일', daily);
      html += sectionHTML('주간', weekly);
    }
    $('#dashBody').innerHTML = html;
  }

  function setDashboard(open) {
    ui.dashboardOpen = open;
    if (isQuotaRoom() || isYoutubeRoom()) { applyRoomMode(); return; }
    $('#dashboard').hidden = !open;
    $('#chatView').hidden = open;
    $('#summaryToggle').setAttribute('aria-expanded', String(open));
    $('#summaryRight').classList.toggle('collapsed', !open);
    if (open) {
      renderDashboard();
      $('#dashboard').scrollTop = 0;
    } else {
      renderChat();
      settleAtBottom();
    }
    applyRoomMode();
  }

  /* ── rendering: 📊 AI-API-사용량 채널방 ──────────────────── */
  function quotaDot(status) {
    if (status === 'ok') return 'ok';
    if (status === 'limited' || status === 'error') return 'risk';
    return 'unknown';
  }

  function quotaChipsHTML(c) {
    return [['ok', '정상', c.ok], ['limited', '한도초과', c.limited], ['error', '오류', c.error], ['unknown', '미확인', c.unknown]]
      .map(function (p) {
        return '<span class="q-chip" data-state="' + p[0] + '"><i></i>' + p[1] + ' <b>' + p[2] + '</b></span>';
      }).join('');
  }

  function quotaCardHTML(q) {
    var st = q.status;
    var pct = q.remainingPct;
    var est = q.pctSource === 'estimated';
    var notionTag = '';
    if (q.notionSync && q.notionSync.ok !== false && q.notionUsed > 0) {
      var unit = q.notionUnit === '자' ? '자' : '회';
      notionTag = '<span class="q-tag notion" title="노션 03 - 제작 기록에 적힌 외부 사용분(하한 추정)을 합산한 값입니다">노션 +' +
        esc(Number(q.notionUsed).toLocaleString('ko-KR')) + unit + '</span>';
    }
    var value;
    if (pct != null) {
      value = '<span class="q-value">' + fmtPct(pct) + '<small>%</small></span><span class="q-value-sub">남음</span>' +
        (est ? '<span class="q-tag" title="API가 숫자를 주지 않아 기준 무료 한도에서 누적 사용량을 뺀 예상치입니다">예상</span>' : '') +
        notionTag;
    } else if (st === 'ok') {
      value = '<span class="q-value word ok">사용 가능</span>';
    } else if (st === 'limited') {
      value = '<span class="q-value word limited">한도 초과</span>';
    } else if (st === 'error') {
      value = '<span class="q-value word error">호출 오류</span>';
    } else {
      value = '<span class="q-value word">미확인</span>';
    }
    var bar = pct == null ? '' :
      '<div class="bar"' + (est ? ' data-src="est"' : '') + '><i data-state="' + st + '" style="width:' + clamp(pct, 0, 100) + '%"></i></div>';
    var meta = '';
    if (q.remainingText) meta += '<span class="q-line">' + esc(q.remainingText) + '</span>';
    if (q.limitText) meta += '<span class="q-line muted">' + (est ? '예상 기준 · ' : '') + esc(q.limitText) + '</span>';
    if (q.resetAt && q.resetAt > Date.now()) meta += '<span class="q-line accent">' + esc(relUntil(q.resetAt)) + '</span>';
    if (q.usedText) meta += '<span class="q-line muted">' + esc(q.usedText) + '</span>';
    if (q.notionSync && q.notionSync.ok !== false && q.notionUsed > 0 && q.notionSync.episodes_list && q.notionSync.episodes_list.length) {
      meta += '<span class="q-line muted">노션 기록 ' + esc(q.notionSync.episodes_list.join('·')) + ' 합산</span>';
    }
    if (q.notionSync && q.notionSync.hints && q.notionSync.hints.length) {
      meta += '<span class="q-line muted">노션: ' + esc(q.notionSync.hints[0]) + '</span>';
    }
    if (q.notes) meta += '<span class="q-line warn">' + esc(q.notes) + '</span>';
    return '<article class="q-card" data-state="' + st + '"' + (est ? ' data-src="est"' : '') + '>' +
      '<div class="q-top">' +
      '<span class="q-emoji">' + esc(q.emoji) + '</span>' +
      '<span class="q-name">' + esc(q.label) + '</span>' +
      '<span class="q-badge" data-state="' + st + '">' + (QUOTA_STATUS_LABEL[st] || st) + '</span>' +
      '</div>' +
      '<div class="q-value-row">' + value + '</div>' +
      bar +
      '<div class="q-meta">' + meta + '</div>' +
      (q.guide ? '<p class="q-guide">' + esc(q.guide) + '</p>' : '') +
      '<div class="q-foot"><span>확인 ' + (q.checkedAt ? esc(relTime(q.checkedAt)) : '—') + '</span>' +
      '<span>' + (q.httpStatus ? 'HTTP ' + q.httpStatus : '') + '</span></div>' +
      '</article>';
  }

  function notionSummary() {
    var seen = false, ok = false, eps = {}, total = 0, err = null, fresh = null;
    state.quotas.forEach(function (q) {
      if (!q.notionSync) return;
      seen = true;
      if (q.notionSync.ok !== false) ok = true;
      else if (q.notionSync.error && !err) err = String(q.notionSync.error);
      (q.notionSync.episodes_list || []).forEach(function (e) { eps[e] = 1; });
      if (q.notionSync.episodes) total = Math.max(total, Number(q.notionSync.episodes) || 0);
      if (q.notionSync.fetched_at && !fresh) fresh = Date.parse(q.notionSync.fetched_at) || null;
    });
    var list = Object.keys(eps).sort(function (a, b) {
      var ca = a.replace(/\d+/g, ''), cb = b.replace(/\d+/g, '');
      if (ca !== cb) return ca < cb ? -1 : 1;
      return Number(a.replace(/\D+/g, '')) - Number(b.replace(/\D+/g, ''));
    });
    return { seen: seen, ok: ok, episodes: list, total: total, error: err, fetchedAt: fresh };
  }

  function renderQuota() {
    var c = quotaCounts();
    var lastAt = lastMeasuredAt();
    var lastEl = $('#quotaLast');
    if (lastEl) {
      if (lastAt) {
        var fresh = (Date.now() - lastAt) < 6 * HOUR;
        lastEl.innerHTML = '마지막 실측 <b>' + esc(fmtClock(lastAt)) + '</b> · ' + esc(relTime(lastAt)) +
          (fresh ? '' : ' <span class="q-stale">· 갱신 필요</span>');
      } else {
        lastEl.textContent = '실측 기록 없음';
      }
    }
    var chips = $('#quotaChips');
    if (chips) chips.innerHTML = quotaChipsHTML(c);
    var notionEl = $('#quotaNotion');
    if (notionEl) {
      var ns = notionSummary();
      if (!ns.seen) {
        notionEl.hidden = true;
        notionEl.innerHTML = '';
      } else if (ns.ok) {
        var shown = ns.episodes.slice(0, 8).join('·');
        var more = ns.episodes.length > 8 ? ' 외 ' + (ns.episodes.length - 8) + '건' : '';
        notionEl.hidden = false;
        notionEl.innerHTML = '<b>노션 03 - 제작 기록 반영됨</b>' +
          (ns.episodes.length ? ' · 외부 기록 ' + ns.episodes.length + '건 합산 (' + esc(shown) + esc(more) + ')' : '') +
          (ns.fetchedAt ? ' · ' + esc(relTime(ns.fetchedAt)) : '');
      } else {
        notionEl.hidden = false;
        notionEl.innerHTML = '<b>노션 기록 조회 실패</b> · 직전에 합산한 값을 그대로 둡니다' +
          (ns.error ? ' (' + esc(ns.error) + ')' : '');
      }
    }
    var grid = $('#quotaGrid');
    if (grid) {
      grid.innerHTML = state.quotas.length
        ? state.quotas.map(quotaCardHTML).join('')
        : '<div class="q-empty">실측 기록이 없습니다.<br>위의 <b>실시간 실측 새로고침</b> 버튼을 누르면 채워집니다.</div>';
    }
    var runsEl = $('#quotaRuns');
    if (runsEl) {
      /* 전체 제공자를 다 돈 실측만 '기록'으로 보여준다 (--only 부분 점검 제외) */
      var runs = state.quotaRuns.filter(function (r) { return !state.quotas.length || r.total >= state.quotas.length; });
      runsEl.innerHTML = runs.length ? runs.map(function (r) {
        return '<div class="q-run">' +
          '<span class="q-run-time">' + esc(dayLabel(r.finishedAt)) + ' ' + esc(fmtClock(r.finishedAt)) + '</span>' +
          '<span class="q-run-nums"><b class="ok">' + r.ok + '</b> 정상 · <b class="lim">' + r.limited +
          '</b> 한도 · <b class="err">' + r.error + '</b> 오류</span>' +
          '</div>';
      }).join('') : '<p class="set-hint">아직 실측 기록이 없습니다.</p>';
    }
    var rc = $('#quotaRunCount');
    if (rc) {
      var nRuns = state.quotaRuns.filter(function (r) { return !state.quotas.length || r.total >= state.quotas.length; }).length;
      rc.textContent = nRuns ? '(' + nRuns + '회)' : '';
    }
  }

  /* ── 📅 업로드-캘린더 채널방 (노션 일정 · Edge Function이 노션을 읽는다) ── */
  var CAL_SLUG = 'upload-calendar';
  var CAL_DOW = ['일', '월', '화', '수', '목', '금', '토'];
  var CAL_CH = {
    kr: { flag: '🇰🇷', name: '별별해외이슈' },
    jp: { flag: '🇯🇵', name: 'ショッと見て' },
    etc: { flag: '🗓', name: '기타' }
  };
  var CAL_STATUS = {
    done: { label: '공개 완료', icon: '✅', short: '공개' },
    scheduled: { label: '예약됨', icon: '⏳', short: '예약' },
    warn: { label: '보완 필요', icon: '⚠️', short: '보완' },
    missing: { label: '미제작', icon: '⛔', short: '누락' },
    unknown: { label: '확인 필요', icon: '•', short: '확인' }
  };
  var CAL_DRAWER_STATE = { done: 'ok', scheduled: 'soon', missing: 'risk', warn: 'risk', unknown: 'unknown' };
  var calState = {
    items: [], fetchedAt: 0, lastAttempt: 0, source: null, error: null,
    loading: false, started: false, inFlight: false,
    month: '', selected: '', filter: 'all'
  };

  function isCalendarRoom() {
    var r = currentRoom();
    return !!(r && r.slug === CAL_SLUG);
  }
  function calPad(n) { return (n < 10 ? '0' : '') + n; }
  function calDateKey(d) { return d.getFullYear() + '-' + calPad(d.getMonth() + 1) + '-' + calPad(d.getDate()); }
  function calTodayKey() { return calDateKey(new Date()); }
  function calMonthOf(key) { return (key || calTodayKey()).slice(0, 7); }
  function calMonthLabel(mk) { return (+mk.slice(0, 4)) + '년 ' + (+mk.slice(5, 7)) + '월'; }
  function calShiftMonth(mk, delta) {
    var y = +mk.slice(0, 4), m = +mk.slice(5, 7) - 1 + delta;
    var d = new Date(y, m, 1);
    return d.getFullYear() + '-' + calPad(d.getMonth() + 1);
  }
  function calFiltered() {
    return calState.items.filter(function (it) {
      return calState.filter === 'all' || it.channel === calState.filter;
    });
  }
  function calItemsOn(key) {
    return calFiltered().filter(function (it) { return it.date === key; });
  }
  function calTally(list) {
    var t = { total: list.length, done: 0, scheduled: 0, missing: 0, warn: 0, unknown: 0 };
    list.forEach(function (it) { if (t[it.status] != null) t[it.status]++; });
    return t;
  }
  function calDotStatus(list) {
    if (!list.length) return '';
    var has = function (s) { return list.some(function (i) { return i.status === s; }); };
    if (has('missing')) return 'missing';
    if (has('warn')) return 'warn';
    if (has('scheduled')) return 'scheduled';
    if (has('done')) return 'done';
    return 'unknown';
  }
  function calMonthStats() {
    var mk = calState.month || calMonthOf(calState.selected || calTodayKey());
    var t = calTally(calState.items.filter(function (it) { return (it.date || '').slice(0, 7) === mk; }));
    t.month = mk;
    return t;
  }

  async function calFetch(force) {
    var url = CFG.calendarFunctionUrl || '';
    if (!url) { calState.error = '캘린더 함수 주소가 설정되지 않았습니다.'; renderCalendar(); return; }
    if (calState.inFlight) return;
    calState.inFlight = true;
    calState.loading = true;
    calState.lastAttempt = Date.now();
    renderCalendar();
    renderTop();
    try {
      var res = await fetch(url + (force ? '?refresh=1' : ''), {
        headers: {
          apikey: CFG.supabaseAnonKey || '',
          Authorization: 'Bearer ' + (CFG.supabaseAnonKey || '')
        },
        cache: 'no-store'
      });
      var data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      if (!res.ok || !data || data.ok === false) {
        throw new Error((data && data.message) || ('HTTP ' + res.status));
      }
      calState.items = Array.isArray(data.items) ? data.items : [];
      calState.source = data.source || null;
      calState.fetchedAt = data.fetchedAt ? (Date.parse(data.fetchedAt) || Date.now()) : Date.now();
      calState.error = null;
      if (!calState.selected) calState.selected = calTodayKey();
      if (!calState.month) calState.month = calMonthOf(calState.selected);
      if (force) toast('노션 일정을 새로 불러왔습니다 · ' + calState.items.length + '건');
    } catch (err) {
      calState.error = (err && err.message) || String(err);
      if (force) toast('노션 일정을 불러오지 못했습니다: ' + calState.error);
    } finally {
      calState.inFlight = false;
      calState.loading = false;
      calState.started = true;
      renderCalendar();
      renderTop();
      renderDrawer();
    }
  }

  function renderCalendar() {
    var root = $('#calendarView');
    if (!root) return;
    var btn = $('#calRefresh');
    if (btn) {
      btn.classList.toggle('spin', calState.loading);
      btn.disabled = calState.loading;
      btn.setAttribute('aria-busy', calState.loading ? 'true' : 'false');
      var lbl = btn.querySelector('.c-refresh-label');
      if (lbl) lbl.textContent = calState.loading ? '동기화 중…' : '노션 새로고침';
    }
    var syncEl = $('#calSynced');
    if (syncEl) {
      if (calState.loading && !calState.items.length) {
        syncEl.textContent = '노션에서 일정을 불러오는 중…';
        syncEl.removeAttribute('data-state');
      } else if (calState.error) {
        syncEl.textContent = '노션 읽기 실패 · ' + calState.error;
        syncEl.setAttribute('data-state', 'error');
      } else if (calState.fetchedAt) {
        var edited = calState.source && calState.source.lastEditedTime ? Date.parse(calState.source.lastEditedTime) : 0;
        syncEl.innerHTML = '노션 <b>' + esc(fmtClock(calState.fetchedAt)) + '</b> 동기화 · ' + esc(relTime(calState.fetchedAt));
        syncEl.title = edited ? '노션 페이지 수정 ' + relTime(edited) + ' · ' + (calState.items.length + '건') : '';
        syncEl.removeAttribute('data-state');
      } else {
        syncEl.textContent = '아직 동기화하지 않았습니다.';
        syncEl.removeAttribute('data-state');
      }
    }
    if (!calState.month) calState.month = calMonthOf(calState.selected || calTodayKey());
    if (!calState.selected) calState.selected = calTodayKey();
    renderCalMonthbar();
    renderCalGrid();
    renderCalDetail();
  }

  function renderCalMonthbar() {
    var el = $('#calMonthbar');
    if (!el) return;
    var mk = calState.month || calMonthOf(calTodayKey());
    var t = calTally(calFiltered().filter(function (it) { return (it.date || '').slice(0, 7) === mk; }));
    var label = calState.filter === 'all' ? '' : ' · ' + (CAL_CH[calState.filter] ? CAL_CH[calState.filter].name : '');
    if (!t.total) {
      el.innerHTML = '<span class="c-mb-label">' + (+mk.slice(5, 7)) + '월' + esc(label) + '</span><span class="c-mb-empty">등록된 일정 없음</span>';
      return;
    }
    el.innerHTML = '<span class="c-mb-label">' + (+mk.slice(5, 7)) + '월' + esc(label) + '</span>' +
      '<span class="c-mb">총 <b>' + t.total + '</b>건</span>' +
      '<span class="c-mb ok"><i class="c-dot" data-s="done"></i>공개 <b>' + t.done + '</b></span>' +
      '<span class="c-mb wait"><i class="c-dot" data-s="scheduled"></i>예약 <b>' + t.scheduled + '</b></span>' +
      (t.missing ? '<span class="c-mb miss"><i class="c-dot" data-s="missing"></i>미제작 <b>' + t.missing + '</b></span>' : '') +
      (t.warn ? '<span class="c-mb warn"><i class="c-dot" data-s="warn"></i>보완 <b>' + t.warn + '</b></span>' : '');
  }

  function renderCalGrid() {
    var grid = $('#calGrid');
    if (!grid) return;
    var mk = calState.month || calMonthOf(calTodayKey());
    var y = +mk.slice(0, 4), m = +mk.slice(5, 7);
    var monthEl = $('#calMonth');
    if (monthEl) monthEl.textContent = calMonthLabel(mk);
    var startDow = new Date(y, m - 1, 1).getDay();
    var days = new Date(y, m, 0).getDate();
    var cells = Math.ceil((startDow + days) / 7) * 7;
    var today = calTodayKey();
    var html = '';
    for (var i = 0; i < cells; i++) {
      var d = new Date(y, m - 1, 1 - startDow + i);
      var key = calDateKey(d);
      var out = d.getMonth() !== m - 1;
      var list = out ? [] : calItemsOn(key);
      var cls = 'c-day' + (out ? ' out' : '') + (d.getDay() === 0 ? ' sun' : '') + (d.getDay() === 6 ? ' sat' : '') +
        (key === today ? ' today' : '') + (key === calState.selected ? ' sel' : '');
      var label = (d.getMonth() + 1) + '월 ' + d.getDate() + '일';
      var chips = '';
      ['kr', 'jp', 'etc'].forEach(function (ch) {
        if (calState.filter !== 'all' && calState.filter !== ch) return;
        var part = list.filter(function (it) { return it.channel === ch; });
        if (!part.length) return;
        var done = part.filter(function (it) { return it.status === 'done'; }).length;
        var st = calDotStatus(part);
        var meta = CAL_CH[ch] || CAL_CH.etc;
        // 기타(스레드 등)는 공개/전체 비율이 의미가 없어 건수만 보여 준다
        var count = ch === 'etc' ? String(part.length) : ('<b>' + done + '</b>/' + part.length);
        chips += '<span class="c-chip" data-ch="' + ch + '" data-s="' + st + '"><span class="cf" aria-hidden="true">' + meta.flag + '</span>' +
          count + '<i class="c-dot" data-s="' + st + '"></i></span>';
        label += ', ' + meta.name + ' ' + part.length + '건 중 ' + done + '건 공개';
      });
      if (list.length) label += ' · 업로드 ' + list.length + '건';
      html += '<button type="button" role="gridcell" class="' + cls + '" data-date="' + key + '"' +
        ' aria-selected="' + (key === calState.selected ? 'true' : 'false') + '"' +
        (out ? ' tabindex="-1" aria-disabled="true"' : '') +
        ' aria-label="' + esc(label) + '">' +
        '<span class="c-num">' + d.getDate() + '</span>' +
        (chips ? '<span class="c-chips">' + chips + '</span>' : '') + '</button>';
    }
    grid.innerHTML = html;
  }

  function renderCalDetail() {
    var el = $('#calDetail');
    if (!el) return;
    if (calState.loading && !calState.items.length) {
      el.innerHTML = '<div class="c-empty">노션에서 일정을 불러오는 중…</div>';
      return;
    }
    if (calState.error && !calState.items.length) {
      el.innerHTML = '<div class="c-empty c-err"><b>노션 일정을 불러오지 못했습니다</b><span>' + esc(calState.error) + '</span>' +
        '<button type="button" class="c-btn" data-act="retry">다시 시도</button></div>';
      return;
    }
    var key = calState.selected || calTodayKey();
    var parts = key.split('-');
    var d = new Date(+parts[0], +parts[1] - 1, +parts[2]);
    var list = calItemsOn(key);
    var t = calTally(list);
    var isToday = key === calTodayKey();
    var h = '<div class="c-detail-head">' +
      '<h3>' + (d.getMonth() + 1) + '월 ' + d.getDate() + '일 (' + CAL_DOW[d.getDay()] + ')' +
      (isToday ? '<span class="c-today-badge">오늘</span>' : '') + '</h3>' +
      '<p class="c-sum">' + (t.total
        ? '업로드 <b>' + t.total + '</b>건 · 공개 <b>' + t.done + '</b>' +
          (t.scheduled ? ' · 예약 <b>' + t.scheduled + '</b>' : '') +
          (t.missing ? ' · <b class="miss">미제작 ' + t.missing + '</b>' : '') +
          (t.warn ? ' · <b class="warn">보완 ' + t.warn + '</b>' : '')
        : '등록된 업로드가 없습니다') + '</p></div>';
    if (!list.length) {
      h += '<div class="c-empty">이 날짜에 잡힌 업로드가 없습니다.<br><span>노션 캘린더에 일정을 넣으면 여기에 바로 나타납니다.</span></div>' +
        (isToday ? '' : '<button type="button" class="c-btn block" data-act="today">오늘로 돌아가기</button>');
    } else {
      h += '<ol class="c-tl">' + list.map(function (it) {
        var st = CAL_STATUS[it.status] || CAL_STATUS.unknown;
        var ch = CAL_CH[it.channel] || CAL_CH.etc;
        var url = it.url || '';
        return '<li class="c-tl-item" data-s="' + esc(it.status) + '">' +
          '<div class="c-time">' + esc(it.time || '—') + '</div>' +
          '<article class="c-card" data-s="' + esc(it.status) + '">' +
            '<div class="c-card-top">' +
              '<span class="c-badge ch" data-ch="' + esc(it.channel) + '">' + ch.flag + ' ' + esc(ch.name) + '</span>' +
              (it.episode ? '<span class="c-badge code">' + esc(it.episode) + '</span>' : '') +
              '<span class="c-badge st" data-s="' + esc(it.status) + '">' + st.icon + ' ' + esc(st.label) + '</span>' +
            '</div>' +
            '<p class="c-title">' + esc(it.title || '—') + '</p>' +
            '<div class="c-card-foot">' +
              (url
                ? '<a class="c-yt" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">YouTube에서 열기 ↗</a>'
                : '<span class="c-yt off">영상 링크 없음</span>') +
              (it.note ? '<span class="c-note">' + esc(it.note) + '</span>' : '') +
            '</div>' +
          '</article></li>';
      }).join('') + '</ol>';
    }
    el.innerHTML = h;
  }

  function bindCalendar() {
    var filter = $('#calFilter');
    if (filter) {
      filter.addEventListener('click', function (e) {
        var b = e.target.closest('button[data-f]');
        if (!b) return;
        calState.filter = b.getAttribute('data-f');
        $$('#calFilter button').forEach(function (x) {
          x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
        });
        renderCalendar();
      });
    }
    var prev = $('#calPrev');
    if (prev) prev.addEventListener('click', function () {
      calState.month = calShiftMonth(calState.month || calMonthOf(calState.selected), -1);
      renderCalendar();
    });
    var next = $('#calNext');
    if (next) next.addEventListener('click', function () {
      calState.month = calShiftMonth(calState.month || calMonthOf(calState.selected), 1);
      renderCalendar();
    });
    var today = $('#calToday');
    if (today) today.addEventListener('click', function () {
      calState.selected = calTodayKey();
      calState.month = calMonthOf(calState.selected);
      renderCalendar();
      renderTop();
    });
    var grid = $('#calGrid');
    if (grid) {
      grid.addEventListener('click', function (e) {
        var cell = e.target.closest('[data-date]');
        if (!cell || cell.classList.contains('out')) return;
        calState.selected = cell.getAttribute('data-date');
        calState.month = calMonthOf(calState.selected);
        renderCalendar();
        renderTop();
      });
    }
    var detail = $('#calDetail');
    if (detail) {
      detail.addEventListener('click', function (e) {
        if (e.target.closest('[data-act="retry"]')) { calFetch(true); return; }
        if (e.target.closest('[data-act="today"]')) {
          calState.selected = calTodayKey();
          calState.month = calMonthOf(calState.selected);
          renderCalendar();
        }
      });
    }
    var refresh = $('#calRefresh');
    if (refresh) refresh.addEventListener('click', function () { calFetch(true); });
  }

  /* ── 📺 유튜브-대시보드 채널방 (YouTube Data·Analytics · Edge Function이 직접 읽는다) ── */
  var YT_SLUG = 'youtube-dashboard';
  var YT_FALLBACK = {
    kr: { flag: '🇰🇷', name: '별별해외이슈' },
    jp: { flag: '🇯🇵', name: 'ショッと見て' }
  };
  var ytState = {
    data: null, fetchedAt: 0, lastAttempt: 0, error: null,
    loading: false, started: false, inFlight: false, filter: 'all'
  };

  function isYoutubeRoom() {
    var r = currentRoom();
    return !!(r && r.slug === YT_SLUG);
  }
  function ytNum(n) {
    if (n == null || n === '' || isNaN(Number(n))) return '—';
    return Number(n).toLocaleString('ko-KR');
  }
  function ytParse(iso) { return iso ? (Date.parse(iso) || 0) : 0; }
  function ytChannels() {
    var list = (ytState.data && ytState.data.channels) || [];
    return list.filter(function (c) { return ytState.filter === 'all' || c.key === ytState.filter; });
  }
  function ytMetaOf(key) { return YT_FALLBACK[key] || { flag: '📺', name: key }; }
  /** '11/27 18:30' — 예약 시각처럼 먼 미래도 보이게 */
  function ytWhen(iso) {
    var ts = ytParse(iso);
    if (!ts) return '—';
    var d = new Date(ts);
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function ytClock(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  async function ytFetch(force) {
    var url = CFG.youtubeFunctionUrl || '';
    if (!url) { ytState.error = '유튜브 함수 주소가 설정되지 않았습니다.'; renderYoutube(); return; }
    if (ytState.inFlight) return;
    ytState.inFlight = true;
    ytState.loading = true;
    ytState.lastAttempt = Date.now();
    renderYoutube();
    renderTop();
    try {
      var res = await fetch(url + (force ? '?refresh=1' : ''), {
        headers: {
          apikey: CFG.supabaseAnonKey || '',
          Authorization: 'Bearer ' + (CFG.supabaseAnonKey || '')
        },
        cache: 'no-store'
      });
      var data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      if (!res.ok || !data || data.ok === false) {
        var msg = (data && (data.message || (data.warnings && data.warnings[0]))) || ('HTTP ' + res.status);
        if (data && data.channels && data.channels.length) {
          ytState.data = data;   // 일부 채널만 실패해도 보여줄 수 있는 건 보여준다
          ytState.error = msg;
          ytState.fetchedAt = data.fetchedAt ? (Date.parse(data.fetchedAt) || Date.now()) : Date.now();
          if (force) toast('일부 채널을 읽지 못했습니다: ' + msg);
          return;
        }
        throw new Error(msg);
      }
      ytState.data = data;
      ytState.fetchedAt = data.fetchedAt ? (Date.parse(data.fetchedAt) || Date.now()) : Date.now();
      ytState.error = null;
      if (force) {
        var sm = data.summary || {};
        toast('유튜브 통계를 새로 읽었습니다 · 구독 ' + ytNum(sm.subscribers) + ' · 미응답 댓글 ' + (sm.unanswered || 0) + '건');
      }
    } catch (err) {
      ytState.error = (err && err.message) || String(err);
      if (force) toast('유튜브 통계를 불러오지 못했습니다: ' + ytState.error);
    } finally {
      ytState.inFlight = false;
      ytState.loading = false;
      ytState.started = true;
      renderYoutube();
      renderTop();
      renderDrawer();
    }
  }

  function ytSparkHTML(days) {
    var list = days || [];
    var max = 1;
    list.forEach(function (d) { if (d.views > max) max = d.views; });
    return '<div class="y-spark" aria-hidden="true">' + list.map(function (d) {
      var h = Math.max(2, Math.round((d.views / max) * 26));
      var cls = d.views > 0 ? '' : 'dim';
      return '<i class="' + cls + '" style="height:' + h + 'px" title="' + esc(d.date) + ' · ' + ytNum(d.views) + '회"></i>';
    }).join('') + '</div>';
  }

  function ytCardHTML(ch) {
    var st = ch.stats || {};
    var an = ch.analytics || {};
    var cm = ch.comments || {};
    var meta = ytMetaOf(ch.key);
    var chips = '';
    if (ch.error) {
      chips += '<span class="y-chip err">⚠ 읽기 실패</span>';
    } else {
      if (cm.unanswered) chips += '<span class="y-chip wait">💬 미응답 ' + cm.unanswered + '</span>';
      if (ch.hotCount) chips += '<span class="y-chip hot">🔥 급상승 ' + ch.hotCount + '</span>';
      if (cm.error) chips += '<span class="y-chip err">댓글 ' + esc(cm.error.slice(0, 12)) + '</span>';
    }
    var change = '';
    if (an.ok && an.changePct != null) {
      change = ' <span class="' + (an.changePct >= 0 ? 'up' : 'down') + '">' +
        (an.changePct >= 0 ? '▲' : '▼') + Math.abs(an.changePct) + '%</span>';
    }
    var head = ch.error ? '' :
      '<div class="y-big"><b>' + ytNum(st.subscribers) + '</b><span>구독자</span></div>' +
      '<div class="y-kv">' +
        '<span>총 조회수 <b>' + ytNum(st.views) + '</b></span>' +
        '<span>영상 <b>' + ytNum(st.videos) + '</b> · 최근 평균 <b>' + ytNum(ch.avgViews) + '</b>회</span>' +
      '</div>' +
      (an.ok ? ytSparkHTML(an.days) : '') +
      '<div class="y-7d"><b>' + ytNum(an.views7d) + '</b> 최근 7<span>일</span>' + change + '</div>';

    return '<a class="y-card" data-ch="' + esc(ch.key || '') + '" href="' + esc(ch.url || '#') + '" target="_blank" rel="noopener noreferrer">' +
      '<div class="y-card-top"><span class="y-flag">' + (ch.flag || meta.flag) + '</span>' +
        '<span class="y-name">' + esc(ch.label || meta.name) + '</span></div>' +
      (ch.error ? '<div class="y-kv" style="color:#fda4af;font-weight:700">' + esc(ch.error) + '</div>' : head) +
      (chips ? '<div class="y-card-foot">' + chips + '</div>' : '') +
    '</a>';
  }

  function renderYtChannels() {
    var el = $('#ytChannels');
    if (!el) return;
    if (!ytState.data) {
      el.innerHTML = '<div class="y-skel"><i style="height:150px"></i></div><div class="y-skel"><i style="height:150px"></i></div>';
      el.classList.remove('single');
      return;
    }
    var list = ytChannels();
    el.classList.toggle('single', list.length === 1);
    if (!list.length) {
      el.classList.remove('single');
      el.innerHTML = '<div class="y-empty"><b>채널 정보가 없습니다</b><span>새로고침을 눌러 다시 읽어 보세요.</span></div>';
      return;
    }
    el.innerHTML = list.map(ytCardHTML).join('');
  }

  function ytVideoRowHTML(ch, v) {
    var meta = ytMetaOf(ch.key);
    var pills = '<span class="y-pill ch" data-ch="' + esc(ch.key || '') + '">' + (ch.flag || meta.flag) + ' ' + esc(ch.label || meta.name) + '</span>';
    if (v.hot) pills += '<span class="y-pill hot">🔥 급상승</span>';
    var pcls = v.privacy === 'scheduled' ? 'scheduled' : (v.privacy || 'public');
    pills += '<span class="y-pill ' + esc(pcls) + '">' + esc(v.privacyIcon || '') + ' ' + esc(v.privacyLabel || '공개') + '</span>';
    var when = v.privacy === 'scheduled' && v.scheduleAt
      ? '게시 ' + ytWhen(v.scheduleAt)
      : relTime(ytParse(v.publishedAt));
    var dur = '';
    if (v.durationSeconds) {
      var s = v.durationSeconds;
      dur = Math.floor(s / 60) + ':' + pad2(s % 60);
    }
    var ratio = (v.hot && v.vsAvg) ? '<span class="hot-ratio">평균 ' + v.vsAvg + '배</span>' : '';
    return '<a class="y-vrow' + (v.hot ? ' hot' : '') + '" href="' + esc(v.url) + '" target="_blank" rel="noopener noreferrer">' +
      '<span class="y-thumb">' +
        '<img src="' + esc(v.thumbnail) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' +
        (dur ? '<span class="y-dur">' + dur + '</span>' : '') +
      '</span>' +
      '<span class="y-vbody">' +
        '<span class="y-vtitle">' + esc(v.title || '—') + '</span>' +
        '<span class="y-vmeta">' + pills + '<span>' + esc(when) + '</span></span>' +
        '<span class="y-vstat">' +
          '<span>👁 ' + ytNum(v.views) + '</span>' +
          '<span>👍 ' + ytNum(v.likes) + '</span>' +
          '<span>💬 ' + ytNum(v.comments) + '</span>' +
          ratio +
        '</span>' +
      '</span>' +
    '</a>';
  }

  function renderYtVideos() {
    var el = $('#ytVideos');
    var sub = $('#ytVideoSub');
    if (!el) return;
    if (!ytState.data) {
      el.innerHTML = '<div class="y-skel"><i></i><i></i><i></i></div>';
      if (sub) sub.textContent = '';
      return;
    }
    var rows = [];
    ytChannels().forEach(function (ch) {
      (ch.videos || []).forEach(function (v) { rows.push({ ch: ch, v: v }); });
    });
    rows.sort(function (a, b) {
      var at = ytParse(a.v.publishedAt), bt = ytParse(b.v.publishedAt);
      return bt - at;
    });
    var limit = ytState.filter === 'all' ? 12 : 20;
    var shown = rows.slice(0, limit);
    if (sub) {
      var hotN = shown.filter(function (r) { return r.v.hot; }).length;
      sub.textContent = shown.length + '개 표시 · 전체 ' + rows.length + '개' + (hotN ? ' · 🔥 ' + hotN : '');
    }
    if (!shown.length) {
      el.innerHTML = '<div class="y-empty"><b>최근 영상이 없습니다</b><span>업로드 목록을 읽지 못했거나 아직 영상이 없습니다.</span></div>';
      return;
    }
    el.innerHTML = shown.map(function (r) { return ytVideoRowHTML(r.ch, r.v); }).join('');
  }

  function ytCommentRowHTML(ch, c) {
    var meta = ytMetaOf(ch.key);
    var fresh = (Date.now() - ytParse(c.publishedAt)) < 24 * HOUR;
    var initial = (c.author || '?').replace(/^@/, '').charAt(0).toUpperCase();
    var avatar = c.authorThumb
      ? '<span class="y-avatar"><img src="' + esc(c.authorThumb) + '" alt="" loading="lazy" referrerpolicy="no-referrer"></span>'
      : '<span class="y-avatar">' + esc(initial) + '</span>';
    return '<a class="y-crow' + (fresh ? ' fresh' : '') + '" href="' + esc(c.url) + '" target="_blank" rel="noopener noreferrer">' +
      avatar +
      '<span class="y-cbody">' +
        '<span class="y-chead">' +
          '<span class="y-cauthor">' + esc(c.author || '익명') + '</span>' +
          (fresh ? '<span class="y-new">NEW</span>' : '') +
          '<span class="y-pill ch" data-ch="' + esc(ch.key || '') + '">' + (ch.flag || meta.flag) + '</span>' +
          '<span style="margin-left:auto;white-space:nowrap">' + esc(relTime(ytParse(c.publishedAt))) + '</span>' +
        '</span>' +
        '<span class="y-ctext">' + esc(c.text || '') + '</span>' +
        '<span class="y-cvid">🎬 ' + esc(c.videoTitle || '영상') + '</span>' +
        '<span class="y-cfoot">👍 ' + ytNum(c.likes) + (c.replyCount ? ' · 답글 ' + c.replyCount + '개(내 답글 없음)' : '') + ' · 답글 달기 ↗</span>' +
      '</span>' +
    '</a>';
  }

  function renderYtComments() {
    var el = $('#ytComments');
    var sub = $('#ytCommentSub');
    if (!el) return;
    if (!ytState.data) {
      el.innerHTML = '<div class="y-skel"><i></i><i></i></div>';
      if (sub) sub.textContent = '';
      return;
    }
    var rows = [];
    ytChannels().forEach(function (ch) {
      (ch.comments && ch.comments.items || []).forEach(function (c) { rows.push({ ch: ch, c: c }); });
    });
    rows.sort(function (a, b) { return ytParse(b.c.publishedAt) - ytParse(a.c.publishedAt); });
    var shown = rows.slice(0, 12);
    if (sub) sub.textContent = (rows.length ? rows.length + '건' : '없음') + ' · 채널당 최근 25건 확인';
    if (!shown.length) {
      var anyErr = ytChannels().some(function (c) { return c.comments && c.comments.error; });
      el.innerHTML = '<div class="y-empty">' +
        '<b>답글 없는 새 댓글이 없습니다</b>' +
        '<span>' + (anyErr ? '일부 채널의 댓글을 읽지 못했습니다.' : '최근 댓글 ' + (ytState.data ? ytChannels().reduce(function (n, c) { return n + ((c.comments && c.comments.scanned) || 0); }, 0) : 0) + '건을 확인했고, 모두 답글이 있습니다.') + '</span>' +
      '</div>';
      return;
    }
    el.innerHTML = shown.map(function (r) { return ytCommentRowHTML(r.ch, r.c); }).join('');
  }

  function renderYoutube() {
    var root = $('#youtubeView');
    if (!root) return;
    var btn = $('#ytRefresh');
    if (btn) {
      btn.classList.toggle('spin', ytState.loading);
      btn.disabled = ytState.loading;
      btn.setAttribute('aria-busy', ytState.loading ? 'true' : 'false');
      var lbl = btn.querySelector('.c-refresh-label');
      if (lbl) lbl.textContent = ytState.loading ? '불러오는 중…' : '실시간 새로고침';
    }
    var sync = $('#ytSynced');
    if (sync) {
      if (ytState.loading && !ytState.data) {
        sync.textContent = '유튜브에서 통계를 불러오는 중…';
        sync.removeAttribute('data-state');
      } else if (ytState.error && !ytState.data) {
        sync.textContent = '유튜브 읽기 실패 · ' + ytState.error;
        sync.setAttribute('data-state', 'error');
      } else if (ytState.data) {
        sync.removeAttribute('data-state');
        var sm = ytState.data.summary || {};
        sync.innerHTML = '마지막 새로고침 <b>' + esc(ytClock(ytState.fetchedAt)) + '</b> (' + esc(relTime(ytState.fetchedAt)) + ')' +
          ' · 구독 <b>' + ytNum(sm.subscribers) + '</b> · 7일 조회 <b>' + ytNum(sm.views7d) + '</b>' +
          (ytState.error ? ' · <span style="color:#fdba74">일부 채널 읽기 실패</span>' : '');
      } else {
        sync.textContent = '유튜브에서 통계를 불러오는 중…';
      }
    }
    $$('#ytFilter button').forEach(function (x) {
      x.setAttribute('aria-pressed', x.getAttribute('data-f') === ytState.filter ? 'true' : 'false');
    });
    renderYtChannels();
    renderYtVideos();
    renderYtComments();
  }

  function bindYoutube() {
    var filter = $('#ytFilter');
    if (filter) {
      filter.addEventListener('click', function (e) {
        var b = e.target.closest('button[data-f]');
        if (!b) return;
        ytState.filter = b.getAttribute('data-f');
        renderYoutube();
      });
    }
    var refresh = $('#ytRefresh');
    if (refresh) refresh.addEventListener('click', function () { ytFetch(true); });
    var box = $('#youtubeView');
    if (box) {
      box.addEventListener('click', function (e) {
        if (e.target.closest('[data-act="retry"]')) ytFetch(true);
      });
    }
  }

  /* 채널방과 회의실의 화면·컴포저를 서로 섮이지 않게 전환한다 */
  function applyRoomMode() {
    var quota = isQuotaRoom();
    var cal = isCalendarRoom();
    var yt = isYoutubeRoom();
    var channel = quota || cal || yt;
    document.body.classList.toggle('quota-mode', quota);
    document.body.classList.toggle('calendar-mode', cal);
    document.body.classList.toggle('yt-mode', yt);
    var qv = $('#quotaView');
    if (qv) qv.hidden = !quota;
    var cv = $('#calendarView');
    if (cv) cv.hidden = !cal;
    var yv = $('#youtubeView');
    if (yv) yv.hidden = !yt;
    var sum = $('#summaryBar');
    if (sum) sum.hidden = channel;
    var comp = $('#composer');
    if (comp) comp.hidden = channel;
    var members = $('#membersBtn');
    if (members) members.hidden = channel;
    var sBtn = $('#searchBtn');
    if (sBtn) sBtn.hidden = channel;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', (cal || yt) ? '#0f1115' : '#f2f3f5');
    if (channel) {
      $('#chatView').hidden = true;
      $('#dashboard').hidden = true;
      if (ui.searchOpen) closeSearch();
    } else {
      $('#chatView').hidden = !!ui.dashboardOpen;
      $('#dashboard').hidden = !ui.dashboardOpen;
    }
    if (cal && !calState.inFlight && (!calState.started || (Date.now() - calState.lastAttempt) > 5 * 60 * 1000)) {
      calFetch(false);
    }
    if (yt && !ytState.inFlight && (!ytState.started || (Date.now() - ytState.lastAttempt) > 60 * 1000)) {
      ytFetch(false);
    }
  }

  /* ── rendering: mentions & drawer & members ──────────────── */
  function renderMentionChips() {
    var row = $('#mentionRow');
    row.innerHTML = '';
    var all = document.createElement('button');
    all.className = 'm-chip all';
    all.type = 'button';
    all.textContent = '@전체';
    all.addEventListener('click', function () { insertMention('전체'); });
    row.appendChild(all);

    var room = currentRoom();
    if (!room) return;
    room.assistants.forEach(function (a) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'm-chip';
      b.textContent = (a.emoji ? a.emoji + ' ' : '') + '@' + a.name;
      b.addEventListener('click', function () { insertMention(a.name); });
      row.appendChild(b);
    });
  }

  function goRoom(r) {
    if (r.id !== state.activeRoomId) {
      state.activeRoomId = r.id;
      ui.search = '';
      $('#searchInput').value = '';
      closeDrawer();
      renderAll();
      setDashboard(false);
      if (!isQuotaRoom() && !isCalendarRoom() && !isYoutubeRoom()) scrollToBottom();
      toast('# ' + r.name + ((r.slug === QUOTA_SLUG || r.slug === CAL_SLUG || r.slug === YT_SLUG) ? ' 채널방으로 이동했습니다.' : ' 회의실로 이동했습니다.'));
    } else {
      closeDrawer();
    }
  }

  function renderDrawer() {
    var roomsEl = $('#roomList');
    roomsEl.innerHTML = '';
    if (!state.rooms.length) {
      roomsEl.innerHTML = '<p class="set-hint">회의실을 불러오는 중…</p>';
    }
    state.rooms.filter(function (r) { return r.slug !== QUOTA_SLUG && r.slug !== CAL_SLUG; }).forEach(function (r) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'room-item' + (r.id === state.activeRoomId ? ' active' : '');
      b.innerHTML = '<span class="hash">#</span><span class="rname">' + esc(r.name) + '</span>' +
        '<small>' + r.assistants.length + '명</small>';
      b.addEventListener('click', function () { goRoom(r); });
      roomsEl.appendChild(b);
    });

    /* ── 채널방 목록 (비서 회의실과 명확히 구분) ── */
    var chEl = $('#channelList');
    if (chEl) {
      chEl.innerHTML = '';
      var qc = quotaCounts();
      state.rooms.filter(function (r) { return r.slug === QUOTA_SLUG || r.slug === CAL_SLUG || r.slug === YT_SLUG; }).forEach(function (r) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'room-item channel' + (r.id === state.activeRoomId ? ' active' : '') +
          (r.slug === CAL_SLUG ? ' cal' : '') + (r.slug === YT_SLUG ? ' yt' : '');
        var badge;
        if (r.slug === CAL_SLUG) {
          if (!calState.started && !calState.loading) badge = '달력';
          else if (calState.loading && !calState.items.length) badge = '동기화 중';
          else if (calState.error && !calState.items.length) badge = '읽기 실패';
          else {
            var cs = calMonthStats();
            badge = cs.total ? (+cs.month.slice(5, 7)) + '월 ' + cs.total + '건' : '일정 없음';
          }
        } else if (r.slug === YT_SLUG) {
          var ysum = ytState.data && ytState.data.summary;
          if (!ytState.started && !ytState.loading) badge = '대시보드';
          else if (ytState.loading && !ysum) badge = '불러오는 중';
          else if (ytState.error && !ysum) badge = '읽기 실패';
          else if (ysum) {
            badge = ysum.unanswered ? '미응답 ' + ysum.unanswered : '구독 ' + ytNum(ysum.subscribers);
          } else badge = '대시보드';
        } else {
          var warn = qc.limited + qc.error;
          badge = !qc.total ? '실측 전' : (warn > 0 ? warn + ' 주의' : qc.total + '개 API');
        }
        b.innerHTML = '<span class="hash">#</span><span class="rname">' + esc(r.name) + '</span>' +
          '<small>' + esc(badge) + '</small>';
        b.addEventListener('click', function () { goRoom(r); });
        chEl.appendChild(b);
      });
    }

    var listEl = $('#drawerAssistants');
    listEl.innerHTML = '';
    var room = currentRoom();
    var lbl = $('#drawerMembersLabel');
    if (isCalendarRoom()) {
      var todayList = calItemsOn(calTodayKey());
      if (lbl) lbl.textContent = '오늘 업로드';
      $('#drawerMemberCount').textContent = todayList.length;
      if (!todayList.length) {
        listEl.innerHTML = '<p class="set-hint">오늘 예정된 업로드가 없습니다.</p>';
      }
      todayList.forEach(function (it) {
        var row = document.createElement('div');
        row.className = 'da-row';
        var chMeta = CAL_CH[it.channel] || CAL_CH.etc;
        var stMeta = CAL_STATUS[it.status] || CAL_STATUS.unknown;
        row.innerHTML = '<span class="dot" data-state="' + (CAL_DRAWER_STATE[it.status] || 'unknown') + '"></span>' +
          '<span class="da-name">' + esc(it.time) + ' ' + chMeta.flag + ' ' + esc(it.episode || it.title) + '</span>' +
          '<span class="da-pct">' + esc(stMeta.short) + '</span>';
        listEl.appendChild(row);
      });
      return;
    }
    if (isYoutubeRoom()) {
      var ytRows = [];
      ((ytState.data && ytState.data.channels) || []).forEach(function (c) {
        ((c.comments && c.comments.items) || []).forEach(function (cm) { ytRows.push({ ch: c, cm: cm }); });
      });
      ytRows.sort(function (a, b) { return ytParse(b.cm.publishedAt) - ytParse(a.cm.publishedAt); });
      if (lbl) lbl.textContent = '미응답 댓글';
      $('#drawerMemberCount').textContent = ytRows.length;
      if (!ytRows.length) {
        listEl.innerHTML = '<p class="set-hint">' + (ytState.data ? '답글 없는 새 댓글이 없습니다.' : '유튜브 통계를 불러오는 중…') + '</p>';
      }
      ytRows.slice(0, 8).forEach(function (r) {
        var row = document.createElement('div');
        row.className = 'da-row';
        var meta = ytMetaOf(r.ch.key);
        row.innerHTML = '<span class="dot" data-state="risk"></span>' +
          '<span class="da-name">' + (r.ch.flag || meta.flag) + ' ' + esc(r.cm.author || '익명') + ' — ' + esc(String(r.cm.text || '').slice(0, 34)) + '</span>' +
          '<span class="da-pct">' + esc(relTime(ytParse(r.cm.publishedAt))) + '</span>';
        listEl.appendChild(row);
      });
      return;
    }
    if (lbl) lbl.textContent = isQuotaRoom() ? 'API 상태' : '참여 비서';
    if (isQuotaRoom()) {
      $('#drawerMemberCount').textContent = state.quotas.length;
      if (!state.quotas.length) {
        listEl.innerHTML = '<p class="set-hint">실측 기록이 없습니다.</p>';
      }
      state.quotas.forEach(function (q) {
        var row = document.createElement('div');
        row.className = 'da-row';
        row.innerHTML = '<span class="dot" data-state="' + quotaDot(q.status) + '"></span>' +
          '<span class="da-name">' + esc(q.emoji) + ' ' + esc(q.label) + '</span>' +
          '<span class="da-pct">' + (q.remainingPct == null ? (QUOTA_STATUS_LABEL[q.status] || '—') : fmtPct(q.remainingPct) + '%') + '</span>';
        listEl.appendChild(row);
      });
      return;
    }
    var assist = room ? room.assistants : [];
    $('#drawerMemberCount').textContent = assist.length;
    if (!assist.length) {
      listEl.innerHTML = '<p class="set-hint">아직 비서가 없습니다.</p>';
    }
    assist.forEach(function (a) {
      var st = statusOf(a);
      var row = document.createElement('div');
      row.className = 'da-row';
      row.innerHTML = '<span class="dot" data-state="' + st + '"></span>' +
        '<span class="da-name">' + esc(a.emoji) + ' ' + esc(a.name) + '</span>' +
        '<span class="da-pct">' + (a.remaining == null ? '—' : fmtPct(a.remaining) + '%') + '</span>';
      listEl.appendChild(row);
    });
  }

  function renderMembers() {
    var listEl = $('#memberList');
    listEl.innerHTML = '';
    var room = currentRoom();
    var assist = room ? room.assistants : [];
    $('#memberModalCount').textContent = assist.length + 1;

    var me = document.createElement('div');
    me.className = 'member-row';
    me.innerHTML = '<div class="avatar" style="background:#111827;width:32px;height:32px;border-radius:10px;font-size:12px">나</div>' +
      '<span class="m-name">나</span><span class="m-sub">회의실 관리자</span>';
    listEl.appendChild(me);

    assist.forEach(function (a) {
      var st = statusOf(a);
      var row = document.createElement('div');
      row.className = 'member-row';
      row.innerHTML = '<div class="avatar' + (a.emoji ? ' emoji' : '') + '" style="background:' + esc(a.color) + ';width:32px;height:32px;border-radius:10px;font-size:12px">' +
        esc(a.emoji || a.name.trim().charAt(0)) + '</div>' +
        '<span class="m-name">' + esc(a.name) + '</span>' +
        '<span class="m-sub">' + esc(a.role || STATUS_LABEL[st]) + (a.remaining == null ? '' : ' · ' + fmtPct(a.remaining) + '%') + '</span>' +
        '<button data-edit="' + esc(a.id) + '">입력</button>';
      listEl.appendChild(row);
    });
  }

  function renderManageList() {
    var listEl = $('#manageList');
    var room = currentRoom();
    var assist = room ? room.assistants : [];
    $('#setAssistCount').textContent = assist.length;
    listEl.innerHTML = '';
    if (!assist.length) {
      listEl.innerHTML = '<p class="set-hint">등록된 비서가 없습니다.</p>';
      return;
    }
    assist.forEach(function (a) {
      var st = statusOf(a);
      var row = document.createElement('div');
      row.className = 'manage-row';
      row.innerHTML = '<span class="dot" data-state="' + st + '"></span>' +
        '<span class="m-name">' + esc(a.emoji) + ' ' + esc(a.name) + '</span>' +
        '<span class="m-sub">' + (a.period === 'daily' ? '일일' : '주간') + ' · ' +
        (a.remaining == null ? '미확인' : fmtPct(a.remaining) + '%') + '</span>' +
        '<button data-edit="' + esc(a.id) + '">수정</button>';
      listEl.appendChild(row);
    });
  }

  function renderAll() {
    renderTop();
    renderDrawer();
    applyRoomMode();
    if (isQuotaRoom()) { renderQuota(); return; }
    if (isCalendarRoom()) {
      if (!calState.started) {
        calState.selected = calState.selected || calTodayKey();
        calState.month = calState.month || calMonthOf(calState.selected);
      }
      renderCalendar();
      return;
    }
    if (isYoutubeRoom()) {
      renderYoutube();
      return;
    }
    renderSummary();
    renderMentionChips();
    if (ui.dashboardOpen) renderDashboard(); else renderChat();
  }

  /* ── message actions ─────────────────────────────────────── */
  async function sendMessage() {
    if (isQuotaRoom() || isCalendarRoom() || isYoutubeRoom()) { toast('이 채널방은 읽기 전용입니다.'); return; }
    var input = $('#composerInput');
    var text = input.value.trim();
    var room = currentRoom();
    if (!text) {
      toast('보낼 내용을 입력하세요.');
      input.focus();
      return;
    }
    if (!room) { toast('회의실을 먼저 불러와 주세요.'); return; }

    input.value = '';
    autoGrow();
    hideMentionPop();

    var tempId = uid('tmp');
    room.messages.push({ id: tempId, roomId: room.id, type: 'user', authorId: 'me', text: text, at: Date.now(), name: '나', emoji: '' });
    sortMessages(room.messages);
    if (ui.dashboardOpen) setDashboard(false);
    renderTop();
    renderChat({ bottom: true });
    settleAtBottom();

    var res = await insertMessage({
      room_id: room.id,
      sender_id: null,
      sender_name: '나',
      sender_role: 'user',
      kind: 'text',
      content: text
    });

    var r = roomById(room.id) || room;
    r.messages = r.messages.filter(function (m) { return m.id !== tempId; });
    if (res.error) {
      toast('전송하지 못했습니다: ' + res.error.message);
    } else if (res.data) {
      var msg = mapMessage(res.data);
      if (!r.messages.some(function (m) { return m.id === msg.id; })) r.messages.push(msg);
      sortMessages(r.messages);
    }
    renderTop();
    if (!ui.dashboardOpen) { renderChat(); settleAtBottom(); }
  }

  /* ── composer helpers ────────────────────────────────────── */
  function autoGrow() {
    var el = $('#composerInput');
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 112) + 'px';
  }

  function insertMention(name) {
    var input = $('#composerInput');
    var start = input.selectionStart || input.value.length;
    var end = input.selectionEnd || input.value.length;
    var before = input.value.slice(0, start);
    var after = input.value.slice(end);
    var token = '@' + name + ' ';
    var needsSpace = before && !/\s$/.test(before);
    input.value = before + (needsSpace ? ' ' : '') + token + after;
    var caret = before.length + (needsSpace ? 1 : 0) + token.length;
    input.focus();
    input.setSelectionRange(caret, caret);
    autoGrow();
    hideMentionPop();
  }

  function currentMentionQuery() {
    var input = $('#composerInput');
    var caret = input.selectionStart || 0;
    var before = input.value.slice(0, caret);
    var m = before.match(/(^|\s)@([^\s@]*)$/);
    if (!m) return null;
    return { query: m[2], start: caret - m[2].length - 1, end: caret };
  }

  var mentionState = { items: [], index: 0, ctx: null };

  function showMentionPop(ctx) {
    var pop = $('#mentionPop');
    var room = currentRoom();
    if (!room) return;
    var q = ctx.query.toLowerCase();
    var names = [{ name: '전체', sub: '모든 비서' }].concat(room.assistants.map(function (a) {
      return { name: a.name, sub: a.remaining == null ? '미확인' : fmtPct(a.remaining) + '%' };
    }));
    var items = names.filter(function (n) { return !q || n.name.toLowerCase().indexOf(q) !== -1; });
    if (!items.length) { hideMentionPop(); return; }

    mentionState.items = items;
    mentionState.index = 0;
    mentionState.ctx = ctx;
    pop.innerHTML = '';
    items.forEach(function (n, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'mention-item' + (i === 0 ? ' active' : '');
      b.innerHTML = '<span class="m-dot"></span><span>@' + esc(n.name) + '</span><small>' + esc(n.sub) + '</small>';
      b.addEventListener('mousedown', function (e) {
        e.preventDefault();
        applyMentionItem(n.name);
      });
      pop.appendChild(b);
    });
    pop.hidden = false;
  }

  function hideMentionPop() {
    $('#mentionPop').hidden = true;
    mentionState.items = [];
    mentionState.ctx = null;
  }

  function applyMentionItem(name) {
    var ctx = mentionState.ctx;
    if (!ctx) { insertMention(name); return; }
    var input = $('#composerInput');
    var text = input.value;
    var insert = '@' + name + ' ';
    input.value = text.slice(0, ctx.start) + insert + text.slice(ctx.end);
    var caret = ctx.start + insert.length;
    input.focus();
    input.setSelectionRange(caret, caret);
    hideMentionPop();
    autoGrow();
  }

  function moveMentionSelection(delta) {
    var pop = $('#mentionPop');
    if (pop.hidden || !mentionState.items.length) return false;
    mentionState.index = (mentionState.index + delta + mentionState.items.length) % mentionState.items.length;
    $$('.mention-item', pop).forEach(function (el, i) {
      el.classList.toggle('active', i === mentionState.index);
      if (i === mentionState.index) el.scrollIntoView({ block: 'nearest' });
    });
    return true;
  }

  /* ── modals ──────────────────────────────────────────────── */
  function openModal(id) {
    var el = document.getElementById(id);
    el.hidden = false;
    document.body.classList.add('modal-open');
    var wantsFocus = ['assistantModal', 'inviteModal', 'promptModal'].indexOf(id) !== -1;
    var focusable = wantsFocus ? el.querySelector('input:not([type=hidden]):not([type=file]), textarea, select') : null;
    setTimeout(function () { if (focusable) focusable.focus({ preventScroll: true }); }, 60);
  }
  function closeModal(id) {
    var el = document.getElementById(id);
    if (!el) return;
    el.hidden = true;
    if (!$$('.modal:not([hidden])').length) document.body.classList.remove('modal-open');
  }
  function closeAllModals() {
    $$('.modal').forEach(function (m) { m.hidden = true; });
    document.body.classList.remove('modal-open');
  }

  /* assistant add / edit */
  function openAssistantModal(id) {
    ui.editingId = id || null;
    var a = id ? assistantById(id) : null;
    $('#assistantModalTitle').textContent = a ? '비서 정보 · 사용량' : '비서 추가';
    $('#assistantModalSub').textContent = a
      ? a.name + '의 남은 사용량과 리셋 시각을 업데이트합니다.'
      : '이름과 남은 사용량을 입력하면 회의실에 바로 등록됩니다.';
    $('#fEmoji').value = a ? (a.emoji || '') : '';
    $('#fName').value = a ? a.name : '';
    $('#fRole').value = a ? (a.role || '') : '';
    $('#fModel').value = a ? (a.model || '') : '';
    $('#fPeriod').value = a ? a.period : 'daily';
    $('#fMode').value = a ? a.mode : 'auto';
    $('#fRemaining').value = a && a.remaining != null ? a.remaining : '';
    $('#fExtra').value = a ? (a.extra || '') : '';
    $('#fReset').value = a && a.resetAt ? toLocalInput(a.resetAt) : '';
    $('#fNote').value = a ? (a.note || '') : '';
    $('#fId').value = a ? a.id : '';
    $('#fDelete').hidden = !a;
    $('#fSubmit').textContent = a ? '저장' : '추가';
    openModal('assistantModal');
  }

  async function submitAssistant(e) {
    e.preventDefault();
    var room = currentRoom();
    if (!room) { toast('회의실을 먼저 불러와 주세요.'); return; }
    var name = $('#fName').value.trim();
    if (!name) { toast('비서 이름을 입력하세요.'); return; }
    var remainingRaw = $('#fRemaining').value.trim();
    var remaining = remainingRaw === '' ? null : clamp(Number(remainingRaw), 0, 100);
    if (remainingRaw !== '' && isNaN(remaining)) { toast('남은 사용량을 숫자로 입력하세요.'); return; }
    var resetRaw = $('#fReset').value;
    var resetAt = resetRaw ? new Date(resetRaw).toISOString() : null;
    var editing = ui.editingId ? assistantById(ui.editingId) : null;

    var payload = {
      name: name,
      emoji: $('#fEmoji').value.trim() || null,
      role: $('#fRole').value.trim() || null,
      model: $('#fModel').value.trim() || null,
      period: $('#fPeriod').value,
      mode: $('#fMode').value,
      quota_percent: remaining,
      reset_at: resetAt,
      extra: $('#fExtra').value.trim() || null,
      note: $('#fNote').value.trim() || null
    };
    if (remaining != null) payload.last_report_at = new Date().toISOString();

    var res;
    if (editing) {
      res = await sb.from('assistants').update(payload).eq('id', editing.id).select().single();
      if (dbError(res.error, '저장')) return;
      // 시스템 메시지: 사용량 갱신 알림
      await insertMessage({
        room_id: room.id, sender_name: 'system', sender_role: 'system', kind: 'system',
        content: name + '의 사용량이 ' + (remaining == null ? '미확인으로' : fmtPct(remaining) + '% 남음으로') + ' 갱신되었습니다.'
      });
      toast('[' + name + '] 사용량을 저장했습니다.');
    } else {
      payload.room_id = room.id;
      payload.status = 'online';
      payload.last_seen_at = new Date().toISOString();
      payload.color = COLORS[room.assistants.length % COLORS.length];
      res = await sb.from('assistants').insert(payload).select().single();
      if (dbError(res.error, '추가')) return;
      await insertMessage({
        room_id: room.id, sender_name: 'system', sender_role: 'system', kind: 'system',
        content: name + ' 비서가 회의실에 참여했습니다.'
      });
      toast('[' + name + '] 비서를 추가했습니다.');
    }
    closeModal('assistantModal');
  }

  async function deleteAssistant() {
    var a = ui.editingId ? assistantById(ui.editingId) : null;
    if (!a) return;
    if (!confirm('[' + a.name + '] 비서를 이 회의실에서 삭제할까요?\n지난 메시지는 보낸 사람 이름만 남습니다.')) return;
    var room = currentRoom();
    var res = await sb.from('assistants').delete().eq('id', a.id);
    if (dbError(res.error, '삭제')) return;
    if (room) room.assistants = room.assistants.filter(function (x) { return x.id !== a.id; });
    await insertMessage({
      room_id: room.id, sender_name: 'system', sender_role: 'system', kind: 'system',
      content: a.name + ' 비서가 회의실에서 나갔습니다.'
    });
    closeModal('assistantModal');
    renderAll();
    if (!ui.dashboardOpen) { renderChat(); scrollChatIfNearBottom(); }
    toast('[' + a.name + '] 비서를 삭제했습니다.');
  }

  /* invite */
  function apiSpecText(room) {
    var base = (CFG.supabaseUrl || '').replace(/\/$/, '');
    var key = CFG.supabaseAnonKey || '';
    var roomId = room ? room.id : '<room_id>';
    return [
      '■ 비서 통합 회의실 · Supabase REST',
      '',
      'BASE : ' + base,
      'KEY  : ' + key,
      '헤더 : apikey: <KEY> / Authorization: Bearer <KEY> / Content-Type: application/json',
      '',
      '1) 초대 수락 → 비서 등록 (초대 링크의 토큰 사용)',
      'POST ' + base + '/rest/v1/rpc/redeem_invite',
      '{"p_token":"<초대토큰>","p_name":"피클2호기","p_emoji":"🥒","p_role":"비서","p_model":"muse-3","p_provider":"Pickle","p_plan":"free","p_period":"daily"}',
      '→ 응답의 id(sender_id)·room_id 를 아래에서 사용',
      '',
      '2) 회의실에 메시지 보내기',
      'POST ' + base + '/rest/v1/messages',
      '{"room_id":"' + roomId + '","sender_id":"<assistant id>","sender_name":"피클2호기","sender_emoji":"🥒","sender_role":"assistant","content":"안녕하세요, 참여했습니다."}',
      '',
      '3) 사용량·리셋 시간 보고',
      'POST ' + base + '/rest/v1/rpc/report_usage',
      '{"p_assistant_id":"<assistant id>","p_percent":87.5,"p_reset_at":"2026-11-27T09:00:00+09:00"}',
      '',
      '4) 최근 메시지 읽기',
      'GET ' + base + '/rest/v1/messages?room_id=eq.' + roomId + '&order=created_at.desc&limit=50',
      '',
      '실시간 수신(JS): supabase-js 로 messages 테이블을 구독하면 새 메시지가 바로 도착합니다.',
      '  sb.channel("room").on("postgres_changes",{event:"INSERT",schema:"public",table:"messages"},cb).subscribe()'
    ].join('\n');
  }

  function inviteLinkFor(token) {
    var base = INVITE_BASE;
    if (base.indexOf('?') !== -1) base = base.split('?')[0];
    if (base.charAt(base.length - 1) !== '/') base += '/';
    return base + '?invite=' + encodeURIComponent(token);
  }

  function openInvite() {
    var room = currentRoom();
    $('#invLabel').value = '';
    $('#invMax').value = '';
    $('#inviteLinkBox').hidden = true;
    $('#inviteLink').value = '';
    $('#inviteLinkHint').textContent = '';
    $('#apiSpec').textContent = apiSpecText(room);
    openModal('inviteModal');
  }

  async function createInvite() {
    var room = currentRoom();
    if (!room) { toast('회의실을 먼저 불러와 주세요.'); return; }
    var btn = $('#createInvite');
    btn.disabled = true;
    var token = randomToken();
    var maxUses = Number($('#invMax').value) || 0;
    var res = await sb.from('invites').insert({
      token: token,
      room_id: room.id,
      label: $('#invLabel').value.trim() || null,
      created_by: '나',
      max_uses: Math.max(0, Math.min(99, Math.round(maxUses)))
    });
    btn.disabled = false;
    if (dbError(res.error, '초대 링크 생성')) return;

    var link = inviteLinkFor(token);
    $('#inviteLink').value = link;
    $('#inviteLinkHint').textContent = '토큰 ' + token + ' · ' +
      (maxUses > 0 ? '최대 ' + maxUses + '명' : '인원 제한 없음') + ' · 이 링크를 전달하면 비서가 직접 참여합니다.';
    $('#inviteLinkBox').hidden = false;
    copyText(link).then(function (ok) {
      toast(ok ? '초대 링크를 만들고 복사했습니다.' : '초대 링크를 만들었습니다.');
    });
  }

  async function copyText(text, okMsg) {
    var ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch (e) { ok = false; }
    if (!ok) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        ta.remove();
      } catch (e) { ok = false; }
    }
    if (okMsg) toast(ok ? okMsg : '복사하지 못했습니다. 길게 눌러 복사하세요.');
    return ok;
  }

  async function quickAddAssistant(e) {
    e.preventDefault();
    var room = currentRoom();
    if (!room) { toast('회의실을 먼저 불러와 주세요.'); return; }
    var name = $('#qName').value.trim();
    if (!name) { toast('비서 이름을 입력하세요.'); return; }
    var res = await sb.from('assistants').insert({
      room_id: room.id,
      name: name,
      period: $('#qPeriod').value,
      mode: 'auto',
      status: 'online',
      color: COLORS[room.assistants.length % COLORS.length],
      last_seen_at: new Date().toISOString()
    }).select().single();
    if (dbError(res.error, '초대')) return;
    await insertMessage({
      room_id: room.id, sender_name: 'system', sender_role: 'system', kind: 'system',
      content: name + ' 비서가 회의실에 초대되었습니다.'
    });
    $('#qName').value = '';
    closeModal('inviteModal');
    toast('[' + name + '] 비서를 초대했습니다.');
  }

  /* settings */
  function openSettings() {
    var room = currentRoom();
    $('#setRoomName').value = room ? room.name : '';
    $('#setRisk').value = state.settings.risk;
    $('#setSoon').value = state.settings.soon;
    $('#setStale').value = state.settings.staleHours;
    $('#setStartDash').checked = !!state.settings.startDash;
    $('#setEnterSend').checked = state.settings.enterSend !== false;
    updateThresholdHints();
    $('#setConn').textContent = ({ connecting: '연결 중…', live: '실시간 연결됨', error: '연결 끊김', offline: '오프라인' })[connState] || connState;
    $('#lastSaved').textContent = state.updatedAt ? relTime(state.updatedAt) : '—';
    $('#appVersion').textContent = APP_VERSION;
    $('#settingsDeleteRoom').disabled = state.rooms.length <= 1;
    $('#settingsDeleteRoom').style.opacity = state.rooms.length <= 1 ? '.45' : '';
    renderManageList();
    openModal('settingsModal');
  }

  function updateThresholdHints() {
    $('#hintRisk').textContent = state.settings.risk;
    $('#hintSoon').textContent = state.settings.soon;
    $('#hintStale').textContent = state.settings.staleHours;
  }

  function applyThresholds() {
    var risk = clamp(Number($('#setRisk').value) || 10, 1, 50);
    var soon = clamp(Number($('#setSoon').value) || 30, 1, 80);
    if (soon <= risk) soon = risk + 1;
    var stale = clamp(Number($('#setStale').value) || 6, 1, 72);
    state.settings.risk = Math.round(risk);
    state.settings.soon = Math.round(soon);
    state.settings.staleHours = Math.round(stale);
    $('#setRisk').value = state.settings.risk;
    $('#setSoon').value = state.settings.soon;
    $('#setStale').value = state.settings.staleHours;
    updateThresholdHints();
    saveSettings();
    renderAll();
    toast('사용량 기준을 저장했습니다.');
  }

  /* rooms */
  function promptCreateRoom() {
    openPrompt({
      title: '새 회의실',
      sub: '비서를 새로 모을 회의실을 만듭니다.',
      label: '회의실 이름',
      value: '',
      placeholder: '예: 업무-비서실',
      onSave: async function (name) {
        var slug = 'room-' + randomToken().slice(0, 8);
        var res = await sb.from('rooms').insert({ slug: slug, name: name, description: null }).select().single();
        if (dbError(res.error, '회의실 생성')) return;
        await insertMessage({
          room_id: res.data.id, sender_name: 'system', sender_role: 'system', kind: 'system',
          content: '# ' + name + ' 회의실이 열렸습니다. 초대 링크로 비서를 불러보세요.'
        });
        state.activeRoomId = res.data.id;
        await loadRemote({ silent: true });
        setDashboard(false);
        toast('새 회의실을 만들었습니다.');
      }
    });
  }

  async function deleteRoom() {
    if (state.rooms.length <= 1) {
      toast('회의실이 하나뿐이라 삭제할 수 없습니다.');
      return;
    }
    var room = currentRoom();
    if (!room) return;
    if (!confirm('"#' + room.name + '" 회의실을 삭제할까요?\n이 회의실의 대화와 비서 목록이 함께 삭제됩니다.')) return;
    var res = await sb.from('rooms').delete().eq('id', room.id);
    if (dbError(res.error, '회의실 삭제')) return;
    state.activeRoomId = null;
    await loadRemote({ silent: true });
    closeAllModals();
    setDashboard(false);
    toast('회의실을 삭제했습니다.');
  }

  function openPrompt(cfg) {
    $('#promptTitle').textContent = cfg.title;
    $('#promptSub').textContent = cfg.sub || '';
    $('#promptLabel').textContent = cfg.label || '이름';
    $('#promptInput').value = cfg.value || '';
    $('#promptInput').placeholder = cfg.placeholder || '';
    ui.promptHandler = cfg.onSave;
    openModal('promptModal');
  }

  function savePrompt() {
    var v = $('#promptInput').value.trim();
    if (!v) { toast('이름을 입력하세요.'); return; }
    var fn = ui.promptHandler;
    closeModal('promptModal');
    ui.promptHandler = null;
    if (fn) fn(v);
  }

  /* data portability */
  function exportData() {
    var payload = JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), rooms: state.rooms }, null, 2);
    var blob = new Blob([payload], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var d = new Date();
    a.href = url;
    a.download = 'pickle-meeting-room-' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    toast('JSON 파일로 내보냈습니다.');
  }

  /* drawer */
  function openDrawer() {
    $('#drawer').hidden = false;
    $('#drawerScrim').hidden = false;
    renderDrawer();
  }
  function closeDrawer() {
    $('#drawer').hidden = true;
    $('#drawerScrim').hidden = true;
  }

  /* ── search ──────────────────────────────────────────────── */
  function openSearch() {
    ui.searchOpen = true;
    $('#searchBar').hidden = false;
    setDashboard(false);
    setTimeout(function () { $('#searchInput').focus(); }, 50);
  }
  function closeSearch() {
    ui.searchOpen = false;
    ui.search = '';
    $('#searchBar').hidden = true;
    $('#searchInput').value = '';
    $('#searchCount').textContent = '';
    renderChat();
    scrollToBottom();
  }

  /* ── theme (seal) ────────────────────────────────────────── */
  var THEMES = [
    { bg: '#f3f4f6', name: '기본' },
    { bg: '#edf4f1', name: '민트' },
    { bg: '#f4f1fb', name: '라벤더' },
    { bg: '#fbf3ed', name: '살구' }
  ];
  var themeIndex = 0;
  function cycleTheme() {
    themeIndex = (themeIndex + 1) % THEMES.length;
    document.documentElement.style.setProperty('--bg', THEMES[themeIndex].bg);
    toast('테마: ' + THEMES[themeIndex].name);
  }

  /* ── voice input ─────────────────────────────────────────── */
  function startVoice() {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { toast('이 브라우저는 음성 입력을 지원하지 않습니다.'); return; }
    var rec = new SR();
    rec.lang = 'ko-KR';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    var btn = $('#micBtn');
    btn.classList.add('listening');
    rec.onresult = function (e) {
      var text = e.results[0][0].transcript;
      var input = $('#composerInput');
      input.value = (input.value ? input.value.replace(/\s*$/, ' ') : '') + text;
      autoGrow();
      input.focus();
    };
    rec.onerror = function () { toast('음성 인식에 실패했습니다.'); };
    rec.onend = function () { btn.classList.remove('listening'); };
    try { rec.start(); } catch (e) { btn.classList.remove('listening'); }
  }

  /* ── join flow (?invite=<token>) ─────────────────────────── */
  var joinState = { token: null, invite: null, assistant: null };

  function showJoinView() {
    $('#app').hidden = true;
    $('#joinView').hidden = false;
    document.body.classList.add('joining');
  }

  function hideJoinView() {
    $('#app').hidden = false;
    $('#joinView').hidden = true;
    document.body.classList.remove('joining');
  }

  async function initJoin(token) {
    joinState.token = token;
    showJoinView();
    $('#joinTitle').textContent = '초대 확인 중…';
    $('#joinSub').textContent = '초대 링크를 검증하고 있습니다.';
    var res = await sb.rpc('verify_invite', { p_token: token });
    if (res.error) {
      $('#joinTitle').textContent = '초대를 확인하지 못했습니다';
      $('#joinSub').textContent = res.error.message;
      return;
    }
    var inv = res.data || {};
    joinState.invite = inv;
    if (!inv.valid) {
      var reason = { not_found: '존재하지 않는 초대 링크입니다.', expired: '초대 링크가 만료되었습니다.', exhausted: '초대 인원이 모두 찼습니다.' }[inv.reason] || '사용할 수 없는 초대입니다.';
      $('#joinTitle').textContent = '참여할 수 없습니다';
      $('#joinSub').textContent = reason + ' 회의실 관리자에게 새 링크를 요청하세요.';
      return;
    }
    $('#joinRoomName').textContent = inv.room_name || '비서 회의실';
    $('#joinTitle').textContent = '회의실에 참여합니다';
    $('#joinSub').textContent = '# ' + (inv.room_name || '비서 회의실') +
      (inv.label ? ' · 초대: ' + inv.label : '') +
      (inv.remaining_uses > 0 ? ' · 남은 인원 ' + inv.remaining_uses + '명' : '');
    $('#joinForm').hidden = false;
    $('#jName').focus();
  }

  async function submitJoin(e) {
    e.preventDefault();
    var name = $('#jName').value.trim();
    if (!name) { toast('비서 이름을 입력하세요.'); return; }
    var btn = $('#joinSubmit');
    btn.disabled = true;
    var res = await sb.rpc('redeem_invite', {
      p_token: joinState.token,
      p_name: name,
      p_emoji: $('#jEmoji').value.trim() || null,
      p_role: $('#jRole').value.trim() || '비서',
      p_model: $('#jModel').value.trim() || null,
      p_period: $('#jPeriod').value
    });
    btn.disabled = false;
    if (res.error) {
      toast('참여하지 못했습니다: ' + res.error.message);
      return;
    }
    var aide = res.data;
    joinState.assistant = aide;
    $('#joinForm').hidden = true;
    $('#joinResult').hidden = false;
    $('#joinTitle').textContent = '참여 완료';
    $('#joinSub').textContent = '# ' + (joinState.invite.room_name || '회의실') + '에 ' + aide.name + ' 비서로 등록되었습니다.';
    $('#joinResultHint').innerHTML = '회의실에 실시간으로 연결되었습니다. 아래 REST API로 메시지를 보내고 사용량을 보고하세요.<br>' +
      'assistant id: <b>' + esc(aide.id) + '</b><br>room id: <b>' + esc(aide.room_id) + '</b>';
    $('#joinApi').textContent = [
      'BASE : ' + (CFG.supabaseUrl || ''),
      'KEY  : ' + (CFG.supabaseAnonKey || ''),
      '',
      '■ 메시지 보내기',
      'POST ' + CFG.supabaseUrl + '/rest/v1/messages',
      '{"room_id":"' + aide.room_id + '","sender_id":"' + aide.id + '","sender_name":"' + aide.name + '","sender_role":"assistant","content":"안녕하세요, 참여했습니다."}',
      '',
      '■ 사용량 보고',
      'POST ' + CFG.supabaseUrl + '/rest/v1/rpc/report_usage',
      '{"p_assistant_id":"' + aide.id + '","p_percent":87.5,"p_reset_at":"2026-11-27T09:00:00+09:00"}',
      '',
      '■ 메시지 읽기',
      'GET ' + CFG.supabaseUrl + '/rest/v1/messages?room_id=eq.' + aide.room_id + '&order=created_at.desc&limit=50',
      '',
      '■ 실시간 수신',
      'supabase-js 채널로 messages 테이블을 구독하면 새 메시지가 즉시 도착합니다.'
    ].join('\n');
    try { localStorage.setItem('pickle-meeting-room.my-assistant.v1', JSON.stringify({ id: aide.id, roomId: aide.room_id, name: aide.name })); } catch (err) { /* ignore */ }
  }

  /* ── events ──────────────────────────────────────────────── */
  function bind() {
    $('#menuBtn').addEventListener('click', openDrawer);
    $('#drawerClose').addEventListener('click', closeDrawer);
    $('#drawerScrim').addEventListener('click', closeDrawer);
    $('#membersBtn').addEventListener('click', function () { renderMembers(); openModal('membersModal'); });
    $('#searchBtn').addEventListener('click', function () {
      if (ui.searchOpen) closeSearch(); else openSearch();
    });
    $('#knotBtn').addEventListener('click', cycleTheme);
    $('#settingsBtn').addEventListener('click', openSettings);
    $('#moreBtn').addEventListener('click', function () { openModal('moreModal'); });

    $('#summaryToggle').addEventListener('click', function () { setDashboard(!ui.dashboardOpen); });
    $('#summaryRight').addEventListener('click', function () { setDashboard(!ui.dashboardOpen); });
    $('#dashClose').addEventListener('click', function () { setDashboard(false); });
    $('#dashRefresh').addEventListener('click', function () {
      var btn = $('#dashRefresh');
      btn.classList.add('spin');
      setTimeout(function () { btn.classList.remove('spin'); }, 700);
      loadRemote({ silent: true }).then(function (ok) {
        if (ok) toast('사용량을 새로 불러왔습니다.');
      });
    });

    var qRefresh = $('#quotaRefresh');
    if (qRefresh) {
      var qBusy = false;
      qRefresh.addEventListener('click', async function () {
        if (qBusy) return;
        var fnUrl = CFG.quotaFunctionUrl || '';
        if (!fnUrl) {
          toast('실시간 실측 주소가 설정되지 않았습니다.');
          return;
        }
        qBusy = true;
        var labelEl = qRefresh.querySelector('.q-refresh-label');
        var prevLabel = labelEl ? labelEl.textContent : '';
        qRefresh.classList.add('spin');
        qRefresh.setAttribute('aria-busy', 'true');
        qRefresh.disabled = true;
        if (labelEl) labelEl.textContent = '실측 중…';
        try {
          var res = await fetch(fnUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              apikey: CFG.supabaseAnonKey || '',
              Authorization: 'Bearer ' + (CFG.supabaseAnonKey || '')
            },
            body: '{}'
          });
          var data = null;
          try { data = await res.json(); } catch (e) { data = null; }
          if (!res.ok || !data || data.ok === false) {
            throw new Error((data && data.error) || ('HTTP ' + res.status));
          }
          await loadRemote({ silent: true });
          if (data.ran === false) {
            var wait = (data.skipped && data.skipped[0] && data.skipped[0].reason) || '잠시 뒤 다시 눌러 주세요.';
            toast('지난 실측 결과입니다 · ' + wait);
          } else {
            var skippedN = (data.skipped || []).length;
            var notionBit = '';
            if (data.notion && data.notion.ok) notionBit = ' · 노션 기록 반영';
            else if (data.notion && data.notion.error) notionBit = ' · 노션 조회 실패';
            toast('실측 완료 · 정상 ' + (data.ok_count || 0) + '곳' +
              (data.limited_count ? ' · 한도초과 ' + data.limited_count + '곳' : '') +
              (data.error_count ? ' · 오류 ' + data.error_count + '곳' : '') +
              (skippedN ? ' (' + skippedN + '곳은 재호출 생략)' : '') + notionBit);
          }
        } catch (err) {
          toast('실시간 실측 실패: ' + ((err && err.message) || err));
        } finally {
          qBusy = false;
          qRefresh.classList.remove('spin');
          qRefresh.removeAttribute('aria-busy');
          qRefresh.disabled = false;
          if (labelEl) labelEl.textContent = prevLabel || '실시간 실측 새로고침';
        }
      });
    }

    bindCalendar();
    bindYoutube();

    $('#dashBody').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act="edit"]');
      if (btn) openAssistantModal(btn.getAttribute('data-id'));
    });
    $('#memberList').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-edit]');
      if (btn) { closeModal('membersModal'); openAssistantModal(btn.getAttribute('data-edit')); }
    });
    $('#manageList').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-edit]');
      if (btn) openAssistantModal(btn.getAttribute('data-edit'));
    });

    $('#addBtn').addEventListener('click', openInvite);
    $('#inviteChip').addEventListener('click', openInvite);
    $('#memberInvite').addEventListener('click', function () { closeModal('membersModal'); openInvite(); });
    $('#drawerInvite').addEventListener('click', function () { closeDrawer(); openInvite(); });
    $('#createInvite').addEventListener('click', createInvite);
    $('#copyLink').addEventListener('click', function () {
      copyText($('#inviteLink').value, '초대 링크를 복사했습니다.');
    });
    $('#copySpec').addEventListener('click', function () {
      copyText($('#apiSpec').textContent, '참여 안내를 복사했습니다.');
    });
    $('#quickAddForm').addEventListener('submit', quickAddAssistant);

    $('#assistantForm').addEventListener('submit', submitAssistant);
    $('#fDelete').addEventListener('click', deleteAssistant);

    $('#renameRoom').addEventListener('click', async function () {
      var v = $('#setRoomName').value.trim();
      var room = currentRoom();
      if (!v) { toast('회의실 이름을 입력하세요.'); return; }
      if (!room) return;
      var res = await sb.from('rooms').update({ name: v }).eq('id', room.id);
      if (dbError(res.error, '이름 변경')) return;
      room.name = v;
      renderTop();
      renderDrawer();
      toast('회의실 이름을 변경했습니다.');
    });
    ['#setRisk', '#setSoon', '#setStale'].forEach(function (sel) {
      $(sel).addEventListener('change', applyThresholds);
    });
    $('#setStartDash').addEventListener('change', function () {
      state.settings.startDash = this.checked; saveSettings();
    });
    $('#setEnterSend').addEventListener('change', function () {
      state.settings.enterSend = this.checked; saveSettings();
    });
    $('#manageAdd').addEventListener('click', function () { closeModal('settingsModal'); openAssistantModal(null); });
    $('#settingsNewRoom').addEventListener('click', function () { closeModal('settingsModal'); promptCreateRoom(); });
    $('#settingsDeleteRoom').addEventListener('click', deleteRoom);
    $('#exportBtn2').addEventListener('click', exportData);
    $('#refreshBtn2').addEventListener('click', function () { reload(true); });

    $('#exportBtn').addEventListener('click', function () { closeModal('moreModal'); exportData(); });
    $('#refreshBtn').addEventListener('click', function () { closeModal('moreModal'); reload(true); });
    $('#installBtn').addEventListener('click', function () {
      closeModal('moreModal');
      if (!installEvent) { toast('브라우저 메뉴에서 "홈 화면에 추가"를 선택해 주세요.'); return; }
      installEvent.prompt();
      installEvent.userChoice.finally(function () { installEvent = null; $('#installBtn').hidden = true; });
    });
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      installEvent = e;
      $('#installBtn').hidden = false;
    });
    window.addEventListener('appinstalled', function () { toast('홈 화면에 추가했습니다.'); });

    $('#aboutBtn').addEventListener('click', function () {
      closeModal('moreModal');
      toast('비서 통합 회의실 v' + APP_VERSION + ' · Supabase 실시간 연결');
    });

    $('#newRoomBtn').addEventListener('click', function () { closeDrawer(); promptCreateRoom(); });
    $('#promptSave').addEventListener('click', savePrompt);
    $('#promptInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); savePrompt(); }
    });

    $('#searchInput').addEventListener('input', function () {
      ui.search = this.value.trim();
      renderChat();
      if (ui.search) scrollToBottom();
    });
    $('#searchClose').addEventListener('click', closeSearch);

    var input = $('#composerInput');
    input.addEventListener('input', function () {
      autoGrow();
      var ctx = currentMentionQuery();
      if (ctx) showMentionPop(ctx); else hideMentionPop();
    });
    input.addEventListener('click', function () {
      var ctx = currentMentionQuery();
      if (ctx) showMentionPop(ctx);
    });
    input.addEventListener('blur', function () { setTimeout(hideMentionPop, 120); });
    input.addEventListener('keydown', function (e) {
      if (!($('#mentionPop').hidden)) {
        if (e.key === 'ArrowDown') { e.preventDefault(); moveMentionSelection(1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); moveMentionSelection(-1); return; }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          var item = mentionState.items[mentionState.index];
          if (item) applyMentionItem(item.name);
          return;
        }
        if (e.key === 'Escape') { hideMentionPop(); return; }
      }
      if (e.key === 'Enter' && !e.shiftKey && state.settings.enterSend) {
        e.preventDefault();
        sendMessage();
      }
    });

    $('#sendBtn').addEventListener('click', sendMessage);
    $('#micBtn').addEventListener('click', startVoice);

    $$('[data-quick]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var kind = btn.getAttribute('data-quick');
        var prompts = {
          meeting: '지금까지 대화를 회의록으로 정리해줘. 결정 사항 / 할 일 / 담당자 / 다음 회의 순서로 나눠서.',
          todo: '대화에서 할 일을 뽑아서 담당자와 마감일을 붙여줘.',
          draft: '아래 내용으로 공유용 초안을 써줘.\n\n'
        };
        var el = $('#composerInput');
        el.value = prompts[kind] || '';
        autoGrow();
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      });
    });

    $('#chatView').addEventListener('scroll', function () {
      var el = this;
      var far = el.scrollHeight - el.scrollTop - el.clientHeight > 220;
      $('#scrollBottom').hidden = !far;
    });
    $('#scrollBottom').addEventListener('click', function () { scrollToBottom(); this.hidden = true; });

    $$('[data-close]').forEach(function (el) {
      el.addEventListener('click', function () {
        var modal = el.closest('.modal');
        if (modal) closeModal(modal.id);
      });
    });

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var open = $$('.modal:not([hidden])');
      if (open.length) { closeModal(open[open.length - 1].id); return; }
      if (!$('#drawer').hidden) { closeDrawer(); return; }
      if (ui.searchOpen) closeSearch();
    });

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        if (connState !== 'live' && navigator.onLine !== false) connectRealtime();
        renderSummary();
        if (isQuotaRoom()) { renderTop(); renderQuota(); }
        else if (isCalendarRoom()) {
          if ((Date.now() - calState.lastAttempt) > 60 * 1000) calFetch(false);
          else { renderTop(); renderCalendar(); }
        }
        else if (isYoutubeRoom()) {
          if ((Date.now() - ytState.lastAttempt) > 60 * 1000) ytFetch(false);
          else { renderTop(); renderYoutube(); }
        }
        else if (ui.dashboardOpen) renderDashboard();
      }
    });

    window.addEventListener('online', function () { connectRealtime(); });
    window.addEventListener('offline', function () { setConn('offline'); });

    /* join view */
    $('#joinForm').addEventListener('submit', submitJoin);
    $('#copyJoinApi').addEventListener('click', function () {
      copyText($('#joinApi').textContent, '사용법을 복사했습니다.');
    });
    $('#joinEnter').addEventListener('click', function () {
      location.href = location.pathname;
    });
  }

  var installEvent = null;

  /* ── boot ────────────────────────────────────────────────── */
  function boot() {
    try {
      if (new URLSearchParams(location.search).get('view') === 'dashboard') ui.dashboardOpen = true;
    } catch (e) { /* older browser */ }
    try { pendingSlug = new URLSearchParams(location.search).get('room'); } catch (e) { pendingSlug = null; }

    bind();
    setConn('connecting');
    renderAll();
    setDashboard(ui.dashboardOpen);

    if (!CFG.supabaseUrl || !CFG.supabaseAnonKey || !window.supabase) {
      setConn('error');
      toast('Supabase 설정을 찾지 못했습니다. config.js 를 확인하세요.');
      return;
    }

    sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { params: { eventsPerSecond: 10 } }
    });

    var inviteToken = null;
    try { inviteToken = new URLSearchParams(location.search).get('invite'); } catch (e) { /* ignore */ }

    if (inviteToken) {
      initJoin(inviteToken);
    }

    connectRealtime();
    loadRemote().then(function () {
      if (!ui.dashboardOpen) settleAtBottom();
      // 📅 업로드-캘린더 일정은 방에 들어가기 전에 미리 받아 둔다(드로어 배지·첫 화면이 바로 채워지게)
      calFetch(false);
      // 📺 유튜브-대시보드 통계도 같이 미리 받아 둔다(피클 토큰 0)
      ytFetch(false);
    });

    setInterval(function () {
      renderSummary();
      if (isQuotaRoom()) { renderTop(); renderQuota(); }
      else if (isCalendarRoom()) { renderTop(); }
      else if (isYoutubeRoom()) { renderTop(); }
      else if (ui.dashboardOpen) renderDashboard();
      // 활동 시각이 오래된 비서의 온라인 표시 갱신
      var room = currentRoom();
      if (room) {
        var changed = false;
        room.assistants.forEach(function (a) {
          var on = a.lastSeenAt && (Date.now() - a.lastSeenAt) < ONLINE_MS;
          if (!!a.online !== !!on) { a.online = !!on; changed = true; }
        });
        if (changed) renderTop();
      }
    }, 30000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
