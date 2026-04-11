import { useMemo } from "react";
import { useViability, useModel, useBetsByLeague, useBetsByMarket, useClvStats } from "@/hooks/use-dashboard";
import { formatCurrency } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckCircle2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Traffic Light ────────────────────────────────────────────────────────────

const SIGNAL_CONFIG = {
  GREEN: {
    label: "GO — Fund £499",
    explanation:
      "The model is consistently finding value edges. Conservative projections show recoup within 2 months. This system is ready for live capitalisation.",
    color: "#10b981",
    shadow: "rgba(16,185,129,0.5)",
    bg: "rgba(16,185,129,0.08)",
    border: "rgba(16,185,129,0.25)",
    text: "#10b981",
    order: 2,
  },
  AMBER: {
    label: "EXTEND — More Data Needed",
    explanation:
      "Returns are promising but projections are marginal. Run for another 2–4 weeks to build a statistically robust dataset before committing capital.",
    color: "#f59e0b",
    shadow: "rgba(245,158,11,0.5)",
    bg: "rgba(245,158,11,0.06)",
    border: "rgba(245,158,11,0.2)",
    text: "#f59e0b",
    order: 1,
  },
  RED: {
    label: "DO NOT FUND — Model Needs Improvement",
    explanation:
      "At current ROI the model would not recoup the £499 system cost within a reasonable timeframe. Review feature quality, edge thresholds, and market selection.",
    color: "#ef4444",
    shadow: "rgba(239,68,68,0.5)",
    bg: "rgba(239,68,68,0.06)",
    border: "rgba(239,68,68,0.2)",
    text: "#ef4444",
    order: 0,
  },
} as const;

type Signal = keyof typeof SIGNAL_CONFIG;

function TrafficLight({ signal }: { signal: Signal }) {
  const lights = [
    { sig: "GREEN" as Signal, color: "#10b981", label: "Go" },
    { sig: "AMBER" as Signal, color: "#f59e0b", label: "Caution" },
    { sig: "RED" as Signal, color: "#ef4444", label: "No" },
  ];

  const cfg = SIGNAL_CONFIG[signal];

  return (
    <div
      className="rounded-2xl border p-8 flex flex-col items-center gap-6"
      style={{ background: cfg.bg, borderColor: cfg.border }}
    >
      {/* Traffic light housing */}
      <div
        className="rounded-2xl px-8 py-6 flex flex-col gap-4 border"
        style={{
          background: "#0a0f18",
          borderColor: "#1e293b",
          boxShadow: "inset 0 2px 8px rgba(0,0,0,0.4)",
        }}
      >
        {[...lights].reverse().map(({ sig, color }) => {
          const isActive = sig === signal;
          return (
            <div
              key={sig}
              className="w-24 h-24 rounded-full flex items-center justify-center transition-all duration-700"
              style={{
                background: isActive ? color : "#0f1c2e",
                boxShadow: isActive
                  ? `0 0 40px ${cfg.shadow}, 0 0 80px ${cfg.shadow}40`
                  : "none",
                border: isActive ? `2px solid ${color}` : "2px solid #1e293b",
              }}
            >
              {isActive && (
                <div
                  className="w-12 h-12 rounded-full animate-pulse"
                  style={{ background: `${color}cc` }}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Signal label */}
      <div className="text-center space-y-2">
        <p className="text-xs font-mono uppercase tracking-widest text-slate-500">Signal</p>
        <h2 className="text-2xl font-bold" style={{ color: cfg.text }}>{cfg.label}</h2>
        <p className="text-sm text-slate-400 max-w-lg leading-relaxed">{cfg.explanation}</p>
      </div>
    </div>
  );
}

// ─── Projection Card ──────────────────────────────────────────────────────────

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
  const goodRecoup = months != null && months <= 2;

  return (
    <div
      className={cn("rounded-xl border p-5 flex flex-col gap-4 relative")}
      style={{
        background: highlight ? "#1e293b" : "#172033",
        borderColor: highlight ? "#4b5563" : "#334155",
        boxShadow: highlight ? "0 0 0 1px rgba(255,255,255,0.05)" : "none",
      }}
    >
      {highlight && (
        <div
          className="absolute -top-px left-8 right-8 h-px"
          style={{
            background: "linear-gradient(to right, transparent, #94a3b8, transparent)",
          }}
        />
      )}
      <div>
        <div className="flex items-center justify-between mb-1">
          <p className="text-sm font-semibold text-white">{title}</p>
          {highlight && (
            <span className="text-[10px] font-mono uppercase tracking-wider text-slate-400 bg-slate-700 px-2 py-0.5 rounded">
              Primary
            </span>
          )}
        </div>
        <p className="text-xs text-slate-500">{desc}</p>
        <p className="text-[11px] text-slate-600 italic mt-0.5">{assumption}</p>
      </div>

      <div className="space-y-3">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-slate-600 font-semibold mb-1">
            Monthly Profit
          </p>
          <p
            className="text-3xl font-bold font-mono"
            style={{ color: isProfitable ? "#10b981" : "#ef4444" }}
          >
            {profit != null ? `${isProfitable ? "+" : ""}${formatCurrency(profit)}` : "—"}
          </p>
        </div>

        <div>
          <p className="text-[10px] uppercase tracking-wider text-slate-600 font-semibold mb-1">
            Months to Recoup £499
          </p>
          <p
            className="text-xl font-bold font-mono"
            style={{
              color: goodRecoup ? "#10b981" : months != null ? "#f59e0b" : "#475569",
            }}
          >
            {months != null ? `${months.toFixed(1)} mo` : "—"}
          </p>
        </div>

        {minBankroll != null && (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-slate-600 font-semibold mb-1">
              Min Bankroll Needed
            </p>
            <p className="text-base font-mono text-slate-300">{formatCurrency(minBankroll)}</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Criteria Row ─────────────────────────────────────────────────────────────

function CriteriaRow({ label, value, pass, note }: {
  label: string;
  value: string;
  pass: boolean;
  note?: string;
}) {
  return (
    <tr
      className="border-b transition-colors hover:bg-slate-800/20"
      style={{ borderColor: "#1e3a5f" }}
    >
      <td className="py-3.5 pl-5 pr-3 w-8">
        {pass
          ? <CheckCircle2 className="h-4 w-4 text-emerald-400" />
          : <XCircle className="h-4 w-4 text-red-400" />}
      </td>
      <td className="py-3.5 text-sm text-slate-300">{label}</td>
      <td className="py-3.5 text-right font-mono text-sm pr-3">
        <span style={{ color: pass ? "#10b981" : "#ef4444" }}>{value}</span>
      </td>
      {note && (
        <td className="py-3.5 text-right text-xs text-slate-600 pr-5">{note}</td>
      )}
    </tr>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Viability() {
  const { data: via, isLoading } = useViability();
  const { data: model } = useModel();
  const { data: byLeague } = useBetsByLeague();
  const { data: byMarket } = useBetsByMarket();
  const { data: clvStats } = useClvStats();

  const accuracyTrend = useMemo(() => {
    const h = (model?.accuracyHistory as any[]) ?? [];
    if (h.length < 2) return "flat";
    const delta = (h[h.length - 1]?.accuracy ?? 0) - (h[0]?.accuracy ?? 0);
    if (delta > 0.02) return "improving";
    if (delta < -0.02) return "declining";
    return "flat";
  }, [model]);

  const edgeDiversity = useMemo(() => {
    const leagues = ((byLeague as any[]) ?? []).filter((l: any) => l.roi > 0).length;
    const markets = ((byMarket as any[]) ?? []).filter((m: any) => m.roi > 0).length;
    return leagues + markets;
  }, [byLeague, byMarket]);

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-4xl mx-auto">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-96 w-full rounded-2xl" />
        <div className="grid grid-cols-3 gap-4">
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
        </div>
        <Skeleton className="h-72" />
      </div>
    );
  }

  const signal = (via?.trafficLightSignal ?? "RED") as Signal;
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
      <div>
        <h2 className="text-2xl font-bold text-white tracking-tight">Go Live Calculator</h2>
        <p className="text-sm text-slate-500 mt-1">
          Evidence-based decision framework for the £499 go-live investment.
        </p>
      </div>

      <TrafficLight signal={signal} />

      {/* Scenarios */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-4">
          Profit Projections
        </p>
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
            assumption="Historical averages with some friction"
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

      {/* Criteria checklist */}
      <div
        className="rounded-xl border overflow-hidden"
        style={{ background: "#1e293b", borderColor: "#334155" }}
      >
        <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: "#334155" }}>
          <div>
            <p className="text-sm font-semibold text-white">Supporting Criteria</p>
            <p className="text-xs text-slate-500 mt-0.5">All criteria must pass for a confident funding decision.</p>
          </div>
          <span
            className="text-[11px] font-mono px-3 py-1.5 rounded-full border font-semibold"
            style={{
              background: allPass ? "rgba(16,185,129,0.1)" : "rgba(239,68,68,0.1)",
              color: allPass ? "#10b981" : "#ef4444",
              borderColor: allPass ? "rgba(16,185,129,0.3)" : "rgba(239,68,68,0.3)",
            }}
          >
            {allPass ? "All Criteria Met ✓" : "Criteria Failing"}
          </span>
        </div>
        <table className="w-full">
          <thead>
            <tr className="border-b" style={{ borderColor: "#334155" }}>
              <th className="py-2.5 pl-5 pr-3 w-8" />
              <th className="py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Criterion
              </th>
              <th className="py-2.5 pr-3 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Value
              </th>
              <th className="py-2.5 pr-5 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Threshold
              </th>
            </tr>
          </thead>
          <tbody>
            <CriteriaRow label="Paper trading days elapsed" value={`${days} days`} pass={days >= 14} note="≥ 14 days" />
            <CriteriaRow label="Total settled bets" value={`${bets} bets`} pass={bets >= 30} note="≥ 30 bets" />
            <CriteriaRow label="Average ROI per bet" value={`${roi.toFixed(2)}%`} pass={roi > 0} note="Must be positive" />
            <CriteriaRow label="Average bets per week" value={`${bpw.toFixed(1)} / week`} pass={bpw >= 3} note="≥ 3 / week" />
            <CriteriaRow label="Average stake size" value={formatCurrency(stake)} pass={stake >= 5} note="≥ £5 avg stake" />
            <CriteriaRow
              label="Model accuracy trend"
              value={accuracyTrend.charAt(0).toUpperCase() + accuracyTrend.slice(1)}
              pass={trendPass}
              note="Not declining"
            />
            <CriteriaRow
              label="Edge diversity (profitable segments)"
              value={`${edgeDiversity} segments`}
              pass={diversityPass}
              note="≥ 2 segments"
            />
            <CriteriaRow label="Agent active" value={days > 0 ? "Active" : "Inactive"} pass={days > 0} note="Must be running" />
            {(clvStats as any)?.count > 0 && (
              <>
                <CriteriaRow
                  label="Avg Closing Line Value (CLV)"
                  value={(clvStats as any)?.avgClv != null ? `${Number((clvStats as any).avgClv) >= 0 ? "+" : ""}${Number((clvStats as any).avgClv).toFixed(2)}%` : "—"}
                  pass={(clvStats as any)?.avgClv != null && Number((clvStats as any).avgClv) >= 0}
                  note="Must be ≥ 0% (beating close)"
                />
                <CriteriaRow
                  label="Pinnacle-validated bets"
                  value={(clvStats as any)?.pinnacleCount > 0 ? `${(clvStats as any).pinnacleCount} bets` : "None yet"}
                  pass={(clvStats as any)?.pinnacleCount > 0}
                  note="≥ 1 sharp-line verified"
                />
              </>
            )}
          </tbody>
        </table>
      </div>

      {/* Footer note */}
      <div
        className="rounded-xl border px-6 py-4 text-sm text-slate-500 text-center leading-relaxed"
        style={{ background: "#172033", borderColor: "#334155" }}
      >
        The £499 funding decision should only be made when the signal is{" "}
        <span className="text-emerald-400 font-semibold">GREEN</span> and all criteria show{" "}
        <span className="text-emerald-400 font-semibold">green ticks</span>.
        Conservative projections are used because real-money execution always underperforms paper trading.
      </div>
    </div>
  );
}
