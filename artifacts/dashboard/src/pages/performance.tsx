import { useMemo } from "react";
import {
  usePerformance, useSummary, useClvStats, useBetsByLeague, useBetsByMarket,
  useExecutionMetrics, useLiveTierStats, useModelHealth, useCommissionStats,
} from "@/hooks/use-dashboard";
import { formatCurrency } from "@/lib/format";
import { InfoTooltip } from "@/components/layout";
import { cn } from "@/lib/utils";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer,
  Tooltip as RechartsTooltip, XAxis, YAxis, ReferenceLine, Cell,
} from "recharts";

const TOOLTIP_STYLE = {
  contentStyle: { background: "#0f172a", border: "1px solid #334155", borderRadius: "8px", fontSize: "12px", color: "#e2e8f0" },
  itemStyle: { color: "#94a3b8" },
  labelStyle: { color: "#64748b", fontWeight: 600 },
};

function StatCard({ label, value, sub, color, tooltip }: {
  label: string; value: React.ReactNode; sub?: React.ReactNode;
  color?: "green" | "red" | "amber" | "default"; tooltip?: string;
}) {
  const valueColor = color === "green" ? "text-emerald-400" : color === "red" ? "text-red-400" : color === "amber" ? "text-amber-400" : "text-white";
  return (
    <div className="rounded-xl p-4 border flex flex-col gap-1.5" style={{ background: "#1e293b", borderColor: "#334155" }}>
      <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500 flex items-center">
        {label}
        {tooltip && <InfoTooltip text={tooltip} />}
      </p>
      <p className={cn("text-2xl font-bold font-mono leading-none", valueColor)}>{value}</p>
      {sub && <p className="text-xs text-slate-500 leading-snug">{sub}</p>}
    </div>
  );
}

export default function Performance() {
  const { data: summary, isLoading: loadingSummary } = useSummary();
  const { data: perfData, isLoading: loadingPerf } = usePerformance();
  const { data: clvStats } = useClvStats();
  const { data: leagueData } = useBetsByLeague();
  const { data: marketData } = useBetsByMarket();
  const { data: execMetrics } = useExecutionMetrics();
  const { data: tierStats } = useLiveTierStats();
  const { data: modelHealth } = useModelHealth();
  const { data: commStats } = useCommissionStats();

  const pnl = summary?.totalPnl ?? 0;
  const roi = summary?.overallRoiPct ?? 0;
  const wins = summary?.wins ?? 0;
  const losses = summary?.losses ?? 0;
  const settledBets = (summary as any)?.settledBets ?? 0;
  const avgClv = (clvStats as any)?.count > 0 ? Number((clvStats as any).avgClv) : null;

  const chartData = useMemo(() => {
    const arr = (perfData?.cumulativeProfit as any[]) ?? [];
    const sliced = arr.slice(-90);
    if (sliced.length === 0) return [];
    return [{ date: sliced[0].date, cumPnl: 0 }, ...sliced];
  }, [perfData]);

  const currentPnl = chartData.length > 1 ? (chartData[chartData.length - 1]?.cumPnl ?? 0) : 0;
  const isChartPositive = currentPnl >= 0;

  const leagueChartData = useMemo(() => {
    const leagues = (leagueData?.leagues as any[]) ?? [];
    return leagues
      .filter((l: any) => l.settled > 0)
      .sort((a: any, b: any) => Number(b.pnl) - Number(a.pnl))
      .slice(0, 10)
      .map((l: any) => ({
        name: l.league?.split(" - ").pop() ?? l.league,
        pnl: Number(l.pnl),
        roi: Number(l.roi),
        bets: l.settled,
      }));
  }, [leagueData]);

  const marketChartData = useMemo(() => {
    const markets = (marketData?.markets as any[]) ?? [];
    return markets
      .filter((m: any) => m.settled > 0)
      .sort((a: any, b: any) => Number(b.pnl) - Number(a.pnl))
      .map((m: any) => ({
        name: m.marketType?.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()) ?? m.marketType,
        pnl: Number(m.pnl),
        roi: Number(m.roi),
        bets: m.settled,
      }));
  }, [marketData]);

  const tier1Stats = tierStats?.tiers?.tier1_real;
  const tier2Stats = tierStats?.tiers?.tier2_paper;

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div>
        <h2 className="text-2xl font-bold text-white tracking-tight">Live Performance</h2>
        <p className="text-sm text-slate-500 mt-1">
          Real-time P&L, execution quality, and model health
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <StatCard
          label="Total P&L" value={loadingSummary ? "—" : formatCurrency(pnl)}
          sub={`${settledBets} settled bets`}
          color={!loadingSummary ? (pnl >= 0 ? "green" : "red") : "default"}
        />
        <StatCard
          label="ROI" value={loadingSummary ? "—" : `${roi >= 0 ? "+" : ""}${roi.toFixed(2)}%`}
          sub="Return on stakes"
          color={!loadingSummary ? (roi >= 0 ? "green" : "red") : "default"}
          tooltip="Return on Investment: your net profit divided by total amount staked. Positive means you're making money."
        />
        <StatCard
          label="CLV" value={avgClv != null ? `${avgClv >= 0 ? "+" : ""}${avgClv.toFixed(2)}%` : "—"}
          sub={(clvStats as any)?.count > 0 ? `${(clvStats as any).count} scored` : "Closing line value"}
          color={avgClv != null ? (avgClv >= 2 ? "green" : avgClv >= 0 ? "amber" : "red") : "default"}
          tooltip="Closing Line Value: measures if you got better odds than the market closing price. +2% is considered elite."
        />
        <StatCard
          label="Win Rate" value={loadingSummary ? "—" : `${(summary?.winPercentage ?? 0).toFixed(1)}%`}
          sub={`${wins}W – ${losses}L`}
          color={!loadingSummary ? ((summary?.winPercentage ?? 0) >= 50 ? "green" : "amber") : "default"}
        />
        <StatCard
          label="Today" value={loadingSummary ? "—" : formatCurrency(summary?.todayPnl ?? 0)}
          sub={`This week: ${formatCurrency((summary as any)?.thisWeekPnl ?? 0)}`}
          color={!loadingSummary ? ((summary?.todayPnl ?? 0) >= 0 ? "green" : "red") : "default"}
        />
      </div>

      {tierStats && (tier1Stats || tier2Stats) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {tier1Stats && (
            <div className="rounded-xl border p-5" style={{ background: "#052e16", borderColor: "#166534" }}>
              <p className="text-sm font-semibold text-emerald-300 mb-3">Tier 1 — Real Money</p>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <p className="text-[10px] text-emerald-500/60 uppercase font-semibold">P&L</p>
                  <p className={cn("text-lg font-bold font-mono", tier1Stats.pnl >= 0 ? "text-emerald-400" : "text-red-400")}>
                    {formatCurrency(tier1Stats.pnl)}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] text-emerald-500/60 uppercase font-semibold">ROI</p>
                  <p className={cn("text-lg font-bold font-mono", tier1Stats.roi >= 0 ? "text-emerald-400" : "text-red-400")}>
                    {tier1Stats.roi >= 0 ? "+" : ""}{tier1Stats.roi.toFixed(1)}%
                  </p>
                </div>
                <div>
                  <p className="text-[10px] text-emerald-500/60 uppercase font-semibold">Bets</p>
                  <p className="text-lg font-bold font-mono text-emerald-300">{tier1Stats.settled} / {tier1Stats.total}</p>
                </div>
              </div>
              {tier1Stats.avgClv != null && (
                <p className="text-xs text-emerald-500/70 mt-2">CLV: {tier1Stats.avgClv >= 0 ? "+" : ""}{tier1Stats.avgClv.toFixed(2)}%</p>
              )}
            </div>
          )}
          {tier2Stats && (
            <div className="rounded-xl border p-5" style={{ background: "#1e1b4b", borderColor: "#4c1d95" }}>
              <p className="text-sm font-semibold text-violet-300 mb-3">Tier 2 — Paper (Experiments)</p>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <p className="text-[10px] text-violet-500/60 uppercase font-semibold">P&L</p>
                  <p className={cn("text-lg font-bold font-mono", tier2Stats.pnl >= 0 ? "text-violet-400" : "text-red-400")}>
                    {formatCurrency(tier2Stats.pnl)}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] text-violet-500/60 uppercase font-semibold">ROI</p>
                  <p className={cn("text-lg font-bold font-mono", tier2Stats.roi >= 0 ? "text-violet-400" : "text-red-400")}>
                    {tier2Stats.roi >= 0 ? "+" : ""}{tier2Stats.roi.toFixed(1)}%
                  </p>
                </div>
                <div>
                  <p className="text-[10px] text-violet-500/60 uppercase font-semibold">Bets</p>
                  <p className="text-lg font-bold font-mono text-violet-300">{tier2Stats.settled} / {tier2Stats.total}</p>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="rounded-xl border p-5" style={{ background: "#1e293b", borderColor: "#334155" }}>
        <div className="mb-4">
          <h3 className="text-sm font-semibold text-white">P&L Over Time</h3>
          <p className="text-xs text-slate-500 mt-0.5">Cumulative profit from all settled bets (last 90 days)</p>
        </div>
        {loadingPerf ? (
          <div className="h-64 rounded-lg animate-pulse" style={{ background: "#0f172a" }} />
        ) : chartData.length < 2 ? (
          <div className="h-64 flex items-center justify-center text-sm text-slate-500">
            No settled bets yet — chart appears after first settlement.
          </div>
        ) : (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="perfGradPos" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0.03} />
                  </linearGradient>
                  <linearGradient id="perfGradNeg" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#ef4444" stopOpacity={0.03} />
                    <stop offset="95%" stopColor="#ef4444" stopOpacity={0.35} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e3a5f" vertical={false} />
                <ReferenceLine y={0} stroke="#475569" strokeDasharray="4 4" />
                <XAxis dataKey="date" stroke="#475569" fontSize={10} tickLine={false} axisLine={false}
                  tickFormatter={(v) => new Date(v).toLocaleDateString("en-GB", { month: "short", day: "numeric" })} />
                <YAxis stroke="#475569" fontSize={10} tickLine={false} axisLine={false}
                  tickFormatter={(v) => `£${v}`} width={50} />
                <RechartsTooltip {...TOOLTIP_STYLE}
                  formatter={(v: number) => [formatCurrency(v), "Cumulative P&L"]}
                  labelFormatter={(l) => new Date(l).toLocaleDateString("en-GB", { dateStyle: "long" })} />
                <Area type="monotone" dataKey="cumPnl"
                  stroke={isChartPositive ? "#10b981" : "#ef4444"} strokeWidth={2}
                  fill={isChartPositive ? "url(#perfGradPos)" : "url(#perfGradNeg)"}
                  dot={false} activeDot={{ r: 4 }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-xl border p-5" style={{ background: "#1e293b", borderColor: "#334155" }}>
          <div className="mb-4">
            <h3 className="text-sm font-semibold text-white">P&L by League</h3>
            <p className="text-xs text-slate-500 mt-0.5">Top 10 leagues by profit</p>
          </div>
          {leagueChartData.length === 0 ? (
            <div className="h-48 flex items-center justify-center text-sm text-slate-500">No settled league data yet.</div>
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={leagueChartData} layout="vertical" margin={{ top: 0, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e3a5f" horizontal={false} />
                  <XAxis type="number" stroke="#475569" fontSize={10} tickLine={false} axisLine={false}
                    tickFormatter={(v) => `£${v}`} />
                  <YAxis type="category" dataKey="name" stroke="#475569" fontSize={10} tickLine={false}
                    axisLine={false} width={100} />
                  <RechartsTooltip {...TOOLTIP_STYLE}
                    formatter={(v: number) => [formatCurrency(v), "P&L"]} />
                  <Bar dataKey="pnl" radius={[0, 4, 4, 0]}>
                    {leagueChartData.map((entry, idx) => (
                      <Cell key={idx} fill={entry.pnl >= 0 ? "#10b981" : "#ef4444"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div className="rounded-xl border p-5" style={{ background: "#1e293b", borderColor: "#334155" }}>
          <div className="mb-4">
            <h3 className="text-sm font-semibold text-white">P&L by Market Type</h3>
            <p className="text-xs text-slate-500 mt-0.5">Performance across different bet types</p>
          </div>
          {marketChartData.length === 0 ? (
            <div className="h-48 flex items-center justify-center text-sm text-slate-500">No settled market data yet.</div>
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={marketChartData} layout="vertical" margin={{ top: 0, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e3a5f" horizontal={false} />
                  <XAxis type="number" stroke="#475569" fontSize={10} tickLine={false} axisLine={false}
                    tickFormatter={(v) => `£${v}`} />
                  <YAxis type="category" dataKey="name" stroke="#475569" fontSize={10} tickLine={false}
                    axisLine={false} width={110} />
                  <RechartsTooltip {...TOOLTIP_STYLE}
                    formatter={(v: number) => [formatCurrency(v), "P&L"]} />
                  <Bar dataKey="pnl" radius={[0, 4, 4, 0]}>
                    {marketChartData.map((entry, idx) => (
                      <Cell key={idx} fill={entry.pnl >= 0 ? "#3b82f6" : "#ef4444"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>

      {execMetrics && execMetrics.fillRate?.livePlaced > 0 && (
        <div className="rounded-xl border p-5" style={{ background: "#1e293b", borderColor: "#334155" }}>
          <h3 className="text-sm font-semibold text-white mb-4">Execution Quality</h3>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="rounded-lg p-3 border" style={{ background: "#0f172a", borderColor: "#1e293b" }}>
              <p className="text-[10px] text-slate-500 uppercase font-semibold">Live Orders</p>
              <p className="text-xl font-bold font-mono text-white">{execMetrics.fillRate.livePlaced}</p>
              <p className="text-[10px] text-slate-600">{execMetrics.fillRate.placed24h} in last 24h</p>
            </div>
            <div className="rounded-lg p-3 border" style={{ background: "#0f172a", borderColor: "#1e293b" }}>
              <p className="text-[10px] text-slate-500 uppercase font-semibold">Fill Rate</p>
              <p className={cn("text-xl font-bold font-mono",
                (execMetrics.fillRate.avgFillPct ?? 0) >= 90 ? "text-emerald-400" :
                (execMetrics.fillRate.avgFillPct ?? 0) >= 70 ? "text-amber-400" : "text-red-400")}>
                {execMetrics.fillRate.avgFillPct ?? "—"}%
              </p>
              <p className="text-[10px] text-slate-600">{execMetrics.fillRate.cancelled} cancelled</p>
            </div>
            <div className="rounded-lg p-3 border" style={{ background: "#0f172a", borderColor: "#1e293b" }}>
              <p className="text-[10px] text-slate-500 uppercase font-semibold">Signal Speed</p>
              <p className="text-xl font-bold font-mono text-white">
                {execMetrics.timing.avgSignalToPlaceSecs != null ? `${execMetrics.timing.avgSignalToPlaceSecs}s` : "—"}
              </p>
              <p className="text-[10px] text-slate-600">Signal to placement</p>
            </div>
            <div className="rounded-lg p-3 border" style={{ background: "#0f172a", borderColor: "#1e293b" }}>
              <p className="text-[10px] text-slate-500 uppercase font-semibold">Betfair Proxy</p>
              <p className={cn("text-xl font-bold font-mono",
                execMetrics.relay.healthy ? "text-emerald-400" : execMetrics.relay.configured ? "text-red-400" : "text-emerald-400")}>
                {execMetrics.relay.configured ? (execMetrics.relay.healthy ? "Online" : "Offline") : "Active (VPS)"}
              </p>
              {execMetrics.relay.lastLatencyMs != null && (
                <p className="text-[10px] text-slate-600">{execMetrics.relay.lastLatencyMs}ms latency</p>
              )}
            </div>
          </div>
        </div>
      )}

      {commStats && (
        <div className="rounded-xl border p-5" style={{ background: "#1e293b", borderColor: "#334155" }}>
          <h3 className="text-sm font-semibold text-white mb-4">Commission & Costs</h3>

          {(commStats as any).premiumChargeWarning && (
            <div className="rounded-lg border px-4 py-3 mb-4 bg-red-500/10 border-red-500/30">
              <p className="text-sm text-red-300 font-medium">
                Premium Charge Warning — Lifetime gross profit: {formatCurrency((commStats as any).lifetimeGrossProfit)} / £25,000 threshold
              </p>
            </div>
          )}
          {!((commStats as any).premiumChargeWarning) && (commStats as any).lifetimeGrossProfit >= 20000 && (
            <div className="rounded-lg border px-4 py-3 mb-4 bg-amber-500/10 border-amber-500/30">
              <p className="text-sm text-amber-300 font-medium">
                Approaching Premium Charge — Lifetime gross profit: {formatCurrency((commStats as any).lifetimeGrossProfit)} / £25,000 threshold
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
            <StatCard
              label="Gross P&L (All Time)"
              value={formatCurrency((commStats as any).allTime?.grossProfit ?? 0)}
              color={((commStats as any).allTime?.grossProfit ?? 0) >= 0 ? "green" : "red"}
              tooltip="Total profit before commission deduction"
            />
            <StatCard
              label="Commission Paid"
              value={formatCurrency((commStats as any).allTime?.totalCommission ?? 0)}
              sub={`Effective rate: ${(((commStats as any).allTime?.effectiveRate ?? 0) * 100).toFixed(2)}%`}
              color="amber"
              tooltip="5% Betfair commission on net winnings only"
            />
            <StatCard
              label="Net P&L (All Time)"
              value={formatCurrency((commStats as any).allTime?.netProfit ?? 0)}
              color={((commStats as any).allTime?.netProfit ?? 0) >= 0 ? "green" : "red"}
              tooltip="Profit after commission — what you actually keep"
            />
            <StatCard
              label="Projected Monthly Comm."
              value={formatCurrency((commStats as any).projectedMonthlyCommission ?? 0)}
              sub={`This month so far: ${formatCurrency((commStats as any).thisMonth?.totalCommission ?? 0)}`}
              tooltip="Based on commission pace this month"
            />
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="rounded-lg p-3 border" style={{ background: "#0f172a", borderColor: "#1e293b" }}>
              <p className="text-[10px] text-slate-500 uppercase font-semibold mb-1">This Week</p>
              <p className="text-sm font-mono text-white">
                Gross: <span className={cn((commStats as any).thisWeek?.grossProfit >= 0 ? "text-emerald-400" : "text-red-400")}>{formatCurrency((commStats as any).thisWeek?.grossProfit ?? 0)}</span>
                {" · "}Comm: <span className="text-amber-400">{formatCurrency((commStats as any).thisWeek?.totalCommission ?? 0)}</span>
                {" · "}Net: <span className={cn((commStats as any).thisWeek?.netProfit >= 0 ? "text-emerald-400" : "text-red-400")}>{formatCurrency((commStats as any).thisWeek?.netProfit ?? 0)}</span>
              </p>
            </div>
            <div className="rounded-lg p-3 border" style={{ background: "#0f172a", borderColor: "#1e293b" }}>
              <p className="text-[10px] text-slate-500 uppercase font-semibold mb-1">Today</p>
              <p className="text-sm font-mono text-white">
                Gross: <span className={cn((commStats as any).today?.grossProfit >= 0 ? "text-emerald-400" : "text-red-400")}>{formatCurrency((commStats as any).today?.grossProfit ?? 0)}</span>
                {" · "}Comm: <span className="text-amber-400">{formatCurrency((commStats as any).today?.totalCommission ?? 0)}</span>
                {" · "}Net: <span className={cn((commStats as any).today?.netProfit >= 0 ? "text-emerald-400" : "text-red-400")}>{formatCurrency((commStats as any).today?.netProfit ?? 0)}</span>
              </p>
            </div>
            <div className="rounded-lg p-3 border" style={{ background: "#0f172a", borderColor: "#1e293b" }}>
              <p className="text-[10px] text-slate-500 uppercase font-semibold mb-1">Exchanges</p>
              <div className="space-y-0.5">
                {((commStats as any).exchanges ?? []).map((ex: any) => (
                  <p key={ex.id} className="text-xs font-mono">
                    <span className={cn(ex.isActive ? "text-emerald-400" : "text-slate-600")}>{ex.isActive ? "●" : "○"}</span>
                    {" "}<span className="text-slate-300">{ex.displayName}</span>
                    {" "}<span className="text-slate-500">{((ex.commissionStructure?.standard_rate ?? 0) * 100).toFixed(1)}%</span>
                  </p>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {modelHealth && (
        <div className="rounded-xl border p-5" style={{ background: "#1e293b", borderColor: "#334155" }}>
          <h3 className="text-sm font-semibold text-white mb-4">Model Health</h3>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {(modelHealth as any).metrics && Object.entries((modelHealth as any).metrics).slice(0, 8).map(([key, val]: [string, any]) => (
              <div key={key} className="rounded-lg p-3 border" style={{ background: "#0f172a", borderColor: "#1e293b" }}>
                <p className="text-[10px] text-slate-500 uppercase font-semibold">
                  {key.replace(/([A-Z])/g, " $1").replace(/^./, s => s.toUpperCase()).trim()}
                </p>
                <p className={cn("text-lg font-bold font-mono",
                  val?.status === "good" ? "text-emerald-400" :
                  val?.status === "warning" ? "text-amber-400" :
                  val?.status === "critical" ? "text-red-400" : "text-white")}>
                  {typeof val === "object" ? (val?.value ?? val?.score ?? "—") : String(val)}
                </p>
              </div>
            ))}
          </div>
          {(modelHealth as any).flags && (modelHealth as any).flags.length > 0 && (
            <div className="mt-3 pt-3 border-t" style={{ borderColor: "#334155" }}>
              <p className="text-xs text-slate-500 mb-2">Issues detected:</p>
              <div className="space-y-1">
                {(modelHealth as any).flags.map((flag: any, i: number) => (
                  <p key={i} className="text-xs text-amber-400">
                    {typeof flag === "string" ? flag : flag.message ?? JSON.stringify(flag)}
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
