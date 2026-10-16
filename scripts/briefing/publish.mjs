// Validates a briefing JSON written by the Claude Code routine and publishes it into
// lab/briefing/data/. No dependencies; see ROUTINE.md for how the routine uses it.
//
//   node scripts/briefing/publish.mjs <raw.json> --searches 18 --sources 64 [--model NAME]
//
// Exits non-zero (and writes nothing) if the briefing doesn't pass validation.

import fs from "node:fs";
import { todayParts, extractJSON, normalize, writeEdition } from "./lib.mjs";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

try {
  const file = process.argv[2];
  if (!file || file.startsWith("--")) throw new Error("Usage: publish.mjs <raw.json> --searches N --sources N [--model NAME]");
  const { long, iso, generatedAt } = todayParts();
  const briefing = normalize(extractJSON(fs.readFileSync(file, "utf8")), long);
  const count = (v) => (Number.isFinite(+v) && +v >= 0 ? Math.round(+v) : 0);
  briefing.meta = {
    id: iso,
    generated_at: generatedAt,
    model: arg("model") || "claude",
    via: "claude-code-routine",
    searches: count(arg("searches")),
    source_count: count(arg("sources")),
  };
  writeEdition(briefing, iso);
  console.log(`Published ${iso}: ${briefing.edition}, ${briefing.sections.length} sections, ${briefing.tldr_bullets.length} TL;DR bullets`);
} catch (err) {
  console.error(`Not published: ${err.message}`);
  process.exit(1);
}
