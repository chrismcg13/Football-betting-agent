import { useState } from "react";
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

function ExperimentRow({ exp, tier }: { exp: any; tier: string }) {
  const [expanded, setExpanded] = useState(false);
  const promote = useManualPromote();
  const [targetTier, setTargetTier] = useState("candidate");
  const [reason, setReason] = useState("");

  const roi = exp.roi != null ? (Number(exp.roi) * 100).toFixed(1) : "—";
  const winRate = exp.winRate != null ? (Number(exp.winRate) * 100).toFixed(1) : "—";
  const clv = exp.avgClv != null ? Number(exp.avgClv).toFixed(2) : "—";

  return (
    <div className="rounded-lg border p-3" style={{ background: "#0f172a", borderColor: "#334155" }}>
      <div className="flex items-center justify-between cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <div>
          <span className="text-sm font-semibold text-white">{exp.experimentTag ?? "unknown"}</span>
          <span className="ml-2 text-xs text-slate-500">{exp.betCount ?? 0} bets</span>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className={cn("font-mono", Number(exp.roi) >= 0 ? "text-emerald-400" : "text-red-400")}>
            ROI: {roi}%
          </span>
          <span className="text-slate-400 font-mono">WR: {winRate}%</span>
          <span className="text-blue-300 font-mono">CLV: {clv}%</span>
        </div>
      </div>
      {expanded && (
        <div className="mt-3 pt-3 border-t" style={{ borderColor: "#334155" }}>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs mb-3">
            <div>
              <span className="text-slate-500 block">Sample Size</span>
              <span className="text-white font-mono">{exp.betCount ?? 0}</span>
            </div>
            <div>
              <span className="text-slate-500 block">Won / Lost</span>
              <span className="text-white font-mono">{exp.won ?? 0} / {exp.lost ?? 0}</span>
            </div>
            <div>
              <span className="text-slate-500 block">Total P&L</span>
              <span className={cn("font-mono", Number(exp.totalPnl) >= 0 ? "text-emerald-400" : "text-red-400")}>
                {Number(exp.totalPnl) >= 0 ? "+" : ""}{Number(exp.totalPnl ?? 0).toFixed(2)}
              </span>
            </div>
            <div>
              <span className="text-slate-500 block">Avg Edge</span>
              <span className="text-white font-mono">{exp.avgEdge != null ? (Number(exp.avgEdge) * 100).toFixed(1) + "%" : "—"}</span>
            </div>
          </div>
          {(tier === "experiment" || tier === "candidate") && (
            <div className="flex items-center gap-2 pt-2 border-t" style={{ borderColor: "#1e293b" }}>
              <Select value={targetTier} onValueChange={setTargetTier}>
                <SelectTrigger className="w-[130px] h-7 text-xs border-slate-700 bg-slate-800/50">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="candidate">Candidate</SelectItem>
                  <SelectItem value="promoted">Promoted</SelectItem>
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

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-xl border p-4" style={{ background: "#1e293b", borderColor: "#334155" }}>
          <span className="text-xs text-slate-500 uppercase tracking-wider font-semibold">Total Experiments</span>
          <p className="text-2xl font-bold text-white mt-1">{data?.total ?? 0}</p>
        </div>
        <div className="rounded-xl border p-4" style={{ background: "#1e293b", borderColor: "#334155" }}>
          <span className="text-xs text-slate-500 uppercase tracking-wider font-semibold">Active (Exp + Candidate)</span>
          <p className="text-2xl font-bold text-amber-400 mt-1">
            {(grouped.experiment?.length ?? 0) + (grouped.candidate?.length ?? 0)}
          </p>
        </div>
        <div className="rounded-xl border p-4" style={{ background: "#1e293b", borderColor: "#334155" }}>
          <span className="text-xs text-slate-500 uppercase tracking-wider font-semibold">Promoted</span>
          <p className="text-2xl font-bold text-emerald-400 mt-1">{grouped.promoted?.length ?? 0}</p>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-32 rounded-xl animate-pulse" style={{ background: "#1e293b" }} />
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          <TierCard tier="experiment" experiments={grouped.experiment ?? []} />
          <TierCard tier="candidate" experiments={grouped.candidate ?? []} />
          <TierCard tier="promoted" experiments={grouped.promoted ?? []} />
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
