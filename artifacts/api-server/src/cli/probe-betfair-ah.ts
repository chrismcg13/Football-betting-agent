/**
 * One-shot probe: for each Betfair eventId arg, list every ASIAN_HANDICAP
 * sub-market and the top-of-book back/lay prices + sizes. Used to verify
 * whether Betfair Exchange offers multiple AH lines per fixture and what
 * liquidity actually exists at the model's expected prices.
 *
 * Usage (from repo root, after build):
 *   node ./artifacts/api-server/dist/cli/probe-betfair-ah.js 35543085 35568242
 */
import { listMarketCatalogue, listMarketBook } from "../services/betfair";

async function main(): Promise<void> {
  const eventIds = process.argv.slice(2);
  if (eventIds.length === 0) {
    console.error("Usage: probe-betfair-ah <eventId> [eventId...]");
    process.exit(1);
  }

  for (const eventId of eventIds) {
    console.log(`\n=== Event ${eventId} ===`);
    const markets = await listMarketCatalogue([eventId], ["ASIAN_HANDICAP"]);
    console.log(`AH markets returned: ${markets.length}`);
    if (markets.length === 0) continue;

    const books = await listMarketBook(markets.map((m) => m.marketId));
    for (const m of markets) {
      const book = books.find((b) => b.marketId === m.marketId);
      const handicap = m.runners?.[0]?.handicap ?? "unknown";
      const totalMatched = book?.totalMatched ?? 0;
      console.log(
        `\n  AH line=${handicap} marketId=${m.marketId} totalMatched=GBP${totalMatched}`,
      );
      const runners = book?.runners ?? [];
      for (const runner of runners) {
        const cat = m.runners?.find((r) => r.selectionId === runner.selectionId);
        const backs = runner.ex?.availableToBack ?? [];
        const lays = runner.ex?.availableToLay ?? [];
        const b1 = backs[0];
        const b2 = backs[1];
        const l1 = lays[0];
        const name = cat?.runnerName ?? `id=${runner.selectionId}`;
        const fmt = (p: { price: number; size: number } | undefined): string =>
          p ? `${p.price} (GBP${p.size})` : "-";
        console.log(
          `    ${name}: BACK ${fmt(b1)} | next ${fmt(b2)} | LAY ${fmt(l1)}`,
        );
      }
    }
  }
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
