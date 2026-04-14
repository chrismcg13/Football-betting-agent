import { useMemo, useState } from "react";
import { useSummary, useBets, useNarratives, usePerformance, useClvStats, useLeagueDiscoveryStats, useGoLiveReadiness, useExperiments } from "@/hooks/use-dashboard";
import { formatCurrency, formatRelativeTime, formatMarketType } from "@/lib/format";
import { BetStatusBadge } from "@/components/layout";
import { cn } from "@/lib/utils";
import { Info } from "lucide-react";
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip as RechartsTooltip,
  XAxis, YAxis, ReferenceLine,
} from "recharts";

// ─── Market type label ────────────────────────────────────────────────────────

// (formatMarketType is imported from format.ts)

// ─── Narrative helpers ────────────────────────────────────────────────────────

function getNarrativeEmoji(type: string): string {
  const map: Record<string, string> = {
    risk_circuit_breaker: "⚠️",
    sustained_positive_edge: "🎯",
    strategy_best_segment: "⭐",
    strategy_worst_segment: "📉",
    feature_importance_shift: "🧠",
    feature_importance_change: "🧠",
    accuracy_change: "📈",
    model_accuracy_improvement: "📈",
    calibration_change: "🔄",
    model_retrain: "📈",
    league_allocation: "🌍",
    league_discovery: "🔍",
  };
  return map[type] ?? "📊";
}

function generateNarrativeText(n: any): string {
  const body = n.body ?? "";
  if (body && body !== n.narrativeType && body.length > 10) return body;
  const d = n.relatedData ?? {};
  switch (n.narrativeType) {
    case "risk_circuit_breaker":
      return `Risk control activated: ${d.reason ?? "loss limit reached"}. Agent paused to protect the bankroll.`;
    case "sustained_positive_edge":
      return `Consistent edge found in ${d.league ?? "—"} ${d.market ?? ""}${d.roi != null ? ` — ${Number(d.roi).toFixed(1)}% ROI` : ""}${d.count != null ? ` over ${d.count} bets` : ""}.`;
    case "strategy_best_segment":
      return `Top strategy: ${d.league ?? d.segment ?? "—"} ${d.market ?? ""} returning ${d.roi != null ? Number(d.roi).toFixed(1) : "?"}% ROI.`;
    case "strategy_worst_segment":
      return `Weak spot: ${d.league ?? d.segment ?? "—"} ${d.market ?? ""} at ${d.roi != null ? Number(d.roi).toFixed(1) : "?"}% ROI. Reducing exposure.`;
    case "feature_importance_shift":
    case "feature_importance_change":
      return `Model insight: ${d.feature ?? "a feature"} has become the #${d.rank ?? "?"} most important predictor.`;
    case "accuracy_change":
    case "model_accuracy_improvement":
      return `Model accuracy ${(d.delta ?? 0) >= 0 ? "improved" : "decreased"} from ${d.oldAccuracy != null ? (Number(d.oldAccuracy) * 100).toFixed(1) : "?"}% to ${d.newAccuracy != null ? (Number(d.newAccuracy) * 100).toFixed(1) : "?"}%${d.count != null ? ` after learning from ${d.count} bets` : ""}.`;
    case "model_retrain":
      return `Model retrained on ${d.trainedOn ?? d.count ?? "?"} bets.${d.accuracy != null ? ` New accuracy: ${(Number(d.accuracy) * 100).toFixed(1)}%.` : ""}`;
    case "league_allocation":
      return `League focus: ${d.league ?? "—"} ${d.direction === "up" ? "promoted" : "demoted"} based on ${d.reason ?? "recent performance"}.`;
    case "league_discovery":
      return `New opportunity: ${d.league ?? "—"} ${d.market ?? ""} showing ${d.edge != null ? Number(d.edge).toFixed(1) : "?"}% average edge.`;
    default:
      return n.title ?? (n.narrativeType ?? "").replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
  }
}

// ─── CLV Info Tooltip ─────────────────────────────────────────────────────────

function ClvInfoIcon() {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex ml-1.5 align-middle">
      <button
        type="button"
        className="text-slate-500 hover:text-slate-300 transition-colors focus:outline-none"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        aria-label="CLV explanation"
      >
        <Info className="w-3.5 h-3.5" />
      </button>
      {open && (
        <div
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 rounded-xl border p-3 text-xs text-slate-300 leading-relaxed shadow-2xl"
          style={{ background: "#0f172a", borderColor: "#334155", width: "260px" }}
        >
          <p className="font-semibold text-white mb-1">What is CLV?</p>
          CLV measures whether the agent gets better odds than the closing market price. Positive CLV = the agent is beating the market. Professional bettors consider +2% CLV elite. This is the single best predictor of long-term profitability.
          <div
            className="absolute top-full left-1/2 -translate-x-1/2 w-2 h-2 rotate-45 border-r border-b"
            style={{ background: "#0f172a", borderColor: "#334155" }}
          />
        </div>
      )}
    </span>
  );
}

// ─── Primary Stat Card ────────────────────────────────────────────────────────

function PrimaryCard({
  label,
  value,
  sub,
  color,
  labelSuffix,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  color?: "green" | "red" | "amber" | "default";
  labelSuffix?: React.ReactNode;
}) {
  const valueColor =
    color === "green" ? "text-emerald-400"
    : color === "red" ? "text-red-400"
    : color === "amber" ? "text-amber-400"
    : "text-white";

  return (
    <div
      className="rounded-xl p-5 border flex flex-col gap-2.5"
      style={{ background: "#1e293b", borderColor: "#334155" }}
    >
      <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-500 flex items-center">
        {label}
        {labelSuffix}
      </p>
      <p className={cn("text-4xl font-bold font-mono leading-none", valueColor)}>{value}</p>
      {sub && <p className="text-xs text-slate-500 leading-snug">{sub}</p>}
    </div>
  );
}

// ─── Secondary Stat Card ──────────────────────────────────────────────────────

function SecondaryCard({
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
      className="rounded-xl p-4 border flex flex-col gap-1.5"
      style={{ background: "#172033", borderColor: "#334155" }}
    >
      <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-600">{label}</p>
      <p className={cn("text-2xl font-bold font-mono leading-none", valueColor)}>{value}</p>
      {sub && <p className="text-xs text-slate-500 leading-snug">{sub}</p>}
    </div>
  );
}

// ─── Chart Tooltip ────────────────────────────────────────────────────────────

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

const DEMO_DAY = new Date("2026-04-23T23:59:59Z");
const SETTLED_TARGET = 500;

export default function Overview() {
  const { data: summary, isLoading: loadingSummary } = useSummary();
  const { data: clvStats } = useClvStats();
  const { data: allBetsData, isLoading: loadingBets, isError: betsError } = useBets(1, 500, "all");
  const { data: narrativesData, isLoading: loadingNarratives } = useNarratives();
  const { data: perfData, isLoading: loadingPerf } = usePerformance();
  const { data: discoveryStats } = useLeagueDiscoveryStats();
  const { data: readiness } = useGoLiveReadiness();
  const { data: experimentsData } = useExperiments();

  // ── Derived values ──────────────────────────────────────────────────────────
  const pnl = summary?.totalPnl ?? 0;
  const roi = summary?.overallRoiPct ?? 0;
  const bankroll = summary?.currentBankroll ?? 0;
  const wins = summary?.wins ?? 0;
  const losses = summary?.losses ?? 0;
  const voids = (summary as any)?.voids ?? 0;
  const pending = summary?.pending ?? 0;
  const settledBets = (summary as any)?.settledBets ?? 0;
  const winPercentage = summary?.winPercentage ?? 0;
  const avgScore = summary?.avgOpportunityScore ?? null;
  const paperMode = (summary as any)?.paperMode ?? false;
  const betsToday = (summary as any)?.betsToday ?? 0;

  const avgClv: number | null = (clvStats as any)?.count > 0 ? Number((clvStats as any).avgClv) : null;

  // ── Demo Day countdown ──────────────────────────────────────────────────────
  const daysRemaining = useMemo(() => {
    const now = new Date();
    const diff = DEMO_DAY.getTime() - now.getTime();
    return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
  }, []);

  const progressPct = Math.min((settledBets / SETTLED_TARGET) * 100, 100);
  const demoDayPositive =
    avgClv != null && avgClv > 0 && pnl > 0 && settledBets >= 30;

  // ── Bet splits ──────────────────────────────────────────────────────────────
  const upcomingBets = useMemo(() => {
    const bets = (allBetsData?.bets as any[]) ?? [];
    return bets
      .filter((b: any) => b.status === "pending")
      .sort((a: any, b: any) => {
        const ta = a.kickoffTime ? new Date(a.kickoffTime).getTime() : Infinity;
        const tb = b.kickoffTime ? new Date(b.kickoffTime).getTime() : Infinity;
        return ta - tb;
      });
  }, [allBetsData]);

  const recentResults = useMemo(() => {
    const bets = (allBetsData?.bets as any[]) ?? [];
    return bets
      .filter((b: any) => b.status === "won" || b.status === "lost")
      .slice(0, 20);
  }, [allBetsData]);

  // ── Narratives ──────────────────────────────────────────────────────────────
  const narratives = useMemo(
    () => ((narrativesData?.narratives as any[]) ?? []).slice(0, 5),
    [narrativesData],
  );

  // ── Chart data ──────────────────────────────────────────────────────────────
  const chartData = useMemo(() => {
    const arr = (perfData?.cumulativeProfit as any[]) ?? [];
    const sliced = arr.slice(-60);
    if (sliced.length === 0) return [];
    const first = sliced[0];
    const zeroPoint = { date: first.date, cumPnl: 0, _zero: true };
    return [zeroPoint, ...sliced];
  }, [perfData]);

  const currentPnl = chartData.length > 1 ? (chartData[chartData.length - 1]?.cumPnl ?? 0) : 0;
  const isChartPositive = currentPnl >= 0;

  // ── CLV color ───────────────────────────────────────────────────────────────
  const clvColor =
    avgClv == null ? "default"
    : avgClv >= 2 ? "green"
    : avgClv >= 0 ? "amber"
    : "red";

  return (
    <div className="space-y-6 max-w-7xl mx-auto">

      {/* Page header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold text-white tracking-tight">Overview</h2>
          <p className="text-sm text-slate-500 mt-1">Mission control for the paper trading agent.</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {paperMode && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-400 text-xs font-semibold tracking-wide">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
              PAPER MODE
            </span>
          )}
          {!loadingSummary && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-slate-800 border border-slate-700 text-slate-300 text-xs font-semibold">
              {betsToday} placed today · {pending} open
            </span>
          )}
        </div>
      </div>

      {/* ── PRIMARY METRICS ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <PrimaryCard
          label="Profit"
          value={loadingSummary ? "—" : formatCurrency(pnl)}
          sub="Net profit from paper trading"
          color={!loadingSummary ? (pnl >= 0 ? "green" : "red") : "default"}
        />
        <PrimaryCard
          label="ROI"
          value={loadingSummary ? "—" : `${roi >= 0 ? "+" : ""}${roi.toFixed(2)}%`}
          sub="Return on every £1 staked"
          color={!loadingSummary ? (roi >= 0 ? "green" : "red") : "default"}
        />
        <PrimaryCard
          label="Win Rate"
          value={loadingSummary ? "—" : `${winPercentage.toFixed(1)}%`}
          sub={!loadingSummary ? `${wins} won from ${wins + losses} settled bets` : undefined}
          color={!loadingSummary ? (winPercentage >= 50 ? "green" : "amber") : "default"}
        />
        <PrimaryCard
          label="CLV"
          labelSuffix={<ClvInfoIcon />}
          value={
            loadingSummary ? "—"
            : avgClv == null ? "No data yet"
            : `${avgClv >= 0 ? "+" : ""}${avgClv.toFixed(2)}%`
          }
          sub={
            (clvStats as any)?.count > 0
              ? `Over ${(clvStats as any).count} scored bets (${(clvStats as any).totalSettled ?? settledBets} settled)`
              : "How much better our odds are vs the market"
          }
          color={!loadingSummary ? clvColor : "default"}
        />
      </div>

      {/* ── SECONDARY METRICS ───────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <SecondaryCard
          label="Bankroll"
          value={loadingSummary ? "—" : formatCurrency(bankroll)}
          sub="Simulated trading balance (started £500)"
          color={!loadingSummary ? (bankroll >= 500 ? "green" : "red") : "default"}
        />
        <SecondaryCard
          label="Bets Record"
          value={loadingSummary ? "—" : `${wins}W – ${losses}L – ${voids}V`}
          sub={!loadingSummary ? `Won – Lost – Voided (${pending} pending)` : undefined}
        />
        <SecondaryCard
          label="Avg Opportunity Score"
          value={loadingSummary ? "—" : avgScore != null ? `${avgScore.toFixed(1)} / 100` : "—"}
          sub="Quality of bets selected (higher = more confident)"
          color={
            !loadingSummary && avgScore != null
              ? avgScore >= 80 ? "green" : avgScore >= 70 ? "amber" : "default"
              : "default"
          }
        />
        <SecondaryCard
          label="Active Leagues"
          value={discoveryStats ? `${(discoveryStats as any).active ?? "—"}` : "—"}
          sub={
            discoveryStats
              ? `${(discoveryStats as any).withPinnacleOdds ?? 0} with Pinnacle · ${(discoveryStats as any).totalDiscovered ?? 0} total discovered`
              : "Scanning globally for edge"
          }
          color={discoveryStats && (discoveryStats as any).active >= 30 ? "green" : "amber"}
        />
      </div>

      {/* ── GO LIVE READINESS PANEL ──────────────────────────────────────────── */}
      {readiness && (
        <div
          className="rounded-xl border p-5"
          style={{
            background: readiness.ready ? "#052e16" : "#1e293b",
            borderColor: readiness.ready ? "#166534" : "#334155",
          }}
        >
          <div className="flex items-start justify-between gap-4 mb-4 flex-wrap">
            <div>
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold text-white">Go Live Readiness</p>
                {readiness.ready && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-semibold">
                    READY
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500 mt-0.5">
                All criteria must be met before transitioning from paper to real-money trading
              </p>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <div className="text-right">
                <p className="text-3xl font-mono font-bold" style={{ color: readiness.overallScore >= 80 ? "#22c55e" : readiness.overallScore >= 50 ? "#f59e0b" : "#ef4444" }}>
                  {readiness.overallScore}%
                </p>
                <p className="text-[10px] text-slate-500 uppercase tracking-wide font-medium">Overall Score</p>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 mb-4">
            {(readiness.checks ?? []).map((check: any) => (
              <div
                key={check.id}
                className="flex items-center gap-2 rounded-lg px-3 py-2 border"
                style={{
                  background: check.met ? "#052e16" : "#0f172a",
                  borderColor: check.met ? "#166534" : "#1e293b",
                }}
              >
                <span className={cn("text-sm shrink-0", check.met ? "text-emerald-400" : "text-slate-600")}>
                  {check.met ? "✓" : "○"}
                </span>
                <div className="min-w-0 flex-1">
                  <p className={cn("text-xs font-medium", check.met ? "text-emerald-300" : "text-slate-400")}>{check.label}</p>
                  <p className="text-[10px] font-mono text-slate-500">{check.current} / {check.target}</p>
                </div>
              </div>
            ))}
          </div>
          {readiness.estDaysToTarget != null && !readiness.ready && (
            <p className="text-xs text-slate-500">
              At current pace ({readiness.betsPerDay} bets/day), sample target reached in ~{readiness.estDaysToTarget} days
            </p>
          )}
        </div>
      )}

      {/* ── DEMO DAY PROGRESS ───────────────────────────────────────────────── */}
      <div
        className="rounded-xl border p-5"
        style={{ background: "#1e293b", borderColor: "#334155" }}
      >
        <div className="flex items-start justify-between gap-4 mb-3 flex-wrap">
          <div>
            <p className="text-sm font-semibold text-white">Journey to Demo Day</p>
            <p className="text-xs text-slate-500 mt-0.5">
              Settled bets needed for statistical confidence. Demo Day: <span className="text-slate-300 font-medium">April 23, 2026</span>
            </p>
          </div>
          <div className="text-right shrink-0 flex items-center gap-4">
            <div>
              <p className="text-2xl font-mono font-bold text-white">
                {settledBets} <span className="text-slate-500 text-base font-normal">/ {SETTLED_TARGET}</span>
              </p>
              <p className="text-xs text-slate-500">{progressPct.toFixed(1)}% complete</p>
            </div>
            <div
              className="rounded-lg px-3 py-2 text-center border"
              style={{ background: "#0f172a", borderColor: "#334155" }}
            >
              <p className="text-2xl font-bold font-mono text-blue-400">{daysRemaining}</p>
              <p className="text-[10px] text-slate-500 font-medium uppercase tracking-wide">days left</p>
            </div>
          </div>
        </div>

        <div className="h-2.5 w-full rounded-full bg-slate-700/60 overflow-hidden mb-3">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-700",
              progressPct >= 100 ? "bg-emerald-500" : progressPct >= 50 ? "bg-amber-500" : "bg-blue-500",
            )}
            style={{ width: `${Math.max(progressPct, 0.5)}%` }}
          />
        </div>

        <div className="flex items-center justify-between gap-4 flex-wrap">
          {demoDayPositive ? (
            <p className="text-xs font-medium text-emerald-400">
              ✓ Early indicators are positive. Model is beating the market.
            </p>
          ) : (
            <p className="text-xs font-medium text-amber-400">
              ⏳ More data needed. The model is still learning.
            </p>
          )}
          {readiness?.betsPerDay > 0 && settledBets < SETTLED_TARGET && (
            <p className="text-[10px] text-slate-500 font-mono">
              ~{readiness.betsPerDay} bets/day · est. {readiness.estDaysToTarget ?? "?"} days to target
            </p>
          )}
        </div>

        {/* Pipeline snapshot */}
        {experimentsData?.grouped && (
          <div className="mt-3 pt-3 border-t flex items-center gap-3 flex-wrap" style={{ borderColor: "#334155" }}>
            <span className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">Pipeline:</span>
            {[
              { tier: "promoted", count: experimentsData.grouped.promoted?.length ?? 0, color: "#22c55e" },
              { tier: "candidate", count: experimentsData.grouped.candidate?.length ?? 0, color: "#f59e0b" },
              { tier: "experiment", count: experimentsData.grouped.experiment?.length ?? 0, color: "#8b5cf6" },
            ].map(t => (
              <span key={t.tier} className="inline-flex items-center gap-1.5 text-[11px]">
                <span className="w-2 h-2 rounded-full" style={{ background: t.color }} />
                <span className="text-slate-400">{t.count}</span>
                <span className="text-slate-600">{t.tier}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* ── PROFIT CHART ────────────────────────────────────────────────────── */}
      <div
        className="rounded-xl border p-5"
        style={{ background: "#1e293b", borderColor: "#334155" }}
      >
        <div className="mb-4">
          <h3 className="text-sm font-semibold text-white">Profit Over Time</h3>
          <p className="text-xs text-slate-500 mt-0.5">Cumulative net profit from all settled bets</p>
        </div>
        {loadingPerf ? (
          <div className="h-52 rounded-lg animate-pulse" style={{ background: "#0f172a" }} />
        ) : chartData.length < 2 ? (
          <div className="h-52 flex items-center justify-center text-sm text-slate-500">
            No settled bets yet — the profit line will appear here after first settlement.
          </div>
        ) : (
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="profitGradPos" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0.03} />
                  </linearGradient>
                  <linearGradient id="profitGradNeg" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#ef4444" stopOpacity={0.03} />
                    <stop offset="95%" stopColor="#ef4444" stopOpacity={0.35} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e3a5f" vertical={false} />
                <ReferenceLine y={0} stroke="#475569" strokeDasharray="4 4" />
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
                <RechartsTooltip
                  {...TOOLTIP_STYLE}
                  formatter={(v: number) => [formatCurrency(v), "Profit"]}
                  labelFormatter={(l) =>
                    new Date(l).toLocaleDateString("en-GB", { dateStyle: "long" })
                  }
                />
                <Area
                  type="monotone"
                  dataKey="cumPnl"
                  stroke={isChartPositive ? "#10b981" : "#ef4444"}
                  strokeWidth={2}
                  fill={isChartPositive ? "url(#profitGradPos)" : "url(#profitGradNeg)"}
                  dot={false}
                  activeDot={{ r: 4, fill: isChartPositive ? "#10b981" : "#ef4444" }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* ── TWO COLUMNS ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Upcoming Bets */}
        <div
          className="rounded-xl border overflow-hidden flex flex-col"
          style={{ background: "#1e293b", borderColor: "#334155" }}
        >
          <div className="px-5 py-4 border-b flex items-center justify-between shrink-0" style={{ borderColor: "#334155" }}>
            <div>
              <h3 className="text-sm font-semibold text-white">Upcoming Bets</h3>
              <p className="text-xs text-slate-500 mt-0.5">Bets placed, waiting for matches to finish</p>
            </div>
            {upcomingBets.length > 0 && (
              <span className="text-xs font-mono font-semibold px-2.5 py-1 rounded-full bg-blue-500/15 text-blue-400 border border-blue-500/25">
                {upcomingBets.length}
              </span>
            )}
          </div>
          <div className="overflow-y-auto flex-1 divide-y" style={{ divideColor: "#334155", maxHeight: "520px" }}>
            {loadingBets ? (
              <div className="p-5 space-y-3">
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="h-14 rounded animate-pulse" style={{ background: "#0f172a" }} />
                ))}
              </div>
            ) : betsError ? (
              <div className="px-5 py-10 text-center">
                <p className="text-sm text-red-400">Could not load bets — retrying…</p>
              </div>
            ) : upcomingBets.length === 0 ? (
              <div className="px-5 py-10 text-center">
                <p className="text-sm text-slate-500">No pending bets.</p>
                <p className="text-xs text-slate-600 mt-1">Agent scans for value every 10 minutes.</p>
              </div>
            ) : (
              upcomingBets.map((bet: any) => {
                const ko = bet.kickoffTime ? new Date(bet.kickoffTime) : null;
                return (
                  <div key={bet.id} className="px-5 py-3.5 hover:bg-slate-700/20 transition-colors">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-white truncate">
                          {bet.homeTeam} vs {bet.awayTeam}
                        </p>
                        <p className="text-[11px] text-slate-500 mt-0.5 truncate">
                          {bet.league}
                        </p>
                        <p className="text-[11px] text-slate-400 mt-0.5">
                          <span className="text-blue-400">{formatMarketType(bet.marketType)}</span>
                          {" · "}{bet.selectionName}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-sm font-mono font-bold text-white">
                          {bet.oddsAtPlacement?.toFixed(2)}
                        </p>
                        <p className="text-xs text-slate-400 font-mono">{formatCurrency(bet.stake)}</p>
                        {bet.calculatedEdge != null && (
                          <span
                            className={cn(
                              "text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded mt-1 inline-block",
                              bet.calculatedEdge >= 0
                                ? "bg-emerald-950 text-emerald-400"
                                : "bg-red-950 text-red-400",
                            )}
                          >
                            {(bet.calculatedEdge * 100).toFixed(1)}% edge
                          </span>
                        )}
                      </div>
                    </div>
                    {ko && (
                      <p className="text-[10px] text-slate-600 mt-1.5">
                        KO:{" "}
                        {ko.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}{" "}
                        {ko.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                      </p>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Recent Results */}
        <div
          className="rounded-xl border overflow-hidden flex flex-col"
          style={{ background: "#1e293b", borderColor: "#334155" }}
        >
          <div className="px-5 py-4 border-b shrink-0" style={{ borderColor: "#334155" }}>
            <h3 className="text-sm font-semibold text-white">Recent Results</h3>
            <p className="text-xs text-slate-500 mt-0.5">Latest settled bets</p>
          </div>
          <div className="overflow-y-auto flex-1 divide-y" style={{ divideColor: "#334155", maxHeight: "520px" }}>
            {loadingBets ? (
              <div className="p-5 space-y-3">
                {[...Array(5)].map((_, i) => (
                  <div key={i} className="h-14 rounded animate-pulse" style={{ background: "#0f172a" }} />
                ))}
              </div>
            ) : recentResults.length === 0 ? (
              <div className="px-5 py-10 text-center">
                <p className="text-sm text-slate-500">No settled bets yet.</p>
              </div>
            ) : (
              recentResults.map((bet: any) => (
                <div
                  key={bet.id}
                  className={cn(
                    "px-5 py-3.5 flex items-center gap-3 border-l-[3px] transition-colors",
                    bet.status === "won"
                      ? "border-l-emerald-500 hover:bg-emerald-950/20"
                      : bet.status === "lost"
                        ? "border-l-red-500 hover:bg-red-950/20"
                        : "border-l-slate-600 hover:bg-slate-700/10",
                  )}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium text-white truncate">
                        {bet.homeTeam} vs {bet.awayTeam}
                      </p>
                      <BetStatusBadge status={bet.status} />
                    </div>
                    <p className="text-[11px] text-slate-500 mt-0.5 truncate">
                      {formatMarketType(bet.marketType)} · {bet.selectionName} @ {bet.oddsAtPlacement?.toFixed(2)}
                    </p>
                    <p className="text-[10px] text-slate-600 mt-0.5">{formatRelativeTime(bet.placedAt)}</p>
                  </div>
                  {bet.settlementPnl != null && (
                    <p
                      className={cn(
                        "text-sm font-bold font-mono shrink-0",
                        bet.settlementPnl > 0 ? "text-emerald-400"
                        : bet.settlementPnl < 0 ? "text-red-400"
                        : "text-slate-500",
                      )}
                    >
                      {bet.settlementPnl > 0 ? "+" : ""}
                      {formatCurrency(bet.settlementPnl)}
                    </p>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* ── AGENT INTELLIGENCE ──────────────────────────────────────────────── */}
      <div>
        <div className="mb-4">
          <h3 className="text-base font-semibold text-white">Agent Intelligence</h3>
          <p className="text-xs text-slate-500 mt-0.5">
            What the model has discovered from its results
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
            No learning signals yet. They appear after the first retraining cycle (daily at 03:00 UTC).
          </div>
        ) : (
          <div className="space-y-3">
            {narratives.map((n: any) => {
              const text = generateNarrativeText(n);
              const emoji = getNarrativeEmoji(n.narrativeType);
              return (
                <div
                  key={n.id}
                  className="rounded-xl border flex items-start gap-4 px-5 py-4"
                  style={{ background: "#1e293b", borderColor: "#334155" }}
                >
                  <span className="text-xl leading-none mt-0.5 shrink-0">{emoji}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-slate-200 leading-relaxed">{text}</p>
                  </div>
                  <p className="text-[11px] text-slate-600 shrink-0 pt-0.5 whitespace-nowrap">
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
