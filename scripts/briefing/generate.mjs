// Generates the Daily Intelligence Briefing for /lab/briefing/.
// API-key path, kept as a manual backup: run from GitHub Actions (workflow_dispatch in
// .github/workflows/daily-briefing.yml) with ANTHROPIC_API_KEY. The daily edition normally
// comes from a Claude Code routine via publish.mjs (see ROUTINE.md). Writes JSON into lab/briefing/data/; the static page renders it.
// On any failure it exits non-zero without touching existing data, so the last good
// edition stays live.

import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT, SCHEMA_EXAMPLE, todayParts, extractJSON, normalize, sourceStats, writeEdition } from "./lib.mjs";

const MODEL = "claude-sonnet-5-5";
const MAX_CONTINUATIONS = 8;

// ---------- Main ----------
async function main() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
  const { long, iso, generatedAt } = todayParts();
  const client = new Anthropic({ timeout: 15 * 60 * 1000 });

  const messages = [{
    role: "user",
    content: `Generate today's intelligence briefing for ${long}. Search broadly across global news sources — US, European, Asian, Middle Eastern — and compile a comprehensive briefing with 6-8 sections.

Return a JSON object with exactly this shape:
${SCHEMA_EXAMPLE}

Tag variants for [[TAG:variant:label]] are danger, warning, info, and success. Keep tags short (one to four words). Every paragraph needs a "heading". Every section needs "citations": the outlet, title and exact URL of each search result it relies on (copy URLs exactly from the search results). Leave "searches" and "fetched" out; they are recorded automatically. Your final message must be the JSON object only.`,
  }];

  let final;
  const searchLog = new Map(); // tool_use_id -> { query, results }
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };

  for (let turn = 0; turn <= MAX_CONTINUATIONS; turn++) {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 64000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM_PROMPT,
      messages,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 20 }],
    });
    const msg = await stream.finalMessage();

    usage.input_tokens += msg.usage?.input_tokens || 0;
    usage.output_tokens += msg.usage?.output_tokens || 0;
    usage.cache_read_input_tokens += msg.usage?.cache_read_input_tokens || 0;
    for (const block of msg.content) {
      if (block.type === "server_tool_use" && block.name === "web_search") {
        searchLog.set(block.id, { query: String(block.input?.query || ""), results: [] });
      }
      if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
        const entry = searchLog.get(block.tool_use_id) || { query: "(query not recorded)", results: [] };
        for (const r of block.content) if (r?.url) entry.results.push({ title: r.title || "", url: r.url });
        searchLog.set(block.tool_use_id, entry);
      }
    }

    if (msg.stop_reason === "refusal") {
      throw new Error(`Model declined (category: ${msg.stop_details?.category ?? "unknown"})`);
    }
    if (msg.stop_reason === "pause_turn") {
      // Server-side search loop hit its iteration limit; send the turn back to resume.
      messages.push({ role: "assistant", content: msg.content });
      continue;
    }
    final = msg;
    break;
  }
  if (!final) throw new Error(`Still paused after ${MAX_CONTINUATIONS} continuations`);
  if (final.stop_reason === "max_tokens") console.warn("Warning: hit max_tokens; output may be truncated");

  // The briefing is the text written after the last search result.
  const blocks = final.content;
  let lastTool = -1;
  blocks.forEach((b, i) => { if (b.type === "web_search_tool_result" || b.type === "server_tool_use") lastTool = i; });
  let text = blocks.slice(lastTool + 1).filter((b) => b.type === "text").map((b) => b.text).join("");
  if (!text.includes("{")) text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
  if (!text.trim()) throw new Error(`No text in the final response (stop_reason: ${final.stop_reason})`);

  // The search log comes from the API's own tool blocks, not from the model's text.
  const raw = extractJSON(text);
  raw.searches = [...searchLog.values()];
  raw.fetched = [];
  const briefing = normalize(raw, long);
  briefing.meta = { id: iso, generated_at: generatedAt, model: final.model || MODEL, via: "api", ...sourceStats(briefing), usage };

  writeEdition(briefing, iso);
  console.log(`Wrote ${iso}: ${briefing.edition}, ${briefing.sections.length} sections, ${briefing.meta.searches} searches, ${briefing.meta.cited_count} cited sources`);
  console.log(`Usage: ${JSON.stringify(usage)}`);
}

main().catch((err) => {
  if (err instanceof Anthropic.APIError) console.error(`Anthropic API error ${err.status}: ${err.message}`);
  else console.error(err?.stack || String(err));
  process.exit(1);
});
