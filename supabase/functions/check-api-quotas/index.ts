// ──────────────────────────────────────────────────────────────
//  Supabase Edge Function · check-api-quotas
//  # 📊 AI-API-사용량 채널방의 '실시간 실측 새로고침' 버튼이 호출하는 함수.
//
//  · keys.json 의 제공자들을 실제로 호출해 남은 무료 한도/잔여량/리셋 시각을 잰다.
//  · 결과는 public.api_quotas (1제공자=1행) 에 upsert, 실행 1건을 public.api_quota_runs 에 남긴다.
//  · API 키는 이 함수의 Edge Function Secrets 에만 있고, 코드·응답·DB 어디에도 쓰지 않는다.
//  · CORS: 브라우저에서 직접 호출할 수 있게 Access-Control-Allow-Origin: *
//  · 무료 한도 보호: 리셋 전 '한도 초과' 제공자와 Gemini 계열(6시간 스로틀)은 재호출하지 않고
//    직전 실측값을 그대로 유지한다(carried). 45초 안에 다시 눌리면 실측 없이 캐시만 돌려준다.
// ──────────────────────────────────────────────────────────────
// deno-lint-ignore-file no-explicit-any

type Dict = Record<string, any>;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "86400",
};

const HTTP_TIMEOUT = 40_000;
const PROBE_CONCURRENCY = 5; // 무료 등급 동시 요청 제한을 피하려고 5개씩만 동시에 호출한다
const MAX_BODY = 600;
const MIN_INTERVAL_SEC = 45; // 이 시간 안의 재요청은 실측하지 않고 캐시 반환(중복 클릭·여러 탭 보호)
const KST_OFFSET = 9 * 3600 * 1000;

// 무료 일일 한도가 작은 제공자는 이 간격 안에서 다시 부르지 않는다(시간)
const THROTTLE_HOURS: Record<string, number> = {
  gemini: 6,
  gemini_backup: 6,
  gemini_free_3: 6,
  gemini_free_4: 6,
};

// ────────────────────────────── 기준 한도(예상 %) ──────────────────────────────
// API 응답이 잔여 %를 직접 주지 않는 제공자는, 공개된 무료 한도에서
// 우리가 집계한 이번 기간 사용량을 빼서 remaining_pct 를 계산한다(표시: '예상').
type Period = "day" | "month" | "total";

type Basis = {
  limit: number; // 기준 한도 (unit 단위)
  unit: string; // 회 / 자 / Neuron
  period: Period; // day · month · total(리셋 없음)
  tz: string; // 기간 경계를 계산할 시간대
  cost: number; // 실측 1회가 소모하는 양(unit)
  limitLabel: string; // 카드의 기준 줄
  resetLabel: string; // 리셋 안내
};

const GEMINI_RESET = "매일 17:00(KST) 리셋";
const BASIS: Record<string, Basis> = {
  gemini: {
    limit: 10, unit: "회", period: "day", tz: "America/Los_Angeles", cost: 1,
    limitLabel: "1일 10회", resetLabel: GEMINI_RESET,
  },
  gemini_backup: {
    limit: 10, unit: "회", period: "day", tz: "America/Los_Angeles", cost: 1,
    limitLabel: "1일 10회", resetLabel: GEMINI_RESET,
  },
  gemini_free_3: {
    limit: 10, unit: "회", period: "day", tz: "America/Los_Angeles", cost: 1,
    limitLabel: "1일 10회", resetLabel: GEMINI_RESET,
  },
  gemini_free_4: {
    limit: 10, unit: "회", period: "day", tz: "America/Los_Angeles", cost: 1,
    limitLabel: "1일 10회", resetLabel: GEMINI_RESET,
  },
  cohere: {
    limit: 1000, unit: "회", period: "month", tz: "Asia/Seoul", cost: 1,
    limitLabel: "월 1,000회", resetLabel: "매월 1일 00:00(KST) 리셋",
  },
  requesty: {
    limit: 200, unit: "회", period: "day", tz: "UTC", cost: 1,
    limitLabel: "1일 200회", resetLabel: "매일 09:00(KST) 리셋",
  },
  exaone: {
    limit: 100, unit: "회", period: "day", tz: "UTC", cost: 1,
    limitLabel: "1일 100회", resetLabel: "매일 09:00(KST) 리셋 · 2026-12-19 만료",
  },
  cloudflare: {
    limit: 10000, unit: "Neuron", period: "day", tz: "UTC", cost: 1,
    limitLabel: "1일 10,000 Neuron", resetLabel: "매일 09:00(KST) 리셋",
  },
  gcloud_tts: {
    limit: 1000000, unit: "자", period: "month", tz: "America/Los_Angeles", cost: 2,
    limitLabel: "월 100만 자", resetLabel: "매월 1일 17:00(KST) 리셋",
  },
  upstage: {
    limit: 12000, unit: "회", period: "total", tz: "UTC", cost: 1,
    limitLabel: "무료 크레딧 $10 ≈ 12,000회", resetLabel: "리셋 없음(크레딧 소진까지)",
  },
};

function tzParts(ms: number, tz: string): Record<string, string> {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(ms))) if (p.type !== "literal") out[p.type] = p.value;
  return out;
}

const tzDateKey = (ms: number, tz: string) => {
  const p = tzParts(ms, tz);
  return `${p.year}-${p.month}-${p.day}`;
};
const tzMonthKey = (ms: number, tz: string) => {
  const p = tzParts(ms, tz);
  return `${p.year}-${p.month}`;
};

function periodKey(b: Basis, ms: number): string {
  if (b.period === "day") return tzDateKey(ms, b.tz);
  if (b.period === "month") return tzMonthKey(ms, b.tz);
  return "total";
}

// 기간이 바뀌는 다음 시각(현지 자정/월초). 시간대 오프셋이 정시 단위라
// 정시 격자로 올라가며 날짜(월) 키가 바뀌는 순간을 찾으면 정확하다.
function nextBoundary(b: Basis, ms: number): number | null {
  if (b.period === "total") return null;
  const startHour = Math.floor(ms / 3600000) * 3600000;
  let t = startHour;
  if (b.period === "day") {
    const key = tzDateKey(ms, b.tz);
    for (let i = 0; i < 30; i++) {
      t += 3600000;
      if (tzDateKey(t, b.tz) !== key) return t;
    }
    return ms + 86400000;
  }
  const key = tzMonthKey(ms, b.tz);
  for (let i = 0; i < 24 * 33; i++) {
    t += 3600000;
    if (tzMonthKey(t, b.tz) !== key) return t;
  }
  return ms + 86400000 * 31;
}

const fmtCount = (n: number) => Math.round(n).toLocaleString("en-US");

// 이번 기간 누적 사용량 = 직전 기록(같은 기간) + 이번 실측 소모량.
// 기간이 바뀌었으면 0 에서 시작한다(리셋). 응답이 429 면 0% 로 고정.
function applyEstimate(row: Dict, prev: Dict | null, freshOk: boolean): void {
  const b = BASIS[row.provider];
  if (!b) return;
  const now = nowMs();
  const key = periodKey(b, now);
  const prevDetail = prev && prev.detail && typeof prev.detail === "object" ? prev.detail : null;
  const prevUsage = prevDetail && prevDetail.usage && typeof prevDetail.usage === "object"
    ? prevDetail.usage
    : null;
  let used = prevUsage && prevUsage.period_key === key ? Number(prevUsage.used) || 0 : 0;
  if (freshOk && row.status === "ok") used += b.cost;
  if (row.status === "limited") used = Math.max(used, b.limit);
  used = Math.max(0, Math.min(b.limit, used));

  const pct = used <= 0 ? 100 : Math.max(0, Math.min(100, Math.floor((1 - used / b.limit) * 1000) / 10));
  row.remaining_pct = pct;

  const detail = row.detail && typeof row.detail === "object" ? row.detail : {};
  row.detail = {
    ...detail,
    pct_source: "estimated",
    usage: {
      period_key: key,
      used,
      limit: b.limit,
      unit: b.unit,
      period: b.period,
      period_tz: b.tz,
      cost_per_probe: freshOk ? b.cost : null,
      updated_at: iso(now),
    },
  };
  row.limit_text = `${b.limitLabel} · ${b.resetLabel}`;

  const periodWord = b.period === "day" ? "오늘" : b.period === "month" ? "이번 달" : "누적";
  const gap = /^[A-Za-z]/.test(b.unit) ? " " : "";
  const usageLine = `${periodWord} ${fmtCount(used)}/${fmtCount(b.limit)}${gap}${b.unit} 사용`;
  if (row.status === "limited") {
    row.remaining_text = `한도 소진 · ${b.limitLabel} 기준`;
  } else if (row.status === "ok" || used > 0) {
    row.remaining_text = usageLine;
  }
  row.reset_at = iso(nextBoundary(b, now));
}

// ────────────────────────────── helpers ──────────────────────────────
const SECRETS: string[] = [];

function addSecret(v: string | null | undefined): void {
  if (v && typeof v === "string" && v.length >= 12) SECRETS.push(v);
}

function scrub(input: unknown): string {
  let s = input == null ? "" : String(input);
  for (const secret of SECRETS) s = s.split(secret).join("***");
  s = s.replace(/sk-[A-Za-z0-9_\-.]{8,}/g, "***");
  s = s.replace(/gsk_[A-Za-z0-9]{8,}/g, "***");
  s = s.replace(/rqsty-[A-Za-z0-9+/=.\-]{8,}/g, "***");
  s = s.replace(/cohere_[A-Za-z0-9]{8,}/g, "***");
  s = s.replace(/up_[A-Za-z0-9]{8,}/g, "***");
  s = s.replace(/cfut_[A-Za-z0-9]{8,}/g, "***");
  s = s.replace(/AQ\.[A-Za-z0-9_\-]{8,}/g, "***");
  s = s.replace(/(-----BEGIN [A-Z ]+-----)[\s\S]*?(-----END [A-Z ]+-----)/g, "$1***$2");
  return s;
}

const nowMs = () => Date.now();
const iso = (ms: number | null | undefined) => (ms == null ? null : new Date(ms).toISOString());

function parseDuration(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number") return value;
  const s = String(value).trim();
  const asNum = Number(s);
  if (!Number.isNaN(asNum) && /^[\d.]+$/.test(s)) return asNum;
  let total = 0;
  let found = false;
  const re = /([\d.]+)\s*(ms|h|m|s)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    found = true;
    const n = Number(m[1]);
    total += m[2] === "ms" ? n / 1000 : m[2] === "s" ? n : m[2] === "m" ? n * 60 : n * 3600;
  }
  return found ? total : null;
}

function resetFromSeconds(sec: number | null): string | null {
  if (sec == null || sec < 0) return null;
  return iso(nowMs() + sec * 1000);
}

function humanDelta(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h && m) return `${h}시간 ${m}분`;
  if (h) return `${h}시간`;
  if (m) return `${m}분`;
  return `${s}초`;
}

type Probe = {
  status: number;
  ok: boolean;
  text: string;
  json: any;
  headers: Headers;
  ms: number;
};

async function call(url: string, init: Dict = {}): Promise<Probe> {
  const t0 = nowMs();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    let text = "";
    try {
      text = await res.text();
    } catch {
      text = "";
    }
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: res.status, ok: res.ok, text, json: parsed, headers: res.headers, ms: nowMs() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

function bodySnippet(res: Probe): string {
  return scrub((res.text || "").replace(/\s+/g, " ").trim().slice(0, MAX_BODY));
}

function headerMap(res: Probe, prefix = "x-ratelimit"): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (k.toLowerCase().startsWith(prefix)) out[k.toLowerCase()] = v;
  });
  return out;
}

function classify(res: Probe): string {
  if (res.status >= 200 && res.status < 300) return "ok";
  if (res.status === 429 || res.status === 402) return "limited";
  return "error";
}

function errorNote(res: Probe): string {
  const data = res.json;
  if (data && typeof data === "object") {
    const err = data.error;
    if (err && typeof err === "object" && !Array.isArray(err)) {
      const msg = err.message || err.status || JSON.stringify(err);
      return scrub(msg).slice(0, 240);
    }
    if (typeof err === "string") return scrub(err).slice(0, 240);
    if (Array.isArray(data.errors) && data.errors[0] && data.errors[0].message) {
      return scrub(String(data.errors[0].message)).slice(0, 240);
    }
    for (const k of ["message", "detail", "errors"]) {
      if (data[k]) return scrub(typeof data[k] === "string" ? data[k] : JSON.stringify(data[k])).slice(0, 240);
    }
  }
  return bodySnippet(res);
}

function chatProbe(
  url: string,
  key: string,
  model: string,
  maxTokens = 1,
  extra?: Dict,
  prompt = "ok",
): Promise<Probe> {
  const payload: Dict = {
    model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: maxTokens,
    stream: false,
    ...(extra || {}),
  };
  return call(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function baseRow(
  provider: string,
  label: string,
  emoji: string,
  category: string,
  sortOrder: number,
  guide: string,
  models = "",
): Dict {
  return {
    provider,
    label,
    emoji,
    category,
    sort_order: sortOrder,
    guide,
    models: models || null,
    status: "unknown",
    available: null,
    http_status: null,
    remaining_pct: null,
    remaining_text: null,
    limit_text: null,
    used_text: null,
    reset_at: null,
    detail: {},
    notes: null,
    latency_ms: null,
  };
}

function missingSecret(row: Dict, secretName: string): Dict {
  row.status = "unknown";
  row.available = null;
  row.notes = `Edge Function Secret '${secretName}' 미설정 · 이 제공자는 실측하지 못했습니다`;
  return row;
}

// ────────────────────────────── secrets ──────────────────────────────
const ENV = (name: string) => (Deno.env.get(name) || "").trim();

const KEYCFG = {
  openrouter: ENV("OPENROUTER_API_KEY"),
  groq: ENV("GROQ_API_KEY"),
  gemini: ENV("GEMINI_API_KEY"),
  gemini_backup: ENV("GEMINI_BACKUP_API_KEY"),
  gemini_free_3: ENV("GEMINI_FREE_3_API_KEY"),
  gemini_free_4: ENV("GEMINI_FREE_4_API_KEY"),
  cohere: ENV("COHERE_API_KEY"),
  upstage: ENV("UPSTAGE_API_KEY"),
  zai: ENV("ZAI_API_KEY"),
  exaone: ENV("EXAONE_API_KEY"),
  requesty: ENV("REQUESTY_API_KEY"),
  cloudflare_token: ENV("CLOUDFLARE_API_TOKEN"),
  cloudflare_account: ENV("CLOUDFLARE_ACCOUNT_ID"),
  pixabay: ENV("PIXABAY_API_KEY"),
  gcp_sa: ENV("GCP_SERVICE_ACCOUNT_JSON"),
};

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

// ────────────────────────────── probes ──────────────────────────────
async function probeOpenRouter(): Promise<Dict> {
  const row = baseRow(
    "openrouter",
    "OpenRouter",
    "🌐",
    "라우터",
    10,
    "무료 모델(:free) 1일 50회 · 유료 모델은 크레딧 필요",
    "particle-ai/particle-1:free, nvidia/nemotron-3-ultra-550b-a55b:free, google/gemma-4-31b-it:free",
  );
  if (!KEYCFG.openrouter) return missingSecret(row, "OPENROUTER_API_KEY");
  const r = await call("https://openrouter.ai/api/v1/key", {
    headers: { Authorization: "Bearer " + KEYCFG.openrouter },
  });
  row.latency_ms = r.ms;
  row.http_status = r.status;
  row.status = classify(r);
  row.available = row.status === "ok";
  if (r.status === 200) {
    const d = (r.json && r.json.data) || {};
    const free = d.free_model_daily_requests || {};
    const used = free.used;
    const limit = free.limit;
    const remaining = free.remaining;
    if (remaining != null && limit) {
      row.remaining_pct = Math.round((Number(remaining) / Number(limit)) * 1000) / 10;
      row.remaining_text = `무료 모델 ${remaining}/${limit}회 남음`;
      row.limit_text = `무료 모델 1일 ${limit}회`;
    } else if (limit != null) {
      row.limit_text = `1일 ${limit}`;
    }
    if (used != null) row.used_text = `무료 모델 ${used}회 사용`;
    if (d.usage != null) {
      row.used_text = (row.used_text ? row.used_text + " · " : "") + `누적 $${d.usage}`;
    }
    row.detail = {
      usage: d.usage,
      usage_monthly: d.usage_monthly,
      is_free_tier: d.is_free_tier,
      free_model_daily_requests: free,
      limit: d.limit,
      limit_remaining: d.limit_remaining,
    };
    if (!row.remaining_text) row.remaining_text = "키 정상 · 무료 등급 사용 중";
  } else {
    row.notes = errorNote(r);
  }
  return row;
}

async function probeGroq(): Promise<Dict> {
  const row = baseRow(
    "groq",
    "Groq",
    "⚡",
    "LLM",
    20,
    "무료 등급 · 분당 요청/토큰 한도(헤더로 확인)",
    "openai/gpt-oss-120b, openai/gpt-oss-20b, qwen/qwen3.8-27b",
  );
  if (!KEYCFG.groq) return missingSecret(row, "GROQ_API_KEY");
  const r = await chatProbe(
    "https://api.groq.com/openai/v1/chat/completions",
    KEYCFG.groq,
    "openai/gpt-oss-20b",
  );
  row.latency_ms = r.ms;
  row.http_status = r.status;
  row.status = classify(r);
  row.available = row.status === "ok";
  const h = headerMap(r);
  row.detail = { ratelimit_headers: h };
  const reqRem = h["x-ratelimit-remaining-requests"];
  const reqLim = h["x-ratelimit-limit-requests"];
  const tokRem = h["x-ratelimit-remaining-tokens"];
  const tokLim = h["x-ratelimit-limit-tokens"];
  if (reqRem != null && reqLim != null && Number(reqLim) !== 0) {
    row.remaining_pct = Math.round((Number(reqRem) / Number(reqLim)) * 1000) / 10;
  }
  const parts: string[] = [];
  if (reqRem != null && reqLim != null) {
    parts.push(`요청 ${Math.round(Number(reqRem)).toLocaleString("en-US")}/${Math.round(Number(reqLim)).toLocaleString("en-US")}회 남음`);
  }
  if (tokRem != null && tokLim != null) {
    parts.push(`토큰 ${Math.round(Number(tokRem)).toLocaleString("en-US")}/${Math.round(Number(tokLim)).toLocaleString("en-US")}`);
  }
  row.remaining_text = parts.length ? parts.join(" · ") : null;
  const resetS =
    parseDuration(h["x-ratelimit-reset-requests"]) ?? parseDuration(h["x-ratelimit-reset-tokens"]);
  row.reset_at = resetFromSeconds(resetS);
  row.limit_text = "분당 요청/토큰 한도";
  if (row.status !== "ok") {
    row.notes = errorNote(r);
    if (row.status === "limited") {
      row.reset_at = resetFromSeconds(parseDuration(r.headers.get("retry-after")) ?? resetS);
    }
  }
  return row;
}

async function probeGemini(
  provider: string,
  label: string,
  sortOrder: number,
  model: string,
  kind: "tts" | "text",
): Promise<Dict> {
  const key = (KEYCFG as Dict)[provider] as string;
  const row = baseRow(
    provider,
    label,
    "✨",
    kind === "tts" ? "TTS" : "LLM",
    sortOrder,
    "AI Studio 무료 등급 · 키별 무료 한도(TTS/텍스트)",
    model,
  );
  const envName = provider.toUpperCase() + "_API_KEY";
  if (!key) return missingSecret(row, envName);
  const url = `${GEMINI_BASE}/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const payload =
    kind === "tts"
      ? {
          contents: [{ parts: [{ text: "한" }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } },
          },
        }
      : {
          contents: [{ parts: [{ text: "ok" }] }],
          generationConfig: { maxOutputTokens: 1 },
        };
  let r = await call(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (r.status >= 500) {
    // 일시적 과부하(503 등)는 한 번만 다시 시도
    await new Promise((res) => setTimeout(res, 3000));
    r = await call(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }
  row.latency_ms = r.ms;
  row.http_status = r.status;
  row.status = classify(r);
  row.available = row.status === "ok";
  const detail: Dict = { model, probe: kind === "tts" ? "generateContent(TTS, 1자)" : "generateContent(text, 1토큰)" };
  if (r.status === 200) {
    try {
      const d = r.json || {};
      const usage = d.usageMetadata || {};
      detail.usage_metadata = usage;
      const part = (((d.candidates || [{}])[0] || {}).content || {}).parts || [{}];
      detail.audio_bytes = String((part[0] || {}).inlineData?.data || "").length;
      row.used_text = `이번 실측 ${usage.totalTokenCount ?? "?"} 토큰`;
    } catch {
      detail.body = bodySnippet(r);
    }
    row.remaining_text = "사용 가능 (HTTP 200)";
    row.limit_text = "무료 등급 한도";
    row.detail = detail;
  } else {
    const d = (r.json && r.json.error) || {};
    let delay: number | null = null;
    for (const item of d.details || []) {
      if (item && (item.retryDelay || item.retry_delay)) delay = parseDuration(item.retryDelay || item.retry_delay);
    }
    row.detail = { ...detail, error_status: d.status, error_message: scrub(String(d.message || "")).slice(0, 240) };
    row.notes = scrub(String(d.message || bodySnippet(r))).slice(0, 240);
    if (r.status >= 500) {
      row.notes = `모델 일시 과부하 (HTTP ${r.status}) · 잠시 후 재시도`;
      row.remaining_text = `일시 오류 (HTTP ${r.status})`;
    }
    if (row.status === "limited") {
      row.reset_at = resetFromSeconds(delay);
      row.remaining_text = "한도 초과 (HTTP 429)";
      row.limit_text = "무료 등급 한도";
      row.notes = "무료 한도 소진 · 응답 429";
    }
  }
  return row;
}

async function probeApiroom(
  provider: string,
  key: string,
  secretName: string,
  url: string,
  model: string,
  label: string,
  emoji: string,
  category: string,
  sortOrder: number,
  guide: string,
  models: string,
  extra?: Dict,
  maxTokens = 1,
): Promise<Dict> {
  const row = baseRow(provider, label, emoji, category, sortOrder, guide, models);
  if (!key) return missingSecret(row, secretName);
  let r = await chatProbe(url, key, model, maxTokens, extra);
  if (r.status === 429 && (r.text || "").toLowerCase().includes("concurrent")) {
    await new Promise((res) => setTimeout(res, 5000));
    r = await chatProbe(url, key, model, maxTokens, extra);
  }
  row.latency_ms = r.ms;
  row.http_status = r.status;
  row.status = classify(r);
  row.available = row.status === "ok";
  const h = headerMap(r);
  if (Object.keys(h).length) row.detail = { ratelimit_headers: h };
  if (row.status === "ok") {
    row.remaining_text = "사용 가능 (HTTP 200)";
  } else {
    let note = errorNote(r);
    if (provider === "cloudflare" && note.toLowerCase().includes("neuron")) {
      note = "일일 무료 10,000 Neuron 소진 (HTTP 429) · 유료 플랜 필요";
    } else if (note.toLowerCase().includes("concurrent")) {
      note = "동시 요청 초과 · 잠시 후 재시도";
    } else if (/throttl|too many|rate limit/i.test(note)) {
      note = "요청 속도 제한 (HTTP " + r.status + ") · 잠시 후 다시 시도";
    }
    row.notes = note;
    row.detail = { ...(row.detail || {}), body: bodySnippet(r) };
    if (row.status === "limited") {
      row.reset_at = resetFromSeconds(parseDuration(r.headers.get("retry-after")));
      if (!row.remaining_text) row.remaining_text = `한도 초과 (HTTP ${r.status})`;
    }
  }
  return row;
}

async function probePixabay(): Promise<Dict> {
  const row = baseRow("pixabay", "Pixabay", "🖼️", "스톡", 120, "무료 스톡 이미지/영상 · 60초당 100회", "videos, images");
  if (!KEYCFG.pixabay) return missingSecret(row, "PIXABAY_API_KEY");
  const url = `https://pixabay.com/api/videos/?key=${encodeURIComponent(KEYCFG.pixabay)}&q=test&per_page=3`;
  const r = await call(url);
  row.latency_ms = r.ms;
  row.http_status = r.status;
  row.status = classify(r);
  row.available = row.status === "ok";
  const h = headerMap(r);
  row.detail = { ratelimit_headers: h };
  const rem = h["x-ratelimit-remaining"];
  const lim = h["x-ratelimit-limit"];
  if (rem != null && lim != null && Number(lim) !== 0) {
    row.remaining_pct = Math.round((Number(rem) / Number(lim)) * 1000) / 10;
  }
  if (rem != null && lim != null) {
    row.remaining_text = `${Math.round(Number(rem))}/${Math.round(Number(lim))}회 남음 (60초 기준)`;
    row.limit_text = `60초당 ${Math.round(Number(lim))}회`;
  }
  row.reset_at = resetFromSeconds(parseDuration(h["x-ratelimit-reset"]));
  if (row.status === "ok") {
    if (r.json && r.json.totalHits != null) row.detail.total_hits = r.json.totalHits;
    if (!row.remaining_text) row.remaining_text = "사용 가능 (HTTP 200)";
  } else {
    row.notes = errorNote(r);
  }
  return row;
}

// ── Google Cloud TTS: 서비스 계정 JWT(RS256) → OAuth 토큰 → 합성 1회 ──
function b64url(bytes: Uint8Array | string): string {
  const arr = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToPkcs8(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const raw = atob(body);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function gcpAccessToken(sa: Dict): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const iat = Math.floor(nowMs() / 1000);
  const claims = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token",
    iat,
    exp: iat + 3600,
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(String(sa.private_key || "")),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const assertion = `${unsigned}.${b64url(new Uint8Array(sig))}`;
  const r = await call("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });
  if (!r.ok || !r.json || !r.json.access_token) {
    throw new Error(`서비스 계정 토큰 발급 실패 HTTP ${r.status}: ${scrub(bodySnippet(r))}`);
  }
  return r.json.access_token as string;
}

async function probeGcloudTts(): Promise<Dict> {
  const row = baseRow(
    "gcloud_tts",
    "Google Cloud TTS",
    "🔊",
    "TTS",
    130,
    "월 100만 자 무료(Standard 음성) · 서비스 계정 인증",
    "ko-KR-Standard-A",
  );
  if (!KEYCFG.gcp_sa) return missingSecret(row, "GCP_SERVICE_ACCOUNT_JSON");
  let sa: Dict;
  try {
    sa = JSON.parse(KEYCFG.gcp_sa);
  } catch {
    row.status = "error";
    row.available = false;
    row.notes = "GCP_SERVICE_ACCOUNT_JSON 이 올바른 JSON 이 아닙니다";
    return row;
  }
  const t0 = nowMs();
  let token: string;
  try {
    token = await gcpAccessToken(sa);
  } catch (exc) {
    row.latency_ms = nowMs() - t0;
    row.status = "error";
    row.available = false;
    row.notes = "서비스 계정 토큰 발급 실패: " + scrub(String(exc)).slice(0, 200);
    return row;
  }
  const r = await call("https://texttospeech.googleapis.com/v1/text:synthesize", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({
      input: { text: "확인" },
      voice: { languageCode: "ko-KR", name: "ko-KR-Standard-A" },
      audioConfig: { audioEncoding: "MP3" },
    }),
  });
  row.latency_ms = nowMs() - t0;
  row.http_status = r.status;
  row.status = classify(r);
  row.available = row.status === "ok";
  if (r.status === 200) {
    try {
      const audio = String((r.json && r.json.audioContent) || "");
      row.detail = { audio_bytes: Math.floor((audio.length * 3) / 4) };
    } catch {
      /* noop */
    }
    row.remaining_text = "사용 가능 (HTTP 200)";
    row.used_text = "이번 실측 2자 사용";
    row.limit_text = "월 100만 자 무료";
  } else {
    row.notes = errorNote(r);
    row.detail = { body: bodySnippet(r) };
  }
  return row;
}

// ── 제공자 목록 ──
type Job = { provider: string; run: () => Promise<Dict> };

const JOBS: Job[] = [
  { provider: "openrouter", run: probeOpenRouter },
  { provider: "groq", run: probeGroq },
  { provider: "gemini", run: () => probeGemini("gemini", "Gemini (기본)", 30, "gemini-3.5-flash-lite", "text") },
  { provider: "gemini_backup", run: () => probeGemini("gemini_backup", "Gemini (백업)", 40, "gemini-2.5-flash-preview-tts", "tts") },
  { provider: "gemini_free_3", run: () => probeGemini("gemini_free_3", "Gemini (3호)", 50, "gemini-2.5-flash-preview-tts", "tts") },
  {
    provider: "gemini_free_4",
    run: () => probeGemini("gemini_free_4", "Gemini (4호)", 55, "gemini-3.5-flash-lite", "text"),
  },
  {
    provider: "cohere",
    run: () =>
      probeApiroom(
        "cohere",
        KEYCFG.cohere,
        "COHERE_API_KEY",
        "https://api.cohere.com/v2/chat",
        "command-r7b-12-2024",
        "Cohere",
        "🧭",
        "LLM",
        60,
        "Trial 무료 · 월 1,000회 (20회/분)",
        "command-a-03-2025, command-r-plus-08-2024, command-r7b-12-2024",
      ),
  },
  {
    provider: "upstage",
    run: () =>
      probeApiroom(
        "upstage",
        KEYCFG.upstage,
        "UPSTAGE_API_KEY",
        "https://api.upstage.ai/v1/chat/completions",
        "solar-mini4",
        "Upstage",
        "🌞",
        "LLM",
        70,
        "무료 크레딧 $10 (약 1.2만 회, ~2027-02-20)",
        "solar-pro4, solar-mini4",
      ),
  },
  {
    provider: "zai",
    run: () =>
      probeApiroom(
        "zai",
        KEYCFG.zai,
        "ZAI_API_KEY",
        "https://api.z.ai/api/paas/v4/chat/completions",
        "glm-4.5-flash",
        "Z.AI (GLM)",
        "🧩",
        "LLM",
        80,
        "무료 등급 · 동시 호출 제한(flash 1~2건)",
        "glm-4.7-flash, glm-4.5-flash",
        { thinking: { type: "disabled" } },
      ),
  },
  {
    provider: "exaone",
    run: () =>
      probeApiroom(
        "exaone",
        KEYCFG.exaone,
        "EXAONE_API_KEY",
        "https://api.exaone.ai/v1/chat/completions",
        "k-exaone_v2.5",
        "EXAONE",
        "🧠",
        "LLM",
        90,
        "비상업용 1일 100회 · 2026-12-19 만료",
        "k-exaone_v2.5",
      ),
  },
  {
    provider: "requesty",
    run: () =>
      probeApiroom(
        "requesty",
        KEYCFG.requesty,
        "REQUESTY_API_KEY",
        "https://router.requesty.ai/v1/chat/completions",
        "google/gemma-4-31b-it",
        "Requesty",
        "🔀",
        "라우터",
        100,
        "카드 없이 1일 200회 무료",
        "google/gemma-4-31b-it, nvidia/nemotron-3-ultra-550b-a55b, novita/ling-3.1-flash",
        undefined,
        800,
      ),
  },
  {
    provider: "cloudflare",
    run: () =>
      probeApiroom(
        "cloudflare",
        KEYCFG.cloudflare_token,
        "CLOUDFLARE_API_TOKEN",
        `https://api.cloudflare.com/client/v4/accounts/${KEYCFG.cloudflare_account || "ec0a9c73efaca37740baa270ab1641f0"}/ai/v1/chat/completions`,
        "@cf/openai/gpt-oss-120b",
        "Cloudflare Workers AI",
        "☁️",
        "LLM",
        110,
        "무료 등급 · 1일 10,000 Neuron",
        "@cf/openai/gpt-oss-120b, @cf/qwen/qwen3.8-27b, @cf/google/gemma-4-26b-a4b-it",
      ),
  },
  { provider: "pixabay", run: probePixabay },
  { provider: "gcloud_tts", run: probeGcloudTts },
];

const DEFAULTS: Record<string, [string, string, string]> = {
  openrouter: ["OpenRouter", "🌐", "라우터"],
  groq: ["Groq", "⚡", "LLM"],
  gemini: ["Gemini (기본)", "✨", "LLM"],
  gemini_backup: ["Gemini (백업)", "✨", "TTS"],
  gemini_free_3: ["Gemini (3호)", "✨", "TTS"],
  gemini_free_4: ["Gemini (4호)", "✨", "LLM"],
  cohere: ["Cohere", "🧭", "LLM"],
  upstage: ["Upstage", "🌞", "LLM"],
  zai: ["Z.AI (GLM)", "🧩", "LLM"],
  exaone: ["EXAONE", "🧠", "LLM"],
  requesty: ["Requesty", "🔀", "라우터"],
  cloudflare: ["Cloudflare Workers AI", "☁️", "LLM"],
  pixabay: ["Pixabay", "🖼️", "스톡"],
  gcloud_tts: ["Google Cloud TTS", "🔊", "TTS"],
};

const ORDER: Record<string, number> = {
  openrouter: 10,
  groq: 20,
  gemini: 30,
  gemini_backup: 40,
  gemini_free_3: 50,
  gemini_free_4: 55,
  cohere: 60,
  upstage: 70,
  zai: 80,
  exaone: 90,
  requesty: 100,
  cloudflare: 110,
  pixabay: 120,
  gcloud_tts: 130,
};

const LIMIT_DEFAULTS: Record<string, string> = {
  cohere: "월 1,000회",
  upstage: "무료 크레딧 $10",
  zai: "동시 호출 1~2건",
  exaone: "1일 100회",
  requesty: "1일 200회",
  cloudflare: "1일 10,000 Neuron",
  gemini: "무료 등급 한도",
  gemini_backup: "무료 등급 한도",
  gemini_free_3: "무료 등급 한도",
  gemini_free_4: "무료 등급 한도",
  gcloud_tts: "월 100만 자",
};

// ────────────────────────────── supabase ──────────────────────────────
const SB_URL = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");

// service_role 키로 쓰는 것이 기본. 이 프로젝트의 api_quotas/api_quota_runs 는
// anon 역할에도 insert/update 권한과 RLS 정책이 열려 있어(실측 스크립트가 그 키를 쓴다),
// service_role 권한이 아직 부여되지 않은 경우 anon 으로 자동 대체한다.
const SB_SERVICE =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
  Deno.env.get("SUPABASE_SECRET_KEY") ||
  Deno.env.get("SB_SECRET_KEY") ||
  "";
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || "";
let preferredWriteKey = SB_SERVICE;

function sbHeaders(key: string, extra: Dict = {}): Dict {
  return { apikey: key, Authorization: "Bearer " + key, ...extra };
}

async function sbWrite(url: string, init: Dict): Promise<void> {  const keys = Array.from(new Set([preferredWriteKey, SB_SERVICE, SB_ANON].filter(Boolean)));
  let last = "";
  for (const key of keys) {
    const r = await call(url, { ...init, headers: sbHeaders(key, init.headers || {}) });
    if (r.status < 300) {
      preferredWriteKey = key;
      return;
    }
    last = `HTTP ${r.status}: ${scrub(bodySnippet(r))}`;
    if (![401, 403].includes(r.status)) break;
  }
  throw new Error(`Supabase 쓰기 실패 (${scrub(url.split("/rest/v1/")[1]?.split("?")[0] || "")}) ${last}`);
}

async function readCurrent(): Promise<Dict[]> {
  const keys = Array.from(new Set([SB_SERVICE, SB_ANON].filter(Boolean)));
  let r: Probe | null = null;
  for (const key of keys) {
    r = await call(`${SB_URL}/rest/v1/api_quotas?select=*`, { headers: sbHeaders(key) });
    if (r.status < 300) return Array.isArray(r.json) ? r.json : [];
    if (![401, 403].includes(r.status)) break;
  }
  throw new Error(`api_quotas 읽기 HTTP ${r ? r.status : "?"}: ${scrub(r ? bodySnippet(r) : "")}`);
}

async function readLastRun(): Promise<Dict | null> {
  const keys = Array.from(new Set([SB_SERVICE, SB_ANON].filter(Boolean)));
  for (const key of keys) {
    const r = await call(`${SB_URL}/rest/v1/api_quota_runs?select=*&order=finished_at.desc&limit=1`, {
      headers: sbHeaders(key),
    });
    if (r.status >= 300) {
      if ([401, 403].includes(r.status)) continue;
      return null;
    }
    const rows = Array.isArray(r.json) ? r.json : [];
    return rows[0] || null;
  }
  return null;
}

async function writeRows(rows: Dict[]): Promise<void> {
  await sbWrite(`${SB_URL}/rest/v1/api_quotas?on_conflict=provider`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
}

async function writeRun(run: Dict): Promise<void> {
  await sbWrite(`${SB_URL}/rest/v1/api_quota_runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(run),
  });
}

// ────────────────────────────── run ──────────────────────────────
function summarize(rows: Dict[]) {
  const counts: Dict = { ok: 0, limited: 0, error: 0, unknown: 0 };
  for (const row of rows) {
    const s = row.status || "unknown";
    counts[s] = (counts[s] || 0) + 1;
  }
  return counts;
}

function compact(rows: Dict[]): Dict[] {
  return rows
    .slice()
    .sort((a, b) => (ORDER[a.provider] ?? 999) - (ORDER[b.provider] ?? 999))
    .map((r) => ({
      provider: r.provider,
      label: r.label,
      emoji: r.emoji,
      status: r.status,
      http_status: r.http_status,
      remaining_pct: r.remaining_pct,
      pct_source: (r.detail && r.detail.pct_source) || null,
      remaining_text: r.remaining_text,
      limit_text: r.limit_text,
      reset_at: r.reset_at,
      notes: r.notes,
      checked_at: r.checked_at,
    }));
}

async function runLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<Dict>): Promise<PromiseSettledResult<Dict>[]> {
  const out: PromiseSettledResult<Dict>[] = new Array(items.length);
  let idx = 0;
  const worker = async () => {
    while (idx < items.length) {
      const i = idx++;
      try {
        out[i] = { status: "fulfilled", value: await fn(items[i]) };
      } catch (exc) {
        out[i] = { status: "rejected", reason: exc };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

async function runProbes(): Promise<Dict> {
  for (const v of Object.values(KEYCFG)) addSecret(v);

  const started = nowMs();
  const carried: Record<string, { row: Dict; why: string }> = {};
  let prevRows: Dict[] = [];
  try {
    prevRows = await readCurrent();
  } catch {
    prevRows = [];
  }
  const now0 = nowMs();
  for (const prev of prevRows) {
    const name = prev.provider;
    if (!name) continue;
    let reset: number | null = null;
    if (prev.reset_at) {
      const t = Date.parse(prev.reset_at);
      if (!Number.isNaN(t)) reset = t;
    }
    if (prev.status === "limited" && reset && reset > now0 + 120_000) {
      carried[name] = {
        row: prev,
        why: "한도 초과 유지 · 리셋까지 " + humanDelta((reset - now0) / 1000) + " 남아 재호출 생략",
      };
      continue;
    }
    const th = THROTTLE_HOURS[name];
    if (th && prev.checked_at) {
      const ct = Date.parse(prev.checked_at);
      if (!Number.isNaN(ct) && now0 - ct < th * 3600 * 1000) {
        carried[name] = { row: prev, why: `${th}시간 내 재확인 생략 · 직전 실측값 유지` };
      }
    }
  }

  const jobs = JOBS.filter((j) => !carried[j.provider]);
  const settled = await runLimited(jobs, PROBE_CONCURRENCY, (j) => j.run());
  const rows: Dict[] = [];
  const skipped: Dict[] = [];
  settled.forEach((res, i) => {
    const name = jobs[i].provider;
    if (res.status === "fulfilled") {
      const row = res.value;
      row.provider = row.provider || name;
      row.checked_at = iso(nowMs());
      row.__fresh_ok = row.status === "ok"; // 이번에 실제로 호출해 200 을 받았는가
      rows.push(row);
    } else {
      const [label, emoji, cat] = DEFAULTS[name] || [name, "🔧", "기타"];
      const raw = String((res.reason && res.reason.message) || res.reason);
      const timeout = /abort|timeout|timed out/i.test(raw);
      rows.push({
        ...baseRow(name, label, emoji, cat, ORDER[name] ?? 999, ""),
        status: "error",
        available: false,
        notes: timeout ? "응답 시간 초과 · 잠시 후 다시 누르면 다시 잽니다" : scrub(raw).slice(0, 200),
        checked_at: iso(nowMs()),
      });
    }
  });

  for (const [name, info] of Object.entries(carried)) {
    const row = { ...info.row };
    row.detail = info.row.detail || {};
    row.notes = info.why; // checked_at 은 실제 호출 시각 그대로 둔다(가짜 갱신 금지)
    row.__fresh_ok = false; // 재호출을 생략했으니 사용량을 더하지 않는다
    rows.push(row);
    skipped.push({ provider: name, reason: info.why });
  }

  // 화면용 기본값 채우기
  for (const row of rows) {
    const [label, emoji, cat] = DEFAULTS[row.provider] || [row.provider, "🔧", "기타"];
    row.label = row.label || label;
    row.emoji = row.emoji || emoji;
    row.category = row.category || cat;
    row.sort_order = row.sort_order || ORDER[row.provider] || 999;
    row.limit_text = row.limit_text || LIMIT_DEFAULTS[row.provider] || null;
    // upsert 로 보낼 수 없는 값 정리
    delete row.id;
  }

  // ── 기준 한도 기반 예상 잔여 % 적용 ──
  // 한도가 공개된 제공자는 누적 사용량을 차감해 계산하고, 그 밖의 제공자는
  // API가 준 실측 %(api) 또는 % 없음(none)으로 표시 방식을 남긴다.
  const prevByName: Record<string, Dict> = {};
  for (const p of prevRows) if (p && p.provider) prevByName[p.provider] = p;
  for (const row of rows) {
    const freshOk = row.__fresh_ok === true;
    delete row.__fresh_ok;
    if (BASIS[row.provider]) {
      applyEstimate(row, prevByName[row.provider] || null, freshOk);
    } else {
      const d = row.detail && typeof row.detail === "object" && !Array.isArray(row.detail) ? row.detail : {};
      d.pct_source = row.remaining_pct == null ? "none" : "api";
      row.detail = d;
    }
  }
  rows.sort((a, b) => (ORDER[a.provider] ?? 999) - (ORDER[b.provider] ?? 999));

  const counts = summarize(rows);
  const run = {
    started_at: iso(started),
    finished_at: iso(nowMs()),
    ok_count: counts.ok,
    limited_count: counts.limited,
    error_count: counts.error,
    unknown_count: counts.unknown,
    total_count: rows.length,
    source: "edge-function",
    notes: skipped.length
      ? `Edge Function 실측 · 재호출 생략 ${skipped.length}개`
      : "Edge Function 실측",
  };

  await writeRows(rows);
  await writeRun(run);

  return {
    ok: true,
    ran: true,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    total: rows.length,
    ok_count: counts.ok,
    limited_count: counts.limited,
    error_count: counts.error,
    unknown_count: counts.unknown,
    measured: jobs.length,
    skipped,
    db_role: preferredWriteKey === SB_ANON ? "anon" : "service_role",
    providers: compact(rows),
  };
}

// 같은 인스턴스에서 동시에 두 번 돌지 않게
let inflight: Promise<Dict> | null = null;

function jsonResponse(data: any, status = 200, extraHeaders: Dict = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: CORS_HEADERS });
  }

  const t0 = nowMs();
  try {
    // 45초 안의 재요청은 실측 없이 지난 결과만 돌려준다(무료 한도 보호 + 중복 클릭)
    const last = await readLastRun();
    if (last && last.finished_at) {
      const lastMs = Date.parse(last.finished_at);
      const elapsed = (nowMs() - lastMs) / 1000;
      if (!Number.isNaN(lastMs) && elapsed >= 0 && elapsed < MIN_INTERVAL_SEC) {
        const rows = await readCurrent();
        const counts = summarize(rows);
        return jsonResponse(
          {
            ok: true,
            ran: false,
            skipped: [
              {
                provider: "*",
                reason: `${Math.round(MIN_INTERVAL_SEC - elapsed)}초 뒤에 다시 실측할 수 있습니다 (${Math.round(elapsed)}초 전 실측)`,
              },
            ],
            lastRunAt: last.finished_at,
            total: rows.length,
            ok_count: counts.ok,
            limited_count: counts.limited,
            error_count: counts.error,
            unknown_count: counts.unknown,
            providers: compact(rows),
          },
          200,
          { "X-Quota-Run": "cached", "Retry-After": String(Math.max(1, Math.round(MIN_INTERVAL_SEC - elapsed))) },
        );
      }
    }

    if (!inflight) {
      inflight = runProbes().finally(() => {
        inflight = null;
      });
    }
    const result = await inflight;
    return jsonResponse(result, 200, { "X-Quota-Run": "fresh", "X-Quota-Ms": String(nowMs() - t0) });
  } catch (exc) {
    console.error("check-api-quotas 실패:", scrub(String((exc as Error)?.stack || exc)).slice(0, 1200));
    return jsonResponse(
      {
        ok: false,
        error: scrub(String((exc as Error)?.message || exc)).slice(0, 400),
        ms: nowMs() - t0,
      },
      500,
    );
  }
});
