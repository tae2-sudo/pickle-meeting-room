// ──────────────────────────────────────────────────────────────
// run-ai-meeting — 비서 통합 회의실 · 🏛️ AI 팀 회의실 (1라운드 = 1요청)
//
//  · 다섯 팀장(기획·대본·팩트·썸네일/제목·리스크)을 서로 다른 AI 제공자로 병렬 호출한다.
//    기획=Gemini · 대본=Groq · 팩트=Cohere · 썸네일/제목=Upstage · 리스크=Requesty
//  · 한 번의 요청이 '한 라운드'만 실행하고 곧바로 JSON 으로 돌려준다.
//    → Edge Function 타임아웃(60~150초)에 걸리지 않고, 화면은 라운드마다 진행 상황을 그린다.
//  · 모델마다 20초 타임아웃. 한 모델이 느리거나 실패해도 나머지로 회의를 계속한다
//    (Promise.allSettled · 실패 사유는 결과 배열에 그대로 담는다).
//  · API 키는 이 함수의 Edge Function Secrets 에만 있고, 코드·응답·브라우저 어디에도 쓰지 않는다.
//      GEMINI_API_KEY · GROQ_API_KEY · COHERE_API_KEY · UPSTAGE_API_KEY · REQUESTY_API_KEY
//  · 보안: 허용한 Origin(https://tae2-sudo.github.io · 로컬 개발)에만 CORS 를 열고,
//    Secrets 에 APP_ACCESS_KEY 가 있으면 x-app-key 헤더가 맞아야 응답한다(아래 '보안' 절).
// ──────────────────────────────────────────────────────────────

type Dict = Record<string, any>;

// ────────────────────────────── 보안: CORS · 앱 접근 키 ──────────────────────────────
// 이 함수는 Secrets 의 키로 유료/무료 한도가 걸린 외부 API 를 대신 호출한다.
// 아무 사이트나 브라우저에서 부를 수 없도록 (1) 허용한 Origin 에만 CORS 를 열고
// (2) Secrets 에 APP_ACCESS_KEY 가 있을 때는 x-app-key 헤더가 맞아야 응답한다.
// · APP_ACCESS_KEY 미설정 → 키 검증 생략(기존 동작 그대로 · 배포 중 장애 방지)
// · APP_ALLOWED_ORIGINS(선택) → 쉼표로 구분해 허용 Origin 을 더 넣을 수 있다
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
  let diff = 0;
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
    return jsonResponse(
      req,
      { ok: false, error: "unauthorized", message: "x-app-key 헤더가 필요합니다." },
      401,
    );
  }
  return null;
}

// ────────────────────────────── 팀장 5명 ──────────────────────────────
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MODEL_TIMEOUT_MS = 20_000; // 모델 1개당 20초
const MAX_TOPIC = 2_000;
const MAX_NOTES = 4_000;
const MAX_RESULT_CHARS = 4_000; // 응답 1건 상한(화면·복사용)
const MAX_HISTORY_CHARS = 2_000; // 라운드 기록에서 팀장 1명당 잘라 넣는 길이
const MAX_HISTORY_TOTAL = 9_000; // 다음 라운드 프롬프트에 넣는 기록 전체 상한

type Leader = {
  id: string;
  name: string;
  emoji: string;
  role: string;
  provider: string;
  secret: string;
  model: string;
  /** 라운드 지시문에 덧붙는 역할 문장 */
  lens: string;
  /** 최종안을 정리하는 헤드(기획) */
  head?: boolean;
};

const LEADERS: Leader[] = [
  {
    id: "plan",
    name: "기획",
    emoji: "🧭",
    role: "트렌드·구조 설계",
    provider: "gemini",
    secret: "GEMINI_API_KEY",
    model: "gemini-3.5-flash-lite",
    lens:
      "너는 기획 팀장이다. 시청자가 왜 지금 이 영상을 눌러야 하는지(트렌드·검색 의도), 15~35초 쇼츠의 구조(훅→전개→반전→CTA), 시리즈로 이어질 각도를 설계한다.",
    head: true,
  },
  {
    id: "script",
    name: "대본",
    emoji: "✍️",
    role: "카피·후킹·대본",
    provider: "groq",
    secret: "GROQ_API_KEY",
    model: "openai/gpt-oss-120b",
    lens:
      "너는 대본 팀장이다. 첫 3초 훅 문장, 말맛이 살아 있는 구어체 대본, 자막으로 끊는 호흡을 쓴다. 설명 대신 장면이 그려지는 문장을 쓴다.",
  },
  {
    id: "fact",
    name: "팩트",
    emoji: "🧾",
    role: "팩트·수치·발음 검수",
    provider: "cohere",
    secret: "COHERE_API_KEY",
    model: "command-a-03-2025",
    lens:
      "너는 팩트 검수 팀장이다. 수치·단위·고유명사·날짜·인용을 원문과 대조하고, 확인할 수 없는 주장은 '확인 필요'로 표시한다. TTS 가 읽을 한글 발음(숫자·영문·약어)까지 지적한다.",
  },
  {
    id: "thumb",
    name: "썸네일·제목",
    emoji: "🖼️",
    role: "제목·썸네일 문구",
    provider: "upstage",
    secret: "UPSTAGE_API_KEY",
    model: "solar-pro4",
    lens:
      "너는 제목·썸네일 팀장이다. 클릭을 부르는 제목 후보와, 썸네일에 크게 박을 2~5단어 문구, 그 문구와 제목의 역할 분담을 만든다. 낚시성 거짓 약속은 쓰지 않는다.",
  },
  {
    id: "risk",
    name: "리스크",
    emoji: "🛡️",
    role: "리스크·정책·반대 논점",
    provider: "requesty",
    secret: "REQUESTY_API_KEY",
    model: "google/gemma-4-31b-it",
    lens:
      "너는 리스크 팀장이다. 저작권·초상권·명예훼손·정책 위반·오해 소지·반대 여론을 먼저 본다. '이대로 올리면 무엇이 터지는가'를 구체적으로 쓰고, 안전하게 비틀 방법을 제안한다.",
  },
];

// ────────────────────────────── 라운드 정의 ──────────────────────────────
type Mode = "fast" | "full";

const MODES: Record<Mode, { label: string; totalRounds: number; titles: string[] }> = {
  fast: {
    label: "⚡ 고속 2라운드",
    totalRounds: 2,
    titles: ["개별 제안", "교차 비평 + 최종 확정"],
  },
  full: {
    label: "🔥 풀 5라운드",
    totalRounds: 5,
    titles: ["개별 제안", "상호 비평", "대본 3안", "팩트·발음 대조", "최종 확정"],
  },
};

const FINAL_FORMAT = `아래 다섯 제목을 **그대로** 쓰고, 각 제목 아래에 내용을 적어라. 제목을 바꾸거나 더하지 마라.
### 제목
(제목 후보 2~4개, 각 1줄. 가능하면 [별별해외이슈] 채널 톤)
### 훅
(첫 3초에 말할 문장 그대로. 1~2문장)
### 타임라인
(0:00~0:03 형식으로 4~7줄. 각 줄에 화면·자막·효과 지시를 함께)
### TTS
(TTS 가 그대로 읽을 한국어 문장. 숫자·영문은 읽는 소리로 병기 — 예: '3.5 → 삼 점 오')
### 팩트
(검증된 사실 / 확인 필요 항목을 나눠 3~6줄)`;

function roundInstruction(mode: Mode, round: number, leader: Leader): string {
  const fast = mode === "fast";
  if (round === 1) {
    return [
      "[R1 · 개별 제안]",
      "다른 팀장의 답은 아직 없다. 소재를 처음 보는 상태에서 네 역할 관점의 1차 제안을 내라.",
      "- 6~10줄. 결론부터. 실행에 바로 옮길 수 있는 내용만.",
      "- 확인되지 않은 수치·통계·1인칭 체험담은 쓰지 마라. 모르면 '확인 필요'라고 써라.",
      "- 이번 라운드에서 네가 확실히 책임질 1가지를 마지막 줄에 '책임: …' 로 적어라.",
    ].join("\n");
  }
  if (round === 2 && fast) {
    const common = [
      "[R2 · 교차 비평 + 최종 확정]",
      "아래 '앞선 라운드'에는 다섯 팀장의 R1 제안이 있다. 두 가지를 한 번에 하라.",
      "1) 교차 비평 — 다른 팀장의 제안 중 살릴 것 1개(이유), 버릴 것 1개(이유), 반박 1개. 각 1줄.",
      "2) 자기 역할의 최종 반영 — 네 관점에서 최종안에 반드시 들어가야 할 것을 확정한다.",
    ];
    if (leader.head) {
      common.push(
        "3) 헤드로서 **최종안**을 확정한다. 비평에서 나온 반대를 반영하고, 아래 형식만 쓴다.",
        "",
        FINAL_FORMAT,
      );
    } else {
      common.push(
        "3) 최종 검수 — '통과 / 보류 / 반대' 중 하나와 이유 2줄, 반드시 반영할 1가지.",
      );
    }
    return common.join("\n");
  }
  if (round === 2) {
    return [
      "[R2 · 상호 비평]",
      "아래 '앞선 라운드'의 다섯 제안을 읽고 서로를 비판하라.",
      "- 동의하는 안 1개(왜), 문제 있는 안 1개(무엇이 왜 문제인지), 빠진 관점 1개.",
      "- 네 역할 관점에서 '이건 내가 책임질 수 없다' 지점을 분명히 말하라.",
      "- 새 아이디어를 길게 쓰지 말고, 판단에 집중하라. 6~10줄.",
    ].join("\n");
  }
  if (round === 3) {
    return [
      "[R3 · 대본 3안]",
      "R2 비평을 반영해 **서로 다른 방향의 3안**을 만든다(예: 정보형 / 반전형 / 논쟁형).",
      "- 각 안: 훅 1문장 → 본문 2~3문장 → 마무리 1문장, 예상 길이(초) 표기.",
      "- 네 역할 관점에서 3안의 차이를 드러내라. 세 안이 비슷하면 실패다.",
    ].join("\n");
  }
  if (round === 4) {
    return [
      "[R4 · 팩트·발음 대조]",
      "아래 '앞선 라운드'의 3안 중 **가장 안전하고 센 안 1개**를 고르고, 그 안을 검증하라.",
      "- 수치·단위·고유명사·날짜·인용을 한 줄씩 대조: '맞음 / 틀림(정정: …) / 확인 필요'.",
      "- TTS 가 잘못 읽을 표기(숫자·영문·약어·외래어)를 읽는 소리로 적어라.",
      "- 네 역할과 무관한 항목은 건너뛰고, 대신 네 관점의 위험 1개를 적어라.",
    ].join("\n");
  }
  // round 5 (full)
  const common = [
    "[R5 · 최종 확정]",
    "지금까지의 라운드를 모두 반영해 회의를 끝낸다.",
  ];
  if (leader.head) {
    common.push(
      "1) 남은 반대 의견을 어떻게 처리했는지 2줄로 밝힌다(무시했다면 무시했다고 쓴다).",
      "2) 헤드로서 **최종안**을 확정한다. 아래 형식만 쓴다.",
      "",
      FINAL_FORMAT,
    );
  } else {
    common.push(
      "1) 최종 검수 — '통과 / 보류 / 반대' 중 하나, 이유 2줄.",
      "2) 이대로 공개했을 때 터질 수 있는 것을 1개, 그것을 막는 문장 수정 1개.",
      "3) 최종안에 반드시 남아야 하는 문구 1개.",
    );
  }
  return common.join("\n");
}

const SYSTEM_BASE = `너는 '별별해외이슈' 유튜브 쇼츠 채널을 만드는 AI 기획팀의 팀장이다.
회의는 한국어로 한다. 짧고 밀도 있게, 실무자가 바로 쓸 수 있는 말로 쓴다.
지켜야 할 선:
- 확인하지 않은 수치·통계·연구 결과를 만들지 않는다. 출처가 없으면 '확인 필요'라고 쓴다.
- 하지 않은 일을 한 것처럼 쓰는 1인칭 체험담을 만들지 않는다.
- 타인·특정 집단을 근거 없이 비하하거나 명예훼손하는 표현을 쓰지 않는다.
- 자기 역할 밖의 일은 짧게만 언급하고, 자기 역할에서 책임질 것을 분명히 한다.`;

function systemPrompt(leader: Leader): string {
  return `${SYSTEM_BASE}\n\n${leader.lens}`;
}

function historyBlock(history: Dict[], mode: Mode): string {
  if (!Array.isArray(history) || !history.length) return "(없음 — 첫 라운드다)";
  const out: string[] = [];
  let total = 0;
  for (const item of history) {
    const n = Number(item && item.round);
    if (!n) continue;
    const title = String((item && item.title) || (MODES[mode].titles[n - 1] || `R${n}`));
    const lines: string[] = [`── R${n} · ${title} ──`];
    const results = Array.isArray(item.results) ? item.results : [];
    for (const r of results) {
      const name = String((r && r.name) || "팀장");
      const text = String((r && r.text) || "").trim();
      const body = r && r.ok === false
        ? `(응답 실패: ${String(r.error || "이유 없음").slice(0, 120)})`
        : (text ? clip(text, MAX_HISTORY_CHARS) : "(응답 없음)");
      const piece = `[${name}] ${body}`;
      if (total + piece.length > MAX_HISTORY_TOTAL) {
        lines.push(`[${name}] (분량 제한으로 생략)`);
        continue;
      }
      total += piece.length;
      lines.push(piece);
    }
    out.push(lines.join("\n"));
  }
  return out.join("\n\n");
}

function userPrompt(opts: {
  mode: Mode;
  round: number;
  leader: Leader;
  topic: string;
  notes: string;
  history: Dict[];
}): string {
  const { mode, round, leader, topic, notes, history } = opts;
  const meta = MODES[mode];
  return [
    `# 회의 안건`,
    `주제/소재: ${topic}`,
    notes ? `참고 링크·메모:\n${notes}` : "참고 링크·메모: (없음)",
    `모드: ${meta.label} · ${round}/${meta.totalRounds} 라운드 — ${meta.titles[round - 1]}`,
    "",
    `# 앞선 라운드 기록`,
    historyBlock(history, mode),
    "",
    `# 이번 라운드에서 네가 할 일 (${leader.emoji} ${leader.name} 팀장)`,
    roundInstruction(mode, round, leader),
    "",
    "답변은 한국어 마크다운으로, 인사말·자기소개 없이 본론만 쓴다.",
  ].join("\n");
}

// ────────────────────────────── 유틸 ──────────────────────────────
function clip(s: string, n: number): string {
  const t = String(s || "").trim();
  return t.length > n ? t.slice(0, n) + "\n…(생략)" : t;
}

function scrubKeys(input: unknown): string {
  return String(input == null ? "" : input)
    .replace(/AIza[0-9A-Za-z\-_]{20,}/g, "***")
    .replace(/gsk_[0-9A-Za-z]{10,}/g, "***")
    .replace(/cohere_[A-Za-z0-9]{8,}/g, "***")
    .replace(/up_[0-9A-Za-z]{10,}/g, "***")
    .replace(/rq_[0-9A-Za-z]{10,}/g, "***")
    .slice(0, 400);
}

function errorNote(json: any, text: string): string {
  const data = json;
  if (data && typeof data === "object") {
    const err = data.error;
    if (err && typeof err === "object" && !Array.isArray(err)) {
      const msg = err.message || err.status || JSON.stringify(err);
      return scrubKeys(msg);
    }
    if (typeof err === "string") return scrubKeys(err);
    if (data.message) return scrubKeys(data.message);
    if (Array.isArray(data.errors) && data.errors[0] && data.errors[0].message) {
      return scrubKeys(data.errors[0].message);
    }
  }
  return scrubKeys((text || "").replace(/\s+/g, " ").slice(0, 240));
}

function jsonResponse(req: Request, data: any, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

type Probe = { status: number; ok: boolean; text: string; json: any; ms: number };

async function postJson(url: string, headers: Dict, payload: Dict): Promise<Probe> {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MODEL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
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
    return { status: res.status, ok: res.ok, text, json: parsed, ms: Date.now() - t0 };
  } catch (exc) {
    const aborted = (exc as Error)?.name === "AbortError" || ctrl.signal.aborted;
    if (aborted) {
      const e = new Error(`${MODEL_TIMEOUT_MS / 1000}초 응답 없음(타임아웃)`);
      (e as any).timeout = true;
      throw e;
    }
    throw exc;
  } finally {
    clearTimeout(timer);
  }
}

// ────────────────────────────── 제공자별 호출 ──────────────────────────────
type LeaderResult = {
  id: string;
  name: string;
  emoji: string;
  role: string;
  provider: string;
  model: string;
  head?: boolean;
  ok: boolean;
  ms: number | null;
  text: string;
  error?: string;
  errorCode?: string;
  warning?: string;
};

/* 한 팀장 1회 호출 — 제공자별 요청 형식만 담당한다(재시도는 callLeader 가 한다) */
async function postLeader(leader: Leader, key: string, system: string, user: string, maxTokens: number): Promise<Probe> {
  if (leader.provider === "gemini") {
    return await postJson(
      `${GEMINI_BASE}/models/${encodeURIComponent(leader.model)}:generateContent?key=${encodeURIComponent(key)}`,
      {},
      {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature: 0.85, topP: 0.95, maxOutputTokens: maxTokens },
      },
    );
  } else if (leader.provider === "cohere") {
    return await postJson(
      "https://api.cohere.com/v2/chat",
      { Authorization: "Bearer " + key },
      {
        model: leader.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.6,
        max_tokens: maxTokens,
        stream: false,
      },
    );
  } else if (leader.provider === "upstage") {
    return await postJson(
      "https://api.upstage.ai/v1/chat/completions",
      { Authorization: "Bearer " + key },
      {
        model: leader.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.7,
        max_tokens: maxTokens,
        stream: false,
      },
    );
  } else {
    // groq · requesty — OpenAI 호환
    const url = leader.provider === "groq"
      ? "https://api.groq.com/openai/v1/chat/completions"
      : "https://router.requesty.ai/v1/chat/completions";
    return await postJson(
      url,
      { Authorization: "Bearer " + key },
      {
        model: leader.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.7,
        max_tokens: maxTokens,
        stream: false,
      },
    );
  }
}

/* 재시도 정책: 한도(429)·서버 혼잡(4xx·5xx)·타임아웃·네트워크 오류는 2.5초 쉬고 한 번만 더 부른다 */
const RETRY_DELAY_MS = 2_500;
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}
function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callLeader(leader: Leader, system: string, user: string, maxTokens: number): Promise<LeaderResult> {
  const base: LeaderResult = {
    id: leader.id,
    name: leader.name,
    emoji: leader.emoji,
    role: leader.role,
    provider: leader.provider,
    model: leader.model,
    head: !!leader.head,
    ok: false,
    ms: null,
    text: "",
  };
  const key = (Deno.env.get(leader.secret) || "").trim();
  if (!key) {
    return { ...base, error: `Secret '${leader.secret}' 미설정`, errorCode: "secret_missing" };
  }
  let r: Probe | null = null;
  let lastError: (Error & { timeout?: boolean }) | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      r = await postLeader(leader, key, system, user, maxTokens);
      lastError = null;
      if (r.ok || !isRetryableStatus(r.status)) break;   // 성공이거나 다시 불러도 같은 답이면 끝
    } catch (exc) {
      lastError = exc as Error & { timeout?: boolean };
      r = null;
    }
    if (attempt === 0) await sleepMs(RETRY_DELAY_MS);
  }
  if (!r) {
    const e = lastError as (Error & { timeout?: boolean }) | null;
    return {
      ...base,
      error: e && e.timeout ? e.message : scrubKeys((e && e.message) || String(e)),
      errorCode: e && e.timeout ? "timeout" : "network",
    };
  }

  base.ms = r.ms;
  if (!r.ok) {
    const note = errorNote(r.json, r.text);
    const code = r.status === 429 || r.status === 402 ? "limited" : (r.status >= 500 ? "server" : "http");
    return {
      ...base,
      error: `HTTP ${r.status}${note ? " · " + note : ""}`,
      errorCode: code,
    };
  }

  let text = "";
  let warning: string | undefined;
  if (leader.provider === "gemini") {
    const d = r.json || {};
    const cand = (d.candidates || [])[0] || {};
    const parts = (cand.content && cand.content.parts) || [];
    text = parts.map((p: Dict) => String(p.text || "")).join("").trim();
    if (!text) {
      const blocked = (d.promptFeedback && d.promptFeedback.blockReason) || cand.finishReason;
      warning = blocked ? `응답 없음 (${blocked})` : "응답 본문이 비어 있음";
    } else if (cand.finishReason === "MAX_TOKENS") {
      warning = "길이 한도로 문장이 잘렸습니다";
    }
  } else if (leader.provider === "cohere") {
    const d = r.json || {};
    const msg = d.message || {};
    if (Array.isArray(msg.content)) {
      text = msg.content.map((c: Dict) => String(c.text || "")).join("").trim();
    } else if (typeof msg.content === "string") {
      text = msg.content.trim();
    }
    if (!text && d.text) text = String(d.text).trim();
    if (!text) warning = "응답 본문이 비어 있음";
    else if (d.finish_reason === "MAX_TOKENS") warning = "길이 한도로 문장이 잘렸습니다";
  } else {
    const d = r.json || {};
    const choice = (d.choices || [])[0] || {};
    const content = (choice.message && choice.message.content) || "";
    text = (typeof content === "string" ? content : "").trim();
    if (!text) warning = "응답 본문이 비어 있음";
    else if (choice.finish_reason === "length") warning = "길이 한도로 문장이 잘렸습니다";
  }

  if (!text) {
    return { ...base, ok: false, error: warning || "응답 본문이 비어 있음", errorCode: "empty" };
  }
  return { ...base, ok: true, text: clip(text, MAX_RESULT_CHARS), warning };
}

// ────────────────────────────── 요청 처리 ──────────────────────────────
function rosterPayload() {
  return LEADERS.map((l) => ({
    id: l.id,
    name: l.name,
    emoji: l.emoji,
    role: l.role,
    provider: l.provider,
    model: l.model,
    head: !!l.head,
    secretSet: Boolean((Deno.env.get(l.secret) || "").trim()),
    secret: l.secret,
  }));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    const blocked = originRejected(req);
    if (blocked) return blocked;
    return new Response("ok", { status: 200, headers: corsHeaders(req) });
  }

  const denied = rejectUnauthorized(req);
  if (denied) return denied;

  // GET: 배포·설정 확인용(외부 API 를 부르지 않으므로 한도를 쓰지 않는다)
  if (req.method === "GET") {
    return jsonResponse(req, {
      ok: true,
      function: "run-ai-meeting",
      modes: MODES,
      leaders: rosterPayload(),
      modelTimeoutMs: MODEL_TIMEOUT_MS,
      note: "POST { topic, notes, mode: 'fast'|'full', round, history } 로 라운드 1개를 실행합니다.",
    });
  }

  if (req.method !== "POST") {
    return jsonResponse(req, { ok: false, error: "method_not_allowed", message: "POST 로 호출하세요." }, 405);
  }

  let body: Dict = {};
  try {
    const raw = await req.text();
    if (raw.length > 80_000) {
      return jsonResponse(req, { ok: false, error: "too_large", message: "요청이 너무 큽니다." }, 413);
    }
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return jsonResponse(req, { ok: false, error: "bad_json", message: "JSON 본문을 읽지 못했습니다." }, 400);
  }

  const mode: Mode = body.mode === "full" ? "full" : "fast";
  const meta = MODES[mode];
  const topic = String(body.topic || "").trim().slice(0, MAX_TOPIC);
  const notes = String(body.notes || "").trim().slice(0, MAX_NOTES);
  const round = Math.max(1, Math.min(meta.totalRounds, Number(body.round) || 1));
  const history: Dict[] = Array.isArray(body.history) ? body.history.slice(-(meta.totalRounds - 1)) : [];

  if (!topic) {
    return jsonResponse(req, { ok: false, error: "topic_required", message: "주제/소재를 입력하세요." }, 400);
  }

  const t0 = Date.now();
  const isFinal = round === meta.totalRounds;

  // 병렬 호출 — 한 팀장이 실패·타임아웃해도 전체가 멈추지 않는다
  const settled = await Promise.allSettled(
    LEADERS.map((leader) => {
      const system = systemPrompt(leader);
      const user = userPrompt({ mode, round, leader, topic, notes, history });
      // 마지막 라운드의 헤드는 최종안 형식을 다 써야 하므로 조금 더 준다
      const maxTokens = isFinal ? (leader.head ? 1_600 : 700) : 800;
      return callLeader(leader, system, user, maxTokens);
    }),
  );

  const results: LeaderResult[] = settled.map((s, i) => {
    const leader = LEADERS[i];
    if (s.status === "fulfilled") return s.value;
    return {
      id: leader.id,
      name: leader.name,
      emoji: leader.emoji,
      role: leader.role,
      provider: leader.provider,
      model: leader.model,
      head: !!leader.head,
      ok: false,
      ms: null,
      text: "",
      error: scrubKeys((s.reason && s.reason.message) || s.reason || "알 수 없는 오류"),
      errorCode: "unknown",
    };
  });

  const missing = rosterPayload().filter((l) => !l.secretSet).map((l) => l.secret);
  const okCount = results.filter((r) => r.ok).length;

  // 전부 'Secret 미설정' 으로 실패하면 설정 문제임을 분명히 알린다
  const allMissing = results.every((r) => r.errorCode === "secret_missing");
  if (allMissing) {
    return jsonResponse(
      req,
      {
        ok: false,
        error: "secrets_missing",
        message: `Edge Function Secrets 가 하나도 없습니다: ${missing.join(", ")}`,
        missing,
        results,
      },
      503,
    );
  }

  return jsonResponse(req, {
    ok: okCount > 0,
    mode,
    modeLabel: meta.label,
    round,
    totalRounds: meta.totalRounds,
    roundTitle: meta.titles[round - 1],
    final: isFinal,
    elapsedMs: Date.now() - t0,
    okCount,
    failCount: results.length - okCount,
    missing,
    results,
  });
});
