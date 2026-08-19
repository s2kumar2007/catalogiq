/**
 * scripts/unilog-enrich.js — REPLACED
 *
 * This file has been superseded by scripts/unilog-enrich.ts.
 * The old version produced demo output using a regex-only pipeline
 * (no LLM calls) and contained a ground-truth answer-key lookup
 * (inferCategory exact MPN match) that inflated accuracy metrics.
 *
 * Run the real pipeline instead:
 *   npm run enrich
 *   -- or --
 *   npx ts-node --project tsconfig.scripts.json -r tsconfig-paths/register scripts/unilog-enrich.ts
 */
console.error("\n[ERROR] unilog-enrich.js is no longer the demo/scored pipeline.");
console.error("        The LLM pipeline is in unilog-enrich.ts");
console.error("        Run:  npm run enrich\n");
process.exit(1);
