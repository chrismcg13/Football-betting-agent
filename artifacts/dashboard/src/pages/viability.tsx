import { useViability, useModel, useBetsByLeague, useBetsByMarket } from "@/hooks/use-dashboard";
import { formatCurrency } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { CheckCircle2, XCircle } from "lucide-react";
import { useMemo } from "react";

// ─── Traffic Light ──────────────────────────────────────────────────────────

const SIGNAL_CONFIG = {
  GREEN: {
    label: "GO — Fund £499",
    explanation:
      "The model is consistently finding value edges. Conservative projections show recoup within 2 months. This system is ready for live capitalisation.",
    pulse: "bg-emerald-400",
    ring: "ring-emerald-500/40",
    glow: "shadow-[0_0_60px_rgba(16,185,129,0.25)]",
    border: "border-emerald-500/30",
    bg: "bg-emerald-950/30",
    text: "text-emerald-400",
    label_text: "text-emerald-300",
  },
  AMBER: {
    label: "EXTEND — More Data Needed",
    explanation:
      "Returns are promising but projections are marginal. Run for another 2–4 weeks to build a statistically robust dataset before committing capital.",
    pulse: "bg-amber-400",
    ring: "ring-amber-500/40",
    glow: "shadow-[0_0_60px_rgba(245,158,11,0.2)]",
    border: "border-amber-500/30",
    bg: "bg-amber-950/20",
    text: "text-amber-400",
    label_text: "text-amber-300",
  },
  RED: {
    label: "DO NOT FUND — Model Needs Improvement",
    explanation:
      "At current ROI the model would not recoup the £499 system cost within a reasonable timeframe. Review feature quality, edge thresholds, and market selection before funding.",
    pulse: "bg-red-400",
    ring: "ring-red-500/40",
    glow: "shadow-[0_0_60px_rgba(239,68,68,0.2)]",
    border: "border-red-500/30",
    bg: "bg-red-950/20",
    text: "text-red-400",
    label_text: "text-red-300",
  },
} as const;

type Signal = keyof typeof SIGNAL_CONFIG;

function TrafficLight({ signal }: { signal: Signal }) {
  const cfg = SIGNAL_CONFIG[signal];
  return (
    <div className={cn("rounded-2xl border p-8 flex flex-col items-center gap-6 text-center", cfg.bg, cfg.border, cfg.glow)}>
      {/* Light */}
      <div className={cn("relative w-28 h-28 rounded-full flex items-center justify-center ring-8", cfg.ring)}>
        <div className={cn("absolute inset-0 rounded-full opacity-20", cfg.pulse)} />
        <div className={cn("w-20 h-20 rounded-full animate-pulse", cfg.pulse)} />
      </div>

      {/* Label */}
      <div className="space-y-2">
        <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
          Signal
        </p>
        <h2 className={cn("text-2xl font-bold tracking-tight", cfg.label_text)}>
          {cfg.label}
        </h2>
      </div>

      {/* Explanation */}
      <p className="text-sm text-slate-300 max-w-xl leading-relaxed">
        {cfg.explanation}
      </p>
    </div>
  );
}

// ─── Projection Card ─────────────────────────────────────────────────────────

function ProjectionCard({
  title,
  desc,
  assumption,
  profit,
  months,
  minBankroll,
  highlight = false,
}: {
  title: string;
  desc: string;
  assumption: string;
  profit: number | null;
  months: number | null;
  minBankroll: number | null;
  highlight?: boolean;
}) {
  const isProfitable = profit != null && profit > 0;
  const isGoodRecoup = months != null && months <= 2;

  return (
    <Card
      className={cn(
        "relative flex flex-col",
        highlight
          ? "border-slate-400/40 bg-slate-800/80 ring-1 ring-slate-400/20"
          : "border-slate-700/50 bg-slate-800/40",
      )}
    >
      {highlight && (
        <div className="absolute -top-px left-6 right-6 h-px bg-gradient-to-r from-transparent via-slate-400/60 to-transparent" />
      )}
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{title}</CardTitle>
          {highlight && (
            <span className="text-[10px] font-mono uppercase tracking-wider bg-slate-700 text-slate-300 px-2 py-0.5 rounded">
              Primary
            </span>
          )}
        </div>
        <CardDescription className="text-xs">{desc}</CardDescription>
        <p className="text-[11px] text-muted-foreground italic">{assumption}</p>
      </CardHeader>
      <CardContent className="space-y-5 flex-1">
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Monthly Profit
          </p>
          <p className={cn("text-3xl font-bold font-mono", isProfitable ? "text-emerald-400" : "text-red-400")}>
            {profit != null ? (isProfitable ? "+" : "") + formatCurrency(profit) : "—"}
          </p>
        </div>
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Months to Recoup £499
          </p>
          <p className={cn("text-xl font-mono font-semibold", isGoodRecoup ? "text-emerald-400" : months != null ? "text-amber-400" : "text-muted-foreground")}>
            {months != null ? `${months.toFixed(1)} mo` : "—"}
          </p>
        </div>
        {minBankroll != null && (
          <div className="space-y-1">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Min Bankroll Needed
            </p>
            <p className="text-base font-mono text-slate-300">
              {formatCurrency(minBankroll)}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Criteria Row ─────────────────────────────────────────────────────────────

function CriteriaRow({
  label,
  value,
  pass,
  note,
}: {
  label: string;
  value: string;
  pass: boolean;
  note?: string;
}) {
  return (
    <tr className="border-b border-slate-700/50 last:border-0 hover:bg-slate-800/30 transition-colors">
      <td className="py-3 pl-4 pr-2 w-8">
        {pass ? (
          <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
        ) : (
          <XCircle className="h-4 w-4 text-red-400 shrink-0" />
        )}
      </td>
      <td className="py-3 text-sm font-medium">{label}</td>
      <td className="py-3 text-right font-mono text-sm pr-4">
        <span className={pass ? "text-emerald-400" : "text-red-400"}>{value}</span>
      </td>
      {note && (
        <td className="py-3 pr-4 text-right text-xs text-muted-foreground">{note}</td>
      )}
    </tr>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Viability() {
  const { data: via, isLoading: viaLoading } = useViability();
  const { data: model } = useModel();
  const { data: byLeague } = useBetsByLeague();
  const { data: byMarket } = useBetsByMarket();

  const accuracyTrend = useMemo(() => {
    const history = model?.accuracyHistory as any[] | undefined;
    if (!history || history.length < 2) return "flat";
    const first = history[0]?.accuracy ?? 0;
    const last = history[history.length - 1]?.accuracy ?? 0;
    const delta = last - first;
    if (delta > 0.02) return "improving";
    if (delta < -0.02) return "declining";
    return "flat";
  }, [model]);

  const edgeDiversity = useMemo(() => {
    const leagues = ((byLeague as any[]) ?? []).filter((l: any) => l.roi > 0).length;
    const markets = ((byMarket as any[]) ?? []).filter((m: any) => m.roi > 0).length;
    return leagues + markets;
  }, [byLeague, byMarket]);

  if (viaLoading) {
    return (
      <div className="space-y-6 max-w-4xl mx-auto">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-96" />
        </div>
        <Skeleton className="h-72 w-full rounded-2xl" />
        <div className="grid grid-cols-3 gap-6">
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
        </div>
        <Skeleton className="h-80 w-full" />
      </div>
    );
  }

  const signal = (via?.trafficLightSignal ?? "RED") as Signal;

  // Supporting criteria
  const days = via?.paperTradingDays ?? 0;
  const bets = via?.totalSettledBets ?? 0;
  const roi = via?.avgRoiPerBet ?? 0;
  const bpw = via?.betsPerWeek ?? 0;
  const stake = via?.avgStake ?? 0;
  const trendPass = accuracyTrend !== "declining";
  const diversityPass = edgeDiversity >= 2;

  const allPass = days >= 14 && bets >= 30 && roi > 0 && bpw >= 3 && stake >= 5 && trendPass && diversityPass;

  return (
    <div className="space-y-8 max-w-4xl mx-auto">
      <div className="flex flex-col gap-2">
        <h2 className="text-3xl font-bold tracking-tight">Viability Assessment</h2>
        <p className="text-muted-foreground">
          Evidence-based decision framework for the £499 system cost.
        </p>
      </div>

      {/* Traffic Light */}
      <TrafficLight signal={signal} />

      {/* Scenario Cards */}
      <div>
        <h3 className="text-sm font-medium uppercase tracking-wider text-muted-foreground mb-4">
          Profit Projections
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <ProjectionCard
            title="Conservative"
            desc="50% of paper ROI"
            assumption="Real-money slippage, lower edge realisation"
            profit={via?.projectedMonthlyProfitConservative ?? null}
            months={via?.monthsToRecoupConservative ?? null}
            minBankroll={via?.minimumBankrollFor2MonthRecoup ?? null}
            highlight
          />
          <ProjectionCard
            title="Moderate"
            desc="75% of paper ROI"
            assumption="Historical averages persist with some friction"
            profit={via?.projectedMonthlyProfitModerate ?? null}
            months={via?.monthsToRecoupModerate ?? null}
            minBankroll={null}
          />
          <ProjectionCard
            title="Optimistic"
            desc="100% of paper ROI"
            assumption="Full edge realisation, compound scaling"
            profit={via?.projectedMonthlyProfitOptimistic ?? null}
            months={via?.monthsToRecoupOptimistic ?? null}
            minBankroll={null}
          />
        </div>
      </div>

      {/* Supporting Criteria */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Supporting Criteria</CardTitle>
              <CardDescription>All criteria must pass for a confident funding decision.</CardDescription>
            </div>
            <div className={cn(
              "text-xs font-mono px-3 py-1.5 rounded-full border font-medium",
              allPass
                ? "bg-emerald-950/50 text-emerald-400 border-emerald-500/30"
                : "bg-red-950/40 text-red-400 border-red-500/30"
            )}>
              {allPass ? "All Criteria Met" : "Criteria Failing"}
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-700/80">
                <th className="py-2 pl-4 pr-2 w-8" />
                <th className="py-2 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Criterion
                </th>
                <th className="py-2 pr-4 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Value
                </th>
                <th className="py-2 pr-4 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Threshold
                </th>
              </tr>
            </thead>
            <tbody>
              <CriteriaRow
                label="Paper trading days elapsed"
                value={`${days} days`}
                pass={days >= 14}
                note="Need ≥ 14 days"
              />
              <CriteriaRow
                label="Total settled bets"
                value={`${bets} bets`}
                pass={bets >= 30}
                note="Need ≥ 30 bets"
              />
              <CriteriaRow
                label="Average ROI per bet"
                value={`${roi.toFixed(2)}%`}
                pass={roi > 0}
                note="Must be positive"
              />
              <CriteriaRow
                label="Average bets per week"
                value={`${bpw.toFixed(1)} / week`}
                pass={bpw >= 3}
                note="Need ≥ 3 / week"
              />
              <CriteriaRow
                label="Average stake size"
                value={formatCurrency(stake)}
                pass={stake >= 5}
                note="Need ≥ £5"
              />
              <CriteriaRow
                label="Model accuracy trend"
                value={accuracyTrend.charAt(0).toUpperCase() + accuracyTrend.slice(1)}
                pass={trendPass}
                note="Must not be declining"
              />
              <CriteriaRow
                label="Edge diversity"
                value={`${edgeDiversity} profitable segments`}
                pass={diversityPass}
                note="Need ≥ 2 segments"
              />
              <CriteriaRow
                label="System activity"
                value={days > 0 ? "Active" : "Inactive"}
                pass={days > 0}
                note="Agent must be running"
              />
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Footer */}
      <div className="rounded-lg border border-slate-700/50 bg-slate-800/30 px-5 py-4 text-sm text-slate-400 leading-relaxed text-center">
        The £499 funding decision should only be made when the traffic light is{" "}
        <span className="text-emerald-400 font-semibold">GREEN</span> and all supporting criteria show{" "}
        <span className="text-emerald-400 font-semibold">green ticks</span>.
        Conservative projections are used because real-money execution always underperforms paper trading.
      </div>
    </div>
  );
}
