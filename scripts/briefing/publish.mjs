// Validates a briefing JSON written by the Claude Code routine and publishes it into
// lab/briefing/data/ (which /lab/briefing/sources/ renders). No dependencies; see ROUTINE.md.
//
//   node scripts/briefing/publish.mjs <raw.json> [--model NAME]
//
// The raw JSON must include the full search log ("searches"), any opened pages ("fetched"),
// and per-section "citations" whose URLs all appear in that log. Counts are computed here.
// Exits non-zero (and writes nothing) if the briefing doesn't pass validation.

import fs from "node:fs";
import { todayParts, extractJSON, normalize, sourceStats, writeEdition } from "./lib.mjs";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

try {
  const file = process.argv[2];
  if (!file || file.startsWith("--")) throw new Error("Usage: publish.mjs <raw.json> [--model NAME]");
  const { long, iso, generatedAt } = todayParts();
  const briefing = normalize(extractJSON(fs.readFileSync(file, "utf8")), long);
  briefing.meta = { id: iso, generated_at: generatedAt, model: arg("model") || "claude", via: "claude-code-routine", ...sourceStats(briefing) };
  writeEdition(briefing, iso);
  const m = briefing.meta;
  console.log(`Published ${iso}: ${briefing.edition}, ${briefing.sections.length} sections; ${m.cited_count} cited sources, ${m.searches} searches, ${m.results_count} links logged`);
  console.log(`Sources page: https://stefanfriend.com/lab/briefing/sources/?d=${iso}`);
} catch (err) {
  console.error(`Not published: ${err.message}`);
  process.exit(1);
}
