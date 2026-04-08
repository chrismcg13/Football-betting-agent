import { useState } from "react";
import { useBets, useBetsByLeague, useBetsByMarket } from "@/hooks/use-dashboard";
import { formatCurrency, formatDate } from "@/lib/format";
import { BetStatusBadge } from "@/pages/overview";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";

export default function Bets() {
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("all");

  const { data: betsData, isLoading } = useBets(page, 20, statusFilter);
  const { data: byLeague } = useBetsByLeague();
  const { data: byMarket } = useBetsByMarket();

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-col gap-2">
        <h2 className="text-3xl font-bold tracking-tight">Bet History</h2>
        <p className="text-muted-foreground">Comprehensive log of all agent placements.</p>
      </div>

      {/* Breakdowns */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="py-4">
            <CardTitle className="text-lg">By League</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>League</TableHead>
                  <TableHead className="text-right">Bets</TableHead>
                  <TableHead className="text-right">Win Rate</TableHead>
                  <TableHead className="text-right">ROI</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {byLeague?.map((l: any) => (
                  <TableRow key={l.league}>
                    <TableCell className="font-medium text-sm">{l.league}</TableCell>
                    <TableCell className="text-right font-mono text-sm">{l.count}</TableCell>
                    <TableCell className="text-right font-mono text-sm">{l.winRate.toFixed(1)}%</TableCell>
                    <TableCell className="text-right font-mono text-sm">{l.roi.toFixed(1)}%</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="py-4">
            <CardTitle className="text-lg">By Market</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Market</TableHead>
                  <TableHead className="text-right">Bets</TableHead>
                  <TableHead className="text-right">Win Rate</TableHead>
                  <TableHead className="text-right">ROI</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {byMarket?.map((m: any) => (
                  <TableRow key={m.marketType}>
                    <TableCell className="font-medium text-sm">{m.marketType}</TableCell>
                    <TableCell className="text-right font-mono text-sm">{m.count}</TableCell>
                    <TableCell className="text-right font-mono text-sm">{m.winRate.toFixed(1)}%</TableCell>
                    <TableCell className="text-right font-mono text-sm">{m.roi.toFixed(1)}%</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      {/* Main Table */}
      <Card className="flex flex-col min-h-[600px]">
        <div className="p-4 border-b border-border flex items-center justify-between">
          <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); }}>
            <SelectTrigger className="w-[180px]" data-testid="select-status-filter">
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="won">Won</SelectItem>
              <SelectItem value="lost">Lost</SelectItem>
              <SelectItem value="void">Void</SelectItem>
            </SelectContent>
          </Select>

          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>Page {betsData?.page || 1} of {betsData?.totalPages || 1}</span>
            <div className="flex gap-1">
              <Button 
                variant="outline" 
                size="icon" 
                className="h-8 w-8"
                disabled={page <= 1}
                onClick={() => setPage(p => p - 1)}
                data-testid="btn-prev-page"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button 
                variant="outline" 
                size="icon" 
                className="h-8 w-8"
                disabled={page >= (betsData?.totalPages || 1)}
                onClick={() => setPage(p => p + 1)}
                data-testid="btn-next-page"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
        
        <CardContent className="flex-1 p-0 overflow-x-auto">
          {isLoading ? (
            <div className="p-6 space-y-4">
              {[...Array(10)].map((_, i) => (
                <div key={i} className="h-12 bg-secondary rounded animate-pulse" />
              ))}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Match</TableHead>
                  <TableHead>Selection</TableHead>
                  <TableHead className="text-right">Odds</TableHead>
                  <TableHead className="text-right">Edge</TableHead>
                  <TableHead className="text-right">Stake</TableHead>
                  <TableHead className="text-right">P&L</TableHead>
                  <TableHead className="text-right">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {betsData?.bets?.map((bet: any) => (
                  <TableRow key={bet.id}>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {formatDate(bet.placedAt)}
                    </TableCell>
                    <TableCell className="font-medium whitespace-nowrap">
                      {bet.homeTeam} vs {bet.awayTeam}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col">
                        <span>{bet.selectionName}</span>
                        <span className="text-xs text-muted-foreground">{bet.marketType}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono">{bet.oddsAtPlacement.toFixed(2)}</TableCell>
                    <TableCell className="text-right font-mono text-emerald-500">{(bet.calculatedEdge * 100).toFixed(1)}%</TableCell>
                    <TableCell className="text-right font-mono">{formatCurrency(bet.stake)}</TableCell>
                    <TableCell className="text-right font-mono">
                      {bet.settlementPnl != null ? (
                        <span className={bet.settlementPnl >= 0 ? "text-emerald-500" : "text-red-500"}>
                          {bet.settlementPnl >= 0 ? '+' : ''}{formatCurrency(bet.settlementPnl)}
                        </span>
                      ) : '-'}
                    </TableCell>
                    <TableCell className="text-right">
                      <BetStatusBadge status={bet.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
