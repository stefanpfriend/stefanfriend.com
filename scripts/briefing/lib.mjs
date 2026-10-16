// Shared pieces for the Daily Intelligence Briefing: the prompt, the schema,
// JSON extraction, validation, and writing editions into lab/briefing/data/.
// Used by generate.mjs (API path) and publish.mjs (Claude Code routine path).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(here, "../../lab/briefing/data");
const EDITIONS_DIR = path.join(DATA_DIR, "editions");
const KEEP_EDITIONS = 60;
const TZ = "America/New_York";

export const SYSTEM_PROMPT = `You are a daily intelligence analyst. Search today's news across US, European, Asian, and Middle Eastern sources. Aim for at least 60 sources. Cover: the dominant global crisis, markets/economy, US politics, diplomacy, and a global roundup. Set the edition field to a short contextual label that reflects the dominant news theme of the day — examples: "WARTIME EDITION", "ELECTION SEASON", "MARKETS IN CRISIS", "MORNING EDITION" — always populate it, never leave it blank. Return ONLY a valid JSON object matching the schema you've been given — no markdown, no backticks, no preamble. Use [[TAG:variant:label]] syntax for inline emphasis in paragraph body strings. Lead each section paragraph with a bold heading using the format: bold label followed by body text. Include 6–8 sections. Keep summary fields under 100 characters.`;

export const SCHEMA_EXAMPLE = `{
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

export function todayParts() {
  const now = new Date();
  const long = now.toLocaleDateString("en-US", { timeZone: TZ, weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const iso = now.toLocaleDateString("en-CA", { timeZone: TZ }); // YYYY-MM-DD
  return { long, iso, generatedAt: now.toISOString() };
}

// ---------- JSON extraction (brace-matched, tolerant of preamble and fences) ----------
export function extractJSON(text) {
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

export function normalize(raw, dateLong) {
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

// ---------- Writing ----------
// Writes the edition file, latest.json, and index.json; prunes editions past KEEP_EDITIONS.
export function writeEdition(briefing, iso) {
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

}
