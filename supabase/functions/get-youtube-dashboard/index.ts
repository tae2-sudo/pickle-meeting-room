// ──────────────────────────────────────────────────────────────
//  Supabase Edge Function · get-youtube-dashboard
//  # 📺 유튜브-대시보드 채널방이 호출하는 함수.
//
//  · 별별해외이슈(kr) · ショッと見て(jp) 두 채널의 YouTube Data API v3 /
//    YouTube Analytics API v2 통계를 한 번에 모아 JSON 으로 돌려준다.
//  · OAuth 클라이언트 ID/Secret 과 두 채널의 리프레시 토큰은 이 함수의
//    Edge Function Secrets (YT_CLIENT_ID / YT_CLIENT_SECRET /
//    YT_REFRESH_TOKEN_KR / YT_REFRESH_TOKEN_JP) 에만 있다.
//    코드·응답·DB·저장소·브라우저 어디에도 쓰지 않는다(피클 토큰도 쓰지 않음).
//  · 60초 캐시: 60초 안의 재요청은 유튜브를 다시 부르지 않고 직전 결과를 돌려준다.
//    ?refresh=1 은 캐시를 건너뛴다(단 5초 안의 연타는 캐시 — 버튼 연타·여러 탭 보호).
//  · Analytics(7일 조회수)가 실패해도 Data API 결과만으로 정상 응답한다.
// ──────────────────────────────────────────────────────────────
// deno-lint-ignore-file no-explicit-any

type Dict = Record<string, any>;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "86400",
};

const DATA_API = "https://www.googleapis.com/youtube/v3";
const ANALYTICS_API = "https://youtubeanalytics.googleapis.com/v2";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

const CACHE_TTL_MS = 60_000;
const FORCE_MIN_MS = 5_000;
const HTTP_TIMEOUT = 20_000;
const VIDEO_LIMIT = 20;          // 최근 영상 몇 건까지 (15~20)
const COMMENT_LIMIT = 25;        // 최근 댓글 스레드 몇 건까지
const REPLY_RECHECK_MAX = 8;     // 답글 전체를 다시 확인할 스레드 상한(Data API 절약)
const HOT_CAP = 2;               // 채널당 🔥 급상승 최대 개수
const KST_MS = 9 * 3600 * 1000;

const CHANNELS: Dict[] = [
  {
    key: "kr",
    label: "별별해외이슈",
    flag: "🇰🇷",
    channelId: "UCA0fpRtikPT2CsjmiRgJwOQ",
    env: "YT_REFRESH_TOKEN_KR",
  },
  {
    key: "jp",
    label: "ショッと見て",
    flag: "🇯🇵",
    channelId: "UCQTPE4JD2ER8pSS034VWO-Q",
    env: "YT_REFRESH_TOKEN_JP",
  },
];

let cache: { at: number; payload: Dict } | null = null;
const tokenCache: Dict = {}; // key → { token, exp }

// ────────────────────────────── 공통 도우미 ──────────────────────────────
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url: string, init: RequestInit = {}, timeout = HTTP_TIMEOUT): Promise<{ status: number; body: Dict }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let body: Dict = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text.slice(0, 400) };
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function googleError(body: Dict): string {
  const e = body?.error;
  if (!e) return "";
  const reason = e?.errors?.[0]?.reason || e?.status || "";
  const message = e?.message || "";
  return `${reason}${reason && message ? ": " : ""}${message}`.slice(0, 300);
}

// ────────────────────────────── OAuth ──────────────────────────────
async function accessToken(refreshToken: string, cacheKey: string): Promise<string> {
  const hit = tokenCache[cacheKey];
  if (hit && hit.exp > Date.now() + 90_000) return hit.token;

  const clientId = Deno.env.get("YT_CLIENT_ID");
  const clientSecret = Deno.env.get("YT_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("YouTube OAuth 클라이언트 시크릿이 없습니다.");
  if (!refreshToken) throw new Error("리프레시 토큰이 없습니다.");

  const form = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const { status, body } = await fetchJson(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (status === 200 && body.access_token) {
      const ttl = Math.max(60, (Number(body.expires_in) || 3600) - 60);
      tokenCache[cacheKey] = { token: body.access_token, exp: Date.now() + ttl * 1000 };
      return body.access_token;
    }
    last = googleError(body) || `HTTP ${status}`;
    if (body?.error === "invalid_grant") throw new Error("invalid_grant: 리프레시 토큰이 만료되었습니다(재승인 필요)");
    await sleep(350 * (attempt + 1));
  }
  throw new Error(`액세스 토큰 발급 실패 — ${last}`);
}

async function apiGet(token: string, url: string, params: Dict): Promise<Dict> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    q.set(k, String(v));
  }
  let lastBody: Dict = {};
  for (let attempt = 0; attempt < 3; attempt++) {
    const { status, body } = await fetchJson(`${url}?${q.toString()}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (status === 200) return body;
    lastBody = body;
    if (status === 429 || status >= 500) {
      await sleep(500 * (attempt + 1) + 200 * Math.random());
      continue;
    }
    break; // 400/403 등은 재시도해도 같다
  }
  throw new Error(googleError(lastBody) || "YouTube API 요청 실패");
}

// ────────────────────────────── 데이터 가공 ──────────────────────────────
const pad2 = (n: number) => (n < 10 ? "0" : "") + n;

function kstToday(): { iso: string; weekAgo: string; prevWeekAgo: string; prevWeekEnd: string } {
  const now = new Date(Date.now() + KST_MS);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const day = 86400000;
  const iso = (ms: number) => {
    const t = new Date(ms);
    return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
  };
  const todayMs = Date.UTC(y, m, d);
  return {
    iso: iso(todayMs),
    weekAgo: iso(todayMs - 6 * day),
    prevWeekAgo: iso(todayMs - 13 * day),
    prevWeekEnd: iso(todayMs - 7 * day),
  };
}

const PRIVACY_LABEL: Dict = {
  public: { key: "public", label: "공개", icon: "🔵" },
  unlisted: { key: "unlisted", label: "미공개", icon: "🟡" },
  private: { key: "private", label: "비공개", icon: "⚪" },
};

function durationSeconds(iso: string): number | null {
  const m = String(iso || "").match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  const [, d, h, mi, s] = m;
  return (+(d || 0)) * 86400 + (+(h || 0)) * 3600 + (+(mi || 0)) * 60 + (+(s || 0));
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const a = nums.slice().sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// ────────────────────────────── 채널 하나 ──────────────────────────────
async function buildChannel(meta: Dict, refreshToken: string, debug: boolean): Promise<Dict> {
  const out: Dict = {
    key: meta.key,
    label: meta.label,
    flag: meta.flag,
    channelId: meta.channelId,
    url: `https://www.youtube.com/channel/${meta.channelId}`,
    avatar: null,
    handle: null,
    stats: { subscribers: null, views: null, videos: null, hiddenSubscribers: false },
    videos: [],
    avgViews: 0,
    hotCount: 0,
    comments: { ok: false, scanned: 0, unanswered: 0, items: [], error: null },
    analytics: { ok: false, days: [], views7d: null, prevViews7d: null, changePct: null, minutesWatched7d: null, error: null },
    error: null,
    timing: debug ? {} : undefined,
  };

  let token: string;
  try {
    token = await accessToken(refreshToken, meta.key);
  } catch (err) {
    out.error = (err as Error).message;
    out.comments.error = out.error;
    out.analytics.error = out.error;
    return out;
  }

  // 1) 채널 기본 정보
  let channel: Dict | null = null;
  try {
    const res = await apiGet(token, `${DATA_API}/channels`, {
      part: "snippet,statistics,contentDetails,status",
      mine: "true",
    });
    channel = (res.items || [])[0] || null;
    if (!channel) throw new Error("채널 정보를 받지 못했습니다.");
    out.handle = channel.snippet?.customUrl || null;
    out.avatar = channel.snippet?.thumbnails?.default?.url || channel.snippet?.thumbnails?.medium?.url || null;
    out.stats = {
      subscribers: channel.statistics?.hiddenSubscriberCount ? null : Number(channel.statistics?.subscriberCount ?? 0),
      views: Number(channel.statistics?.viewCount ?? 0),
      videos: Number(channel.statistics?.videoCount ?? 0),
      hiddenSubscribers: !!channel.statistics?.hiddenSubscriberCount,
    };
  } catch (err) {
    out.error = (err as Error).message;
    out.comments.error = out.error;
    out.analytics.error = out.error;
    return out;
  }

  const uploads = channel?.contentDetails?.relatedPlaylists?.uploads;
  const videoTitles: Dict = {};

  // 2) 최근 업로드 영상 + 통계
  try {
    if (!uploads) throw new Error("업로드 재생목록을 찾지 못했습니다.");
    const pl = await apiGet(token, `${DATA_API}/playlistItems`, {
      part: "snippet,contentDetails,status",
      playlistId: uploads,
      maxResults: VIDEO_LIMIT,
    });
    const ids: string[] = (pl.items || [])
      .map((i: Dict) => i.contentDetails?.videoId)
      .filter(Boolean)
      .slice(0, VIDEO_LIMIT);

    if (ids.length) {
      const vids = await apiGet(token, `${DATA_API}/videos`, {
        part: "snippet,statistics,status,contentDetails",
        id: ids.join(","),
      });
      const byId: Dict = {};
      for (const v of vids.items || []) byId[v.id] = v;

      const rows: Dict[] = ids.map((id) => byId[id]).filter(Boolean).map((v: Dict) => {
        const st = v.statistics || {};
        const status = v.status || {};
        const snippet = v.snippet || {};
        const secs = durationSeconds(v.contentDetails?.duration || "");
        let privacyKey = status.privacyStatus || "public";
        let scheduleAt: string | null = null;
        if (privacyKey === "private" && status.publishAt) {
          privacyKey = "scheduled";
          scheduleAt = status.publishAt;
        }
        const privacy = privacyKey === "scheduled"
          ? { key: "scheduled", label: "예약", icon: "⏳" }
          : (PRIVACY_LABEL[privacyKey] || { key: privacyKey, label: privacyKey, icon: "•" });
        const isShort = (secs !== null && secs > 0 && secs <= 62) || /#shorts?/i.test(snippet.title || "");
        return {
          videoId: v.id,
          title: String(snippet.title || "").replace(/\s*#shorts?\b/gi, "").trim() || snippet.title || "",
          thumbnail: snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`,
          publishedAt: snippet.publishedAt || null,
          scheduleAt,
          privacy: privacy.key,
          privacyLabel: privacy.label,
          privacyIcon: privacy.icon,
          views: Number(st.viewCount ?? 0),
          likes: Number(st.likeCount ?? 0),
          comments: Number(st.commentCount ?? 0),
          durationSeconds: secs,
          isShort,
          url: isShort ? `https://www.youtube.com/shorts/${v.id}` : `https://www.youtube.com/watch?v=${v.id}`,
          hot: false,
          vsAvg: null,
        };
      });

      // 평균 대비 조회수가 높은 영상 → 🔥 급상승 (공개 + 조회수 있는 영상 기준)
      const publics = rows.filter((r) => r.privacy === "public" && r.views > 0).map((r) => r.views);
      const avg = publics.length ? publics.reduce((a, b) => a + b, 0) / publics.length : 0;
      const med = median(publics);
      const threshold = Math.max(avg * 1.5, med * 2);
      rows.forEach((r) => { r.vsAvg = avg > 0 ? Math.round((r.views / avg) * 100) / 100 : null; });
      rows
        .filter((r) => r.privacy === "public" && r.views > 0 && r.views >= threshold)
        .sort((a, b) => (b.vsAvg || 0) - (a.vsAvg || 0))
        .slice(0, HOT_CAP)
        .forEach((r) => { r.hot = true; });

      out.videos = rows;
      out.avgViews = Math.round(avg);
      out.hotCount = rows.filter((r) => r.hot).length;
      rows.forEach((r) => { videoTitles[r.videoId] = r.title; });
    }
  } catch (err) {
    out.videosError = (err as Error).message;
  }

  // 3) 최근 댓글 25건 → 채널 주인 답글이 없는 미응답 댓글
  try {
    const ct = await apiGet(token, `${DATA_API}/commentThreads`, {
      part: "snippet,replies",
      allThreadsRelatedToChannelId: meta.channelId,
      maxResults: COMMENT_LIMIT,
      order: "time",
      textFormat: "plainText",
    });
    const threads: Dict[] = ct.items || [];
    out.comments.scanned = threads.length;

    const unanswered: Dict[] = [];
    let rechecks = 0;
    for (const t of threads) {
      const s = t.snippet || {};
      const tl = s.topLevelComment || {};
      const cs = tl.snippet || {};
      const authorChannel = cs.authorChannelId?.value || "";
      if (authorChannel === meta.channelId) continue; // 채널 주인이 직접 쓴 댓글(고정 댓글 등)

      const embedded: Dict[] = t.replies?.comments || [];
      let ownerReplied = embedded.some((r) => r.snippet?.authorChannelId?.value === meta.channelId);
      const totalReplies = Number(s.totalReplyCount ?? 0);
      if (!ownerReplied && totalReplies > embedded.length && rechecks < REPLY_RECHECK_MAX) {
        rechecks++;
        try {
          const rep = await apiGet(token, `${DATA_API}/comments`, {
            part: "snippet",
            parentId: tl.id,
            maxResults: 100,
            textFormat: "plainText",
          });
          ownerReplied = (rep.items || []).some((r: Dict) => r.snippet?.authorChannelId?.value === meta.channelId);
        } catch { /* 답글 확인 실패는 미응답 후보로 둔다 */ }
      }
      if (ownerReplied) continue;

      unanswered.push({
        threadId: t.id,
        commentId: tl.id,
        videoId: s.videoId,
        videoTitle: videoTitles[s.videoId] || "",
        author: cs.authorDisplayName || "익명",
        authorThumb: cs.authorProfileImageUrl || null,
        authorChannel: authorChannel || null,
        text: String(cs.textDisplay || "").replace(/\s+/g, " ").trim(),
        publishedAt: cs.publishedAt || null,
        likes: Number(cs.likeCount ?? 0),
        replyCount: totalReplies,
        url: `https://www.youtube.com/watch?v=${s.videoId}&lc=${tl.id}`,
      });
    }
    out.comments.items = unanswered;
    out.comments.unanswered = unanswered.length;
    out.comments.ok = true;
    out.comments.rechecked = rechecks;
  } catch (err) {
    const msg = (err as Error).message;
    out.comments.error = /commentsDisabled/i.test(msg) ? "댓글이 꺼져 있는 영상이 있습니다." : msg;
  }

  // 4) 최근 7일 일별 조회수 (Analytics) — 실패해도 Data API 결과는 그대로
  try {
    const range = kstToday();
    const get = async (start: string, end: string, metrics: string) =>
      await apiGet(token, `${ANALYTICS_API}/reports`, {
        ids: "channel==MINE",
        startDate: start,
        endDate: end,
        metrics,
        dimensions: "day",
        sort: "day",
      });

    let rep: Dict;
    try {
      rep = await get(range.weekAgo, range.iso, "views,estimatedMinutesWatched");
    } catch {
      rep = await get(range.weekAgo, range.iso, "views");
    }
    const headers: string[] = (rep.columnHeaders || []).map((h: Dict) => h.name);
    const rows: any[][] = rep.rows || [];
    const iDay = headers.indexOf("day");
    const iViews = headers.indexOf("views");
    const iMin = headers.indexOf("estimatedMinutesWatched");

    const dayMap: Dict = {};
    let views7d = 0;
    let minutes = 0;
    for (const r of rows) {
      const day = iDay >= 0 ? String(r[iDay]) : "";
      const v = iViews >= 0 ? Number(r[iViews] || 0) : 0;
      dayMap[day] = (dayMap[day] || 0) + v;
      views7d += v;
      if (iMin >= 0) minutes += Number(r[iMin] || 0);
    }
    // 7일을 빈 날(0)까지 채운다 — 차트가 끊기지 않게
    const days: Dict[] = [];
    const base = new Date(`${range.iso}T00:00:00Z`).getTime();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(base - i * 86400000);
      const key = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
      days.push({ date: key, views: dayMap[key] || 0 });
    }

    let prevViews: number | null = null;
    try {
      const prev = await get(range.prevWeekAgo, range.prevWeekEnd, "views");
      const ph: string[] = (prev.columnHeaders || []).map((h: Dict) => h.name);
      const pi = ph.indexOf("views");
      prevViews = (prev.rows || []).reduce((a: number, r: any[]) => a + Number(r[pi] || 0), 0);
    } catch { /* 이전 주 비교는 없어도 된다 */ }

    out.analytics = {
      ok: true,
      days,
      views7d,
      prevViews7d: prevViews,
      // 이전 7일 표본이 너무 작으면(채널 초기) %가 의미 없어 생략한다
      changePct: prevViews && prevViews >= 100 ? Math.round(((views7d - prevViews) / prevViews) * 1000) / 10 : null,
      minutesWatched7d: iMin >= 0 ? minutes : null,
      error: null,
    };
  } catch (err) {
    out.analytics = { ...out.analytics, ok: false, error: (err as Error).message };
  }

  return out;
}

// ────────────────────────────── handler ──────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "GET" && req.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }

  const url = new URL(req.url);
  const force = url.searchParams.get("refresh") === "1" || url.searchParams.get("force") === "1";
  const debug = url.searchParams.get("debug") === "1";
  const now = Date.now();

  if (cache && !debug) {
    const age = now - cache.at;
    if ((!force && age < CACHE_TTL_MS) || age < FORCE_MIN_MS) {
      return json({ ...cache.payload, cached: true, cacheAgeSeconds: Math.round(age / 1000) }, 200, {
        "X-Cache": "HIT",
      });
    }
  }

  const clientId = Deno.env.get("YT_CLIENT_ID");
  const clientSecret = Deno.env.get("YT_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    return json({
      ok: false,
      error: "youtube_secrets_missing",
      message: "YT_CLIENT_ID / YT_CLIENT_SECRET 시크릿이 없습니다.",
    }, 500);
  }

  const started = Date.now();
  const results = await Promise.all(
    CHANNELS.map((meta) => {
      const rt = Deno.env.get(meta.env) || "";
      return buildChannel(meta, rt, debug).catch((err) => ({
        key: meta.key,
        label: meta.label,
        flag: meta.flag,
        channelId: meta.channelId,
        url: `https://www.youtube.com/channel/${meta.channelId}`,
        stats: { subscribers: null, views: null, videos: null, hiddenSubscribers: false },
        videos: [],
        avgViews: 0,
        hotCount: 0,
        comments: { ok: false, scanned: 0, unanswered: 0, items: [], error: (err as Error).message },
        analytics: { ok: false, days: [], views7d: null, prevViews7d: null, changePct: null, minutesWatched7d: null, error: (err as Error).message },
        error: (err as Error).message,
      }));
    }),
  );

  const warnings: string[] = [];
  for (const ch of results) {
    if (ch.error) warnings.push(`${ch.label}: ${ch.error}`);
    else {
      if (ch.videosError) warnings.push(`${ch.label} 영상 목록: ${ch.videosError}`);
      if (ch.comments.error) warnings.push(`${ch.label} 댓글: ${ch.comments.error}`);
      if (ch.analytics && !ch.analytics.ok) warnings.push(`${ch.label} 분석: ${ch.analytics.error}`);
    }
  }

  const byKey: Dict = {};
  for (const ch of results) byKey[ch.key] = ch;
  const number = (v: any) => (typeof v === "number" && isFinite(v) ? v : 0);

  const payload: Dict = {
    ok: results.some((c) => !c.error),
    fetchedAt: new Date().toISOString(),
    cached: false,
    source: {
      dataApi: "YouTube Data API v3",
      analyticsApi: "YouTube Analytics API v2",
      channels: CHANNELS.map((c) => c.channelId),
      videoLimit: VIDEO_LIMIT,
      commentLimit: COMMENT_LIMIT,
    },
    channels: results,
    summary: {
      channels: results.length,
      subscribers: number(byKey.kr?.stats?.subscribers) + number(byKey.jp?.stats?.subscribers),
      views: number(byKey.kr?.stats?.views) + number(byKey.jp?.stats?.views),
      videos: number(byKey.kr?.stats?.videos) + number(byKey.jp?.stats?.videos),
      views7d: number(byKey.kr?.analytics?.views7d) + number(byKey.jp?.analytics?.views7d),
      unanswered: number(byKey.kr?.comments?.unanswered) + number(byKey.jp?.comments?.unanswered),
      hot: number(byKey.kr?.hotCount) + number(byKey.jp?.hotCount),
    },
    warnings,
    tookMs: Date.now() - started,
  };

  if (!debug) cache = { at: Date.now(), payload };
  return json(payload, payload.ok ? 200 : 502, {
    "Cache-Control": "public, max-age=45",
    "X-Cache": "MISS",
  });
});

function json(body: unknown, status: number, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      ...extra,
    },
  });
}
