import { useState } from "react";
import { useLaunchPreflight, useLaunchActivation } from "@/hooks/use-dashboard";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Rocket, CheckCircle, XCircle, AlertTriangle, Loader2 } from "lucide-react";

function CheckRow({ name, passed, detail }: { name: string; passed: boolean; detail: string }) {
  return (
    <div className={cn("flex items-start gap-3 rounded-lg border p-3", passed ? "border-emerald-800/40 bg-emerald-950/20" : "border-red-800/40 bg-red-950/20")}>
      {passed ? <CheckCircle className="h-5 w-5 text-emerald-400 mt-0.5 shrink-0" /> : <XCircle className="h-5 w-5 text-red-400 mt-0.5 shrink-0" />}
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-200">{name}</p>
        <p className="text-xs text-slate-400 mt-0.5 break-all">{detail}</p>
      </div>
    </div>
  );
}

function formatCurrency(v: number) {
  return `£${v.toFixed(2)}`;
}

export default function Launch() {
  const { data: preflight, isLoading: preflightLoading } = useLaunchPreflight();
  const launchMutation = useLaunchActivation();
  const [report, setReport] = useState<any>(null);

  const handleLaunch = async () => {
    const result = await launchMutation.mutateAsync();
    setReport(result);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Rocket className="h-6 w-6 text-orange-400" />
            Launch Activation
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Scan paper bets for Tier 1 live promotion and execute the launch batch
          </p>
        </div>
        <div className="flex items-center gap-3">
          {preflight && (
            <span className={cn("text-xs font-bold px-3 py-1.5 rounded-full", preflight.mode === "LIVE" ? "bg-red-600 text-white" : "bg-blue-600 text-white")}>
              {preflight.mode} MODE
            </span>
          )}
        </div>
      </div>

      {preflightLoading && (
        <div className="flex items-center gap-2 text-slate-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading preflight status...
        </div>
      )}

      {preflight && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard label="Risk Level" value={`Level ${preflight.riskLevel}`} sub={preflight.riskLevel === 1 ? "Conservative" : "Elevated"} />
          <StatCard label="Opp Score Threshold" value={String(preflight.oppThreshold)} sub="Minimum to qualify" />
          <StatCard label="Commission Rate" value={`${(preflight.commissionRate * 100).toFixed(1)}%`} sub="Betfair commission" />
          <StatCard label="Max Single Bet" value={formatCurrency(preflight.limits?.maxSingleBet ?? 0)} sub={`${((preflight.limits?.config?.maxSingleBetPct ?? 0) * 100).toFixed(1)}% of balance`} />
        </div>
      )}

      {preflight && (
        <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-5">
          <h2 className="text-lg font-semibold text-white mb-3">Exposure Limits (Level {preflight.riskLevel})</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <LimitCard label="Max Single Bet" value={formatCurrency(preflight.limits?.maxSingleBet ?? 0)} pct={`${((preflight.limits?.config?.maxSingleBetPct ?? 0) * 100).toFixed(1)}%`} />
            <LimitCard label="Max Open Exposure" value={formatCurrency(preflight.limits?.maxOpenExposure ?? 0)} pct={`${((preflight.limits?.config?.maxOpenExposurePct ?? 0) * 100).toFixed(1)}%`} />
            <LimitCard label="Max Daily Loss" value={formatCurrency(preflight.limits?.maxDailyLoss ?? 0)} pct={`${((preflight.limits?.config?.maxDailyLossPct ?? 0) * 100).toFixed(1)}%`} />
            <LimitCard label="Max League Exposure" value={formatCurrency(preflight.limits?.maxLeagueExposure ?? 0)} pct={`${((preflight.limits?.config?.maxLeagueExposurePct ?? 0) * 100).toFixed(1)}%`} />
          </div>
        </div>
      )}

      {!report && (
        <div className="flex justify-center">
          <Button
            onClick={handleLaunch}
            disabled={launchMutation.isPending}
            className="bg-orange-600 hover:bg-orange-500 text-white font-bold px-8 py-3 text-lg rounded-xl"
          >
            {launchMutation.isPending ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin mr-2" />
                Running Launch Scan...
              </>
            ) : (
              <>
                <Rocket className="h-5 w-5 mr-2" />
                {preflight?.mode === "LIVE" ? "Execute Live Launch" : "Run Dry-Run Launch"}
              </>
            )}
          </Button>
        </div>
      )}

      {report && (
        <LaunchReport report={report} />
      )}
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-4">
      <p className="text-xs text-slate-400 uppercase tracking-wider">{label}</p>
      <p className="text-xl font-bold text-white mt-1">{value}</p>
      <p className="text-xs text-slate-500 mt-0.5">{sub}</p>
    </div>
  );
}

function LimitCard({ label, value, pct }: { label: string; value: string; pct: string }) {
  return (
    <div className="rounded-lg border border-slate-600/50 bg-slate-900/50 p-3">
      <p className="text-xs text-slate-400">{label}</p>
      <p className="text-sm font-semibold text-white mt-1">{value}</p>
      <p className="text-[10px] text-slate-500">{pct} of balance</p>
    </div>
  );
}

function LaunchReport({ report }: { report: any }) {
  const pf = report.preFlightChecks;
  const s = report.summary;
  const scan = report.scan;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h2 className="text-xl font-bold text-white">Launch Report</h2>
        <span className={cn("text-xs font-bold px-3 py-1 rounded-full", report.mode === "LIVE" ? "bg-red-600 text-white" : "bg-blue-600 text-white")}>
          {report.mode}
        </span>
        <span className="text-xs text-slate-400">{new Date(report.timestamp).toLocaleString()}</span>
      </div>

      <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-5">
        <h3 className="text-sm font-semibold text-slate-300 mb-3 flex items-center gap-2">
          {pf.passed ? <CheckCircle className="h-4 w-4 text-emerald-400" /> : <XCircle className="h-4 w-4 text-red-400" />}
          Pre-Flight Checks ({pf.checks.filter((c: any) => c.passed).length}/{pf.checks.length} passed)
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {pf.checks.map((c: any, i: number) => (
            <CheckRow key={i} name={c.name} passed={c.passed} detail={c.detail} />
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <SummaryCard label="Paper Bets Scanned" value={s.totalScanned} color="text-blue-400" />
        <SummaryCard label="Qualified for Live" value={s.qualifiedForLive} color="text-emerald-400" />
        <SummaryCard label="Successfully Placed" value={s.successfullyPlaced} color="text-green-400" />
        <SummaryCard label="Failed" value={s.failedToPlace} color={s.failedToPlace > 0 ? "text-red-400" : "text-slate-400"} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <SummaryCard label="Total Stake Deployed" value={formatCurrency(s.totalStakeDeployed)} color="text-white" />
        <SummaryCard label="Stake % of Balance" value={`${s.stakeAsPctOfBalance}%`} color="text-amber-400" />
        <SummaryCard label="Avg Execution Time" value={`${s.avgExecutionTimeMs}ms`} color="text-cyan-400" />
      </div>

      {Object.keys(scan.skippedReasons).length > 0 && (
        <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-5">
          <h3 className="text-sm font-semibold text-slate-300 mb-3 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-400" />
            Skip Reasons
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {Object.entries(scan.skippedReasons).map(([reason, count]) => (
              <div key={reason} className="flex justify-between items-center rounded-lg border border-slate-600/40 bg-slate-900/30 p-3">
                <span className="text-xs text-slate-300">{reason.replace(/_/g, " ")}</span>
                <span className="text-sm font-bold text-amber-400">{count as number}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {report.placements.length > 0 && (
        <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-5 overflow-x-auto">
          <h3 className="text-sm font-semibold text-slate-300 mb-3">Placement Details</h3>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-400 border-b border-slate-700">
                <th className="text-left p-2">Fixture</th>
                <th className="text-left p-2">Market</th>
                <th className="text-left p-2">Selection</th>
                <th className="text-right p-2">Stake</th>
                <th className="text-right p-2">Odds</th>
                <th className="text-right p-2">Opp Score</th>
                <th className="text-right p-2">Pin Edge %</th>
                <th className="text-right p-2">CA-EV</th>
                <th className="text-center p-2">Path</th>
                <th className="text-center p-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {report.placements.map((p: any, i: number) => (
                <tr key={i} className="border-b border-slate-800 hover:bg-slate-700/30">
                  <td className="p-2 text-slate-200 max-w-[200px] truncate">{p.fixture}</td>
                  <td className="p-2 text-slate-300">{p.market}</td>
                  <td className="p-2 text-slate-300">{p.selection}</td>
                  <td className="p-2 text-right text-white font-mono">{formatCurrency(p.stake)}</td>
                  <td className="p-2 text-right text-white font-mono">{p.odds.toFixed(2)}</td>
                  <td className="p-2 text-right text-cyan-400">{p.opportunityScore}</td>
                  <td className="p-2 text-right text-emerald-400">{p.pinnacleEdgePct.toFixed(1)}%</td>
                  <td className={cn("p-2 text-right font-mono", p.commissionAdjustedEV > 0 ? "text-green-400" : "text-red-400")}>
                    {(p.commissionAdjustedEV * 100).toFixed(2)}%
                  </td>
                  <td className="p-2 text-center">
                    <span className={cn("text-[10px] px-2 py-0.5 rounded-full", p.path === "promoted" ? "bg-purple-900/40 text-purple-300 border border-purple-800/40" : "bg-blue-900/40 text-blue-300 border border-blue-800/40")}>
                      {p.path === "promoted" ? "P1" : "P2"}
                    </span>
                  </td>
                  <td className="p-2 text-center">
                    <span className={cn("text-[10px] px-2 py-0.5 rounded-full font-semibold",
                      p.status === "placed" ? "bg-emerald-900/40 text-emerald-300 border border-emerald-800/40" :
                      p.status === "failed" ? "bg-red-900/40 text-red-300 border border-red-800/40" :
                      "bg-amber-900/40 text-amber-300 border border-amber-800/40"
                    )}>
                      {p.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, color }: { label: string; value: number | string; color: string }) {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-4 text-center">
      <p className="text-xs text-slate-400 uppercase tracking-wider">{label}</p>
      <p className={cn("text-2xl font-bold mt-1", color)}>{value}</p>
    </div>
  );
}
