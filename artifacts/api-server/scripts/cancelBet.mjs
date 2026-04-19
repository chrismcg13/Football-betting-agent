import { cancelOrders } from "../dist/services/betfairLive.js";
const marketId = process.argv[2];
const betId = process.argv[3];
if (!marketId || !betId) { console.error("Usage: node cancelBet.mjs <marketId> <betId>"); process.exit(1); }
const r = await cancelOrders(marketId, [{ betId }]);
console.log(JSON.stringify(r, null, 2));
