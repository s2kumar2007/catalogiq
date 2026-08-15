/**
 * lib/gemini.ts
 * Gemini REST API client for CatalogIQ agent routes.
 *
 * Features:
 *  - Primary model with one automatic retry on transient errors (503 / 429)
 *  - Silent fallback to a pinned stable model if primary fails twice
 *  - Immediate failure (no retry) on 400 / 404 — these are bugs, not transients
 *  - Console-level logging of which model served each response
 *  - No SDK dependency — uses native fetch throughout
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GeminiContentPart =
  | { type: "text";  data: string }
  | { type: "image"; data: string }; // base64-encoded bytes (JPEG/PNG/WEBP/HEIC)

// ---------------------------------------------------------------------------
// Model config
// ---------------------------------------------------------------------------

/** Explicit pinned model — avoids intermittent 404s from the "-latest" alias resolver. */
const PRIMARY_MODEL  = "gemini-3.6-flash";

/**
 * Genuinely independent fallback — a different model family so that if the
 * primary has an outage the fallback is unaffected.
 */
const FALLBACK_MODEL = "gemini-flash-lite-latest";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/** Status codes worth retrying — transient infrastructure problems. */
const RETRYABLE_STATUSES = new Set([429, 503]);

/** Status codes that indicate a real bug — retrying won't help. */
const FATAL_STATUSES = new Set([400, 401, 403, 404]);

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/**
 * Strips ```json … ``` (or any ``` … ```) wrappers that Gemini sometimes wraps
 * around JSON responses. Safe to call on plain strings — returns them unchanged.
 *
 * @example
 *   stripCodeFences("```json\n{\"a\":1}\n```") // → '{"a":1}'
 */
export function stripCodeFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json|JSON|ts|typescript|javascript|js)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

/**
 * Convenience helper: strip fences then JSON.parse.
 * Throws a descriptive error if parsing fails.
 */
export function parseJsonResponse<T = unknown>(raw: string): T {
  const cleaned = stripCodeFences(raw);
  try {
    return JSON.parse(cleaned) as T;
  } catch (err) {
    throw new Error(
      `[gemini] Failed to parse JSON response.\nCleaned text: ${cleaned.slice(0, 300)}\nOriginal error: ${err}`
    );
  }
}

// ---------------------------------------------------------------------------
// Internal: single attempt against one model
// ---------------------------------------------------------------------------

interface AttemptResult {
  ok:     boolean;
  status: number;
  text?:  string;   // populated on success
  body?:  string;   // populated on failure (raw error body)
}

async function attemptGemini(
  model:       string,
  apiKey:      string,
  requestBody: object
): Promise<AttemptResult> {
  const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${apiKey}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(requestBody),
    });
  } catch (networkErr) {
    // Network-level failure — treat like a 503
    return { ok: false, status: 503, body: String(networkErr) };
  }

  if (!response.ok) {
    const body = await response.text();
    return { ok: false, status: response.status, body };
  }

  const json = await response.json();
  const text: string | undefined = json?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (typeof text !== "string") {
    return {
      ok:     false,
      status: 200, // HTTP succeeded but shape was wrong — don't retry
      body:   `Unexpected response shape: ${JSON.stringify(json).slice(0, 400)}`,
    };
  }

  return { ok: true, status: 200, text };
}

/** Returns a promise that resolves after `ms` milliseconds. */
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Calls the Gemini generateContent REST API with automatic retry and fallback.
 *
 * Retry strategy:
 *  1. Try PRIMARY_MODEL  ("gemini-3.6-flash")
 *  2. On 429 / 503 → wait 1 s → retry PRIMARY_MODEL
 *  3. On second 429 / 503 → try FALLBACK_MODEL ("gemini-flash-lite-latest") once
 *  4. On 400 / 404 (at any point) → throw immediately (bug, not transient)
 *
 * @param systemPrompt  - System-level instruction for the model.
 * @param userContent   - Plain string or array of GeminiContentPart (text + images).
 * @param apiKey        - Gemini API key. Falls back to GEMINI_API_KEY env var.
 * @param model         - Override the primary model. Defaults to PRIMARY_MODEL.
 * @returns             Raw text string from the model's response.
 * @throws              On non-retryable error, or after all retry+fallback attempts fail.
 */
export async function callGemini(
  systemPrompt: string,
  userContent:  string | GeminiContentPart[],
  apiKey:       string = process.env.GEMINI_API_KEY ?? "",
  model:        string = PRIMARY_MODEL
): Promise<string> {
  if (!apiKey) {
    throw new Error(
      "[gemini] No API key provided. Set GEMINI_API_KEY in .env.local or pass it explicitly."
    );
  }

  const requestBody = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: buildUserParts(userContent) }],
    generationConfig: {
      temperature:     0.2,
      maxOutputTokens: 8192,
    },
  };

  // ── Attempt 1: primary model ──────────────────────────────────────────────
  let result = await attemptGemini(model, apiKey, requestBody);

  if (result.ok) {
    console.log(`[gemini] ✓ served by PRIMARY (${model})`);
    return result.text!;
  }

  // Immediate failure — bug in request, no point retrying
  if (FATAL_STATUSES.has(result.status)) {
    throw new Error(
      `[gemini] Fatal error (HTTP ${result.status}) on model "${model}". ` +
      `This is a configuration issue, not a transient failure.\nBody: ${result.body}`
    );
  }

  if (!RETRYABLE_STATUSES.has(result.status)) {
    // Unexpected status (e.g. bad response shape after 200) — throw directly
    throw new Error(
      `[gemini] Unexpected failure on model "${model}" (HTTP ${result.status}).\nDetail: ${result.body}`
    );
  }

  // ── Attempt 2: retry primary after 1 s (429 / 503) ───────────────────────
  console.warn(
    `[gemini] HTTP ${result.status} on PRIMARY "${model}" — waiting 1 s then retrying…`
  );
  await sleep(1000);

  result = await attemptGemini(model, apiKey, requestBody);

  if (result.ok) {
    console.log(`[gemini] ✓ served by PRIMARY on retry (${model})`);
    return result.text!;
  }

  if (FATAL_STATUSES.has(result.status)) {
    throw new Error(
      `[gemini] Fatal error (HTTP ${result.status}) on retry of "${model}".\nBody: ${result.body}`
    );
  }

  // ── Attempt 3: fallback model ─────────────────────────────────────────────
  console.warn(
    `[gemini] PRIMARY "${model}" failed twice — falling back to "${FALLBACK_MODEL}"…`
  );

  result = await attemptGemini(FALLBACK_MODEL, apiKey, requestBody);

  if (result.ok) {
    console.log(`[gemini] ✓ served by FALLBACK (${FALLBACK_MODEL})`);
    return result.text!;
  }

  // All three attempts exhausted
  throw new Error(
    `[gemini] All attempts failed.\n` +
    `  PRIMARY  "${model}"       → HTTP ${result.status}\n` +
    `  FALLBACK "${FALLBACK_MODEL}" → HTTP ${result.status}: ${result.body}`
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildUserParts(userContent: string | GeminiContentPart[]): object[] {
  if (typeof userContent === "string") {
    return [{ text: userContent }];
  }

  return userContent.map((part) => {
    if (part.type === "text") return { text: part.data };
    const [mimeType, base64Data] = extractMimeAndData(part.data);
    return { inlineData: { mimeType, data: base64Data } };
  });
}

/**
 * Handles both plain base64 strings and data-URL-style strings.
 * Returns [mimeType, base64Bytes].
 */
function extractMimeAndData(data: string): [string, string] {
  const match = data.match(/^data:([^;]+);base64,([\s\S]+)$/);
  if (match) return [match[1], match[2]];
  return ["image/jpeg", data]; // plain base64 — assume JPEG
}
