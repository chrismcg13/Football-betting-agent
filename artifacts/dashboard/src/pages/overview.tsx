import { useMemo, useState } from "react";
import {
  useSummary, useBets, useNarratives, usePerformance, useClvStats,
  useLeagueDiscoveryStats, useExperiments, useCoverage,
  useCircuitBreakerStatus, useInPlayBets, useUpcomingBets, useExecutionMetrics,
  useAgentRecommendations, useTournamentStatus,
} from "@/hooks/use-dashboard";
import { formatCurrency, formatRelativeTime, formatMarketType } from "@/lib/format";
import { BetStatusBadge, LiveTierBadge, InfoTooltip } from "@/components/layout";
import { cn } from "@/lib/utils";
import { Info, Clock, Radio, Zap, AlertTriangle, TrendingUp, ArrowRight } from "lucide-react";
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip as RechartsTooltip,
  XAxis, YAxis, ReferenceLine,
} from "recharts";

function getNarrativeEmoji(type: string): string {
  const map: Record<string, string> = {
    risk_circuit_breaker: "⚠️", sustained_positive_edge: "🎯",
    strategy_best_segment: "⭐", strategy_worst_segment: "📉",
    feature_importance_shift: "🧠", feature_importance_change: "🧠",
    accuracy_change: "📈", model_accuracy_improvement: "📈",
    calibration_change: "🔄", model_retrain: "📈",
    league_allocation: "🌍", league_discovery: "🔍",
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

function PrimaryCard({ label, value, sub, color, labelSuffix }: {
  label: string; value: React.ReactNode; sub?: React.ReactNode;
  color?: "green" | "red" | "amber" | "default"; labelSuffix?: React.ReactNode;
}) {
  const valueColor = color === "green" ? "text-emerald-400" : color === "red" ? "text-red-400" : color === "amber" ? "text-amber-400" : "text-white";
  return (
    <div className="rounded-xl p-5 border flex flex-col gap-2.5" style={{ background: "#1e293b", borderColor: "#334155" }}>
      <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-500 flex items-center">{label}{labelSuffix}</p>
      <p className={cn("text-4xl font-bold font-mono leading-none", valueColor)}>{value}</p>
      {sub && <p className="text-xs text-slate-500 leading-snug">{sub}</p>}
    </div>
  );
}

function SecondaryCard({ label, value, sub, color }: {
  label: string; value: React.ReactNode; sub?: React.ReactNode;
  color?: "green" | "red" | "amber" | "default";
}) {
  const valueColor = color === "green" ? "text-emerald-400" : color === "red" ? "text-red-400" : color === "amber" ? "text-amber-400" : "text-white";
  return (
    <div className="rounded-xl p-4 border flex flex-col gap-1.5" style={{ background: "#172033", borderColor: "#334155" }}>
      <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-600">{label}</p>
      <p className={cn("text-2xl font-bold font-mono leading-none", valueColor)}>{value}</p>
      {sub && <p className="text-xs text-slate-500 leading-snug">{sub}</p>}
    </div>
  );
}

const TOOLTIP_STYLE = {
  contentStyle: { background: "#0f172a", border: "1px solid #334155", borderRadius: "8px", fontSize: "12px", color: "#e2e8f0" },
  itemStyle: { color: "#94a3b8" },
  labelStyle: { color: "#64748b", fontWeight: 600 },
};

export default function Overview() {
  const { data: summary, isLoading: loadingSummary } = useSummary({ liveOnly: true });
  const { data: clvStats } = useClvStats();
  const { data: narrativesData, isLoading: loadingNarratives } = useNarratives();
  const { data: perfData, isLoading: loadingPerf } = usePerformance({ liveOnly: true });
  const { data: discoveryStats } = useLeagueDiscoveryStats();
  const { data: experimentsData } = useExperiments();
  const { data: cbStatus } = useCircuitBreakerStatus();
  const { data: tournamentData } = useTournamentStatus();
  const { data: inPlayData } = useInPlayBets({ liveOnly: true });
  const { data: upcomingData } = useUpcomingBets({ liveOnly: true });
  const { data: execMetrics } = useExecutionMetrics();
  const { data: recommendations } = useAgentRecommendations();

  const pnl = summary?.totalPnl ?? 0;
  const roi = summary?.overallRoiPct ?? 0;
  const bankroll = summary?.currentBankroll ?? 0;
  const wins = summary?.wins ?? 0;
  const losses = summary?.losses ?? 0;
  const voids = (summary as any)?.voids ?? 0;
  const pending = summary?.pending ?? 0;
  const settledBets = (summary as any)?.settledBets ?? 0;
  const winPercentage = summary?.winPercentage ?? 0;
  const isLive = (summary as any)?.isLive === true;
  const betsToday = (summary as any)?.betsToday ?? 0;
  const tierSplit = (summary as any)?.tierSplit ?? { tier1a: 0, tier1b: 0, tier1Other: 0, betfairLive: 0, tier2: 0, betfairStake: 0 };
  const totalLive = tierSplit.tier1a + tierSplit.tier1b + tierSplit.tier1Other;
  const avgClv: number | null = (clvStats as any)?.count > 0 ? Number((clvStats as any).avgClv) : null;

  const inPlayBets = (inPlayData?.bets as any[]) ?? [];
  const upcomingBets = (upcomingData?.bets as any[]) ?? [];

  const narratives = useMemo(
    () => ((narrativesData?.narratives as any[]) ?? []).slice(0, 5),
    [narrativesData],
  );

  const chartData = useMemo(() => {
    const arr = (perfData?.cumulativeProfit as any[]) ?? [];
    const sliced = arr.slice(-60);
    if (sliced.length === 0) return [];
    const first = sliced[0];
    return [{ date: first.date, cumPnl: 0, _zero: true }, ...sliced];
  }, [perfData]);

  const currentPnl = chartData.length > 1 ? (chartData[chartData.length - 1]?.cumPnl ?? 0) : 0;
  const isChartPositive = currentPnl >= 0;
  const clvColor = avgClv == null ? "default" : avgClv >= 2 ? "green" : avgClv >= 0 ? "amber" : "red";

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Page header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold text-white tracking-tight">Overview</h2>
          <p className="text-sm text-slate-500 mt-1">
            Live trading dashboard — real money on Betfair Exchange
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {!loadingSummary && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-slate-800 border border-slate-700 text-slate-300 text-xs font-semibold">
              {totalLive > 0 ? (
                <>{totalLive} live on Betfair{tierSplit.tier1a > 0 ? ` (1A: ${tierSplit.tier1a}` : " ("}{tierSplit.tier1b > 0 ? `${tierSplit.tier1a > 0 ? ", " : ""}1B: ${tierSplit.tier1b}` : ""}{tierSplit.tier1Other > 0 ? `${(tierSplit.tier1a + tierSplit.tier1b) > 0 ? ", " : ""}P: ${tierSplit.tier1Other}` : ""}) · {formatCurrency(tierSplit.betfairStake)} staked</>
              ) : (
                <>{betsToday} placed today · {pending} open</>
              )}
            </span>
          )}
        </div>
      </div>

      {/* Circuit Breaker Banner */}
      {cbStatus && cbStatus.mode !== "paper" && cbStatus.currentDrawdownPct >= cbStatus.weeklyLimit * 0.6 && (
        <div className="rounded-lg border px-4 py-3 bg-red-500/10 border-red-500/30">
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
            <span className="text-sm text-red-300">
              Drawdown at {cbStatus.currentDrawdownPct.toFixed(1)}% — approaching {cbStatus.weeklyLimit}% weekly limit
            </span>
          </div>
        </div>
      )}

      {/* Primary Metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <PrimaryCard
          label="Net Profit"
          value={loadingSummary ? "—" : formatCurrency(pnl)}
          sub={!loadingSummary ? `Gross: ${formatCurrency(summary?.totalGrossPnl ?? 0)} · Comm: ${formatCurrency(summary?.totalCommission ?? 0)}` : (isLive ? "Net profit from live trading" : "Net profit from paper trading")}
          color={!loadingSummary ? (pnl >= 0 ? "green" : "red") : "default"}
        />
        <PrimaryCard
          label="ROI"
          value={loadingSummary ? "—" : `${roi >= 0 ? "+" : ""}${roi.toFixed(2)}%`}
          sub={!loadingSummary ? `Net after 5% commission · Gross: ${(summary?.grossRoiPct ?? 0) >= 0 ? "+" : ""}${(summary?.grossRoiPct ?? 0).toFixed(2)}%` : "Return on every £1 staked"}
          color={!loadingSummary ? (roi >= 0 ? "green" : "red") : "default"}
        />
        <PrimaryCard
          label="Win Rate"
          value={loadingSummary ? "—" : `${winPercentage.toFixed(1)}%`}
          sub={!loadingSummary ? `${wins}W – ${losses}L – ${voids}V (${settledBets} settled)` : undefined}
          color={!loadingSummary ? (winPercentage >= 50 ? "green" : "amber") : "default"}
        />
        <PrimaryCard
          label="CLV"
          labelSuffix={<ClvInfoIcon />}
          value={loadingSummary ? "—" : avgClv == null ? "No data" : `${avgClv >= 0 ? "+" : ""}${avgClv.toFixed(2)}%`}
          sub={(clvStats as any)?.count > 0
            ? `Across ${(clvStats as any).count} scored bets`
            : "How much better our odds are vs the market"}
          color={!loadingSummary ? clvColor : "default"}
        />
      </div>

      {/* In-Play Bets Section */}
      {inPlayBets.length > 0 && (
        <div className="rounded-xl border overflow-hidden" style={{ background: "#1e293b", borderColor: "#334155" }}>
          <div className="px-5 py-4 border-b flex items-center gap-3" style={{ borderColor: "#334155" }}>
            <Radio className="w-4 h-4 text-red-400 animate-pulse" />
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-white">In-Play Right Now</h3>
              <p className="text-xs text-slate-500 mt-0.5">Matches currently being played with your bets on them</p>
            </div>
            <span className="text-xs font-mono font-semibold px-2.5 py-1 rounded-full bg-red-500/15 text-red-400 border border-red-500/25">
              {inPlayBets.length} live
            </span>
          </div>
          <div className="divide-y" style={{ borderColor: "#334155" }}>
            {inPlayBets.slice(0, 5).map((bet: any) => (
              <div key={bet.id} className="px-5 py-3.5 hover:bg-slate-700/20 transition-colors">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-white truncate">
                        {bet.homeTeam} vs {bet.awayTeam}
                      </p>
                      {bet.homeScore != null && bet.awayScore != null && (
                        <span className="text-sm font-bold font-mono text-amber-400">
                          {bet.homeScore} - {bet.awayScore}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-slate-500 mt-0.5">{bet.league}</p>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      <span className="text-blue-400">{formatMarketType(bet.marketType)}</span>
                      {" · "}{bet.selectionName}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-mono font-bold text-white">{bet.oddsAtPlacement?.toFixed(2)}</p>
                    <p className="text-xs text-slate-400 font-mono">{formatCurrency(bet.stake)}</p>
                    {bet.minutesInPlay != null && (
                      <p className="text-[10px] text-amber-400 mt-0.5">{bet.minutesInPlay}' played</p>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Execution Metrics (when live) */}
      {execMetrics && execMetrics.fillRate?.livePlaced > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <SecondaryCard
            label="Fill Rate"
            value={execMetrics.fillRate.avgFillPct != null ? `${execMetrics.fillRate.avgFillPct}%` : "—"}
            sub={`${execMetrics.fillRate.fullyFilled} fully filled, ${execMetrics.fillRate.partialFilled} partial`}
            color={execMetrics.fillRate.avgFillPct >= 90 ? "green" : execMetrics.fillRate.avgFillPct >= 70 ? "amber" : "red"}
          />
          <SecondaryCard
            label="Signal Speed"
            value={execMetrics.timing.avgSignalToPlaceSecs != null ? `${execMetrics.timing.avgSignalToPlaceSecs}s` : "—"}
            sub="Average time from signal to Betfair placement"
          />
          <SecondaryCard
            label="Placed (24h)"
            value={execMetrics.fillRate.placed24h}
            sub={`${execMetrics.weekActivity.bets} this week`}
          />
          <SecondaryCard
            label="Betfair Proxy"
            value={execMetrics.relay.configured ? (execMetrics.relay.healthy ? "Healthy" : "Offline") : "Active (VPS)"}
            sub={execMetrics.relay.lastLatencyMs != null ? `${execMetrics.relay.lastLatencyMs}ms latency` : "Order relay: not configured"}
            color={execMetrics.relay.configured ? (execMetrics.relay.healthy ? "green" : "red") : "green"}
          />
        </div>
      )}

      {/* Agent Recommendations */}
      {recommendations && (recommendations as any).recommendations?.length > 0 && (
        <div className="rounded-xl border p-5" style={{ background: "#172033", borderColor: "#334155" }}>
          <div className="flex items-center gap-2 mb-3">
            <Zap className="w-4 h-4 text-amber-400" />
            <h3 className="text-sm font-semibold text-white">Agent Recommendations</h3>
          </div>
          <div className="space-y-2">
            {((recommendations as any).recommendations as any[]).slice(0, 3).map((rec: any, i: number) => (
              <div key={i} className="flex items-start gap-3 rounded-lg px-3 py-2 border" style={{ background: "#0f172a", borderColor: "#1e293b" }}>
                <span className={cn("text-xs font-bold px-1.5 py-0.5 rounded mt-0.5 shrink-0",
                  rec.priority === "high" ? "bg-red-900/50 text-red-400" :
                  rec.priority === "medium" ? "bg-amber-900/50 text-amber-400" :
                  "bg-slate-800 text-slate-400"
                )}>
                  {rec.priority?.toUpperCase() ?? "INFO"}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-slate-200">{rec.title ?? rec.message ?? rec}</p>
                  {rec.detail && <p className="text-xs text-slate-500 mt-0.5">{rec.detail}</p>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pipeline status (extracted from former Demo Day card) */}
      {experimentsData?.grouped && (
        <div className="rounded-xl border p-4 flex items-center gap-3 flex-wrap" style={{ background: "#1e293b", borderColor: "#334155" }}>
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

      {/* World Cup 2026 Readiness */}
      {tournamentData && (
        <div className="rounded-xl border p-5" style={{ background: "#1e293b", borderColor: "#334155" }}>
          <div className="flex items-start justify-between gap-4 mb-3 flex-wrap">
            <div>
              <p className="text-sm font-semibold text-white">World Cup 2026 Preparation</p>
              <p className="text-xs text-slate-500 mt-0.5">
                {(tournamentData as any).worldCup2026?.phase === "live"
                  ? "TOURNAMENT LIVE — increased polling and soft-line targeting active"
                  : (tournamentData as any).worldCup2026?.phase === "pre_tournament"
                  ? "Pre-tournament phase — early market lines available"
                  : `Preparation phase — ${(tournamentData as any).worldCup2026?.daysUntilStart ?? "?"} days until kickoff`}
              </p>
            </div>
            <div className="rounded-lg px-3 py-2 text-center border shrink-0" style={{ background: "#0f172a", borderColor: "#334155" }}>
              <p className={cn("text-2xl font-bold font-mono",
                ((tournamentData as any).worldCup2026?.daysUntilStart ?? 999) <= 30 ? "text-amber-400" :
                ((tournamentData as any).worldCup2026?.daysUntilStart ?? 999) <= 7 ? "text-red-400" : "text-blue-400")}>
                {(tournamentData as any).worldCup2026?.daysUntilStart ?? "?"}
              </p>
              <p className="text-[10px] text-slate-500 font-medium uppercase tracking-wide">days to WC</p>
            </div>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
            <div className="rounded-lg p-3 border" style={{ background: "#0f172a", borderColor: "#1e293b" }}>
              <p className="text-[10px] text-slate-500 uppercase font-semibold">Qualifiers Ingested</p>
              <p className="text-lg font-bold font-mono text-white">{(tournamentData as any).worldCup2026?.dataReadiness?.qualificationFixturesIngested ?? 0}</p>
            </div>
            <div className="rounded-lg p-3 border" style={{ background: "#0f172a", borderColor: "#1e293b" }}>
              <p className="text-[10px] text-slate-500 uppercase font-semibold">Soft-Line Nations</p>
              <p className="text-lg font-bold font-mono text-emerald-400">{(tournamentData as any).worldCup2026?.dataReadiness?.softLineNationsTracked ?? 0}</p>
            </div>
            <div className="rounded-lg p-3 border" style={{ background: "#0f172a", borderColor: "#1e293b" }}>
              <p className="text-[10px] text-slate-500 uppercase font-semibold">Friendlies Tracked</p>
              <p className="text-lg font-bold font-mono text-white">{(tournamentData as any).worldCup2026?.dataReadiness?.friendliesTracked ?? 0}</p>
            </div>
            <div className="rounded-lg p-3 border" style={{ background: "#0f172a", borderColor: "#1e293b" }}>
              <p className="text-[10px] text-slate-500 uppercase font-semibold">Active Qualifiers</p>
              <p className="text-lg font-bold font-mono text-white">
                {(tournamentData as any).activeTournaments?.filter((t: any) => t.type === "qualifier").length ?? 0}
                <span className="text-xs text-slate-500 ml-1">running</span>
              </p>
            </div>
          </div>

          {((tournamentData as any).activeTournaments ?? []).length > 0 && (
            <div className="space-y-1">
              {((tournamentData as any).activeTournaments ?? []).map((t: any) => (
                <div key={t.id} className="flex items-center justify-between text-xs px-2 py-1 rounded" style={{ background: "#0f172a" }}>
                  <span className="text-slate-300 font-medium">{t.name}</span>
                  <span className="flex items-center gap-2">
                    {t.isLive && <span className="text-emerald-400 font-bold text-[10px] uppercase">LIVE</span>}
                    {t.softLineNationCount > 0 && (
                      <span className="text-amber-400 text-[10px]">{t.softLineNationCount} soft-line nations</span>
                    )}
                    <span className="text-slate-500">{t.pollingMultiplier}x poll</span>
                  </span>
                </div>
              ))}
            </div>
          )}

          {(tournamentData as any).transferWindow?.isActive && (
            <div className="mt-2 rounded-lg border px-3 py-2 bg-amber-500/10 border-amber-500/30">
              <p className="text-xs text-amber-300">{(tournamentData as any).transferWindow?.note}</p>
            </div>
          )}

          {((tournamentData as any).seasonalWarnings ?? []).length > 0 && (
            <div className="mt-2 space-y-1">
              {((tournamentData as any).seasonalWarnings ?? []).map((w: any, i: number) => (
                <p key={i} className="text-xs text-amber-400">{w.message}</p>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Profit Chart */}
      <div className="rounded-xl border p-5" style={{ background: "#1e293b", borderColor: "#334155" }}>
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
                <XAxis dataKey="date" stroke="#475569" fontSize={10} tickLine={false} axisLine={false}
                  tickFormatter={(v) => new Date(v).toLocaleDateString("en-GB", { month: "short", day: "numeric" })} />
                <YAxis stroke="#475569" fontSize={10} tickLine={false} axisLine={false}
                  tickFormatter={(v) => `£${v}`} width={45} />
                <RechartsTooltip {...TOOLTIP_STYLE}
                  formatter={(v: number) => [formatCurrency(v), "Profit"]}
                  labelFormatter={(l) => new Date(l).toLocaleDateString("en-GB", { dateStyle: "long" })} />
                <Area type="monotone" dataKey="cumPnl"
                  stroke={isChartPositive ? "#10b981" : "#ef4444"} strokeWidth={2}
                  fill={isChartPositive ? "url(#profitGradPos)" : "url(#profitGradNeg)"}
                  dot={false} activeDot={{ r: 4, fill: isChartPositive ? "#10b981" : "#ef4444" }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Two Columns: Upcoming Bets + Recent Results */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Upcoming Bets */}
        <div className="rounded-xl border overflow-hidden flex flex-col" style={{ background: "#1e293b", borderColor: "#334155" }}>
          <div className="px-5 py-4 border-b flex items-center justify-between shrink-0" style={{ borderColor: "#334155" }}>
            <div>
              <h3 className="text-sm font-semibold text-white">Upcoming Bets</h3>
              <p className="text-xs text-slate-500 mt-0.5">Waiting for kickoff</p>
            </div>
            {upcomingBets.length > 0 && (
              <span className="text-xs font-mono font-semibold px-2.5 py-1 rounded-full bg-blue-500/15 text-blue-400 border border-blue-500/25">
                {upcomingBets.length}
              </span>
            )}
          </div>
          <div className="overflow-y-auto flex-1 divide-y" style={{ divideColor: "#334155", maxHeight: "440px" }}>
            {upcomingBets.length === 0 ? (
              <div className="px-5 py-10 text-center">
                <p className="text-sm text-slate-500">No upcoming bets.</p>
                <p className="text-xs text-slate-600 mt-1">The agent scans for value every 10 minutes.</p>
              </div>
            ) : (
              upcomingBets.slice(0, 10).map((bet: any) => (
                <div key={bet.id} className="px-5 py-3.5 hover:bg-slate-700/20 transition-colors">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-white truncate">{bet.homeTeam} vs {bet.awayTeam}</p>
                      <p className="text-[11px] text-slate-500 mt-0.5 truncate">{bet.league}</p>
                      <p className="text-[11px] text-slate-400 mt-0.5">
                        <span className="text-blue-400">{formatMarketType(bet.marketType)}</span>
                        {" · "}{bet.selectionName}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-mono font-bold text-white">{bet.oddsAtPlacement?.toFixed(2)}</p>
                      <p className="text-xs text-slate-400 font-mono">{formatCurrency(bet.stake)}</p>
                      {bet.countdownLabel && (
                        <p className="text-[10px] text-blue-400 mt-0.5 flex items-center gap-1 justify-end">
                          <Clock className="w-3 h-3" />{bet.countdownLabel}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Recent Results */}
        <div className="rounded-xl border overflow-hidden flex flex-col" style={{ background: "#1e293b", borderColor: "#334155" }}>
          <div className="px-5 py-4 border-b shrink-0" style={{ borderColor: "#334155" }}>
            <h3 className="text-sm font-semibold text-white">Recent Results</h3>
            <p className="text-xs text-slate-500 mt-0.5">Latest settled bets</p>
          </div>
          <div className="overflow-y-auto flex-1 divide-y" style={{ divideColor: "#334155", maxHeight: "440px" }}>
            {loadingPerf ? (
              <div className="p-5 space-y-3">
                {[...Array(5)].map((_, i) => (
                  <div key={i} className="h-14 rounded animate-pulse" style={{ background: "#0f172a" }} />
                ))}
              </div>
            ) : !perfData?.recentBets || (perfData.recentBets as any[]).length === 0 ? (
              <div className="px-5 py-10 text-center">
                <p className="text-sm text-slate-500">No settled bets yet.</p>
              </div>
            ) : (
              (perfData.recentBets as any[]).slice(0, 15).map((bet: any) => (
                <div
                  key={bet.id}
                  className={cn("px-5 py-3.5 flex items-center gap-3 border-l-[3px] transition-colors",
                    bet.status === "won" ? "border-l-emerald-500 hover:bg-emerald-950/20"
                    : bet.status === "lost" ? "border-l-red-500 hover:bg-red-950/20"
                    : "border-l-slate-600 hover:bg-slate-700/10")}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium text-white truncate">{bet.homeTeam} vs {bet.awayTeam}</p>
                      <BetStatusBadge status={bet.status} />
                    </div>
                    <p className="text-[11px] text-slate-500 mt-0.5 truncate">
                      {formatMarketType(bet.marketType)} · {bet.selectionName} @ {Number(bet.oddsAtPlacement).toFixed(2)}
                    </p>
                    <p className="text-[10px] text-slate-600 mt-0.5">{formatRelativeTime(bet.settledAt ?? bet.placedAt)}</p>
                  </div>
                  {bet.settlementPnl != null && (
                    <p className={cn("text-sm font-bold font-mono shrink-0",
                      Number(bet.settlementPnl) > 0 ? "text-emerald-400"
                      : Number(bet.settlementPnl) < 0 ? "text-red-400" : "text-slate-500")}>
                      {Number(bet.settlementPnl) > 0 ? "+" : ""}{formatCurrency(Number(bet.settlementPnl))}
                    </p>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Agent Intelligence */}
      <div>
        <div className="mb-4">
          <h3 className="text-base font-semibold text-white">Agent Intelligence</h3>
          <p className="text-xs text-slate-500 mt-0.5">What the model has discovered from its results</p>
        </div>
        {loadingNarratives ? (
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-20 rounded-xl animate-pulse" style={{ background: "#1e293b" }} />
            ))}
          </div>
        ) : narratives.length === 0 ? (
          <div className="rounded-xl border p-10 text-center text-sm text-slate-500" style={{ background: "#1e293b", borderColor: "#334155" }}>
            No learning signals yet. They appear after the first retraining cycle (daily at 03:00 UTC).
          </div>
        ) : (
          <div className="space-y-3">
            {narratives.map((n: any) => (
              <div key={n.id} className="rounded-xl border flex items-start gap-4 px-5 py-4" style={{ background: "#1e293b", borderColor: "#334155" }}>
                <span className="text-xl leading-none mt-0.5 shrink-0">{getNarrativeEmoji(n.narrativeType)}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-slate-200 leading-relaxed">{generateNarrativeText(n)}</p>
                </div>
                <p className="text-[11px] text-slate-600 shrink-0 pt-0.5 whitespace-nowrap">
                  {formatRelativeTime(n.createdAt)}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
