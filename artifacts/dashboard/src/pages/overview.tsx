import { useMemo } from "react";
import { useSummary, useBets, useNarratives, usePerformance } from "@/hooks/use-dashboard";
import { formatCurrency, formatRelativeTime } from "@/lib/format";
import { BetStatusBadge } from "@/components/layout";
import { cn } from "@/lib/utils";
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";

// ─── Narrative helpers ────────────────────────────────────────────────────────

function getNarrativeEmoji(type: string): string {
  const map: Record<string, string> = {
    risk_circuit_breaker: "🛡️",
    sustained_positive_edge: "📈",
    strategy_best_segment: "🎯",
    strategy_worst_segment: "🔄",
    feature_importance_shift: "💡",
    feature_importance_change: "💡",
    accuracy_change: "📈",
    calibration_change: "🔄",
    model_retrain: "💡",
  };
  return map[type] ?? "📊";
}

function translateNarrativeType(type: string): string {
  const map: Record<string, string> = {
    risk_circuit_breaker: "Risk Control",
    sustained_positive_edge: "Positive Edge",
    strategy_best_segment: "Best Strategy",
    strategy_worst_segment: "Weak Spot",
    feature_importance_shift: "Feature Discovery",
    feature_importance_change: "Feature Discovery",
    accuracy_change: "Model Update",
    calibration_change: "Calibration",
    model_retrain: "Model Retrained",
  };
  return map[type] ?? type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function generateNarrativeText(n: any): string {
  const body = n.body ?? "";
  if (body && body !== n.narrativeType && body.length > 10) return body;
  const d = n.relatedData ?? {};
  switch (n.narrativeType) {
    case "risk_circuit_breaker":
      return `Risk control activated: ${d.reason ?? "loss limit reached"}. Agent paused to protect bankroll.`;
    case "sustained_positive_edge":
      return `Consistent edge found in ${d.league ?? "—"} ${d.market ?? ""}${d.roi != null ? ` — ${Number(d.roi).toFixed(1)}% ROI` : ""}${d.count != null ? ` over ${d.count} bets` : ""}.`;
    case "strategy_best_segment":
      return `Best performing strategy: ${d.league ?? d.segment ?? "—"} ${d.market ?? ""} with ${d.roi != null ? Number(d.roi).toFixed(1) : "?"}% return.`;
    case "strategy_worst_segment":
      return `Weak spot identified: ${d.league ?? d.segment ?? "—"} ${d.market ?? ""} at ${d.roi != null ? Number(d.roi).toFixed(1) : "?"}% — agent reducing exposure.`;
    case "feature_importance_shift":
    case "feature_importance_change":
      return `Model update: ${d.feature ?? "a feature"} is now the #${d.rank ?? "?"} most important predictor.`;
    case "accuracy_change":
      return `Model accuracy ${(d.delta ?? 0) >= 0 ? "improved" : "decreased"} to ${d.newAccuracy != null ? (Number(d.newAccuracy) * 100).toFixed(1) : "?"}%.`;
    case "model_retrain":
      return `Model retrained on ${d.trainedOn ?? "?"} bets.${d.accuracy != null ? ` New accuracy: ${(Number(d.accuracy) * 100).toFixed(1)}%.` : ""}`;
    default:
      return n.title ?? translateNarrativeType(n.narrativeType);
  }
}

// ─── Stat Card ────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  color?: "green" | "red" | "amber" | "default";
}) {
  const valueColor =
    color === "green" ? "text-emerald-400"
    : color === "red" ? "text-red-400"
    : color === "amber" ? "text-amber-400"
    : "text-white";

  return (
    <div
      className="rounded-xl p-5 border flex flex-col gap-2"
      style={{ background: "#1e293b", borderColor: "#334155" }}
    >
      <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-500">{label}</p>
      <p className={cn("text-3xl font-bold font-mono leading-none", valueColor)}>{value}</p>
      {sub && <p className="text-xs text-slate-500 leading-snug">{sub}</p>}
    </div>
  );
}

// ─── Chart tooltip ────────────────────────────────────────────────────────────

const TOOLTIP_STYLE = {
  contentStyle: {
    background: "#0f172a",
    border: "1px solid #334155",
    borderRadius: "8px",
    fontSize: "12px",
    color: "#e2e8f0",
  },
  itemStyle: { color: "#94a3b8" },
  labelStyle: { color: "#64748b", fontWeight: 600 },
};

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Overview() {
  const { data: summary, isLoading: loadingSummary } = useSummary();
  const { data: allBetsData, isLoading: loadingBets } = useBets(1, 50, "all");
  const { data: narrativesData, isLoading: loadingNarratives } = useNarratives();
  const { data: perfData, isLoading: loadingPerf } = usePerformance();

  const upcomingBets = useMemo(() => {
    const bets = (allBetsData?.bets as any[]) ?? [];
    return bets.filter((b: any) => b.status === "pending").slice(0, 10);
  }, [allBetsData]);

  const recentResults = useMemo(() => {
    const bets = (allBetsData?.bets as any[]) ?? [];
    return bets.filter((b: any) => b.status === "won" || b.status === "lost").slice(0, 10);
  }, [allBetsData]);

  const narratives = useMemo(
    () => ((narrativesData?.narratives as any[]) ?? []).slice(0, 5),
    [narrativesData],
  );

  const chartData = useMemo(() => {
    const arr = (perfData?.cumulativeProfit as any[]) ?? [];
    return arr.slice(-30);
  }, [perfData]);

  const isProfit = useMemo(() => {
    if (chartData.length === 0) return true;
    return (chartData[chartData.length - 1]?.cumPnl ?? 0) >= 0;
  }, [chartData]);

  const pnl = summary?.totalPnl ?? 0;
  const todayPnl = summary?.todayPnl ?? 0;
  const roi = summary?.overallRoiPct ?? 0;
  const bankroll = summary?.currentBankroll ?? 0;
  const startingBankroll = 500;
  const bankrollDiff = bankroll - startingBankroll;

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div>
        <h2 className="text-2xl font-bold text-white tracking-tight">Overview</h2>
        <p className="text-sm text-slate-500 mt-1">Mission control for the paper trading agent.</p>
      </div>

      {/* 6-Card Stats Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <StatCard
          label="Simulated Bankroll"
          value={loadingSummary ? "—" : formatCurrency(bankroll)}
          sub={
            !loadingSummary && summary
              ? `${bankrollDiff >= 0 ? "+" : ""}${formatCurrency(bankrollDiff)} from £500 paper start`
              : undefined
          }
          color={!loadingSummary ? (bankrollDiff >= 0 ? "green" : "red") : "default"}
        />
        <StatCard
          label="Total P&L"
          value={loadingSummary ? "—" : formatCurrency(pnl)}
          sub={!loadingSummary && summary ? `${roi >= 0 ? "+" : ""}${roi.toFixed(2)}% overall ROI` : undefined}
          color={!loadingSummary ? (pnl >= 0 ? "green" : "red") : "default"}
        />
        <StatCard
          label="Total Bets"
          value={loadingSummary ? "—" : (summary?.totalBets ?? 0)}
          sub={
            !loadingSummary && summary
              ? `${summary.wins ?? 0}W · ${summary.losses ?? 0}L · ${summary.pending ?? 0} pending`
              : undefined
          }
        />
        <StatCard
          label="Win Rate"
          value={loadingSummary ? "—" : `${(summary?.winPercentage ?? 0).toFixed(1)}%`}
          sub={!loadingSummary ? "of settled bets" : undefined}
          color={
            !loadingSummary
              ? (summary?.winPercentage ?? 0) >= 50 ? "green" : "red"
              : "default"
          }
        />
        <StatCard
          label="ROI"
          value={loadingSummary ? "—" : `${roi >= 0 ? "+" : ""}${roi.toFixed(2)}%`}
          sub={!loadingSummary ? "total return on stakes" : undefined}
          color={!loadingSummary ? (roi >= 0 ? "green" : "red") : "default"}
        />
        <StatCard
          label="Avg Opportunity Score"
          value={
            loadingSummary
              ? "—"
              : summary?.avgOpportunityScore != null
                ? `${summary.avgOpportunityScore.toFixed(1)}`
                : "—"
          }
          sub={
            !loadingSummary
              ? summary?.avgOpportunityScore != null
                ? summary.avgOpportunityScore >= 80
                  ? "Strong signal quality"
                  : summary.avgOpportunityScore >= 70
                    ? "Good signal quality"
                    : "Moderate signal quality"
                : "No scored bets yet"
              : undefined
          }
          color={
            !loadingSummary && summary?.avgOpportunityScore != null
              ? summary.avgOpportunityScore >= 80
                ? "green"
                : summary.avgOpportunityScore >= 70
                  ? "amber"
                  : "default"
              : "default"
          }
        />
      </div>

      {/* Cumulative P&L Chart */}
      <div
        className="rounded-xl border p-5"
        style={{ background: "#1e293b", borderColor: "#334155" }}
      >
        <div className="mb-4">
          <h3 className="text-sm font-semibold text-white">Cumulative P&L</h3>
          <p className="text-xs text-slate-500 mt-0.5">Net profit over the last 30 data points</p>
        </div>
        {loadingPerf ? (
          <div className="h-48 rounded-lg animate-pulse" style={{ background: "#0f172a" }} />
        ) : chartData.length < 2 ? (
          <div className="h-48 flex items-center justify-center text-sm text-slate-500">
            Not enough data yet — bets will appear here after settlement.
          </div>
        ) : (
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={isProfit ? "#10b981" : "#ef4444"} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={isProfit ? "#10b981" : "#ef4444"} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e3a5f" vertical={false} />
                <XAxis
                  dataKey="date"
                  stroke="#475569"
                  fontSize={10}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v) =>
                    new Date(v).toLocaleDateString("en-GB", { month: "short", day: "numeric" })
                  }
                />
                <YAxis
                  stroke="#475569"
                  fontSize={10}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v) => `£${v}`}
                  width={45}
                />
                <Tooltip
                  {...TOOLTIP_STYLE}
                  formatter={(v: number) => [formatCurrency(v), "P&L"]}
                  labelFormatter={(l) =>
                    new Date(l).toLocaleDateString("en-GB", { dateStyle: "long" })
                  }
                />
                <Area
                  type="monotone"
                  dataKey="cumPnl"
                  stroke={isProfit ? "#10b981" : "#ef4444"}
                  strokeWidth={2}
                  fill="url(#pnlGrad)"
                  dot={false}
                  activeDot={{ r: 4, fill: isProfit ? "#10b981" : "#ef4444" }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Two-column: Upcoming + Recent */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Upcoming Bets */}
        <div
          className="rounded-xl border overflow-hidden"
          style={{ background: "#1e293b", borderColor: "#334155" }}
        >
          <div className="px-5 py-4 border-b" style={{ borderColor: "#334155" }}>
            <h3 className="text-sm font-semibold text-white">Upcoming Bets</h3>
            <p className="text-xs text-slate-500 mt-0.5">Pending paper bets awaiting settlement</p>
          </div>
          <div className="divide-y" style={{ divideColor: "#334155" }}>
            {loadingBets ? (
              <div className="p-5 space-y-3">
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="h-12 rounded animate-pulse" style={{ background: "#0f172a" }} />
                ))}
              </div>
            ) : upcomingBets.length === 0 ? (
              <div className="px-5 py-10 text-center">
                <p className="text-sm text-slate-500">
                  Agent is analysing upcoming fixtures.
                </p>
                <p className="text-xs text-slate-600 mt-1">Next scan in ~15 minutes.</p>
              </div>
            ) : (
              upcomingBets.map((bet: any) => (
                <div key={bet.id} className="px-5 py-3 hover:bg-slate-700/20 transition-colors">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-white truncate">
                        {bet.homeTeam} vs {bet.awayTeam}
                      </p>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {bet.league} · {bet.selectionName} · {bet.marketType}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-mono font-semibold text-white">
                        {bet.oddsAtPlacement.toFixed(2)}
                      </p>
                      <p className="text-xs text-slate-500 font-mono">{formatCurrency(bet.stake)}</p>
                    </div>
                  </div>
                  <div className="flex items-center justify-between mt-2">
                    <span className="text-[10px] text-slate-600">{formatRelativeTime(bet.placedAt)}</span>
                    {bet.calculatedEdge != null && (
                      <span
                        className={cn(
                          "text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded",
                          bet.calculatedEdge >= 0
                            ? "bg-emerald-950 text-emerald-400"
                            : "bg-red-950 text-red-400",
                        )}
                      >
                        Edge {(bet.calculatedEdge * 100).toFixed(1)}%
                      </span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Recent Results */}
        <div
          className="rounded-xl border overflow-hidden"
          style={{ background: "#1e293b", borderColor: "#334155" }}
        >
          <div className="px-5 py-4 border-b" style={{ borderColor: "#334155" }}>
            <h3 className="text-sm font-semibold text-white">Recent Results</h3>
            <p className="text-xs text-slate-500 mt-0.5">Last settled bets</p>
          </div>
          <div>
            {loadingBets ? (
              <div className="p-5 space-y-3">
                {[...Array(5)].map((_, i) => (
                  <div key={i} className="h-12 rounded animate-pulse" style={{ background: "#0f172a" }} />
                ))}
              </div>
            ) : recentResults.length === 0 ? (
              <div className="px-5 py-10 text-center">
                <p className="text-sm text-slate-500">No settled bets yet.</p>
              </div>
            ) : (
              <div className="divide-y" style={{ divideColor: "#334155" }}>
                {recentResults.map((bet: any) => (
                  <div
                    key={bet.id}
                    className={cn(
                      "px-5 py-3 flex items-center gap-3 border-l-[3px] transition-colors",
                      bet.status === "won"
                        ? "border-l-emerald-500 hover:bg-emerald-950/20"
                        : "border-l-red-500 hover:bg-red-950/20",
                    )}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-white truncate">
                          {bet.homeTeam} vs {bet.awayTeam}
                        </p>
                        <BetStatusBadge status={bet.status} />
                      </div>
                      <p className="text-xs text-slate-500 mt-0.5 truncate">
                        {bet.selectionName} @ {bet.oddsAtPlacement.toFixed(2)} · {formatCurrency(bet.stake)}
                      </p>
                    </div>
                    {bet.settlementPnl != null && (
                      <p
                        className={cn(
                          "text-sm font-bold font-mono shrink-0",
                          bet.settlementPnl >= 0 ? "text-emerald-400" : "text-red-400",
                        )}
                      >
                        {bet.settlementPnl >= 0 ? "+" : ""}
                        {formatCurrency(bet.settlementPnl)}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* What the Agent Has Learned */}
      <div>
        <div className="mb-4">
          <h3 className="text-base font-semibold text-white">What the Agent Has Learned</h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Intelligence signals generated by the learning engine
          </p>
        </div>

        {loadingNarratives ? (
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-20 rounded-xl animate-pulse" style={{ background: "#1e293b" }} />
            ))}
          </div>
        ) : narratives.length === 0 ? (
          <div
            className="rounded-xl border p-10 text-center text-sm text-slate-500"
            style={{ background: "#1e293b", borderColor: "#334155" }}
          >
            No learning signals yet. They appear after the first retraining cycle.
          </div>
        ) : (
          <div className="space-y-3">
            {narratives.map((n: any) => {
              const text = generateNarrativeText(n);
              const emoji = getNarrativeEmoji(n.narrativeType);
              const label = translateNarrativeType(n.narrativeType);
              return (
                <div
                  key={n.id}
                  className="rounded-xl border flex items-start gap-4 px-5 py-4"
                  style={{ background: "#1e293b", borderColor: "#334155" }}
                >
                  <span className="text-2xl leading-none mt-0.5 shrink-0">{emoji}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">
                      {label}
                    </p>
                    <p className="text-sm text-slate-200 leading-relaxed">{text}</p>
                  </div>
                  <p className="text-[11px] text-slate-600 shrink-0 pt-0.5">
                    {formatRelativeTime(n.createdAt)}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
