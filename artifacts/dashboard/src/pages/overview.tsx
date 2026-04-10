import { useMemo } from "react";
import { useSummary, useBets, useNarratives, usePerformance, useClvStats, useXGTeams } from "@/hooks/use-dashboard";
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
  const { data: clvStats } = useClvStats();
  const { data: allBetsData, isLoading: loadingBets, isError: betsError } = useBets(1, 500, "all");
  const { data: narrativesData, isLoading: loadingNarratives } = useNarratives();
  const { data: perfData, isLoading: loadingPerf } = usePerformance();
  const { data: xgData, isLoading: loadingXg } = useXGTeams();

  const upcomingBets = useMemo(() => {
    const bets = (allBetsData?.bets as any[]) ?? [];
    return bets.filter((b: any) => b.status === "pending");
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
  const settledBets = (summary as any)?.settledBets ?? 0;
  const betsToday = (summary as any)?.betsToday ?? 0;
  const paperMode = (summary as any)?.paperMode ?? false;
  const SIGNIFICANCE_TARGET = 500;
  const significancePct = Math.min((settledBets / SIGNIFICANCE_TARGET) * 100, 100);

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold text-white tracking-tight">Overview</h2>
          <p className="text-sm text-slate-500 mt-1">Mission control for the paper trading agent.</p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {paperMode && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-400 text-xs font-semibold tracking-wide">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
              PAPER MODE: ON
            </span>
          )}
          {!loadingSummary && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-slate-800 border border-slate-700 text-slate-300 text-xs font-semibold">
              {betsToday} bets placed today
            </span>
          )}
          {!loadingSummary && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-slate-800 border border-slate-700 text-slate-300 text-xs font-semibold">
              {(summary as any)?.pending ?? 0} open
            </span>
          )}
        </div>
      </div>

      {/* Bets to significance progress bar */}
      <div className="rounded-xl border border-slate-700/60 bg-slate-800/40 p-4">
        <div className="flex items-center justify-between mb-2">
          <div>
            <p className="text-sm font-semibold text-white">Bets to Statistical Significance</p>
            <p className="text-xs text-slate-500 mt-0.5">
              {settledBets >= SIGNIFICANCE_TARGET
                ? "Target reached — results are statistically robust for Demo Day."
                : `${SIGNIFICANCE_TARGET - settledBets} more settled bets needed for Demo Day (April 23).`}
            </p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-lg font-mono font-bold text-white">
              {settledBets} <span className="text-slate-500 font-normal text-sm">/ {SIGNIFICANCE_TARGET}</span>
            </p>
            <p className="text-xs text-slate-500">{significancePct.toFixed(1)}% complete</p>
          </div>
        </div>
        <div className="h-2 w-full rounded-full bg-slate-700/60 overflow-hidden">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-500",
              significancePct >= 100 ? "bg-emerald-500" : significancePct >= 50 ? "bg-amber-500" : "bg-blue-500",
            )}
            style={{ width: `${Math.max(significancePct, 0.5)}%` }}
          />
        </div>
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
        {(clvStats as any)?.count > 0 && (
          <StatCard
            label="Avg CLV"
            value={
              (clvStats as any)?.avgClv != null
                ? `${(clvStats as any).avgClv >= 0 ? "+" : ""}${Number((clvStats as any).avgClv).toFixed(2)}%`
                : "—"
            }
            sub={
              (clvStats as any)?.count != null
                ? `over ${(clvStats as any).count} settled bets`
                : "no data yet"
            }
            color={
              (clvStats as any)?.avgClv != null
                ? Number((clvStats as any).avgClv) >= 3 ? "green"
                  : Number((clvStats as any).avgClv) >= 0 ? "amber"
                  : "red"
                : "default"
            }
          />
        )}
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
          <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: "#334155" }}>
            <div>
              <h3 className="text-sm font-semibold text-white">Upcoming Bets</h3>
              <p className="text-xs text-slate-500 mt-0.5">Pending paper bets awaiting settlement</p>
            </div>
            {upcomingBets.length > 0 && (
              <span className="text-xs font-mono font-semibold px-2 py-0.5 rounded-full bg-slate-700 text-slate-300">
                {upcomingBets.length}
              </span>
            )}
          </div>
          <div className="divide-y overflow-y-auto" style={{ divideColor: "#334155", maxHeight: "480px" }}>
            {loadingBets ? (
              <div className="p-5 space-y-3">
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="h-12 rounded animate-pulse" style={{ background: "#0f172a" }} />
                ))}
              </div>
            ) : betsError ? (
              <div className="px-5 py-10 text-center">
                <p className="text-sm text-red-400">Could not load bets — retrying…</p>
                <p className="text-xs text-slate-600 mt-1">Check API server connection.</p>
              </div>
            ) : upcomingBets.length === 0 ? (
              <div className="px-5 py-10 text-center">
                <p className="text-sm text-slate-500">
                  No pending bets yet.
                </p>
                <p className="text-xs text-slate-600 mt-1">Agent scans for value every 15 minutes.</p>
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

      {/* xG Intelligence */}
      <div>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-white">xG Intelligence</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Teams whose actual goals diverge most from expected goals (xG) over last 5 matches
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-emerald-950 text-emerald-400 font-medium">
              ● Underperforming = value territory
            </span>
            <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-red-950 text-red-400 font-medium">
              ● Overperforming = regression risk
            </span>
          </div>
        </div>

        <div
          className="rounded-xl border overflow-hidden"
          style={{ background: "#1e293b", borderColor: "#334155" }}
        >
          {loadingXg ? (
            <div className="p-5 space-y-2">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="h-10 rounded animate-pulse" style={{ background: "#0f172a" }} />
              ))}
            </div>
          ) : !xgData?.teams?.length ? (
            <div className="px-5 py-10 text-center">
              <p className="text-sm text-slate-500">No xG data yet.</p>
              <p className="text-xs text-slate-600 mt-1">
                First ingestion runs daily at 05:00 UTC — or trigger manually via POST /api/xg/refresh
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b" style={{ borderColor: "#334155" }}>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">Team</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">League</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-slate-500 group relative">
                      <span
                        title="Average xG created minus xG conceded over last 5 matches. Positive = creating more chances than conceding."
                        className="cursor-help border-b border-dotted border-slate-600"
                      >
                        xG Diff (5)
                      </span>
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-slate-500">
                      <span
                        title="Actual goals scored minus xG created over last 5 matches. Positive = overperforming (regression risk). Negative = underperforming (value opportunity)."
                        className="cursor-help border-b border-dotted border-slate-600"
                      >
                        Goals vs xG
                      </span>
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-slate-500">
                      <span
                        title="Change in xG diff compared to the 5 matches before that. Positive = improving, negative = declining."
                        className="cursor-help border-b border-dotted border-slate-600"
                      >
                        Momentum
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(xgData.teams as any[]).slice(0, 10).map((team: any, i: number) => {
                    const goalsVsXg = Number(team.goalsVsXgDiff ?? team.goals_vs_xg_diff ?? 0);
                    const xgDiff = Number(team.xgDiff5 ?? team.xg_diff_5 ?? 0);
                    const momentum = Number(team.xgMomentum ?? team.xg_momentum ?? 0);
                    const isOverperforming = goalsVsXg > 0.1;
                    const isUnderperforming = goalsVsXg < -0.1;
                    return (
                      <tr
                        key={i}
                        className="border-b hover:bg-slate-700/20 transition-colors"
                        style={{ borderColor: "#1e293b" }}
                      >
                        <td className="px-4 py-3 font-medium text-white text-sm">
                          {team.teamName ?? team.team_name}
                        </td>
                        <td className="px-4 py-3 text-slate-400 text-xs">
                          {team.league}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs">
                          <span className={xgDiff >= 0 ? "text-emerald-400" : "text-red-400"}>
                            {xgDiff >= 0 ? "+" : ""}{xgDiff.toFixed(2)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <span
                            className={cn(
                              "inline-flex items-center gap-1 font-mono text-xs px-2 py-0.5 rounded-full font-semibold",
                              isOverperforming
                                ? "bg-red-950 text-red-400"
                                : isUnderperforming
                                ? "bg-emerald-950 text-emerald-400"
                                : "bg-slate-800 text-slate-400",
                            )}
                          >
                            {goalsVsXg >= 0 ? "+" : ""}{goalsVsXg.toFixed(2)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs">
                          <span className={momentum >= 0 ? "text-emerald-400" : "text-slate-500"}>
                            {momentum >= 0 ? "↑" : "↓"} {Math.abs(momentum).toFixed(2)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
