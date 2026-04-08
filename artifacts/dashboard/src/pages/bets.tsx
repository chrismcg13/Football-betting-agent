import { Fragment, useState, useMemo } from "react";
import { useBets, useBetsByLeague, useBetsByMarket } from "@/hooks/use-dashboard";
import { formatCurrency, formatRelativeTime } from "@/lib/format";
import { BetStatusBadge } from "@/components/layout";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";

function ExpandedReasoning({ bet }: { bet: any }) {
  const modelProb = bet.modelProbability != null ? (bet.modelProbability * 100).toFixed(1) : null;
  const impliedProb = bet.betfairImpliedProbability != null
    ? (bet.betfairImpliedProbability * 100).toFixed(1)
    : null;
  const edge = bet.calculatedEdge != null ? (bet.calculatedEdge * 100).toFixed(1) : null;

  return (
    <tr>
      <td colSpan={11} className="pb-2 px-4">
        <div
          className="rounded-lg border px-5 py-4 text-sm"
          style={{ background: "#0f172a", borderColor: "#334155" }}
        >
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
            Reasoning
          </p>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {modelProb && (
              <span className="text-slate-300">
                Model probability:{" "}
                <span className="text-blue-400 font-semibold font-mono">{modelProb}%</span>
              </span>
            )}
            {impliedProb && (
              <span className="text-slate-300">
                Betfair implied:{" "}
                <span className="text-amber-400 font-semibold font-mono">{impliedProb}%</span>
              </span>
            )}
            {edge && (
              <span className="text-slate-300">
                Calculated edge:{" "}
                <span
                  className={cn(
                    "font-semibold font-mono",
                    Number(edge) >= 0 ? "text-emerald-400" : "text-red-400",
                  )}
                >
                  {edge}%
                </span>
              </span>
            )}
            <span className="text-slate-300">
              Stake: <span className="text-white font-semibold font-mono">{formatCurrency(bet.stake)}</span>
              {" "}(quarter-Kelly)
            </span>
            {bet.modelVersion && (
              <span className="text-slate-500 font-mono text-xs">Model: {bet.modelVersion}</span>
            )}
          </div>
        </div>
      </td>
    </tr>
  );
}

function rowBg(status: string) {
  if (status === "won") return "bg-emerald-950/25 hover:bg-emerald-950/40";
  if (status === "lost") return "bg-red-950/20 hover:bg-red-950/35";
  if (status === "pending") return "bg-amber-950/15 hover:bg-amber-950/30";
  return "hover:bg-slate-800/30";
}

export default function Bets() {
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("all");
  const [leagueFilter, setLeagueFilter] = useState("all");
  const [marketFilter, setMarketFilter] = useState("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data: betsData, isLoading } = useBets(page, 20, statusFilter);
  const { data: byLeague } = useBetsByLeague();
  const { data: byMarket } = useBetsByMarket();

  const leagues = useMemo(
    () => ((byLeague as any[]) ?? []).map((l: any) => l.league).sort(),
    [byLeague],
  );
  const markets = useMemo(
    () => ((byMarket as any[]) ?? []).map((m: any) => m.marketType).sort(),
    [byMarket],
  );

  const filteredBets = useMemo(() => {
    const bets = (betsData?.bets as any[]) ?? [];
    return bets.filter((b: any) => {
      if (leagueFilter !== "all" && b.league !== leagueFilter) return false;
      if (marketFilter !== "all" && b.marketType !== marketFilter) return false;
      return true;
    });
  }, [betsData, leagueFilter, marketFilter]);

  const summaryStats = useMemo(() => {
    const settled = filteredBets.filter((b: any) => b.status === "won" || b.status === "lost");
    const won = settled.filter((b: any) => b.status === "won").length;
    const lost = settled.filter((b: any) => b.status === "lost").length;
    const totalPnl = filteredBets.reduce(
      (acc: number, b: any) => acc + (b.settlementPnl ?? 0),
      0,
    );
    return { won, lost, totalPnl };
  }, [filteredBets]);

  function resetFilters() {
    setStatusFilter("all");
    setLeagueFilter("all");
    setMarketFilter("all");
    setPage(1);
    setExpandedId(null);
  }

  const hasFilters = statusFilter !== "all" || leagueFilter !== "all" || marketFilter !== "all";

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      <div>
        <h2 className="text-2xl font-bold text-white tracking-tight">Bet History</h2>
        <p className="text-sm text-slate-500 mt-1">Full log of all paper bets with AI reasoning.</p>
      </div>

      {/* Filter Bar */}
      <div
        className="rounded-xl border px-4 py-3 flex flex-wrap gap-3 items-center"
        style={{ background: "#1e293b", borderColor: "#334155" }}
      >
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-slate-500 uppercase tracking-wider font-semibold">Status</span>
          <Select
            value={statusFilter}
            onValueChange={(v) => { setStatusFilter(v); setPage(1); setExpandedId(null); }}
          >
            <SelectTrigger className="w-[140px] h-8 text-xs border-slate-700 bg-slate-800/50" data-testid="select-status-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="won">Won</SelectItem>
              <SelectItem value="lost">Lost</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="void">Void</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[11px] text-slate-500 uppercase tracking-wider font-semibold">League</span>
          <Select
            value={leagueFilter}
            onValueChange={(v) => { setLeagueFilter(v); setPage(1); setExpandedId(null); }}
          >
            <SelectTrigger className="w-[160px] h-8 text-xs border-slate-700 bg-slate-800/50" data-testid="select-league-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Leagues</SelectItem>
              {leagues.map((l: string) => <SelectItem key={l} value={l}>{l}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[11px] text-slate-500 uppercase tracking-wider font-semibold">Market</span>
          <Select
            value={marketFilter}
            onValueChange={(v) => { setMarketFilter(v); setPage(1); setExpandedId(null); }}
          >
            <SelectTrigger className="w-[160px] h-8 text-xs border-slate-700 bg-slate-800/50" data-testid="select-market-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Markets</SelectItem>
              {markets.map((m: string) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        {hasFilters && (
          <button
            onClick={resetFilters}
            className="text-xs text-slate-500 hover:text-slate-300 underline underline-offset-2"
            data-testid="btn-clear-filters"
          >
            Clear filters
          </button>
        )}

        <div className="ml-auto flex items-center gap-3">
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7 border-slate-700 bg-slate-800/50"
              disabled={page <= 1}
              onClick={() => { setPage((p) => p - 1); setExpandedId(null); }}
              data-testid="btn-prev-page"
            >
              <ChevronLeft className="h-3 w-3" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7 border-slate-700 bg-slate-800/50"
              disabled={page >= (betsData?.totalPages ?? 1)}
              onClick={() => { setPage((p) => p + 1); setExpandedId(null); }}
              data-testid="btn-next-page"
            >
              <ChevronRight className="h-3 w-3" />
            </Button>
          </div>
        </div>
      </div>

      {/* Summary Bar */}
      {!isLoading && filteredBets.length > 0 && (
        <div
          className="rounded-lg border px-5 py-3 flex flex-wrap items-center gap-4 text-sm"
          style={{ background: "#1e293b", borderColor: "#334155" }}
        >
          <span className="text-slate-400">
            Showing <span className="text-white font-semibold">{filteredBets.length}</span> bets
          </span>
          <span className="text-slate-700">·</span>
          <span className="text-emerald-400 font-semibold">{summaryStats.won} won</span>
          <span className="text-slate-700">·</span>
          <span className="text-red-400 font-semibold">{summaryStats.lost} lost</span>
          <span className="text-slate-700">·</span>
          <span className="text-slate-400">
            Total P&L:{" "}
            <span
              className={cn(
                "font-semibold font-mono",
                summaryStats.totalPnl >= 0 ? "text-emerald-400" : "text-red-400",
              )}
            >
              {summaryStats.totalPnl >= 0 ? "+" : ""}
              {formatCurrency(summaryStats.totalPnl)}
            </span>
          </span>
          <span className="ml-auto text-xs text-slate-600">
            Page {betsData?.page ?? 1} of {betsData?.totalPages ?? 1}
          </span>
        </div>
      )}

      {/* Table */}
      <div
        className="rounded-xl border overflow-hidden"
        style={{ background: "#1e293b", borderColor: "#334155" }}
      >
        {isLoading ? (
          <div className="p-6 space-y-3">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="h-10 rounded animate-pulse" style={{ background: "#0f172a" }} />
            ))}
          </div>
        ) : filteredBets.length === 0 ? (
          <div className="py-16 text-center text-sm text-slate-500">
            No bets match the current filters.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b" style={{ borderColor: "#334155" }}>
                  <th className="w-8 py-3" />
                  <th className="py-3 px-3 text-left text-[11px] uppercase tracking-wider text-slate-500 font-semibold">Date</th>
                  <th className="py-3 px-3 text-left text-[11px] uppercase tracking-wider text-slate-500 font-semibold">Match</th>
                  <th className="py-3 px-3 text-left text-[11px] uppercase tracking-wider text-slate-500 font-semibold">League</th>
                  <th className="py-3 px-3 text-left text-[11px] uppercase tracking-wider text-slate-500 font-semibold">Market</th>
                  <th className="py-3 px-3 text-left text-[11px] uppercase tracking-wider text-slate-500 font-semibold">Selection</th>
                  <th className="py-3 px-3 text-right text-[11px] uppercase tracking-wider text-slate-500 font-semibold">Odds</th>
                  <th className="py-3 px-3 text-right text-[11px] uppercase tracking-wider text-slate-500 font-semibold">Stake</th>
                  <th className="py-3 px-3 text-right text-[11px] uppercase tracking-wider text-slate-500 font-semibold">Edge</th>
                  <th className="py-3 px-3 text-right text-[11px] uppercase tracking-wider text-slate-500 font-semibold">Result</th>
                  <th className="py-3 px-3 text-right text-[11px] uppercase tracking-wider text-slate-500 font-semibold pr-5">P&L</th>
                </tr>
              </thead>
              <tbody>
                {filteredBets.map((bet: any) => (
                  <Fragment key={bet.id}>
                    <tr
                      className={cn(
                        "cursor-pointer border-b transition-colors",
                        rowBg(bet.status),
                        expandedId === bet.id ? "border-b-0" : "",
                      )}
                      style={{ borderColor: "#1e3a5f" }}
                      onClick={() => setExpandedId((p) => (p === bet.id ? null : bet.id))}
                      data-testid={`row-bet-${bet.id}`}
                    >
                      <td className="py-3 pl-4 w-8">
                        {expandedId === bet.id
                          ? <ChevronUp className="h-3.5 w-3.5 text-slate-500" />
                          : <ChevronDown className="h-3.5 w-3.5 text-slate-500" />}
                      </td>
                      <td className="py-3 px-3 text-xs text-slate-500 whitespace-nowrap">
                        {formatRelativeTime(bet.placedAt)}
                      </td>
                      <td className="py-3 px-3 font-medium text-white whitespace-nowrap">
                        {bet.homeTeam} vs {bet.awayTeam}
                        {bet.homeScore != null && bet.awayScore != null && (
                          <span className="ml-2 text-xs text-slate-500 font-mono">
                            {bet.homeScore}–{bet.awayScore}
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-3 text-xs text-slate-400">{bet.league}</td>
                      <td className="py-3 px-3">
                        <span className="text-[11px] font-mono px-1.5 py-0.5 rounded text-slate-300" style={{ background: "#0f172a" }}>
                          {bet.marketType}
                        </span>
                      </td>
                      <td className="py-3 px-3 text-slate-200">{bet.selectionName}</td>
                      <td className="py-3 px-3 text-right font-mono text-slate-200">
                        {bet.oddsAtPlacement.toFixed(2)}
                      </td>
                      <td className="py-3 px-3 text-right font-mono text-slate-200">
                        {formatCurrency(bet.stake)}
                      </td>
                      <td className="py-3 px-3 text-right font-mono">
                        {bet.calculatedEdge != null ? (
                          <span className={bet.calculatedEdge >= 0 ? "text-emerald-400" : "text-red-400"}>
                            {(bet.calculatedEdge * 100).toFixed(1)}%
                          </span>
                        ) : (
                          <span className="text-slate-600">—</span>
                        )}
                      </td>
                      <td className="py-3 px-3 text-right">
                        <BetStatusBadge status={bet.status} />
                      </td>
                      <td className="py-3 px-3 pr-5 text-right font-mono font-semibold">
                        {bet.settlementPnl != null ? (
                          <span className={bet.settlementPnl >= 0 ? "text-emerald-400" : "text-red-400"}>
                            {bet.settlementPnl >= 0 ? "+" : ""}
                            {formatCurrency(bet.settlementPnl)}
                          </span>
                        ) : (
                          <span className="text-slate-600">—</span>
                        )}
                      </td>
                    </tr>
                    {expandedId === bet.id && <ExpandedReasoning bet={bet} />}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!isLoading && filteredBets.length > 0 && (
          <div
            className="flex items-center justify-between px-5 py-3 border-t"
            style={{ borderColor: "#334155" }}
          >
            <span className="text-xs text-slate-600">
              {betsData?.total ?? 0} total bets
            </span>
            <div className="flex gap-1">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1 border-slate-700 bg-slate-800/50"
                disabled={page <= 1}
                onClick={() => { setPage((p) => p - 1); setExpandedId(null); }}
              >
                <ChevronLeft className="h-3 w-3" /> Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1 border-slate-700 bg-slate-800/50"
                disabled={page >= (betsData?.totalPages ?? 1)}
                onClick={() => { setPage((p) => p + 1); setExpandedId(null); }}
              >
                Next <ChevronRight className="h-3 w-3" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
