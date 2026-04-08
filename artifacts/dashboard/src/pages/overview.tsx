import { useSummary, useBets, useNarratives } from "@/hooks/use-dashboard";
import { formatCurrency, formatPercent, formatNumber, formatDate } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

export default function Overview() {
  const { data: summary, isLoading: loadingSummary } = useSummary();
  const { data: betsData, isLoading: loadingBets } = useBets(1, 10, "all");
  const { data: narrativesData, isLoading: loadingNarratives } = useNarratives();

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-col gap-2">
        <h2 className="text-3xl font-bold tracking-tight">Overview</h2>
        <p className="text-muted-foreground">Mission control for the paper trading agent.</p>
      </div>

      {/* Headline Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard 
          title="Total P&L" 
          value={summary?.totalPnl} 
          formatter={formatCurrency} 
          trend={summary?.totalPnlPct} 
          trendFormatter={v => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`}
          loading={loadingSummary} 
        />
        <MetricCard 
          title="Win Rate" 
          value={summary?.winPercentage} 
          formatter={v => `${v.toFixed(1)}%`} 
          loading={loadingSummary} 
        />
        <MetricCard 
          title="Total Bets" 
          value={summary?.totalBets} 
          formatter={formatNumber} 
          loading={loadingSummary} 
        />
        <MetricCard 
          title="Active Bets" 
          value={summary?.activeBetsCount} 
          formatter={formatNumber} 
          loading={loadingSummary} 
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Recent Bets */}
        <Card className="lg:col-span-2 flex flex-col min-h-[400px]">
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
          </CardHeader>
          <CardContent className="flex-1 p-0">
            {loadingBets ? (
              <div className="p-6 space-y-4">
                {[...Array(5)].map((_, i) => (
                  <div key={i} className="h-12 bg-secondary rounded animate-pulse" />
                ))}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Match</TableHead>
                    <TableHead>Selection</TableHead>
                    <TableHead>Odds</TableHead>
                    <TableHead>Stake</TableHead>
                    <TableHead className="text-right">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {betsData?.bets?.map((bet: any) => (
                    <TableRow key={bet.id}>
                      <TableCell className="font-medium">
                        <div className="flex flex-col">
                          <span>{bet.homeTeam} vs {bet.awayTeam}</span>
                          <span className="text-xs text-muted-foreground">{bet.league}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <span>{bet.selectionName}</span>
                          <span className="text-xs text-muted-foreground">{bet.marketType}</span>
                        </div>
                      </TableCell>
                      <TableCell className="font-mono">{bet.oddsAtPlacement.toFixed(2)}</TableCell>
                      <TableCell className="font-mono">{formatCurrency(bet.stake)}</TableCell>
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

        {/* Narratives Feed */}
        <Card className="flex flex-col min-h-[400px]">
          <CardHeader>
            <CardTitle>Agent Narratives</CardTitle>
          </CardHeader>
          <CardContent className="flex-1 p-0 relative">
            <ScrollArea className="h-[400px]">
              {loadingNarratives ? (
                <div className="p-6 space-y-4">
                  {[...Array(4)].map((_, i) => (
                    <div key={i} className="h-24 bg-secondary rounded animate-pulse" />
                  ))}
                </div>
              ) : (
                <div className="p-6 space-y-6">
                  {narrativesData?.narratives?.slice(0, 10).map((narrative: any) => (
                    <div key={narrative.id} className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Badge variant="outline" className="text-xs font-mono">{narrative.narrativeType}</Badge>
                        <span className="text-xs text-muted-foreground">{formatDate(narrative.createdAt)}</span>
                      </div>
                      <h4 className="text-sm font-semibold">{narrative.title}</h4>
                      <p className="text-sm text-muted-foreground">{narrative.body}</p>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function MetricCard({ title, value, formatter, trend, trendFormatter, loading }: any) {
  return (
    <Card>
      <CardContent className="p-6 flex flex-col justify-between h-full space-y-4">
        <span className="text-sm font-medium text-muted-foreground uppercase tracking-wider">{title}</span>
        {loading ? (
          <div className="h-8 w-24 bg-secondary rounded animate-pulse" />
        ) : (
          <div className="flex items-end justify-between">
            <span className="text-3xl font-bold font-mono">{value != null ? formatter(value) : '-'}</span>
            {trend != null && (
              <span className={cn("text-sm font-medium", trend >= 0 ? "text-emerald-500" : "text-red-500")}>
                {trendFormatter ? trendFormatter(trend) : trend}
              </span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function BetStatusBadge({ status }: { status: string }) {
  if (status === 'won') return <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20 hover:bg-emerald-500/20">Won</Badge>;
  if (status === 'lost') return <Badge className="bg-red-500/10 text-red-500 border-red-500/20 hover:bg-red-500/20">Lost</Badge>;
  if (status === 'pending') return <Badge className="bg-blue-500/10 text-blue-500 border-blue-500/20 hover:bg-blue-500/20">Pending</Badge>;
  if (status === 'void') return <Badge className="bg-slate-500/10 text-slate-400 border-slate-500/20 hover:bg-slate-500/20">Void</Badge>;
  return <Badge variant="outline">{status}</Badge>;
}
