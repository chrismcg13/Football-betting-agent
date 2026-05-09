/**
 * Bundle 9 (2026-05-09) — Wikipedia auto-classifier for stadium roof type.
 *
 * Replaces v2's manual seed list per user's correction: "derive it from
 * data, don't curate it manually."
 *
 * Classifier rules (deterministic, from plan v3 §0.3 — verified on 5 stadium
 * articles in plan mode):
 *   1. Text matches /fully enclosed|closed roof|indoor stadium|domed stadium/
 *      → closed_roof (is_indoor=true)
 *   2. Text matches /retractable roof/ AND /spans the entire|covers the entire
 *      pitch|completely encloses|over the pitch/
 *      → retractable (is_indoor=false default, retractable=true flag for
 *        future refinement — most retractable roofs are open in non-extreme
 *        weather)
 *   3. Text matches /retractable roof/ alone → outdoor + retractable=true
 *   4. Text matches /partial roof|covered stands|covers seats|open-air|open
 *      air/ → outdoor
 *   5. Default (no match / no Wikipedia article) → outdoor (is_indoor=false,
 *      classification_source='unknown') — per plan: less harmful to emit
 *      weather features for an unknown indoor stadium than to miss an outdoor
 *      one
 *
 * Wikipedia API: unauthenticated REST + Action API. Fair-use rate limited at
 * 1 req/sec to avoid getting throttled. The classifier is invoked once per
 * venue at first encounter and cached forever in the venues table.
 */

import { logger } from "../lib/logger";

const WIKIPEDIA_USER_AGENT = "FootballBettingAgent/1.0 (research; non-distributed; contact: chris.mcg@hotmail.co.uk)";

export interface ClassificationResult {
  is_indoor: boolean;
  is_retractable: boolean;
  classification_source: "wikipedia_auto" | "unknown" | "manual_override";
  classification_text: string | null;
  wikipedia_url: string | null;
}

const RULE1 = /fully\s+enclosed|closed\s+roof|indoor\s+stadium|domed\s+stadium/i;
const RULE2_RETRACTABLE = /retractable\s+roof/i;
const RULE2_FULL_COVER = /spans?\s+the\s+entire|covers?\s+the\s+entire\s+pitch|completely\s+encloses|over\s+the\s+pitch/i;
const RULE4_OUTDOOR_HINTS = /partial\s+roof|covered\s+stands|covers?\s+seats|open[- ]air/i;

export function classifyText(articleText: string): { is_indoor: boolean; is_retractable: boolean; matched: string | null } {
  // Rule 1 — fully closed
  const m1 = articleText.match(RULE1);
  if (m1) return { is_indoor: true, is_retractable: false, matched: m1[0] };

  // Rule 2 — retractable + full coverage → still default outdoor (most are open in mild weather) but flag retractable
  const m2a = articleText.match(RULE2_RETRACTABLE);
  if (m2a) {
    const m2b = articleText.match(RULE2_FULL_COVER);
    return { is_indoor: false, is_retractable: true, matched: m2b ? `${m2a[0]} + ${m2b[0]}` : m2a[0] };
  }

  // Rule 4 — outdoor hints (partial roof, open-air, etc.)
  const m4 = articleText.match(RULE4_OUTDOOR_HINTS);
  if (m4) return { is_indoor: false, is_retractable: false, matched: m4[0] };

  // Rule 5 — default outdoor
  return { is_indoor: false, is_retractable: false, matched: null };
}

async function wikipediaSearch(query: string): Promise<{ title: string; pageid: number } | null> {
  // Use the Action API to find the best matching article.
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=1&format=json&origin=*`;
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": WIKIPEDIA_USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      logger.warn({ status: resp.status, query }, "Wikipedia search non-200");
      return null;
    }
    const json = (await resp.json()) as { query?: { search?: Array<{ title: string; pageid: number }> } };
    const hit = json.query?.search?.[0];
    return hit ? { title: hit.title, pageid: hit.pageid } : null;
  } catch (err) {
    logger.warn({ err, query }, "Wikipedia search fetch failed");
    return null;
  }
}

async function wikipediaArticleText(title: string): Promise<string | null> {
  // REST API summary first (small payload). If it doesn't carry roof info,
  // fall back to action=parse for the full extract.
  const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  try {
    const resp = await fetch(summaryUrl, {
      headers: { "User-Agent": WIKIPEDIA_USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { extract?: string };
    let text = json.extract ?? "";
    // If the summary doesn't clearly classify, fetch the longer extract.
    if (!RULE1.test(text) && !RULE2_RETRACTABLE.test(text) && !RULE4_OUTDOOR_HINTS.test(text)) {
      const longUrl = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=true&exsectionformat=plain&titles=${encodeURIComponent(title)}&format=json&origin=*`;
      const longResp = await fetch(longUrl, {
        headers: { "User-Agent": WIKIPEDIA_USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (longResp.ok) {
        const longJson = (await longResp.json()) as { query?: { pages?: Record<string, { extract?: string }> } };
        const pages = longJson.query?.pages ?? {};
        const firstPage = Object.values(pages)[0];
        if (firstPage?.extract) text = firstPage.extract;
      }
    }
    return text;
  } catch (err) {
    logger.warn({ err, title }, "Wikipedia article fetch failed");
    return null;
  }
}

let lastWikipediaCallMs = 0;
async function rateLimit(minIntervalMs = 1000): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastWikipediaCallMs;
  if (elapsed < minIntervalMs) await new Promise((r) => setTimeout(r, minIntervalMs - elapsed));
  lastWikipediaCallMs = Date.now();
}

export async function classifyVenueByWikipedia(
  venueName: string,
  country: string | null,
): Promise<ClassificationResult> {
  if (!venueName || venueName.length < 3) {
    return { is_indoor: false, is_retractable: false, classification_source: "unknown", classification_text: null, wikipedia_url: null };
  }

  await rateLimit();

  // First search: venue name + "stadium" + country (if known) for disambiguation.
  const queries = country
    ? [`${venueName} stadium ${country}`, `${venueName} stadium`, venueName]
    : [`${venueName} stadium`, venueName];

  for (const q of queries) {
    const hit = await wikipediaSearch(q);
    if (!hit) continue;
    await rateLimit();
    const text = await wikipediaArticleText(hit.title);
    if (!text) continue;

    const { is_indoor, is_retractable, matched } = classifyText(text);
    return {
      is_indoor,
      is_retractable,
      classification_source: "wikipedia_auto",
      classification_text: matched,
      wikipedia_url: `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, "_"))}`,
    };
  }

  // No Wikipedia article found — default outdoor with classification_source='unknown'.
  return { is_indoor: false, is_retractable: false, classification_source: "unknown", classification_text: null, wikipedia_url: null };
}
