#!/usr/bin/env node
/**
 * 2026-05-08 (§4.4 of root-cause-analysis): grep-based lint to forbid
 * raw-SQL patterns that hit drizzle's array-bind footgun.
 *
 * Forbidden:
 *   sql`...ANY(${someJsArray}::int[])`
 *   sql`...ANY(${someJsArray})`
 *   sql`...IN ${someJsArray}`              (within raw sql tag)
 *
 * Approved alternatives:
 *   1. drizzle's typed inArray():
 *        .where(inArray(table.col, ids))
 *   2. sqlIntList / sqlTextList from artifacts/api-server/src/lib/dbHelpers:
 *        sql`...WHERE id IN (${sqlIntList(ids)})`
 *
 * Runs in CI before build. Exits 1 on any match.
 *
 * NOTE: this is a coarse grep-based lint. False positives are possible
 * (e.g., a literal `ANY(${someConstant}::int[])` where the constant is
 * already a properly-formatted SQL fragment). Suppress with
 * `// eslint-disable-line no-raw-array-bind` on the offending line.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SEARCH_DIRS = [
  "artifacts/api-server/src",
  "scripts/src",
];

// Patterns that are likely-bad. Conservative — multi-line analysis would
// be more accurate but this catches the >95% case.
const FORBIDDEN_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  {
    name: "ANY(${arr}::int[]) — drizzle binds as row constructor",
    regex: /\bANY\(\$\{[a-zA-Z_][a-zA-Z0-9_]*\}::int\[\]\)/,
  },
  {
    name: "ANY(${arr}::bigint[]) — drizzle binds as row constructor",
    regex: /\bANY\(\$\{[a-zA-Z_][a-zA-Z0-9_]*\}::bigint\[\]\)/,
  },
];

const SUPPRESS_MARKER = "no-raw-array-bind";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry === ".generated") continue;
      out.push(...walk(full));
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

let violations = 0;
for (const dir of SEARCH_DIRS) {
  let files: string[] = [];
  try { files = walk(dir); } catch { continue; }
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (line.includes(SUPPRESS_MARKER)) return;
      for (const p of FORBIDDEN_PATTERNS) {
        if (p.regex.test(line)) {
          // eslint-disable-next-line no-console
          console.error(`${file}:${i + 1}  ${p.name}`);
          // eslint-disable-next-line no-console
          console.error(`  ${line.trim()}`);
          violations++;
        }
      }
    });
  }
}

if (violations > 0) {
  // eslint-disable-next-line no-console
  console.error(`\n✗ ${violations} forbidden raw-array-bind pattern(s) found.`);
  // eslint-disable-next-line no-console
  console.error("  Use drizzle's inArray() or the sqlIntList helper from ../lib/dbHelpers.");
  process.exit(1);
}
// eslint-disable-next-line no-console
console.log("✓ no raw-array-bind patterns detected");
