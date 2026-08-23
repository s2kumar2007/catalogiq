/**
 * lib/groq.ts
 * Groq API client for CatalogIQ agent routes.
 *
 * Features:
 *  - Primary model with one automatic retry on transient errors (503 / 429)
 *  - Silent fallback to a smaller, always-available Groq model if primary fails
 *  - Immediate failure (no retry) on 400 / 401 / 422 — bugs, not transients
 *  - Console-level logging of which model served each response
 *  - OpenAI-compatible endpoint — no SDK dependency
 */

// ---------------------------------------------------------------------------
// Model config
// ---------------------------------------------------------------------------

/**
 * Primary: LLaMA 3.3 70B — best reasoning quality for validation tasks.
 * Groq's most capable model at time of project start.
 */
const PRIMARY_MODEL  = "openai/gpt-oss-120b";

/**
 * Fallback: LLaMA 3.1 8B Instant — always available, extremely fast.
 * Quality is lower but sufficient for validation/reconciliation JSON output.
 */
const FALLBACK_MODEL = "openai/gpt-oss-20b";

const GROQ_API_BASE = "https://api.groq.com/openai/v1/chat/completions";

/** Status codes worth retrying — transient infrastructure problems. */
const RETRYABLE_STATUSES = new Set([429, 503]);

/** Status codes that indicate a real bug — retrying won't help. */
const FATAL_STATUSES = new Set([400, 401, 403, 422]);

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/**
 * Strips ```json … ``` (or any ``` … ```) wrappers that LLMs sometimes wrap
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
      `[groq] Failed to parse JSON response.\nCleaned text: ${cleaned.slice(0, 300)}\nOriginal error: ${err}`
    );
  }
}

// ---------------------------------------------------------------------------
// Internal: single attempt against one model
// ---------------------------------------------------------------------------

interface AttemptResult {
  ok:     boolean;
  status: number;
  text?:  string;  // populated on success
  body?:  string;  // populated on failure (raw error body)
}

async function attemptGroq(
  model:       string,
  apiKey:      string,
  systemPrompt: string,
  userContent:  string,
  maxTokens:    number
): Promise<AttemptResult> {
  const requestBody = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userContent  },
    ],
    temperature: 0.2,
    max_tokens:  maxTokens,
  };

  let response: Response;
  try {
    response = await fetch(GROQ_API_BASE, {
      method:  "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization:  `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
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

  // OpenAI-compatible response shape
  const text: string | undefined = json?.choices?.[0]?.message?.content;

  if (typeof text !== "string") {
    return {
      ok:     false,
      status: 200,
      body:   `Unexpected response shape: ${JSON.stringify(json).slice(0, 400)}`,
    };
  }

  return { ok: true, status: 200, text };
}

/** Returns a promise that resolves after `ms` milliseconds. */
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

function retryDelayMs(body?: string): number {
  if (!body) return 1000;
  const match = body.match(/try again in ([\d.]+)\s*(ms|s)/i);
  if (!match) return 1000;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return 1000;
  const multiplier = match[2].toLowerCase() === "s" ? 1000 : 1;
  return Math.min(30000, Math.max(1000, Math.ceil(value * multiplier) + 500));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let lastCallTimestamp = 0;
const MIN_CALL_SPACING_MS = 2500; // tune based on actual TPM budget / call size

async function enforceMinSpacing() {
  const now = Date.now();
  const elapsed = now - lastCallTimestamp;
  if (elapsed < MIN_CALL_SPACING_MS) {
    await new Promise((r) => setTimeout(r, MIN_CALL_SPACING_MS - elapsed));
  }
  lastCallTimestamp = Date.now();
}

/**
 * Calls the Groq chat completions endpoint with automatic retry and fallback.
 *
 * Retry strategy:
 *  1. Try PRIMARY_MODEL  ("llama-3.3-70b-versatile")
 *  2. On 429 / 503 → wait 1 s → retry PRIMARY_MODEL
 *  3. On second 429 / 503 → try FALLBACK_MODEL ("llama-3.1-8b-instant") once
 *  4. On 400 / 401 / 422 (at any point) → throw immediately (bug, not transient)
 *
 * @param systemPrompt  - System-level instruction for the model.
 * @param userContent   - The user's message (plain text).
 * @param apiKey        - Groq API key. Falls back to GROQ_API_KEY env var.
 * @param model         - Override the primary model. Defaults to PRIMARY_MODEL.
 * @returns             Raw text string from the model's response.
 * @throws              On non-retryable error, or after all retry+fallback attempts fail.
 */
export async function callGroq(
  systemPrompt: string,
  userContent:  string,
  apiKey:       string = process.env.GROQ_API_KEY ?? "",
  model:        string = PRIMARY_MODEL,
  maxTokens:    number = 1024
): Promise<string> {
  await enforceMinSpacing();

  if (!apiKey) {
    throw new Error(
      "[groq] No API key provided. Set GROQ_API_KEY in .env.local or pass it explicitly."
    );
  }

  // ── Attempt 1: primary model ──────────────────────────────────────────────
  let result = await attemptGroq(model, apiKey, systemPrompt, userContent, maxTokens);

  if (result.ok) {
    console.log(`[groq] ✓ served by PRIMARY (${model})`);
    return result.text!;
  }

  if (result.status === 413) {
    throw new Error("Validation skipped - data payload exceeded provider limits");
  }

  // Immediate failure — bug in request, no point retrying
  if (FATAL_STATUSES.has(result.status)) {
    throw new Error(
      `[groq] Fatal error (HTTP ${result.status}) on model "${model}". ` +
      `This is a configuration issue, not a transient failure.\nBody: ${result.body}`
    );
  }

  if (!RETRYABLE_STATUSES.has(result.status)) {
    throw new Error(
      `[groq] Unexpected failure on model "${model}" (HTTP ${result.status}).\nDetail: ${result.body}`
    );
  }

  // ── Attempt 2: retry primary after provider-guided wait (429 / 503) ───────
  const primaryDelay = retryDelayMs(result.body);
  console.warn(
    `[groq] HTTP ${result.status} on PRIMARY "${model}" — waiting ${Math.round(primaryDelay / 1000)}s then retrying…`
  );
  await sleep(primaryDelay);

  result = await attemptGroq(model, apiKey, systemPrompt, userContent, maxTokens);

  if (result.ok) {
    console.log(`[groq] ✓ served by PRIMARY on retry (${model})`);
    return result.text!;
  }

  if (FATAL_STATUSES.has(result.status)) {
    throw new Error(
      `[groq] Fatal error (HTTP ${result.status}) on retry of "${model}".\nBody: ${result.body}`
    );
  }

  // ── Attempt 3: fallback model ─────────────────────────────────────────────
  console.warn(
    `[groq] PRIMARY "${model}" failed twice — falling back to "${FALLBACK_MODEL}"…`
  );

  result = await attemptGroq(FALLBACK_MODEL, apiKey, systemPrompt, userContent, maxTokens);

  if (result.ok) {
    console.log(`[groq] ✓ served by FALLBACK (${FALLBACK_MODEL})`);
    return result.text!;
  }

  if (RETRYABLE_STATUSES.has(result.status)) {
    const fallbackDelay = retryDelayMs(result.body);
    console.warn(
      `[groq] HTTP ${result.status} on FALLBACK "${FALLBACK_MODEL}" — waiting ${Math.round(fallbackDelay / 1000)}s then retrying…`
    );
    await sleep(fallbackDelay);
    result = await attemptGroq(FALLBACK_MODEL, apiKey, systemPrompt, userContent, maxTokens);
    if (result.ok) {
      console.log(`[groq] ✓ served by FALLBACK on retry (${FALLBACK_MODEL})`);
      return result.text!;
    }
  }

  // All three attempts exhausted
  throw new Error(
    `[groq] All attempts failed.\n` +
    `  PRIMARY  "${model}"       → HTTP ${result.status}\n` +
    `  FALLBACK "${FALLBACK_MODEL}" → HTTP ${result.status}: ${result.body}`
  );
}
