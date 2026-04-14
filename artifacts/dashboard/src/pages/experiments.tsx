import { useState, useMemo } from "react";
import { useExperiments, useRunPromotionEngine, useManualPromote } from "@/hooks/use-dashboard";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const tierColors: Record<string, { bg: string; border: string; text: string; dot: string }> = {
  experiment: { bg: "#1e1b4b", border: "#4c1d95", text: "#c4b5fd", dot: "#8b5cf6" },
  candidate: { bg: "#451a03", border: "#92400e", text: "#fcd34d", dot: "#f59e0b" },
  promoted: { bg: "#052e16", border: "#166534", text: "#86efac", dot: "#22c55e" },
  demoted: { bg: "#1c1917", border: "#7f1d1d", text: "#fca5a5", dot: "#ef4444" },
  abandoned: { bg: "#1e1e1e", border: "#374151", text: "#9ca3af", dot: "#6b7280" },
};

function ProgressBar({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-slate-500 w-16 text-right shrink-0">{label}</span>
      <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${Math.min(100, value)}%`, background: value >= 100 ? "#22c55e" : color }}
        />
      </div>
      <span className="text-[10px] font-mono w-8 text-right" style={{ color: value >= 100 ? "#22c55e" : "#94a3b8" }}>
        {value}%
      </span>
    </div>
  );
}

function DistanceBadge({ label, value, unit }: { label: string; value: number; unit: string }) {
  if (value <= 0) return (
    <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-emerald-900/50 text-emerald-400 border border-emerald-800">
      {label} ✓
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700">
      {label}: +{typeof value === "number" ? value.toFixed(value < 10 ? 1 : 0) : value}{unit}
    </span>
  );
}

function TierCard({ tier, experiments }: { tier: string; experiments: any[] }) {
  const colors = tierColors[tier] ?? tierColors.abandoned;
  return (
    <div className="rounded-xl border p-4" style={{ background: colors.bg, borderColor: colors.border }}>
      <div className="flex items-center gap-2 mb-3">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: colors.dot }} />
        <span className="text-sm font-bold uppercase tracking-wider" style={{ color: colors.text }}>
          {tier}
        </span>
        <span className="ml-auto text-xs font-mono px-2 py-0.5 rounded" style={{ background: "#0f172a", color: colors.text }}>
          {experiments.length}
        </span>
      </div>
      {experiments.length === 0 ? (
        <p className="text-xs text-slate-600 italic">No experiments in this tier</p>
      ) : (
        <div className="space-y-2">
          {experiments.map((exp: any, i: number) => (
            <ExperimentRow key={exp.experimentTag ?? i} exp={exp} tier={tier} />
          ))}
        </div>
      )}
    </div>
  );
}

function formatTimeAgo(dateStr: string | null): string {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return "< 1h ago";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function ExperimentRow({ exp, tier }: { exp: any; tier: string }) {
  const [expanded, setExpanded] = useState(false);
  const promote = useManualPromote();
  const [targetTier, setTargetTier] = useState("candidate");
  const [reason, setReason] = useState("");
  const isAbandoned = tier === "abandoned";

  const hasBets = (exp.sampleSize ?? 0) > 0;
  const roi = hasBets ? Number(exp.roi).toFixed(1) : "—";
  const winRate = hasBets ? Number(exp.winRate).toFixed(1) : "—";
  const clv = hasBets ? Number(exp.clv).toFixed(2) : "—";

  return (
    <div className={cn("rounded-lg border p-3", isAbandoned && "opacity-50")} style={{ background: isAbandoned ? "#111111" : "#0f172a", borderColor: isAbandoned ? "#1e1e1e" : "#334155" }}>
      <div className="flex items-center justify-between cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <span className={cn("text-sm font-semibold", isAbandoned ? "text-slate-500 line-through" : "text-white")}>{exp.experimentTag ?? "unknown"}</span>
          <span className="text-xs text-slate-500">{exp.sampleSize ?? 0} bets</span>
          {exp.progress && !isAbandoned && (
            <span
              className="text-[10px] font-mono px-1.5 py-0.5 rounded"
              style={{
                background: exp.progress.overall >= 100 ? "#052e16" : "#1e293b",
                color: exp.progress.overall >= 100 ? "#22c55e" : "#64748b",
                border: `1px solid ${exp.progress.overall >= 100 ? "#166534" : "#334155"}`,
              }}
            >
              {exp.progress.overall}% ready
            </span>
          )}
          {exp.betsPerWeek > 0 && !isAbandoned && (
            <span className="text-[10px] text-slate-600 font-mono">{exp.betsPerWeek}/wk</span>
          )}
          {exp.estWeeksToEval != null && tier === "experiment" && (
            <span className="text-[10px] text-blue-400/70 font-mono">~{exp.estWeeksToEval}w to eval</span>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs shrink-0">
          <span className={cn("font-mono", Number(exp.roi) >= 0 ? "text-emerald-400" : "text-red-400")}>
            ROI: {roi}%
          </span>
          <span className="text-slate-400 font-mono">WR: {winRate}%</span>
          <span className="text-blue-300 font-mono">CLV: {clv}%</span>
          <span className="text-slate-600 text-lg">{expanded ? "▾" : "▸"}</span>
        </div>
      </div>
      {expanded && (
        <div className="mt-3 pt-3 border-t" style={{ borderColor: "#334155" }}>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3 text-xs mb-3">
            <div>
              <span className="text-slate-500 block">Sample Size</span>
              <span className="text-white font-mono">{exp.sampleSize ?? 0}</span>
            </div>
            <div>
              <span className="text-slate-500 block">P-Value</span>
              <span className={cn("font-mono", Number(exp.pValue) <= 0.1 ? "text-emerald-400" : "text-amber-400")}>
                {hasBets ? Number(exp.pValue).toFixed(3) : "—"}
              </span>
            </div>
            <div>
              <span className="text-slate-500 block">Edge</span>
              <span className="text-white font-mono">{hasBets ? Number(exp.edge).toFixed(1) + "%" : "—"}</span>
            </div>
            <div>
              <span className="text-slate-500 block">League</span>
              <span className="text-white font-mono text-[10px]">{exp.leagueCode ?? "—"}</span>
            </div>
            <div>
              <span className="text-slate-500 block">Market</span>
              <span className="text-white font-mono text-[10px]">{exp.marketType ?? "—"}</span>
            </div>
            <div>
              <span className="text-slate-500 block">Last Bet</span>
              <span className="text-slate-400 font-mono text-[10px]">{formatTimeAgo(exp.lastBetAt)}</span>
            </div>
          </div>

          {tier === "experiment" && exp.progress && (
            <div className="mb-3 space-y-1.5 p-2 rounded-lg" style={{ background: "#0c0a1f" }}>
              <span className="text-[10px] text-slate-500 font-semibold uppercase tracking-wider">Progress to Candidate</span>
              <ProgressBar value={exp.progress.sampleSize} label="Sample" color="#8b5cf6" />
              <ProgressBar value={exp.progress.roi} label="ROI" color="#3b82f6" />
              <ProgressBar value={exp.progress.clv} label="CLV" color="#06b6d4" />
              <ProgressBar value={exp.progress.winRate} label="Win Rate" color="#f59e0b" />
              <ProgressBar value={exp.progress.pValue} label="P-Value" color="#ec4899" />
              <ProgressBar value={exp.progress.edge} label="Edge" color="#14b8a6" />
            </div>
          )}

          {tier === "experiment" && exp.distance && (
            <div className="flex flex-wrap gap-1 mb-3">
              <DistanceBadge label="Bets" value={exp.distance.betsNeeded} unit="" />
              <DistanceBadge label="ROI" value={exp.distance.roiNeeded} unit="%" />
              <DistanceBadge label="CLV" value={exp.distance.clvNeeded} unit="%" />
              <DistanceBadge label="WR" value={exp.distance.winRateNeeded} unit="%" />
            </div>
          )}

          {(tier === "experiment" || tier === "candidate" || tier === "promoted") && (
            <div className="flex items-center gap-2 pt-2 border-t" style={{ borderColor: "#1e293b" }}>
              <Select value={targetTier} onValueChange={setTargetTier}>
                <SelectTrigger className="w-[130px] h-7 text-xs border-slate-700 bg-slate-800/50">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {tier !== "candidate" && <SelectItem value="candidate">Candidate</SelectItem>}
                  {tier !== "promoted" && <SelectItem value="promoted">Promoted</SelectItem>}
                  {tier !== "experiment" && <SelectItem value="experiment">Experiment</SelectItem>}
                  <SelectItem value="abandoned">Abandoned</SelectItem>
                  <SelectItem value="demoted">Demoted</SelectItem>
                </SelectContent>
              </Select>
              <input
                className="flex-1 h-7 text-xs rounded border px-2 bg-slate-800/50 text-white placeholder:text-slate-600"
                style={{ borderColor: "#334155" }}
                placeholder="Reason for promotion/demotion..."
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs border-slate-700"
                disabled={!reason.trim() || promote.isPending}
                onClick={() => {
                  promote.mutate({
                    experiment_tag: exp.experimentTag,
                    target_tier: targetTier,
                    reason: reason.trim(),
                  });
                  setReason("");
                }}
              >
                {promote.isPending ? "..." : "Apply"}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Experiments() {
  const { data, isLoading } = useExperiments();
  const runEngine = useRunPromotionEngine();

  const grouped = data?.grouped ?? { experiment: [], candidate: [], promoted: [], demoted: [], abandoned: [] };

  const closestToPromotion = useMemo(() => {
    const experiments = grouped.experiment ?? [];
    if (experiments.length === 0) return null;
    return experiments.reduce((best: any, exp: any) => {
      if (!best || (exp.progress?.overall ?? 0) > (best.progress?.overall ?? 0)) return exp;
      return best;
    }, null);
  }, [grouped.experiment]);

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white tracking-tight">Experiment Lab</h2>
          <p className="text-sm text-slate-500 mt-1">
            Track experiments through the pipeline: experiment → candidate → promoted.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-xs border-slate-700 gap-1.5"
          disabled={runEngine.isPending}
          onClick={() => runEngine.mutate()}
        >
          {runEngine.isPending ? "Running..." : "Run Promotion Engine"}
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="rounded-xl border p-4" style={{ background: "#1e293b", borderColor: "#334155" }}>
          <span className="text-xs text-slate-500 uppercase tracking-wider font-semibold">Total Active</span>
          <p className="text-2xl font-bold text-white mt-1">{data?.total ?? 0}</p>
          <p className="text-[10px] text-slate-600 mt-0.5">with bets placed</p>
        </div>
        <div className="rounded-xl border p-4" style={{ background: "#1e293b", borderColor: "#334155" }}>
          <span className="text-xs text-slate-500 uppercase tracking-wider font-semibold">Experiments</span>
          <p className="text-2xl font-bold text-violet-400 mt-1">{grouped.experiment?.length ?? 0}</p>
          <p className="text-[10px] text-slate-600 mt-0.5">gathering data</p>
        </div>
        <div className="rounded-xl border p-4" style={{ background: "#1e293b", borderColor: "#334155" }}>
          <span className="text-xs text-slate-500 uppercase tracking-wider font-semibold">Candidates</span>
          <p className="text-2xl font-bold text-amber-400 mt-1">{grouped.candidate?.length ?? 0}</p>
          <p className="text-[10px] text-slate-600 mt-0.5">awaiting validation</p>
        </div>
        <div className="rounded-xl border p-4" style={{ background: "#052e16", borderColor: "#166534" }}>
          <span className="text-xs text-emerald-500 uppercase tracking-wider font-semibold">Promoted</span>
          <p className="text-2xl font-bold text-emerald-400 mt-1">{grouped.promoted?.length ?? 0}</p>
          <p className="text-[10px] text-emerald-700 mt-0.5">production-ready</p>
        </div>
      </div>

      {closestToPromotion && (
        <div className="rounded-xl border p-4" style={{ background: "#1e1b4b", borderColor: "#4c1d95" }}>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <span className="text-[10px] text-violet-400 uppercase tracking-wider font-semibold">Closest to Promotion</span>
              <p className="text-sm font-bold text-white mt-0.5">{closestToPromotion.experimentTag}</p>
            </div>
            <div className="flex items-center gap-4 text-xs">
              <span className="font-mono text-violet-300">{closestToPromotion.progress?.overall ?? 0}% ready</span>
              <span className="font-mono text-slate-400">{closestToPromotion.sampleSize} bets</span>
              {closestToPromotion.estWeeksToEval != null && (
                <span className="font-mono text-blue-300">~{closestToPromotion.estWeeksToEval}w to eval</span>
              )}
              <span className={cn("font-mono", Number(closestToPromotion.roi) >= 0 ? "text-emerald-400" : "text-red-400")}>
                ROI: {Number(closestToPromotion.roi).toFixed(1)}%
              </span>
            </div>
          </div>
          {closestToPromotion.progress && (
            <div className="mt-2 h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${Math.min(100, closestToPromotion.progress.overall)}%`, background: "#8b5cf6" }}
              />
            </div>
          )}
        </div>
      )}

      {data?.thresholds && (
        <div className="rounded-lg border p-3 text-xs" style={{ background: "#0f172a", borderColor: "#1e293b" }}>
          <span className="text-slate-500 font-semibold">Promotion thresholds: </span>
          <span className="text-slate-400">
            ≥{data.thresholds.minSampleSize} bets, ≥{data.thresholds.minRoi}% ROI, ≥{data.thresholds.minClv}% CLV,
            ≥{data.thresholds.minWinRate}% WR, ≤{data.thresholds.maxPValue} p-value, ≥{data.thresholds.minWeeksActive} weeks,
            ≥{data.thresholds.minEdge}% edge
          </span>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-32 rounded-xl animate-pulse" style={{ background: "#1e293b" }} />
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          <TierCard tier="promoted" experiments={grouped.promoted ?? []} />
          <TierCard tier="candidate" experiments={grouped.candidate ?? []} />
          <TierCard tier="experiment" experiments={grouped.experiment ?? []} />
          {(grouped.demoted?.length > 0 || grouped.abandoned?.length > 0) && (
            <>
              <TierCard tier="demoted" experiments={grouped.demoted ?? []} />
              <TierCard tier="abandoned" experiments={grouped.abandoned ?? []} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
