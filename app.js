/* ──────────────────────────────────────────────────────────────
   비서 통합 회의실 — app logic (vanilla JS, no dependencies)
   데이터는 브라우저 localStorage 에만 저장됩니다.
   ────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var STORAGE_KEY = 'pickle-meeting-room.v1';
  var APP_VERSION = '1.0.0';
  var MIN = 60000, HOUR = 3600000, DAY = 86400000;

  var COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899',
    '#8b5cf6', '#14b8a6', '#ef4444', '#3b82f6', '#84cc16'];

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
  function nextHour(hour) {
    var d = new Date();
    d.setHours(hour, 0, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  /* ── default / demo state ────────────────────────────────── */
  function makeAssistant(o, i) {
    return {
      id: o.id || uid('a'),
      name: o.name || '비서',
      period: o.period === 'weekly' ? 'weekly' : 'daily',
      mode: o.mode === 'manual' ? 'manual' : 'auto',
      remaining: o.remaining == null || o.remaining === '' ? null : clamp(Number(o.remaining), 0, 100),
      resetAt: o.resetAt || null,
      lastReportAt: o.lastReportAt || null,
      extra: o.extra || '',
      note: o.note || '',
      online: !!o.online,
      color: o.color || COLORS[i % COLORS.length]
    };
  }

  function demoState() {
    var now = Date.now();
    var mins = function (m) { return now - m * MIN; };
    var hrs = function (h) { return now - h * HOUR; };

    var assistants = [
      makeAssistant({ name: '인스팅트2', period: 'daily', remaining: 95, mode: 'auto', online: true,
        resetAt: nextHour(18), lastReportAt: mins(3) }, 0),
      makeAssistant({ name: '인스팅트1', period: 'daily', remaining: 96.9, mode: 'auto', online: true,
        resetAt: nextHour(18), lastReportAt: mins(5) }, 1),
      makeAssistant({ name: '김비서', period: 'daily', remaining: null, mode: 'auto', online: true }, 2),
      makeAssistant({ name: '피클2호기', period: 'daily', remaining: null, mode: 'auto', online: false }, 3),
      makeAssistant({ name: 'Muse2', period: 'weekly', remaining: 63, mode: 'auto', online: true,
        resetAt: now + 3 * DAY + 23 * HOUR, lastReportAt: hrs(1), extra: '7.9B' }, 4),
      makeAssistant({ name: 'Muse3', period: 'weekly', remaining: 75, mode: 'auto', online: true,
        resetAt: now + 5 * DAY + 8 * HOUR, lastReportAt: mins(30), extra: '1B' }, 5),
      makeAssistant({ name: 'Muse1', period: 'weekly', remaining: 96, mode: 'auto', online: true,
        resetAt: now + 6 * DAY + 2 * HOUR, lastReportAt: hrs(2) }, 6),
      makeAssistant({ name: 'Muse4', period: 'weekly', remaining: 96, mode: 'auto', online: true,
        resetAt: now + 2 * DAY + 4 * HOUR, lastReportAt: hrs(2) }, 7),
      makeAssistant({ name: '보리', period: 'weekly', remaining: null, mode: 'manual', online: false }, 8),
      makeAssistant({ name: '수지', period: 'weekly', remaining: null, mode: 'auto', online: false }, 9)
    ];

    var messages = [
      { id: uid('m'), type: 'system', text: '# 비서-통합-회의실 회의실이 열렸습니다. 비서 10명이 참여 중입니다.', at: hrs(8.6) },
      { id: uid('m'), type: 'assistant', authorId: assistants[1].id, text: '좋은 아침입니다. 일일 사용량 96.9% 남았습니다. 오후 6시에 리셋됩니다.', at: hrs(8.5) },
      { id: uid('m'), type: 'assistant', authorId: assistants[0].id, text: '인스팅트2도 일일 95% 남음입니다. 오늘은 여유가 있습니다.', at: hrs(8.4) },
      { id: uid('m'), type: 'assistant', authorId: assistants[4].id, text: '주간 63% 남음, 리셋까지 3일 23시간. 추가 7.9B 크레딧도 있습니다.', at: hrs(8.1) },
      { id: uid('m'), type: 'user', authorId: 'me', text: '@전체 오늘 오후 2시 주간 회의 준비 상황 공유해줘.', at: hrs(8.0) },
      { id: uid('m'), type: 'assistant', authorId: assistants[5].id, text: '@나 주간 75% 남았고, 회의 안건 초안은 준비됐습니다. 리셋은 5일 8시간 후입니다.', at: hrs(7.9) },
      { id: uid('m'), type: 'assistant', authorId: assistants[2].id, text: '회의실 링크 확인했습니다. 사용량은 아직 보고 전이라 곧 정리해서 올리겠습니다.', at: hrs(7.7) },
      { id: uid('m'), type: 'user', authorId: 'me', text: '@김비서 잔여 사용량도 같이 올려줘.', at: hrs(7.6) },
      { id: uid('m'), type: 'assistant', authorId: assistants[8].id, text: '네, 지금 정리해서 올리겠습니다. 회의록은 별도 스레드에 붙여둘게요.', at: hrs(7.2) },
      { id: uid('m'), type: 'assistant', authorId: assistants[3].id, text: '지난 회의록 3건 정리해서 공유드렸습니다. 확인 부탁드립니다.', at: hrs(5.4) },
      { id: uid('m'), type: 'assistant', authorId: assistants[9].id, text: '할 일 목록 초안 뽑았습니다. 담당자 배정만 남았습니다.', at: hrs(4.2) },
      { id: uid('m'), type: 'assistant', authorId: assistants[6].id, text: 'Muse1 주간 96% 남음입니다. 이번 주는 넉넉합니다.', at: hrs(3.5) },
      { id: uid('m'), type: 'user', authorId: 'me', text: '@Muse4 이번 주 리셋 일정 알려줘.', at: hrs(1.1) },
      { id: uid('m'), type: 'assistant', authorId: assistants[7].id, text: '주간 96% 남음, 리셋까지 2일 4시간입니다. 회의 전에 한 번 더 보고드릴게요.', at: hrs(1.05) },
      { id: uid('m'), type: 'system', text: 'Muse2 · Muse3의 사용량이 갱신되었습니다.', at: mins(30) }
    ];

    return {
      version: 1,
      activeRoomId: 'room-main',
      rooms: [{
        id: 'room-main',
        name: '비서-통합-회의실',
        createdAt: now - 30 * DAY,
        assistants: assistants,
        messages: messages
      }],
      settings: {
        risk: 10,
        soon: 30,
        staleHours: 6,
        autoReply: true,
        startDash: false,
        enterSend: true
      },
      updatedAt: now,
      savedAt: now
    };
  }

  /* ── state ───────────────────────────────────────────────── */
  function normalizeState(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.rooms) || !raw.rooms.length) return null;
    var out = {
      version: 1,
      activeRoomId: raw.activeRoomId,
      rooms: [],
      settings: {
        risk: 10, soon: 30, staleHours: 6,
        autoReply: true, startDash: false, enterSend: true
      },
      updatedAt: raw.updatedAt || Date.now(),
      savedAt: raw.savedAt || Date.now()
    };
    if (raw.settings && typeof raw.settings === 'object') {
      var s = raw.settings;
      if (isFinite(s.risk)) out.settings.risk = clamp(Number(s.risk), 1, 50);
      if (isFinite(s.soon)) out.settings.soon = clamp(Number(s.soon), 2, 80);
      if (isFinite(s.staleHours)) out.settings.staleHours = clamp(Number(s.staleHours), 1, 72);
      out.settings.autoReply = s.autoReply !== false;
      out.settings.startDash = !!s.startDash;
      out.settings.enterSend = s.enterSend !== false;
    }
    raw.rooms.forEach(function (r, ri) {
      if (!r || typeof r !== 'object') return;
      var assistants = Array.isArray(r.assistants) ? r.assistants.map(function (a, i) { return makeAssistant(a, i); }) : [];
      var ids = assistants.map(function (a) { return a.id; });
      var messages = Array.isArray(r.messages) ? r.messages.filter(function (m) {
        return m && (m.type === 'system' || (m.type === 'user' && m.authorId === 'me') ||
          (m.type === 'assistant' && ids.indexOf(m.authorId) !== -1));
      }).map(function (m) {
        return {
          id: m.id || uid('m'),
          type: m.type,
          authorId: m.authorId,
          text: String(m.text == null ? '' : m.text),
          at: Number(m.at) || Date.now()
        };
      }) : [];
      messages.sort(function (a, b) { return a.at - b.at; });
      out.rooms.push({
        id: r.id || uid('room'),
        name: String(r.name || ('회의실 ' + (ri + 1))).slice(0, 32),
        createdAt: Number(r.createdAt) || Date.now(),
        assistants: assistants,
        messages: messages
      });
    });
    if (!out.rooms.length) return null;
    if (!out.rooms.some(function (r) { return r.id === out.activeRoomId; })) {
      out.activeRoomId = out.rooms[0].id;
    }
    return out;
  }

  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var parsed = normalizeState(JSON.parse(raw));
        if (parsed) return parsed;
      }
    } catch (e) { /* ignore broken storage */ }
    return demoState();
  }

  var state = loadState();
  var ui = {
    dashboardOpen: !!state.settings.startDash,
    search: '',
    searchOpen: false,
    editingId: null,
    promptHandler: null,
    pendingReplies: []
  };

  var installEvent = null;

  var saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        state.savedAt = Date.now();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (e) {
        toast('저장 공간이 부족해 저장하지 못했습니다.');
      }
    }, 90);
  }
  function touch() { state.updatedAt = Date.now(); save(); }

  function currentRoom() {
    var r = state.rooms.find(function (x) { return x.id === state.activeRoomId; });
    return r || state.rooms[0];
  }
  function assistantById(id) {
    return currentRoom().assistants.find(function (a) { return a.id === id; });
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
    var c = { ok: 0, soon: 0, risk: 0, unknown: 0, total: 0, reported: 0, online: 1 };
    currentRoom().assistants.forEach(function (a) {
      c[statusOf(a)]++;
      c.total++;
      if (isReported(a)) c.reported++;
      if (a.online) c.online++;
    });
    return c;
  }

  /* ── toast ───────────────────────────────────────────────── */
  var toastTimer = null;
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2100);
  }

  /* ── rendering: top bar & summary ────────────────────────── */
  function renderTop() {
    var room = currentRoom();
    var c = counts();
    $('#roomTitle').textContent = room.name;
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
      pair[0] && $(pair[0]).closest('.sum-count').classList.toggle('has', pair[1] > 0);
    });
    var diff = Date.now() - (state.updatedAt || Date.now());
    var label = diff < 60 * 1000 ? '방금 갱신' : (Math.floor(diff / MIN) + '분 전 갱신');
    $('#summaryUpdated').textContent = label;
  }

  /* ── rendering: chat ─────────────────────────────────────── */
  function mentionMatcher() {
    var names = ['전체'].concat(currentRoom().assistants.map(function (a) { return a.name; }));
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

  function avatarEl(name, color, size) {
    var el = document.createElement('div');
    el.className = 'avatar';
    el.style.background = color || '#94a3b8';
    if (size) { el.style.width = size + 'px'; el.style.height = size + 'px'; }
    el.textContent = (name || '?').trim().charAt(0).toUpperCase();
    return el;
  }

  function renderChat(opts) {
    opts = opts || {};
    var list = $('#chatList');
    var chatEl = $('#chatView');
    var room = currentRoom();
    var prevTop = chatEl.scrollTop;
    var q = ui.search.trim().toLowerCase();

    var msgs = room.messages;
    if (q) {
      msgs = msgs.filter(function (m) {
        if (m.type === 'system') return m.text.toLowerCase().indexOf(q) !== -1;
        var a = m.authorId === 'me' ? { name: '나' } : assistantById(m.authorId);
        var name = a ? a.name : '';
        return m.text.toLowerCase().indexOf(q) !== -1 || name.toLowerCase().indexOf(q) !== -1;
      });
    }

    if (q) {
      $('#searchCount').textContent = msgs.length ? msgs.length + '개 일치' : '결과 없음';
    } else {
      $('#searchCount').textContent = '';
    }

    list.innerHTML = '';
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

      var isMe = msg.authorId === 'me';
      var author = isMe ? { name: '나', color: '#111827' } : assistantById(msg.authorId);
      if (!author) author = { name: '알 수 없음', color: '#94a3b8' };

      var wrap = document.createElement('div');
      wrap.className = 'msg' + (isMe ? ' me' : '');
      wrap.appendChild(avatarEl(author.name, author.color));

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

    if (opts.bottom) {
      requestAnimationFrame(scrollToBottom);
    } else if (prevTop) {
      chatEl.scrollTop = prevTop;
    }
  }

  function scrollToBottom() {
    var chatEl = $('#chatView');
    chatEl.scrollTop = chatEl.scrollHeight;
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
    if (a.note) tags += '<span class="tag" title="' + esc(a.note) + '">' + esc(a.note) + '</span>';

    return '' +
      '<article class="card" data-id="' + esc(a.id) + '">' +
      '<div class="card-top">' +
      '<span class="dot" data-state="' + st + '"></span>' +
      '<span class="card-name">' + esc(a.name) + '</span>' +
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
    $('#dashboard').hidden = !open;
    $('#chatView').hidden = open;
    $('#summaryToggle').setAttribute('aria-expanded', String(open));
    $('#summaryRight').classList.toggle('collapsed', !open);
    if (open) {
      renderDashboard();
      $('#dashboard').scrollTop = 0;
    } else {
      renderChat();
      scrollToBottom();
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

    currentRoom().assistants.forEach(function (a) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'm-chip';
      b.textContent = '@' + a.name;
      b.addEventListener('click', function () { insertMention(a.name); });
      row.appendChild(b);
    });
  }

  function renderDrawer() {
    var roomsEl = $('#roomList');
    roomsEl.innerHTML = '';
    state.rooms.forEach(function (r) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'room-item' + (r.id === state.activeRoomId ? ' active' : '');
      b.innerHTML = '<span class="hash">#</span><span class="rname">' + esc(r.name) + '</span>' +
        '<small>' + r.assistants.length + '명</small>';
      b.addEventListener('click', function () {
        if (r.id !== state.activeRoomId) {
          state.activeRoomId = r.id;
          state.updatedAt = Date.now();
          save();
          ui.search = '';
          $('#searchInput').value = '';
        closeDrawer();
          renderAll();
          setDashboard(false);
          scrollToBottom();
          toast('#' + r.name + ' 회의실로 이동했습니다.');
        } else {
          closeDrawer();
        }
      });
      roomsEl.appendChild(b);
    });

    var listEl = $('#drawerAssistants');
    listEl.innerHTML = '';
    var assist = currentRoom().assistants;
    $('#drawerMemberCount').textContent = assist.length;
    if (!assist.length) {
      listEl.innerHTML = '<p class="set-hint">아직 비서가 없습니다.</p>';
    }
    assist.forEach(function (a) {
      var st = statusOf(a);
      var row = document.createElement('div');
      row.className = 'da-row';
      row.innerHTML = '<span class="dot" data-state="' + st + '"></span>' +
        '<span class="da-name">' + esc(a.name) + '</span>' +
        '<span class="da-pct">' + (a.remaining == null ? '—' : fmtPct(a.remaining) + '%') + '</span>';
      listEl.appendChild(row);
    });
  }

  function renderMembers() {
    var listEl = $('#memberList');
    listEl.innerHTML = '';
    $('#memberModalCount').textContent = currentRoom().assistants.length + 1;

    var me = document.createElement('div');
    me.className = 'member-row';
    me.innerHTML = '<div class="avatar" style="background:#111827;width:32px;height:32px;border-radius:10px;font-size:12px">나</div>' +
      '<span class="m-name">나</span><span class="m-sub">회의실 관리자</span>';
    listEl.appendChild(me);

    currentRoom().assistants.forEach(function (a) {
      var st = statusOf(a);
      var row = document.createElement('div');
      row.className = 'member-row';
      row.innerHTML = '<div class="avatar" style="background:' + esc(a.color) + ';width:32px;height:32px;border-radius:10px;font-size:12px">' +
        esc(a.name.trim().charAt(0)) + '</div>' +
        '<span class="m-name">' + esc(a.name) + '</span>' +
        '<span class="m-sub">' + STATUS_LABEL[st] + (a.remaining == null ? '' : ' · ' + fmtPct(a.remaining) + '%') + '</span>' +
        '<button data-edit="' + esc(a.id) + '">입력</button>';
      listEl.appendChild(row);
    });
  }

  function renderManageList() {
    var listEl = $('#manageList');
    var assist = currentRoom().assistants;
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
        '<span class="m-name">' + esc(a.name) + '</span>' +
        '<span class="m-sub">' + (a.period === 'daily' ? '일일' : '주간') + ' · ' +
        (a.remaining == null ? '미확인' : fmtPct(a.remaining) + '%') + '</span>' +
        '<button data-edit="' + esc(a.id) + '">수정</button>';
      listEl.appendChild(row);
    });
  }

  function renderAll() {
    renderTop();
    renderSummary();
    renderMentionChips();
    renderDrawer();
    if (ui.dashboardOpen) renderDashboard(); else renderChat();
  }

  /* ── message actions ─────────────────────────────────────── */
  function scrollChatIfNearBottom() {
    var chatEl = $('#chatView');
    var near = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 160;
    if (near) requestAnimationFrame(scrollToBottom);
  }

  function extractMentions(text) {
    var found = [];
    var matcher = mentionMatcher();
    if (!matcher) return found;
    matcher.lastIndex = 0;
    var m;
    while ((m = matcher.exec(text)) !== null) {
      if (found.indexOf(m[1]) === -1) found.push(m[1]);
    }
    return found;
  }

  function replyTextFor(a, text) {
    var t = text || '';
    if (/회의|안건|회의록/.test(t)) return '네, 회의 내용 정리해서 결정 사항과 할 일로 나눠 올리겠습니다.';
    if (/할\s*일|todo|to-do/i.test(t)) return '할 일 뽑아서 담당자와 마감일 붙여 정리하겠습니다.';
    if (/초안|작성|써/.test(t)) return '초안 먼저 잡아서 공유드리겠습니다. 수정할 부분 알려주세요.';
    if (/사용량|잔여|리셋|한도/.test(t)) {
      if (a.remaining == null) return '사용량은 아직 보고 전입니다. 확인해서 곧 올리겠습니다.';
      return '현재 ' + fmtPct(a.remaining) + '% 남았습니다' + (a.resetAt ? ', ' + relUntil(a.resetAt) + '입니다.' : '입니다.');
    }
    var pool = [
      '확인했습니다. 바로 처리하겠습니다.',
      '네, 정리해서 공유드리겠습니다.',
      '알겠습니다. 진행 상황은 이 스레드에 남길게요.',
      '확인 후 결과 보고드리겠습니다.'
    ];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function scheduleReplies(mentionNames, text) {
    if (!state.settings.autoReply) return;
    var room = currentRoom();
    var targets = [];
    if (mentionNames.indexOf('전체') !== -1) {
      targets = room.assistants.filter(function (a) { return a.online; }).slice(0, 2);
    } else {
      mentionNames.forEach(function (name) {
        var a = room.assistants.find(function (x) { return x.name === name; });
        if (a) targets.push(a);
      });
    }
    targets.slice(0, 3).forEach(function (a, i) {
      var roomId = room.id;
      var timer = setTimeout(function () {
        var target = state.rooms.find(function (r) { return r.id === roomId; });
        if (!target || !state.settings.autoReply) return;
        var still = target.assistants.find(function (x) { return x.id === a.id; });
        if (!still) return;
        target.messages.push({
          id: uid('m'),
          type: 'assistant',
          authorId: still.id,
          text: replyTextFor(still, text),
          at: Date.now()
        });
        state.updatedAt = Date.now();
        save();
        if (state.activeRoomId === roomId) {
          renderTop();
          if (!ui.dashboardOpen) { renderChat(); scrollChatIfNearBottom(); }
        }
      }, 900 + i * 850 + Math.random() * 500);
      ui.pendingReplies.push(timer);
    });
  }

  function sendMessage() {
    var input = $('#composerInput');
    var text = input.value.trim();
    if (!text) {
      toast('보낼 내용을 입력하세요.');
      input.focus();
      return;
    }
    var room = currentRoom();
    room.messages.push({ id: uid('m'), type: 'user', authorId: 'me', text: text, at: Date.now() });
    input.value = '';
    autoGrow();
    hideMentionPop();
    touch();
    if (ui.dashboardOpen) setDashboard(false);
    renderTop();
    renderChat({ bottom: true });
    scrollToBottom();
    var mentions = extractMentions(text);
    if (mentions.length) scheduleReplies(mentions, text);
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
    $('#assistantModalTitle').textContent = a ? '잔여 입력' : '비서 추가';
    $('#assistantModalSub').textContent = a
      ? a.name + '의 남은 사용량과 리셋 시각을 업데이트합니다.'
      : '이름과 남은 사용량을 입력하면 카드가 바로 만들어집니다.';
    $('#fName').value = a ? a.name : '';
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

  function submitAssistant(e) {
    e.preventDefault();
    var name = $('#fName').value.trim();
    if (!name) { toast('비서 이름을 입력하세요.'); return; }
    var remainingRaw = $('#fRemaining').value.trim();
    var remaining = remainingRaw === '' ? null : clamp(Number(remainingRaw), 0, 100);
    if (remainingRaw !== '' && isNaN(remaining)) { toast('남은 사용량을 숫자로 입력하세요.'); return; }
    var resetRaw = $('#fReset').value;
    var resetAt = resetRaw ? new Date(resetRaw).getTime() : null;
    var room = currentRoom();
    var editing = ui.editingId ? assistantById(ui.editingId) : null;

    if (editing) {
      editing.name = name;
      editing.period = $('#fPeriod').value;
      editing.mode = $('#fMode').value;
      editing.remaining = remaining;
      editing.extra = $('#fExtra').value.trim();
      editing.resetAt = resetAt;
      editing.note = $('#fNote').value.trim();
      if (remaining != null) editing.lastReportAt = Date.now();
      room.messages.push({ id: uid('m'), type: 'system', text: name + '의 사용량이 ' + (remaining == null ? '미확인으로' : fmtPct(remaining) + '% 남음으로') + ' 갱신되었습니다.', at: Date.now() });
      toast('[' + name + '] 사용량을 저장했습니다.');
    } else {
      var a = makeAssistant({
        name: name,
        period: $('#fPeriod').value,
        mode: $('#fMode').value,
        remaining: remaining,
        resetAt: resetAt,
        lastReportAt: remaining != null ? Date.now() : null,
        extra: $('#fExtra').value.trim(),
        note: $('#fNote').value.trim(),
        online: true
      }, room.assistants.length);
      room.assistants.push(a);
      room.messages.push({ id: uid('m'), type: 'system', text: a.name + ' 비서가 회의실에 참여했습니다.', at: Date.now() });
      toast('[' + a.name + '] 비서를 추가했습니다.');
    }
    touch();
    closeModal('assistantModal');
    renderAll();
    if (!ui.dashboardOpen) { renderChat(); scrollToBottom(); }
  }

  function deleteAssistant() {
    var a = ui.editingId ? assistantById(ui.editingId) : null;
    if (!a) return;
    if (!confirm('[' + a.name + '] 비서를 이 회의실에서 삭제할까요?\n대화 기록 중 이 비서의 메시지도 함께 정리됩니다.')) return;
    var room = currentRoom();
    room.assistants = room.assistants.filter(function (x) { return x.id !== a.id; });
    room.messages = room.messages.filter(function (m) { return !(m.type === 'assistant' && m.authorId === a.id); });
    room.messages.push({ id: uid('m'), type: 'system', text: a.name + ' 비서가 회의실에서 나갔습니다.', at: Date.now() });
    touch();
    closeModal('assistantModal');
    renderAll();
    toast('[' + a.name + '] 비서를 삭제했습니다.');
  }

  /* invite */
  function inviteSnippet() {
    var room = currentRoom();
    var c = counts();
    var lines = [
      '안녕하세요! 비서 회의실에 초대합니다.',
      '',
      '회의실: # ' + room.name,
      '참여 비서: ' + c.total + '명 (정상 ' + c.ok + ' · 임박 ' + c.soon + ' · 위험 ' + c.risk + ' · 미확인 ' + c.unknown + ')',
      '',
      '아래 형식으로 사용량을 보고해 주세요.',
      '• 이름: (비서 이름)',
      '• 주기: 일일 / 주간',
      '• 남은 사용량: 00.0%',
      '• 리셋 시각: 00월 00일 00:00',
      '• 메모: (선택)',
      '',
      '보고가 ' + state.settings.staleHours + '시간 넘으면 "갱신 필요"로 표시됩니다.'
    ];
    return lines.join('\n');
  }

  function openInvite() {
    $('#invitePreview').textContent = inviteSnippet();
    $('#qName').value = '';
    $('#qPeriod').value = 'daily';
    openModal('inviteModal');
  }

  async function copyInvite() {
    var ok = await copyText(inviteSnippet());
    toast(ok ? '초대 문구를 복사했습니다.' : '복사하지 못했습니다. 문구를 길게 눌러 복사하세요.');
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* fall through */ }
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  function quickAddAssistant(e) {
    e.preventDefault();
    var name = $('#qName').value.trim();
    if (!name) { toast('비서 이름을 입력하세요.'); return; }
    var room = currentRoom();
    var a = makeAssistant({ name: name, period: $('#qPeriod').value, online: true }, room.assistants.length);
    room.assistants.push(a);
    room.messages.push({ id: uid('m'), type: 'system', text: a.name + ' 비서가 회의실에 초대되었습니다.', at: Date.now() });
    $('#qName').value = '';
    touch();
    closeModal('inviteModal');
    renderAll();
    if (!ui.dashboardOpen) { renderChat(); scrollToBottom(); }
    toast('[' + a.name + '] 비서를 초대했습니다.');
  }

  /* settings */
  function openSettings() {
    var room = currentRoom();
    $('#setRoomName').value = room.name;
    $('#setRisk').value = state.settings.risk;
    $('#setSoon').value = state.settings.soon;
    $('#setStale').value = state.settings.staleHours;
    $('#setAutoReply').checked = !!state.settings.autoReply;
    $('#setStartDash').checked = !!state.settings.startDash;
    $('#setEnterSend').checked = !!state.settings.enterSend;
    updateThresholdHints();
    $('#lastSaved').textContent = state.savedAt ? relTime(state.savedAt) : '—';
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
    touch();
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
      onSave: function (name) {
        var r = {
          id: uid('room'),
          name: name,
          createdAt: Date.now(),
          assistants: [],
          messages: [{
            id: uid('m'),
            type: 'system',
            text: '# ' + name + ' 회의실이 열렸습니다. 비서를 초대해 보세요.',
            at: Date.now()
          }]
        };
        state.rooms.push(r);
        state.activeRoomId = r.id;
        state.updatedAt = Date.now();
        save();
        renderAll();
        setDashboard(false);
        toast('새 회의실을 만들었습니다.');
      }
    });
  }

  function deleteRoom() {
    if (state.rooms.length <= 1) {
      toast('회의실이 하나뿐이라 삭제할 수 없습니다.');
      return;
    }
    var room = currentRoom();
    if (!confirm('"#' + room.name + '" 회의실을 삭제할까요?\n이 회의실의 대화와 비서 목록이 함께 삭제됩니다.')) return;
    state.rooms = state.rooms.filter(function (r) { return r.id !== room.id; });
    state.activeRoomId = state.rooms[0].id;
    ui.pendingReplies.forEach(clearTimeout);
    ui.pendingReplies = [];
    touch();
    closeAllModals();
    renderAll();
    setDashboard(false);
    scrollToBottom();
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
    var payload = JSON.stringify(state, null, 2);
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

  function importData(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var parsed = normalizeState(JSON.parse(String(reader.result)));
        if (!parsed) throw new Error('bad shape');
        if (!confirm('가져온 데이터로 현재 회의실을 교체할까요?\n기존 데이터는 덮어쓰여집니다.')) return;
        state = parsed;
        ui.dashboardOpen = false;
        touch();
        closeAllModals();
        renderAll();
        setDashboard(false);
        scrollToBottom();
        toast('데이터를 가져왔습니다.');
      } catch (e) {
        toast('가져올 수 없는 파일입니다. 내보낸 JSON을 사용하세요.');
      }
    };
    reader.readAsText(file);
  }

  function resetDemo() {
    if (!confirm('모든 회의실과 메시지를 지우고 데모 데이터로 되돌릴까요?')) return;
    ui.pendingReplies.forEach(clearTimeout);
    ui.pendingReplies = [];
    state = demoState();
    ui.dashboardOpen = false;
    ui.search = '';
    $('#searchInput').value = '';
    save();
    closeAllModals();
    renderAll();
    setDashboard(false);
    scrollToBottom();
    toast('데모 데이터로 초기화했습니다.');
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
      state.updatedAt = Date.now();
      save();
      renderSummary();
      renderDashboard();
      toast('사용량을 갱신했습니다.');
    });

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
    $('#copyInvite').addEventListener('click', copyInvite);
    $('#quickAddForm').addEventListener('submit', quickAddAssistant);

    $('#assistantForm').addEventListener('submit', submitAssistant);
    $('#fDelete').addEventListener('click', deleteAssistant);

    $('#setRoomName').addEventListener('input', function () { this.dataset.dirty = '1'; });
    $('#renameRoom').addEventListener('click', function () {
      var v = $('#setRoomName').value.trim();
      if (!v) { toast('회의실 이름을 입력하세요.'); return; }
      currentRoom().name = v;
      touch();
      renderTop();
      renderDrawer();
      toast('회의실 이름을 변경했습니다.');
    });
    ['#setRisk', '#setSoon', '#setStale'].forEach(function (sel) {
      $(sel).addEventListener('change', applyThresholds);
    });
    $('#setAutoReply').addEventListener('change', function () {
      state.settings.autoReply = this.checked; touch(); toast(this.checked ? '자동 응답을 켰습니다.' : '자동 응답을 껐습니다.');
    });
    $('#setStartDash').addEventListener('change', function () {
      state.settings.startDash = this.checked; touch();
    });
    $('#setEnterSend').addEventListener('change', function () {
      state.settings.enterSend = this.checked; touch();
    });
    $('#manageAdd').addEventListener('click', function () { closeModal('settingsModal'); openAssistantModal(null); });
    $('#settingsNewRoom').addEventListener('click', function () { closeModal('settingsModal'); promptCreateRoom(); });
    $('#settingsDeleteRoom').addEventListener('click', deleteRoom);
    $('#exportBtn2').addEventListener('click', exportData);
    $('#importBtn2').addEventListener('click', function () { $('#importFile').click(); });
    $('#resetBtn2').addEventListener('click', resetDemo);

    $('#exportBtn').addEventListener('click', function () { closeModal('moreModal'); exportData(); });
    $('#importBtn').addEventListener('click', function () { closeModal('moreModal'); $('#importFile').click(); });
    $('#resetBtn').addEventListener('click', function () { closeModal('moreModal'); resetDemo(); });
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
      toast('비서 통합 회의실 v' + APP_VERSION + ' · 데이터는 이 기기에만 저장됩니다.');
    });

    $('#newRoomBtn').addEventListener('click', function () { closeDrawer(); promptCreateRoom(); });
    $('#promptSave').addEventListener('click', savePrompt);
    $('#promptInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); savePrompt(); }
    });

    $('#importFile').addEventListener('change', function () {
      var f = this.files && this.files[0];
      this.value = '';
      if (f) importData(f);
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
        renderSummary();
        if (ui.dashboardOpen) renderDashboard();
      }
    });

    window.addEventListener('beforeunload', function () {
      try { state.savedAt = Date.now(); localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* noop */ }
    });
  }

  /* ── boot ────────────────────────────────────────────────── */
  function boot() {
    try {
      if (new URLSearchParams(location.search).get('view') === 'dashboard') ui.dashboardOpen = true;
    } catch (e) { /* older browser */ }
    bind();
    renderAll();
    setDashboard(ui.dashboardOpen);
    if (!ui.dashboardOpen) scrollToBottom();

    setInterval(function () {
      renderSummary();
      if (ui.dashboardOpen) renderDashboard();
    }, 30000);

  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
