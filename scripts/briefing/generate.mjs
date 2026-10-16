// Generates the Daily Intelligence Briefing for /lab/briefing/.
// Runs in GitHub Actions (see .github/workflows/daily-briefing.yml) with ANTHROPIC_API_KEY
// from repo secrets. Writes JSON into lab/briefing/data/; the static page renders it.
// On any failure it exits non-zero without touching existing data, so the last good
// edition stays live.

import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(here, "../../lab/briefing/data");
const EDITIONS_DIR = path.join(DATA_DIR, "editions");
const KEEP_EDITIONS = 60;
const TZ = "America/New_York";
const MODEL = "claude-sonnet-5-5";
const MAX_CONTINUATIONS = 8;

const SYSTEM_PROMPT = `You are a daily intelligence analyst. Search today's news across US, European, Asian, and Middle Eastern sources. Aim for at least 60 sources. Cover: the dominant global crisis, markets/economy, US politics, diplomacy, and a global roundup. Set the edition field to a short contextual label that reflects the dominant news theme of the day — examples: "WARTIME EDITION", "ELECTION SEASON", "MARKETS IN CRISIS", "MORNING EDITION" — always populate it, never leave it blank. Return ONLY a valid JSON object matching the schema you've been given — no markdown, no backticks, no preamble. Use [[TAG:variant:label]] syntax for inline emphasis in paragraph body strings. Lead each section paragraph with a bold heading using the format: bold label followed by body text. Include 6–8 sections. Keep summary fields under 100 characters.`;

const SCHEMA_EXAMPLE = `{
  "date": "Wednesday, March 4, 2026",
  "edition": "WARTIME EDITION",
  "tldr_label": "TL;DR — [one-line theme]",
  "tldr_bullets": [
    { "label": "Bold label", "body": "rest of bullet text" }
  ],
  "sections": [
    {
      "title": "Section Title",
      "icon": "🔥",
      "summary": "One-line collapsed teaser under 100 chars",
      "paragraphs": [
        { "heading": "Bold lead", "body": "Paragraph text. Use [[TAG:danger:text]] syntax for inline tags." }
      ],
      "sources": "AP, Reuters, BBC"
    }
  ]
}`;

function todayParts() {
  const now = new Date();
  const long = now.toLocaleDateString("en-US", { timeZone: TZ, weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const iso = now.toLocaleDateString("en-CA", { timeZone: TZ }); // YYYY-MM-DD
  return { long, iso, generatedAt: now.toISOString() };
}

// ---------- JSON extraction (brace-matched, tolerant of preamble and fences) ----------
function extractJSON(text) {
  const s = text.trim().replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();
  const i0 = s.indexOf("{");
  if (i0 === -1) throw new Error("No JSON object found in the model's final text");
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = i0; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth++;
    if (c === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  let jsonStr;
  if (end === -1) {
    // Truncated: close any open brackets/braces and let validation decide if it's usable.
    let r = s.slice(i0);
    const count = (re) => (r.match(re) || []).length;
    r += "]".repeat(Math.max(0, count(/\[/g) - count(/]/g)));
    r += "}".repeat(Math.max(0, count(/{/g) - count(/}/g)));
    jsonStr = r;
  } else {
    jsonStr = s.slice(i0, end + 1);
  }
  return JSON.parse(jsonStr);
}

// ---------- Validation: keep only known fields, enforce types and sane lengths ----------
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function normalize(raw, dateLong) {
  if (!raw || typeof raw !== "object") throw new Error("Parsed briefing is not an object");
  const sections = (Array.isArray(raw.sections) ? raw.sections : [])
    .map((sec) => ({
      title: str(sec?.title, 120),
      icon: str(sec?.icon, 8),
      summary: str(sec?.summary, 140),
      paragraphs: (Array.isArray(sec?.paragraphs) ? sec.paragraphs : [])
        .map((p) => ({ heading: str(p?.heading, 160), body: str(p?.body, 3000) }))
        .filter((p) => p.body),
      sources: str(sec?.sources, 600),
    }))
    .filter((sec) => sec.title && sec.paragraphs.length);
  if (sections.length < 3) throw new Error(`Only ${sections.length} usable sections in the response`);
  const tldr_bullets = (Array.isArray(raw.tldr_bullets) ? raw.tldr_bullets : [])
    .map((b) => ({ label: str(b?.label, 120), body: str(b?.body, 500) }))
    .filter((b) => b.label || b.body)
    .slice(0, 8);
  return {
    date: dateLong,
    edition: str(raw.edition, 40).toUpperCase() || "MORNING EDITION",
    tldr_label: str(raw.tldr_label, 160) || "TL;DR",
    tldr_bullets,
    sections: sections.slice(0, 10),
  };
}

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

Tag variants for [[TAG:variant:label]] are danger, warning, info, and success. Keep tags short (one to four words). Every paragraph needs a "heading". Your final message must be the JSON object only.`,
  }];

  let final;
  const searchResultUrls = new Set();
  let searches = 0;
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
    searches += msg.usage?.server_tool_use?.web_search_requests || 0;
    for (const block of msg.content) {
      if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
        for (const r of block.content) if (r?.url) searchResultUrls.add(r.url);
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

  const briefing = normalize(extractJSON(text), long);
  briefing.meta = {
    id: iso,
    generated_at: generatedAt,
    model: final.model || MODEL,
    searches,
    source_count: searchResultUrls.size,
    usage,
  };

  // Write edition, latest, and index; prune old editions.
  fs.mkdirSync(EDITIONS_DIR, { recursive: true });
  const json = JSON.stringify(briefing, null, 2) + "\n";
  fs.writeFileSync(path.join(EDITIONS_DIR, `${iso}.json`), json);
  fs.writeFileSync(path.join(DATA_DIR, "latest.json"), json);

  const files = fs.readdirSync(EDITIONS_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
  for (const f of files.slice(KEEP_EDITIONS)) fs.unlinkSync(path.join(EDITIONS_DIR, f));
  const index = files.slice(0, KEEP_EDITIONS).map((f) => {
    const e = JSON.parse(fs.readFileSync(path.join(EDITIONS_DIR, f), "utf8"));
    return { id: f.replace(".json", ""), date: e.date, edition: e.edition };
  });
  fs.writeFileSync(path.join(DATA_DIR, "index.json"), JSON.stringify({ editions: index }, null, 2) + "\n");

  console.log(`Wrote ${iso}: ${briefing.edition}, ${briefing.sections.length} sections, ${searches} searches, ${searchResultUrls.size} sources`);
  console.log(`Usage: ${JSON.stringify(usage)}`);
}

main().catch((err) => {
  if (err instanceof Anthropic.APIError) console.error(`Anthropic API error ${err.status}: ${err.message}`);
  else console.error(err?.stack || String(err));
  process.exit(1);
});
