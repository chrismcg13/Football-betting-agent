/**
 * Raw-shape probe for Betfair ASIAN_HANDICAP markets.
 *
 * Dumps the COMPLETE JSON response from listMarketCatalogue + listMarketBook
 * for one or more event IDs. Every field on every runner, every field on every
 * market. No filtering, no inference — exactly what Betfair returns.
 *
 * Purpose: identify which Betfair fields actually carry the per-runner
 * handicap line for AH markets. Previous probe (probe-betfair-ah.ts) only
 * looked at runners[0].handicap; this dump exposes all fields including any
 * not yet in our TypeScript interface (the underlying HTTP response is
 * unfiltered — JSON.stringify on the result emits everything Betfair sent).
 *
 * Output: JSON array printed to stdout. Pipe to a file if needed.
 *
 * Usage (from repo root, after sourcing .env):
 *   pnpm dlx tsx artifacts/api-server/src/cli/probe-betfair-ah-raw.ts <eventId> [eventId...]
 *
 * Example:
 *   ./scripts/probe-betfair-ah-raw.sh 35600532 35608069 35607176
 */
import { listMarketCatalogue, listMarketBook } from "../services/betfair";

async function main(): Promise<void> {
  const eventIds = process.argv.slice(2);
  if (eventIds.length === 0) {
    console.error("Usage: probe-betfair-ah-raw <eventId> [eventId...]");
    console.error("");
    console.error("Suggested event IDs (kickoff < 8h, AH-bearing):");
    console.error("  35600532  Atletico Torque vs Club Nacional (Uruguay)");
    console.error("  35608069  Patriotas vs Millonarios (Colombia)");
    console.error("  35607176  Real Tomayapo vs Aurora (Bolivia)");
    console.error("  35595513  Libertad vs Deportivo Cuenca (Ecuador)");
    process.exit(1);
  }

  for (const eventId of eventIds) {
    process.stderr.write(`\n=== Event ${eventId} ===\n`);

    let markets: unknown;
    try {
      markets = await listMarketCatalogue([eventId], ["ASIAN_HANDICAP"]);
    } catch (err) {
      console.error(`  listMarketCatalogue failed for ${eventId}: ${String(err)}`);
      continue;
    }

    const marketsArr = Array.isArray(markets) ? (markets as Array<{ marketId: string }>) : [];
    process.stderr.write(`  AH markets returned: ${marketsArr.length}\n`);

    if (marketsArr.length === 0) {
      console.log(JSON.stringify({ eventId, marketCount: 0, markets: [], books: [] }, null, 2));
      continue;
    }

    const marketIds = marketsArr.map((m) => m.marketId);
    let books: unknown = [];
    try {
      books = await listMarketBook(marketIds);
    } catch (err) {
      process.stderr.write(`  listMarketBook failed for ${eventId}: ${String(err)}\n`);
    }

    // Full raw dump. JSON.stringify emits every field on every runner /
    // market — TypeScript types do NOT filter at runtime.
    const dump = {
      eventId,
      marketCount: marketsArr.length,
      catalogue: markets,
      books,
    };
    console.log(JSON.stringify(dump, null, 2));
  }
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
