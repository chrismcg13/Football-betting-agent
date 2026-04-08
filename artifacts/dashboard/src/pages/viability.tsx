import { useViability } from "@/hooks/use-dashboard";
import { formatCurrency, formatNumber } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export default function Viability() {
  const { data: via, isLoading } = useViability();

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-7xl mx-auto p-6">
        <div className="h-[200px] w-full bg-secondary rounded animate-pulse" />
        <div className="grid grid-cols-3 gap-6">
          <div className="h-[300px] w-full bg-secondary rounded animate-pulse" />
          <div className="h-[300px] w-full bg-secondary rounded animate-pulse" />
          <div className="h-[300px] w-full bg-secondary rounded animate-pulse" />
        </div>
      </div>
    );
  }

  const signalColors = {
    GREEN: "bg-emerald-500/20 text-emerald-500 border-emerald-500/30",
    AMBER: "bg-amber-500/20 text-amber-500 border-amber-500/30",
    RED: "bg-red-500/20 text-red-500 border-red-500/30",
  };

  const signalText = {
    GREEN: "System is commercially viable. Projected returns exceed operational costs.",
    AMBER: "System viability marginal. Optimization required before scaling.",
    RED: "System is not viable. Operating at a projected loss.",
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-col gap-2">
        <h2 className="text-3xl font-bold tracking-tight">System Viability</h2>
        <p className="text-muted-foreground">Commercial projections based on historical paper trading data.</p>
      </div>

      {/* Signal Banner */}
      <div className={cn("p-6 rounded-lg border flex items-start gap-6", signalColors[via?.trafficLightSignal as keyof typeof signalColors])}>
        <div className={cn("w-12 h-12 rounded-full flex items-center justify-center shrink-0 border", signalColors[via?.trafficLightSignal as keyof typeof signalColors])}>
          <div className="w-4 h-4 rounded-full bg-current animate-pulse" />
        </div>
        <div>
          <h3 className="text-xl font-bold uppercase tracking-wider mb-1">Status: {via?.trafficLightSignal}</h3>
          <p className="text-current opacity-90">{signalText[via?.trafficLightSignal as keyof typeof signalText]}</p>
          <div className="flex gap-6 mt-4 opacity-80 text-sm font-mono">
            <span>Trading Days: {via?.paperTradingDays}</span>
            <span>Settled Bets: {via?.totalSettledBets}</span>
            <span>Avg ROI/Bet: {(via?.avgRoiPerBet * 100).toFixed(2)}%</span>
            <span>System Cost: {formatCurrency(via?.systemCost)}/mo</span>
          </div>
        </div>
      </div>

      {/* Projections */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <ProjectionCard 
          title="Conservative" 
          desc="Assumes 20% degradation in edge and volume"
          profit={via?.projectedMonthlyProfitConservative}
          months={via?.monthsToRecoupConservative}
        />
        <ProjectionCard 
          title="Moderate" 
          desc="Assumes historical averages persist"
          profit={via?.projectedMonthlyProfitModerate}
          months={via?.monthsToRecoupModerate}
          highlight
        />
        <ProjectionCard 
          title="Optimistic" 
          desc="Assumes 10% improvement through compound scaling"
          profit={via?.projectedMonthlyProfitOptimistic}
          months={via?.monthsToRecoupOptimistic}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Bankroll Requirements</CardTitle>
          <CardDescription>Capital required to comfortably absorb variance while hitting targets.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-end justify-between p-6 bg-secondary/50 rounded-lg border border-border">
            <div className="space-y-1">
              <span className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Required Bankroll (2-Mo Recoup)</span>
              <p className="text-sm text-muted-foreground max-w-xl">
                Calculated minimum starting capital needed to achieve ROI targets that cover system costs within 60 days, 
                assuming a standard 1-2% Kelly Criterion staking plan.
              </p>
            </div>
            <div className="text-4xl font-bold font-mono text-primary">
              {formatCurrency(via?.minimumBankrollFor2MonthRecoup)}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ProjectionCard({ title, desc, profit, months, highlight = false }: any) {
  return (
    <Card className={cn(highlight && "border-primary/50 shadow-[0_0_20px_rgba(59,130,246,0.1)]")}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{desc}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Monthly Profit</span>
          <div className="text-3xl font-mono font-bold">{profit != null ? formatCurrency(profit) : '-'}</div>
        </div>
        <div className="space-y-2">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Months to Recoup</span>
          <div className="text-xl font-mono font-medium">{months != null ? formatNumber(months) : '-'} <span className="text-sm font-sans text-muted-foreground">months</span></div>
        </div>
      </CardContent>
    </Card>
  );
}
