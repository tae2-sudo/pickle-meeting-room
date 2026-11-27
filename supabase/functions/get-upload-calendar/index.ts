// ──────────────────────────────────────────────────────────────
//  Supabase Edge Function · get-upload-calendar
//  # 📅 업로드-캘린더 채널방이 호출하는 함수.
//
//  · 노션 페이지 '📅 06 - 업로드 캘린더' (42384f0c-…) 의 블록·표를 읽어
//    날짜별 업로드 일정(채널·편·시각·제목·상태·유튜브 URL·비고)을 구조화된 JSON 으로 돌려준다.
//  · 노션 API 키는 이 함수의 Edge Function Secrets(NOTION_API_KEY) 에만 있고,
//    코드·응답·DB·저장소 어디에도 쓰지 않는다. 브라우저는 키를 갖지 않는다(피클 토큰도 쓰지 않음).
//  · 보안: 허용한 Origin(https://tae2-sudo.github.io · 로컬 개발)에만 CORS 를 열고,
//    Secrets 에 APP_ACCESS_KEY 가 있으면 x-app-key 헤더가 맞아야 응답한다(아래 '보안' 절).
//  · 노션 호출 보호: 45초 안의 재요청은 노션을 다시 부르지 않고 직전 결과를 돌려준다.
//    (?refresh=1 로 들어와도 5초 안이면 캐시 — 버튼 연타·여러 탭 보호)
// ──────────────────────────────────────────────────────────────
// deno-lint-ignore-file no-explicit-any

type Dict = Record<string, any>;

// ────────────────────────────── 보안: CORS · 앱 접근 키 ──────────────────────────────
// 이 함수는 Secrets 의 노션 키로 회의실 캘린더를 대신 읽는다.
// 아무 사이트나 브라우저에서 부를 수 없도록 (1) 허용한 Origin 에만 CORS 를 열고
// (2) Secrets 에 APP_ACCESS_KEY 가 있을 때는 x-app-key 헤더가 맞아야 응답한다.
// · APP_ACCESS_KEY 미설정 → 키 검증 생략(기존 동작 그대로 · 배포 중 장애 방지)
// · APP_ALLOWED_ORIGINS(선택) → 쉼표로 구분해 허용 Origin 을 더 넣을 수 있다
//   (예: 'https://example.com,https://foo.github.io')
const ALLOWED_ORIGINS = ["https://tae2-sudo.github.io"];
const LOCAL_ORIGIN_RE = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/;
const APP_ACCESS_KEY = (Deno.env.get("APP_ACCESS_KEY") || "").trim();

function isAllowedOrigin(origin: string): boolean {
  if (!origin) return false;
  if (LOCAL_ORIGIN_RE.test(origin)) return true;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  return (Deno.env.get("APP_ALLOWED_ORIGINS") || "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean)
    .includes(origin);
}

function corsHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-app-key",
    "Access-Control-Max-Age": "86400",
    // Origin·앱 키에 따라 응답이 달라지므로 중간 캐시가 섞이지 않게 한다
    Vary: "Origin, x-app-key",
  };
  const origin = req.headers.get("origin") || "";
  if (isAllowedOrigin(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function appKeyMatches(got: string): boolean {
  if (!APP_ACCESS_KEY) return true; // 미설정 = 기존 동작 유지
  if (got.length !== APP_ACCESS_KEY.length) return false;
  let diff = 0; // 길이를 먼저 맞춘 뒤 시간 차이를 줄이는 비교
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ APP_ACCESS_KEY.charCodeAt(i);
  return diff === 0;
}

// 허용하지 않은 Origin 이면 403 (본문 없음 · CORS 헤더도 주지 않는다)
function originRejected(req: Request): Response | null {
  const origin = req.headers.get("origin") || "";
  if (!origin || isAllowedOrigin(origin)) return null;
  return new Response(null, { status: 403, headers: corsHeaders(req) });
}

// Origin 검사 → 앱 키 검사. 통과하면 null.
function rejectUnauthorized(req: Request): Response | null {
  const blocked = originRejected(req);
  if (blocked) return blocked;
  if (!appKeyMatches((req.headers.get("x-app-key") || "").trim())) {
    return new Response(
      JSON.stringify({ ok: false, error: "unauthorized", message: "x-app-key 헤더가 필요합니다." }),
      { status: 401, headers: { ...corsHeaders(req), "Content-Type": "application/json; charset=utf-8" } },
    );
  }
  return null;
}

const NOTION_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const PAGE_ID = "42384f0c-8f19-8137-abf1-ea561e37ebcf";
const PAGE_URL = `https://app.notion.com/p/06-${PAGE_ID.replace(/-/g, "")}`;
const KST_MS = 9 * 3600 * 1000;
const CACHE_TTL_MS = 45_000;
const FORCE_MIN_MS = 5_000;
const HTTP_TIMEOUT = 20_000;

const CHANNEL_META: Dict = {
  kr: { key: "kr", label: "별별해외이슈", flag: "🇰🇷", short: "KR" },
  jp: { key: "jp", label: "ショッと見て", flag: "🇯🇵", short: "JP" },
  etc: { key: "etc", label: "기타", flag: "🗓", short: "ETC" },
};

const STATUS_META: Dict = {
  done: { key: "done", label: "공개 완료", icon: "✅" },
  scheduled: { key: "scheduled", label: "예약됨", icon: "⏳" },
  warn: { key: "warn", label: "보완 필요", icon: "⚠️" },
  missing: { key: "missing", label: "미제작", icon: "⛔" },
  unknown: { key: "unknown", label: "확인 필요", icon: "•" },
};

let cache: { at: number; payload: Dict } | null = null;

// ────────────────────────────── Notion fetch ──────────────────────────────
class NotionError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 502, code = "notion_error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function notionGet(path: string, key: string): Promise<Dict> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT);
    try {
      const res = await fetch(`${NOTION_BASE}${path}`, {
        headers: {
          Authorization: `Bearer ${key}`,
          "Notion-Version": NOTION_VERSION,
          Accept: "application/json",
        },
        signal: ctrl.signal,
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new NotionError(`Notion ${res.status}`, res.status === 429 ? 429 : 502, "notion_rate_limited");
        await res.body?.cancel().catch(() => {});
        await sleep(400 * (attempt + 1) + 250 * Math.random());
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        let detail = body.slice(0, 300);
        try {
          const j = JSON.parse(body);
          detail = j.message || detail;
        } catch { /* plain text */ }
        throw new NotionError(`Notion ${res.status}: ${detail}`, 502, "notion_error");
      }
      return await res.json();
    } catch (err) {
      if (err instanceof NotionError && err.code !== "notion_rate_limited") throw err;
      lastErr = err;
      await sleep(400 * (attempt + 1) + 250 * Math.random());
    } finally {
      clearTimeout(timer);
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new NotionError(`Notion 요청 실패: ${msg}`, 504, "notion_unreachable");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function listChildren(blockId: string, key: string): Promise<Dict[]> {
  const out: Dict[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 20; guard++) {
    const q = new URLSearchParams({ page_size: "100" });
    if (cursor) q.set("start_cursor", cursor);
    const data = await notionGet(`/blocks/${blockId}/children?${q.toString()}`, key);
    const results = Array.isArray(data.results) ? data.results : [];
    out.push(...results);
    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
  }
  return out;
}

// ────────────────────────────── text helpers ──────────────────────────────
function richTextsOf(rich: any[]): { text: string; href: string | null } {
  const parts: string[] = [];
  let href: string | null = null;
  for (const r of Array.isArray(rich) ? rich : []) {
    const t = r?.plain_text ?? "";
    parts.push(t);
    const h = r?.href || null;
    if (h && !href) href = h;
  }
  return { text: parts.join(""), href };
}

function cellInfo(cell: any[]): { text: string; href: string | null } {
  const { text, href } = richTextsOf(cell);
  if (href) return { text, href };
  const m = text.match(/https?:\/\/\S+/);
  return { text, href: m ? m[0] : null };
}

function blockText(block: Dict): string {
  const t = block?.type;
  const payload = t ? block[t] : null;
  if (!payload) return "";
  return richTextsOf(payload.rich_text || payload.title || []).text.trim();
}

function squash(s: string): string {
  return String(s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

// ────────────────────────────── date / time ──────────────────────────────
function kstParts(ms: number) {
  const d = new Date(ms + KST_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

const pad2 = (n: number) => (n < 10 ? "0" : "") + n;

function isoDate(y: number, m: number, d: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** '11-25 (수)' / '2026-11-24 (화)' / '11/25' / '2026.11.24' → {date, hasYear} */
function parseDate(text: string): { date: string; hasYear: boolean } | null {
  const s = squash(text);
  const full = s.match(/(20\d{2})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})/);
  if (full) return { date: isoDate(+full[1], +full[2], +full[3]), hasYear: true };
  const md = s.match(/(\d{1,2})\s*[-./월]\s*(\d{1,2})/);
  if (md && +md[1] >= 1 && +md[1] <= 12 && +md[2] >= 1 && +md[2] <= 31) {
    return { date: isoDate(0, +md[1], +md[2]), hasYear: false };
  }
  return null;
}

/** 연도가 없는 날짜는 KST 기준 올해로 채우고, 90일 넘게 미래면 작년으로 본다. */
function withYear(parsed: { date: string; hasYear: boolean }, nowMs: number): string {
  if (parsed.hasYear) return parsed.date;
  const seg = parsed.date.split("-").map(Number);
  const mm = seg[seg.length - 2];
  const dd = seg[seg.length - 1];
  if (!mm || !dd) return parsed.date;
  const now = kstParts(nowMs);
  const todayUtc = Date.UTC(now.year, now.month - 1, now.day);
  let year = now.year;
  if (Date.UTC(year, mm - 1, dd) - todayUtc > 90 * 86400000) year -= 1;
  return isoDate(year, mm, dd);
}

function parseTime(text: string): { text: string; minutes: number | null } {
  const s = squash(text);
  const m = s.match(/(\d{1,2})\s*:\s*(\d{2})/);
  if (m && +m[1] < 24 && +m[2] < 60) {
    return { text: `${pad2(+m[1])}:${m[2]}`, minutes: +m[1] * 60 + +m[2] };
  }
  return { text: s || "—", minutes: null };
}

// ────────────────────────────── status / channel ──────────────────────────────
function statusOf(text: string): { key: string; raw: string } {
  const s = squash(text);
  if (s.includes("⛔")) return { key: "missing", raw: s };
  if (s.includes("⚠")) return { key: "warn", raw: s };
  if (s.includes("⏳")) return { key: "scheduled", raw: s };
  if (s.includes("✅")) return { key: "done", raw: s };
  if (/미제작|비어\s*있|슬롯\s*없/.test(s)) return { key: "missing", raw: s };
  if (/보완|확인\s*필요|미완/.test(s)) return { key: "warn", raw: s };
  if (/예약/.test(s)) return { key: "scheduled", raw: s };
  if (/공개\s*완료|즉시\s*공개|^공개$|전체\s*공개/.test(s)) return { key: "done", raw: s };
  return { key: "unknown", raw: s };
}

const STATUS_PREFIX = /^(공개\s*완료|즉시\s*공개|전체\s*공개\s*전환|비공개\s*→\s*전체\s*공개|예약\s*됨|예약\s*예정|예약|미제작|보완\s*필요|공개)/;

function noteOf(text: string): string {
  let s = squash(text);
  s = s.replace(/[\u2705\u23f3\u26a0\ufe0f\u26d4\u2714\ufe0f\u2757]/g, "").trim();
  s = s.replace(STATUS_PREFIX, "").trim();
  s = s.replace(/^[·\-–—:,，、|\s]+/, "").trim();
  if (s.startsWith("(") && !s.includes(")")) s = s.slice(1).trim();
  if (s.endsWith(")") && !s.includes("(")) s = s.slice(0, -1).trim();
  return s;
}

function channelOf(text: string): { key: string; episode: string; rest: string } {
  const s = squash(text);
  const segs = s.split(/[·•|]/).map((x) => x.trim()).filter(Boolean);
  const first = segs[0] || s;
  let key = "etc";
  if (/별별\s*해외\s*이슈|별별해외이슈/.test(first) || /별별/.test(s) && !/ショッと/.test(first)) key = "kr";
  if (/ショッと|ショット見て/.test(first)) key = "jp";
  if (key === "etc" && /별별해외이슈/.test(s)) key = "kr";
  if (/JP\s*\d+/i.test(s) && key === "etc") key = "jp";
  let episode = segs.length > 1 ? segs.slice(1).join(" · ") : "";
  if (!episode) {
    const m = s.match(/(쇼츠\s*\d+|JP\s*\d+)/i);
    episode = m ? m[1] : "";
  }
  // '쇼츠 12 팁 0원 …' 처럼 편 번호 뒤에 제목이 붙은 경우 편 코드와 나머지를 나눈다
  const code = episode.match(/(쇼츠\s*\d+|JP\s*\d+)/i);
  const episodeCode = code ? code[1].replace(/\s+/g, " ") : episode;
  let rest = code ? episode.slice(code.index! + code[1].length) : episode;
  rest = rest.replace(/^[\s·\-–—:,，、()|]+/, "").trim();
  return { key, episode: episodeCode, rest };
}

// ────────────────────────────── header mapping ──────────────────────────────
type ColMap = { date: number; time: number; channel: number; title: number; status: number; note: number };

const EMPTY_COLS: ColMap = { date: -1, time: -1, channel: -1, title: -1, status: -1, note: -1 };

function mapHeader(cells: string[]): ColMap {
  const cols: ColMap = { ...EMPTY_COLS };
  cells.forEach((raw, i) => {
    const h = squash(raw).replace(/\s+/g, "");
    if (cols.date < 0 && /날짜/.test(h)) cols.date = i;
    else if (cols.time < 0 && /시각|시간/.test(h)) cols.time = i;
    else if (cols.channel < 0 && /채널/.test(h)) cols.channel = i;
    else if (cols.title < 0 && /제목|내용/.test(h)) cols.title = i;
    else if (cols.status < 0 && /상태|결과/.test(h)) cols.status = i;
    else if (cols.note < 0 && /비고|메모/.test(h)) cols.note = i;
  });
  // 순서로 보정: 표준 5열(날짜·시각·채널·제목·상태) / 완료 이력 4열(시각·채널·결과·비고)
  if (cells.length === 5 && cols.date < 0 && cols.time === 0) cols.date = -1;
  return cols;
}

function fallbackCols(cells: string[]): ColMap {
  if (cells.length >= 5) return { date: 0, time: 1, channel: 2, title: 3, status: 4, note: -1 };
  if (cells.length === 4) return { date: -1, time: 0, channel: 1, title: -1, status: 2, note: 3 };
  return { date: -1, time: 0, channel: 1, title: -1, status: 2, note: -1 };
}

// ────────────────────────────── main parse ──────────────────────────────
type Item = Dict;

let DEBUG = false;

async function buildPayload(key: string, opts: { force: boolean }): Promise<Dict> {
  const nowMs = Date.now();

  const page = await notionGet(`/pages/${PAGE_ID}`, key).catch(() => null);
  const pageTitle = page
    ? richTextsOf(page?.properties?.title?.title || Object.values(page?.properties || {}).flatMap((p: any) => p?.title || [])).text
    : "";

  const top = await listChildren(PAGE_ID, key);

  const items: Item[] = [];
  const debug: Dict[] = [];
  const sections: Dict[] = [];
  const notes: Dict[] = [];
  const warnings: string[] = [];

  let section = "";
  let historyDate: string | null = null;
  let sectionCtx: Dict | null = null;

  for (const block of top) {
    const type = block?.type || "";
    const text = blockText(block);

    if (type === "heading_1" || type === "heading_2") {
      section = text;
      historyDate = null;
      sectionCtx = { heading: text, tables: 0, rows: 0 };
      sections.push(sectionCtx);
      continue;
    }
    if (type === "heading_3") {
      const d = parseDate(text);
      historyDate = d ? withYear(d, nowMs) : null;
      continue;
    }
    if (type === "bulleted_list_item" || type === "numbered_list_item" || type === "paragraph") {
      if (/개인\s*일정/.test(section) && text) {
        const d = parseDate(text);
        if (d) {
          const segs = text.split(/[·|]/).map((x) => x.trim());
          const time = parseTime(segs[1] || "");
          items.push(baseItem({
            date: withYear(d, nowMs),
            timeText: time.text,
            minutes: time.minutes,
            channelKey: "etc",
            episode: "",
            title: segs[2] || text,
            url: null,
            statusKey: "unknown",
            statusRaw: "",
            note: squash(text),
            section,
            sectionKey: "personal",
            fromHeading: false,
          }, items.length));
          if (sectionCtx) sectionCtx.rows++;
        }
      } else if (text) {
        notes.push({ section, text });
      }
      continue;
    }

    if (type !== "table") continue;

    const rows = await listChildren(block.id, key);
    const hasHeader = !!block?.table?.has_column_header;
    const cellRows = rows
      .filter((r) => r?.type === "table_row")
      .map((r) => (r.table_row?.cells || []).map((c: any[]) => cellInfo(c)));
    if (!cellRows.length) continue;

    let cols = hasHeader ? mapHeader(cellRows[0].map((c: any) => c.text)) : EMPTY_COLS;
    const missingCore = cols.time < 0 || cols.channel < 0;
    if (!hasHeader || missingCore) {
      if (hasHeader && missingCore) warnings.push(`표 머리글을 알아보지 못해 열 순서로 읽었습니다: ${section}`);
      cols = fallbackCols(cellRows[0].map((c: any) => c.text));
    }
    const bodyRows = hasHeader ? cellRows.slice(1) : cellRows;
    if (DEBUG) {
      debug.push({
        section,
        hasHeader,
        cols,
        rowCount: cellRows.length,
        header: cellRows[0]?.map((c: any) => c.text),
        first: cellRows[1]?.map((c: any) => c.text),
        dateParse: cellRows[1] && cols.date >= 0 ? parseDate(cellRows[1][cols.date].text) : null,
      });
    }

    for (const row of bodyRows) {
      const at = (i: number) => (i >= 0 && i < row.length ? row[i] : { text: "", href: null });
      const dateCell = at(cols.date);
      const timeCell = at(cols.time);
      const chCell = at(cols.channel);
      const titleCell = at(cols.title);
      const statusCell = at(cols.status);
      const noteCell = at(cols.note);

      let date: string | null = null;
      let fromHeading = false;
      if (cols.date >= 0) {
        const d = parseDate(dateCell.text);
        if (d) date = withYear(d, nowMs);
      }
      if (!date && historyDate) {
        date = historyDate;
        fromHeading = true;
      }
      if (!date) {
        const d = parseDate(chCell.text) || parseDate(titleCell.text);
        if (d) date = withYear(d, nowMs);
      }

      const time = parseTime(timeCell.text);
      const ch = channelOf(chCell.text);
      const st = statusOf(statusCell.text || chCell.text || "");
      const titleText = squash(titleCell.text);
      let noteText = noteOf(noteCell.text);
      // '상태 · 비고' 한 칸에 상태와 비고가 같이 있는 경우(5열 표) 상태 칸에서 비고를 뽑는다
      if (cols.note < 0) noteText = noteOf(statusCell.text);

      // 제목 칸이 없거나 비어 있으면 채널 칸에서 편 코드 뒤에 붙은 제목을 쓴다
      let title = titleText || ch.rest || "";

      items.push(baseItem({
        date: date || "",
        timeText: time.text,
        minutes: time.minutes,
        channelKey: ch.key,
        episode: ch.episode,
        title: title || "—",
        url: titleCell.href || statusCell.href || null,
        statusKey: st.key,
        statusRaw: st.raw,
        note: noteText,
        section,
        sectionKey: /완료/.test(section) ? "history" : (/개인/.test(section) ? "personal" : "upcoming"),
        fromHeading,
      }, items.length));
      if (sectionCtx) sectionCtx.rows++;
    }
    if (sectionCtx) sectionCtx.tables++;
  }

  // 날짜가 없으면 채널 칸의 URL 만 남아도 버린다 — 달력에 놓을 수 없기 때문
  const usable = items.filter((it) => it.date && /^\d{4}-\d{2}-\d{2}$/.test(it.date));
  const dropped = items.length - usable.length;
  if (dropped > 0) warnings.push(`날짜를 읽지 못해 달력에 놓지 못한 행 ${dropped}건`);

  usable.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const am = a.minutes == null ? 9999 : a.minutes;
    const bm = b.minutes == null ? 9999 : b.minutes;
    if (am !== bm) return am - bm;
    return String(a.channelKey).localeCompare(String(b.channelKey));
  });

  const summary = buildSummary(usable);
  const lastEdited = page?.last_edited_time || null;

  return {
    ok: true,
    fetchedAt: new Date(nowMs).toISOString(),
    cached: false,
    source: {
      pageId: PAGE_ID,
      title: pageTitle || "📅 06 - 업로드 캘린더",
      url: PAGE_URL,
      lastEditedTime: lastEdited,
      blocks: top.length,
    },
    channels: Object.values(CHANNEL_META),
    statuses: Object.values(STATUS_META),
    items: usable,
    summary,
    sections: sections.map((s) => ({ heading: s.heading, tables: s.tables, rows: s.rows })),
    notes: notes.filter((n) => !/쓰는\s*법|갱신\s*규칙|개인\s*일정/.test(n.section)).slice(0, 40),
    warnings,
    ...(DEBUG ? { debug } : {}),
  };
}

function baseItem(x: Dict, idx: number): Item {
  const meta = CHANNEL_META[x.channelKey] || CHANNEL_META.etc;
  const st = STATUS_META[x.statusKey] || STATUS_META.unknown;
  return {
    id: `${x.date || "noday"}-${(x.timeText || "").replace(":", "")}-${x.channelKey}-${(x.episode || "x").replace(/\s+/g, "")}-${idx}`,
    date: x.date || "",
    time: x.timeText || "—",
    minutes: x.minutes == null ? null : x.minutes,
    channel: meta.key,
    channelLabel: meta.label,
    channelFlag: meta.flag,
    episode: x.episode || "",
    title: x.title || "—",
    url: x.url || null,
    status: st.key,
    statusLabel: st.label,
    statusIcon: st.icon,
    statusRaw: x.statusRaw || "",
    note: x.note || "",
    section: x.section || "",
    sectionKey: x.sectionKey || "upcoming",
    dateFromHeading: !!x.fromHeading,
  };
}

function buildSummary(items: Item[]): Dict {
  const blank = () => ({ total: 0, done: 0, scheduled: 0, warn: 0, missing: 0, unknown: 0 });
  const byChannel: Dict = { kr: blank(), jp: blank(), etc: blank() };
  const byDate: Dict = {};
  const byMonth: Dict = {};

  for (const it of items) {
    const ch = byChannel[it.channel] || byChannel.etc;
    ch.total++;
    ch[it.status] = (ch[it.status] || 0) + 1;

    if (!byDate[it.date]) {
      byDate[it.date] = {
        date: it.date,
        total: 0,
        done: 0,
        scheduled: 0,
        warn: 0,
        missing: 0,
        unknown: 0,
        channels: { kr: blank(), jp: blank(), etc: blank() },
      };
    }
    const day = byDate[it.date];
    day.total++;
    day[it.status] = (day[it.status] || 0) + 1;
    const dch = day.channels[it.channel] || day.channels.etc;
    dch.total++;
    dch[it.status] = (dch[it.status] || 0) + 1;

    const month = it.date.slice(0, 7);
    if (!byMonth[month]) byMonth[month] = { month, total: 0, done: 0, scheduled: 0, warn: 0, missing: 0, unknown: 0 };
    byMonth[month].total++;
    byMonth[month][it.status] = (byMonth[month][it.status] || 0) + 1;
  }

  const dates = items.map((i) => i.date).filter(Boolean).sort();
  const totals = blank();
  for (const k of Object.keys(byChannel)) {
    for (const f of Object.keys(byChannel[k])) {
      if (f === "total") totals.total += byChannel[k].total;
      else totals[f] += byChannel[k][f] || 0;
    }
  }

  return {
    total: items.length,
    ...totals,
    byChannel,
    byDate,
    byMonth,
    range: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
  };
}

// ────────────────────────────── handler ──────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    const blocked = originRejected(req);
    if (blocked) return blocked;
    return new Response("ok", { status: 200, headers: corsHeaders(req) });
  }
  const denied = rejectUnauthorized(req);
  if (denied) return denied;

  if (req.method !== "GET" && req.method !== "POST") {
    return json(req, { ok: false, error: "method_not_allowed" }, 405);
  }

  const url = new URL(req.url);
  DEBUG = url.searchParams.get("debug") === "1";
  const force = url.searchParams.get("refresh") === "1" || url.searchParams.get("force") === "1";
  const now = Date.now();

  if (cache) {
    const age = now - cache.at;
    if ((!force && age < CACHE_TTL_MS) || age < FORCE_MIN_MS) {
      return json(req, { ...cache.payload, cached: true, cacheAgeSeconds: Math.round(age / 1000) }, 200, {
        "X-Cache": "HIT",
      });
    }
  }

  const key = Deno.env.get("NOTION_API_KEY");
  if (!key) {
    return json(req, { ok: false, error: "notion_key_missing", message: "NOTION_API_KEY 시크릿이 없습니다." }, 500);
  }

  try {
    const payload = await buildPayload(key, { force });
    cache = { at: Date.now(), payload };
    return json(req, payload, 200, { "Cache-Control": "public, max-age=30", "X-Cache": "MISS" });
  } catch (err) {
    const e = err as NotionError;
    console.error("get-upload-calendar failed:", e?.message || e);
    return json(req, {
      ok: false,
      error: e?.code || "unknown_error",
      message: e?.message || String(err),
      fetchedAt: new Date().toISOString(),
    }, e?.status && e.status >= 400 && e.status < 600 ? e.status : 502);
  }
});

function json(req: Request, body: unknown, status: number, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "application/json; charset=utf-8",
      ...extra,
    },
  });
}
