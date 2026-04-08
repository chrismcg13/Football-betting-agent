import { Fragment, useState, useMemo } from "react";
import { useBets, useBetsByLeague, useBetsByMarket } from "@/hooks/use-dashboard";
import { formatCurrency, formatDate } from "@/lib/format";
import { BetStatusBadge } from "@/pages/overview";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronLeft, ChevronRight, ChevronDown, ChevronUp } from "lucide-react";

function ExpandedReasoning({ bet }: { bet: any }) {
  const modelProb = bet.modelProbability != null ? (bet.modelProbability * 100).toFixed(1) : "N/A";
  const impliedProb = bet.betfairImpliedProbability != null ? (bet.betfairImpliedProbability * 100).toFixed(1) : "N/A";
  const edge = bet.calculatedEdge != null ? (bet.calculatedEdge * 100).toFixed(1) : "N/A";
  const stake = bet.stake != null ? formatCurrency(bet.stake) : "N/A";
  const version = bet.modelVersion ?? "unknown";

  return (
    <TableRow className="bg-slate-800/50 border-0">
      <TableCell colSpan={11} className="py-3 px-6">
        <div className="text-sm text-slate-300 font-mono bg-slate-900/60 rounded-md px-4 py-3 border border-slate-700">
          <span className="text-slate-400">Reasoning: </span>
          Model estimated{" "}
          <span className="text-blue-400 font-semibold">{modelProb}%</span>{" "}
          probability vs Betfair implied{" "}
          <span className="text-amber-400 font-semibold">{impliedProb}%</span>.
          Calculated edge:{" "}
          <span className="text-emerald-400 font-semibold">{edge}%</span>.
          Kelly stake:{" "}
          <span className="text-slate-100 font-semibold">{stake}</span>.
          Model version:{" "}
          <span className="text-slate-400">{version}</span>.
        </div>
      </TableCell>
    </TableRow>
  );
}

function rowClass(status: string) {
  if (status === "won") return "bg-emerald-950/30 hover:bg-emerald-950/50";
  if (status === "lost") return "bg-red-950/30 hover:bg-red-950/50";
  if (status === "pending") return "bg-amber-950/20 hover:bg-amber-950/40";
  return "hover:bg-slate-800/40";
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

  const leagues = useMemo(() => {
    if (!byLeague) return [];
    return (byLeague as any[]).map((l: any) => l.league).sort();
  }, [byLeague]);

  const markets = useMemo(() => {
    if (!byMarket) return [];
    return (byMarket as any[]).map((m: any) => m.marketType).sort();
  }, [byMarket]);

  const filteredBets = useMemo(() => {
    if (!betsData?.bets) return [];
    return betsData.bets.filter((b: any) => {
      if (leagueFilter !== "all" && b.league !== leagueFilter) return false;
      if (marketFilter !== "all" && b.marketType !== marketFilter) return false;
      return true;
    });
  }, [betsData, leagueFilter, marketFilter]);

  function handleStatusChange(v: string) {
    setStatusFilter(v);
    setPage(1);
    setExpandedId(null);
  }

  function handleLeagueChange(v: string) {
    setLeagueFilter(v);
    setPage(1);
    setExpandedId(null);
  }

  function handleMarketChange(v: string) {
    setMarketFilter(v);
    setPage(1);
    setExpandedId(null);
  }

  function toggleExpand(id: string) {
    setExpandedId(prev => prev === id ? null : id);
  }

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-col gap-2">
        <h2 className="text-3xl font-bold tracking-tight">Bet History</h2>
        <p className="text-muted-foreground">Full log of all agent placements with reasoning.</p>
      </div>

      {/* Filter Bar */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap gap-3 items-center">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Status</span>
              <Select value={statusFilter} onValueChange={handleStatusChange}>
                <SelectTrigger className="w-[140px] h-8 text-sm" data-testid="select-status-filter">
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
              <span className="text-xs text-muted-foreground uppercase tracking-wider font-medium">League</span>
              <Select value={leagueFilter} onValueChange={handleLeagueChange}>
                <SelectTrigger className="w-[170px] h-8 text-sm" data-testid="select-league-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Leagues</SelectItem>
                  {leagues.map((l: string) => (
                    <SelectItem key={l} value={l}>{l}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Market</span>
              <Select value={marketFilter} onValueChange={handleMarketChange}>
                <SelectTrigger className="w-[170px] h-8 text-sm" data-testid="select-market-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Markets</SelectItem>
                  {markets.map((m: string) => (
                    <SelectItem key={m} value={m}>{m}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {(statusFilter !== "all" || leagueFilter !== "all" || marketFilter !== "all") && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-xs text-muted-foreground"
                onClick={() => { setStatusFilter("all"); setLeagueFilter("all"); setMarketFilter("all"); setPage(1); }}
                data-testid="btn-clear-filters"
              >
                Clear filters
              </Button>
            )}

            <div className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
              <span className="text-xs">
                {isLoading ? "—" : `${filteredBets.length} of ${betsData?.total ?? 0} bets`}
              </span>
              <span className="text-xs">· Page {betsData?.page ?? 1} of {betsData?.totalPages ?? 1}</span>
              <div className="flex gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-7 w-7"
                  disabled={page <= 1}
                  onClick={() => { setPage(p => p - 1); setExpandedId(null); }}
                  data-testid="btn-prev-page"
                >
                  <ChevronLeft className="h-3 w-3" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-7 w-7"
                  disabled={page >= (betsData?.totalPages ?? 1)}
                  onClick={() => { setPage(p => p + 1); setExpandedId(null); }}
                  data-testid="btn-next-page"
                >
                  <ChevronRight className="h-3 w-3" />
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Main Table */}
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {[...Array(10)].map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : filteredBets.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground text-sm">
              No bets match the current filters.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-b border-slate-700">
                  <TableHead className="w-8" />
                  <TableHead className="text-xs uppercase tracking-wider">Date</TableHead>
                  <TableHead className="text-xs uppercase tracking-wider">Match</TableHead>
                  <TableHead className="text-xs uppercase tracking-wider">League</TableHead>
                  <TableHead className="text-xs uppercase tracking-wider">Market</TableHead>
                  <TableHead className="text-xs uppercase tracking-wider">Selection</TableHead>
                  <TableHead className="text-xs uppercase tracking-wider text-right">Odds</TableHead>
                  <TableHead className="text-xs uppercase tracking-wider text-right">Stake</TableHead>
                  <TableHead className="text-xs uppercase tracking-wider text-right">Edge %</TableHead>
                  <TableHead className="text-xs uppercase tracking-wider text-right">Model Prob</TableHead>
                  <TableHead className="text-xs uppercase tracking-wider text-right">Status</TableHead>
                  <TableHead className="text-xs uppercase tracking-wider text-right">P&L</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredBets.map((bet: any) => (
                  <Fragment key={bet.id}>
                    <TableRow
                      className={`cursor-pointer transition-colors ${rowClass(bet.status)} ${expandedId === bet.id ? "border-b-0" : ""}`}
                      onClick={() => toggleExpand(bet.id)}
                      data-testid={`row-bet-${bet.id}`}
                    >
                      <TableCell className="py-3 pl-3 pr-0 w-8">
                        {expandedId === bet.id
                          ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                          : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                        }
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap py-3">
                        {formatDate(bet.placedAt)}
                      </TableCell>
                      <TableCell className="font-medium text-sm whitespace-nowrap py-3">
                        {bet.homeTeam} vs {bet.awayTeam}
                        {bet.homeScore != null && bet.awayScore != null && (
                          <span className="ml-2 text-xs text-muted-foreground font-mono">
                            {bet.homeScore}–{bet.awayScore}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground py-3">{bet.league}</TableCell>
                      <TableCell className="text-xs py-3">
                        <span className="font-mono bg-slate-800 px-1.5 py-0.5 rounded text-slate-300">
                          {bet.marketType}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm py-3">{bet.selectionName}</TableCell>
                      <TableCell className="text-right font-mono text-sm py-3">{bet.oddsAtPlacement.toFixed(2)}</TableCell>
                      <TableCell className="text-right font-mono text-sm py-3">{formatCurrency(bet.stake)}</TableCell>
                      <TableCell className="text-right font-mono text-sm py-3">
                        {bet.calculatedEdge != null
                          ? <span className={bet.calculatedEdge >= 0 ? "text-emerald-400" : "text-red-400"}>
                              {(bet.calculatedEdge * 100).toFixed(1)}%
                            </span>
                          : <span className="text-muted-foreground">—</span>
                        }
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm py-3">
                        {bet.modelProbability != null
                          ? <span className="text-blue-400">{(bet.modelProbability * 100).toFixed(1)}%</span>
                          : <span className="text-muted-foreground">—</span>
                        }
                      </TableCell>
                      <TableCell className="text-right py-3">
                        <BetStatusBadge status={bet.status} />
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm py-3">
                        {bet.settlementPnl != null ? (
                          <span className={bet.settlementPnl >= 0 ? "text-emerald-400 font-semibold" : "text-red-400 font-semibold"}>
                            {bet.settlementPnl >= 0 ? "+" : ""}{formatCurrency(bet.settlementPnl)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                    {expandedId === bet.id && (
                      <ExpandedReasoning key={`${bet.id}-expanded`} bet={bet} />
                    )}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>

        {/* Bottom pagination */}
        {!isLoading && filteredBets.length > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-border">
            <span className="text-xs text-muted-foreground">
              {betsData?.total ?? 0} total bets{leagueFilter !== "all" || marketFilter !== "all" ? " (page filtered)" : ""}
            </span>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                Page {betsData?.page ?? 1} of {betsData?.totalPages ?? 1}
              </span>
              <div className="flex gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-7 w-7"
                  disabled={page <= 1}
                  onClick={() => { setPage(p => p - 1); setExpandedId(null); }}
                >
                  <ChevronLeft className="h-3 w-3" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-7 w-7"
                  disabled={page >= (betsData?.totalPages ?? 1)}
                  onClick={() => { setPage(p => p + 1); setExpandedId(null); }}
                >
                  <ChevronRight className="h-3 w-3" />
                </Button>
              </div>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
