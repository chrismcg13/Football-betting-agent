import { useState, useMemo } from "react";
import { usePerformance, useBetsByLeague, useBetsByMarket, useModel, useBets, useClvStats } from "@/hooks/use-dashboard";
import { formatCurrency } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart,
  ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis,
} from "recharts";

const TT = {
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

const AXIS = { stroke: "#475569", fontSize: 10, tickLine: false, axisLine: false };
const GRID = { strokeDasharray: "3 3", stroke: "#1e3a5f", vertical: false as const };

const DATE_RANGES = [
  { label: "7d", days: 7 },
  { label: "14d", days: 14 },
  { label: "30d", days: 30 },
  { label: "All", days: 9999 },
];

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn("rounded-xl border", className)}
      style={{ background: "#1e293b", borderColor: "#334155" }}
    >
      {children}
    </div>
  );
}

function CardHead({ title, sub, right }: { title: string; sub?: string; right?: React.ReactNode }) {
  return (
    <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: "#334155" }}>
      <div>
        <p className="text-sm font-semibold text-white">{title}</p>
        {sub && <p className="text-xs text-slate-500 mt-0.5">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

function DateRangeBtn({ value, onChange }: { value: number; onChange: (d: number) => void }) {
  return (
    <div className="flex items-center gap-0.5 rounded-lg p-0.5" style={{ background: "#0f172a" }}>
      {DATE_RANGES.map(({ label, days }) => (
        <button
          key={days}
          onClick={() => onChange(days)}
          data-testid={`btn-range-${label}`}
          className={cn(
            "text-xs px-3 py-1.5 rounded-md font-medium transition-all",
            value === days
              ? "bg-blue-600 text-white"
              : "text-slate-500 hover:text-slate-300",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function HorizBarChart({ data, xKey, valueKey }: { data: any[]; xKey: string; valueKey: string }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e3a5f" horizontal={false} />
        <XAxis type="number" {...AXIS} tickFormatter={(v) => `${v}%`} domain={["auto", "auto"]} />
        <YAxis
          type="category"
          dataKey={xKey}
          {...AXIS}
          width={120}
          tick={{ fontSize: 11, fill: "#94a3b8" }}
        />
        <Tooltip
          {...TT}
          formatter={(v: number) => [`${v.toFixed(1)}%`, "ROI"]}
          cursor={{ fill: "rgba(255,255,255,0.03)" }}
        />
        <Bar dataKey={valueKey} radius={[0, 4, 4, 0]}>
          {data.map((entry: any, idx: number) => (
            <Cell
              key={`cell-${idx}`}
              fill={entry[valueKey] >= 0 ? "#10b981" : "#ef4444"}
              fillOpacity={0.85}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export default function Performance() {
  const [dateRange, setDateRange] = useState(30);
  const { data: perfData, isLoading: perfLoading } = usePerformance();
  const { data: byLeague, isLoading: leagueLoading } = useBetsByLeague();
  const { data: byMarket, isLoading: marketLoading } = useBetsByMarket();
  const { data: modelData, isLoading: modelLoading } = useModel();
  const { data: allBetsData } = useBets(1, 200, "all");
  const { data: clvData } = useClvStats();

  const chartData = useMemo(() => {
    const arr = (perfData?.cumulativeProfit as any[]) ?? [];
    if (dateRange >= 9999) return arr;
    return arr.slice(Math.max(0, arr.length - dateRange));
  }, [perfData, dateRange]);

  const isProfit = useMemo(() => {
    if (chartData.length === 0) return true;
    return (chartData[chartData.length - 1]?.cumPnl ?? 0) >= 0;
  }, [chartData]);

  const weeklyWin = useMemo(
    () => ((perfData?.weeklyWinRate as any[]) ?? []).map((w: any) => ({ ...w, winRatePct: w.winRate })),
    [perfData],
  );

  const accuracyHistory = useMemo(
    () =>
      ((modelData?.accuracyHistory as any[]) ?? []).map((h: any) => ({
        label: h.version?.slice(0, 14) ?? "",
        accuracy: h.accuracy != null ? Math.round(h.accuracy * 1000) / 10 : null,
        calibration: h.calibration,
      })),
    [modelData],
  );

  const leagueROI = useMemo(() => [...((byLeague as any[]) ?? [])].sort((a, b) => b.roi - a.roi), [byLeague]);
  const marketROI = useMemo(() => [...((byMarket as any[]) ?? [])].sort((a, b) => b.roi - a.roi), [byMarket]);

  const statsTable = useMemo(() => {
    const rows: any[] = [];
    for (const l of (byLeague as any[]) ?? []) {
      rows.push({
        segment: l.league, type: "League",
        count: l.count, wins: l.wins, losses: l.losses,
        winPct: l.wins + l.losses > 0 ? (l.wins / (l.wins + l.losses)) * 100 : 0,
        roi: l.roi, totalPnl: l.totalPnl,
      });
    }
    for (const m of (byMarket as any[]) ?? []) {
      rows.push({
        segment: m.marketType, type: "Market",
        count: m.count, wins: m.wins, losses: m.losses,
        winPct: m.wins + m.losses > 0 ? (m.wins / (m.wins + m.losses)) * 100 : 0,
        roi: m.roi, totalPnl: m.totalPnl,
      });
    }
    return rows.sort((a, b) => b.roi - a.roi);
  }, [byLeague, byMarket]);

  const scatterData = useMemo(() => {
    const bets = (allBetsData?.bets as any[]) ?? [];
    return bets
      .filter((b: any) => b.opportunityScore != null && b.settlementPnl != null && (b.status === "won" || b.status === "lost"))
      .map((b: any) => ({
        score: Number(b.opportunityScore),
        pnl: Number(b.settlementPnl),
        status: b.status,
        label: `${b.homeTeam} vs ${b.awayTeam}`,
      }));
  }, [allBetsData]);

  const scatterWon = useMemo(() => scatterData.filter((d) => d.status === "won"), [scatterData]);
  const scatterLost = useMemo(() => scatterData.filter((d) => d.status === "lost"), [scatterData]);

  if (perfLoading) {
    return (
      <div className="space-y-6 max-w-7xl mx-auto">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-[420px] w-full rounded-xl" />
        <div className="grid grid-cols-2 gap-6">
          <Skeleton className="h-[300px] rounded-xl" />
          <Skeleton className="h-[300px] rounded-xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div>
        <h2 className="text-2xl font-bold text-white tracking-tight">Performance Analytics</h2>
        <p className="text-sm text-slate-500 mt-1">Historical returns, edge analysis, and model health.</p>
      </div>

      {/* Cumulative P&L */}
      <Card>
        <CardHead
          title="Cumulative P&L"
          sub="Net profit after 2% Betfair commission"
          right={<DateRangeBtn value={dateRange} onChange={setDateRange} />}
        />
        <div className="p-5">
          {chartData.length < 2 ? (
            <div className="h-80 flex items-center justify-center text-sm text-slate-500">
              Not enough data yet
            </div>
          ) : (
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
                  <defs>
                    <linearGradient id="perfGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={isProfit ? "#10b981" : "#ef4444"} stopOpacity={0.3} />
                      <stop offset="95%" stopColor={isProfit ? "#10b981" : "#ef4444"} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid {...GRID} />
                  <XAxis
                    dataKey="date"
                    {...AXIS}
                    tickFormatter={(v) =>
                      new Date(v).toLocaleDateString("en-GB", { month: "short", day: "numeric" })
                    }
                  />
                  <YAxis {...AXIS} tickFormatter={(v) => `£${v}`} width={52} />
                  <Tooltip
                    {...TT}
                    formatter={(v: number) => [formatCurrency(v), "Cumulative P&L"]}
                    labelFormatter={(l) =>
                      new Date(l).toLocaleDateString("en-GB", { dateStyle: "long" })
                    }
                  />
                  <Area
                    type="monotone"
                    dataKey="cumPnl"
                    stroke={isProfit ? "#10b981" : "#ef4444"}
                    strokeWidth={2.5}
                    fill="url(#perfGrad)"
                    dot={false}
                    activeDot={{ r: 5, fill: isProfit ? "#10b981" : "#ef4444" }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </Card>

      {/* ROI charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHead title="ROI by League" sub="Return on investment per competition" />
          <div className="p-5">
            {leagueLoading ? <Skeleton className="h-56 w-full" /> : (
              <div className="h-56">
                {leagueROI.length === 0
                  ? <p className="h-full flex items-center justify-center text-sm text-slate-500">No data yet</p>
                  : <HorizBarChart data={leagueROI} xKey="league" valueKey="roi" />}
              </div>
            )}
          </div>
        </Card>

        <Card>
          <CardHead title="ROI by Market Type" sub="Return on investment per market" />
          <div className="p-5">
            {marketLoading ? <Skeleton className="h-56 w-full" /> : (
              <div className="h-56">
                {marketROI.length === 0
                  ? <p className="h-full flex items-center justify-center text-sm text-slate-500">No data yet</p>
                  : <HorizBarChart data={marketROI} xKey="marketType" valueKey="roi" />}
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* Win rate + Model accuracy */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHead title="Weekly Win Rate" sub="Win percentage by week" />
          <div className="p-5">
            <div className="h-56">
              {weeklyWin.length < 2 ? (
                <div className="h-full flex items-center justify-center text-sm text-slate-500">
                  Needs more settled bets
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={weeklyWin} margin={{ top: 8, right: 8, left: 0, bottom: 24 }}>
                    <CartesianGrid {...GRID} />
                    <XAxis
                      dataKey="week"
                      {...AXIS}
                      tick={{ fontSize: 10, fill: "#64748b" }}
                      angle={-30}
                      textAnchor="end"
                      height={40}
                    />
                    <YAxis {...AXIS} tickFormatter={(v) => `${v}%`} domain={[0, 100]} width={44} />
                    <Tooltip
                      {...TT}
                      formatter={(v: number, name: string) => [
                        name === "winRatePct" ? `${v.toFixed(1)}%` : v,
                        name === "winRatePct" ? "Win Rate" : "Bets",
                      ]}
                    />
                    <Line
                      type="monotone"
                      dataKey="winRatePct"
                      stroke="#10b981"
                      strokeWidth={2.5}
                      dot={{ r: 3, fill: "#10b981" }}
                      activeDot={{ r: 5 }}
                    />
                    <Line
                      type="monotone"
                      dataKey="bets"
                      stroke="#475569"
                      strokeWidth={1.5}
                      strokeDasharray="4 3"
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
            <p className="text-xs text-slate-600 mt-2">Solid green = win rate (%) · dashed = bet count</p>
          </div>
        </Card>

        <Card>
          <CardHead title="Model Accuracy over Time" sub="Accuracy across retraining cycles" />
          <div className="p-5">
            {modelLoading ? (
              <Skeleton className="h-56 w-full" />
            ) : accuracyHistory.length < 2 ? (
              <div className="h-56 flex items-center justify-center text-sm text-slate-500">
                Model needs more retraining cycles
              </div>
            ) : (
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={accuracyHistory} margin={{ top: 8, right: 8, left: 0, bottom: 24 }}>
                    <CartesianGrid {...GRID} />
                    <XAxis
                      dataKey="label"
                      {...AXIS}
                      tick={{ fontSize: 9, fill: "#64748b" }}
                      angle={-20}
                      textAnchor="end"
                      height={40}
                    />
                    <YAxis {...AXIS} tickFormatter={(v) => `${v}%`} domain={[0, 100]} width={44} />
                    <Tooltip
                      {...TT}
                      formatter={(v: number, name: string) => [
                        `${v.toFixed(1)}%`,
                        name === "accuracy" ? "Accuracy" : "Calibration",
                      ]}
                    />
                    <Line
                      type="monotone"
                      dataKey="accuracy"
                      stroke="#3b82f6"
                      strokeWidth={2.5}
                      dot={{ r: 4, fill: "#3b82f6" }}
                      activeDot={{ r: 6 }}
                      connectNulls
                    />
                    <Line
                      type="monotone"
                      dataKey="calibration"
                      stroke="#a78bfa"
                      strokeWidth={1.5}
                      strokeDasharray="4 3"
                      dot={{ r: 3, fill: "#a78bfa" }}
                      connectNulls
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
            <p className="text-xs text-slate-600 mt-2">Solid blue = accuracy · dashed purple = calibration</p>
          </div>
        </Card>
      </div>

      {/* Opportunity Score vs P&L Scatter */}
      <Card>
        <CardHead
          title="Opportunity Score vs Outcome"
          sub="Does a higher score actually predict wins? Each dot is a settled bet."
        />
        <div className="p-5">
          {scatterData.length < 3 ? (
            <div className="h-64 flex items-center justify-center text-sm text-slate-500">
              Not enough scored bets to display — this chart populates as bets settle.
            </div>
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 8, right: 16, left: 4, bottom: 0 }}>
                  <CartesianGrid {...GRID} />
                  <XAxis
                    type="number"
                    dataKey="score"
                    domain={[55, 100]}
                    {...AXIS}
                    label={{ value: "Opportunity Score", position: "insideBottom", offset: -2, fontSize: 10, fill: "#64748b" }}
                  />
                  <YAxis
                    type="number"
                    dataKey="pnl"
                    {...AXIS}
                    width={52}
                    tickFormatter={(v) => `£${v}`}
                  />
                  <ZAxis range={[40, 40]} />
                  <Tooltip
                    {...TT}
                    content={({ payload }: any) => {
                      if (!payload?.length) return null;
                      const d = payload[0]?.payload;
                      return (
                        <div style={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 8, padding: "8px 12px", fontSize: 12 }}>
                          <p style={{ color: "#94a3b8", marginBottom: 4 }}>{d.label}</p>
                          <p>Score: <span style={{ color: "#a78bfa", fontWeight: 700 }}>{d.score}</span></p>
                          <p>P&L: <span style={{ color: d.pnl >= 0 ? "#10b981" : "#ef4444", fontWeight: 700 }}>£{d.pnl.toFixed(2)}</span></p>
                        </div>
                      );
                    }}
                  />
                  {scatterWon.length > 0 && (
                    <Scatter name="Won" data={scatterWon} fill="#10b981" fillOpacity={0.7} />
                  )}
                  {scatterLost.length > 0 && (
                    <Scatter name="Lost" data={scatterLost} fill="#ef4444" fillOpacity={0.5} />
                  )}
                </ScatterChart>
              </ResponsiveContainer>
              <div className="flex items-center gap-4 justify-center mt-2">
                <span className="flex items-center gap-1.5 text-xs text-slate-400">
                  <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: "#10b981" }} />
                  Won ({scatterWon.length})
                </span>
                <span className="flex items-center gap-1.5 text-xs text-slate-400">
                  <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: "#ef4444" }} />
                  Lost ({scatterLost.length})
                </span>
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* Segment Table */}
      <Card>
        <CardHead
          title="Edge Analysis by Segment"
          sub="Where is the agent finding value? Sorted by ROI."
        />
        <div className="overflow-x-auto">
          {leagueLoading || marketLoading ? (
            <div className="p-5 space-y-3">
              {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b" style={{ borderColor: "#334155" }}>
                  {["Segment", "Type", "Bets", "Wins", "Losses", "Win%", "ROI%", "Total P&L"].map((h, i) => (
                    <th
                      key={h}
                      className={cn(
                        "py-3 text-[11px] uppercase tracking-wider text-slate-500 font-semibold",
                        i === 0 ? "text-left pl-5" : i >= 2 ? "text-right pr-5" : "text-left px-3",
                      )}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {statsTable.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-10 text-center text-sm text-slate-500">
                      No settled bets yet
                    </td>
                  </tr>
                ) : (
                  statsTable.map((row, i) => (
                    <tr
                      key={i}
                      className="border-b transition-colors hover:bg-slate-800/20"
                      style={{ borderColor: "#1e3a5f" }}
                    >
                      <td className="py-3 pl-5 font-medium text-white">{row.segment}</td>
                      <td className="py-3 px-3">
                        <span
                          className={cn(
                            "text-[10px] font-mono px-2 py-0.5 rounded",
                            row.type === "League"
                              ? "bg-blue-950 text-blue-400 border border-blue-800"
                              : "bg-purple-950 text-purple-400 border border-purple-800",
                          )}
                        >
                          {row.type}
                        </span>
                      </td>
                      <td className="py-3 text-right pr-5 font-mono text-slate-300">{row.count}</td>
                      <td className="py-3 text-right pr-5 font-mono text-emerald-400">{row.wins}</td>
                      <td className="py-3 text-right pr-5 font-mono text-red-400">{row.losses}</td>
                      <td className="py-3 text-right pr-5 font-mono">
                        <span className={row.winPct >= 50 ? "text-emerald-400" : "text-red-400"}>
                          {row.winPct.toFixed(1)}%
                        </span>
                      </td>
                      <td className="py-3 text-right pr-5 font-mono font-semibold">
                        <span className={row.roi >= 0 ? "text-emerald-400" : "text-red-400"}>
                          {row.roi >= 0 ? "+" : ""}{row.roi.toFixed(1)}%
                        </span>
                      </td>
                      <td className="py-3 text-right pr-5 font-mono">
                        <span className={row.totalPnl >= 0 ? "text-emerald-400" : "text-red-400"}>
                          {row.totalPnl >= 0 ? "+" : ""}{formatCurrency(row.totalPnl)}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>
      </Card>

      {/* CLV Trend Chart */}
      {((clvData as any)?.trend ?? []).length >= 2 && (
        <Card>
          <CardHead
            title="Closing Line Value (CLV) Trend"
            sub={`Avg CLV: ${Number((clvData as any).avgClv) >= 0 ? "+" : ""}${Number((clvData as any).avgClv ?? 0).toFixed(2)}% over ${(clvData as any).count} bets`}
          />
          <div className="p-5">
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={(clvData as any).trend} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                  <CartesianGrid {...GRID} />
                  <XAxis dataKey="date" {...AXIS} tick={{ fill: "#475569", fontSize: 10 }} />
                  <YAxis {...AXIS} tick={{ fill: "#475569", fontSize: 10 }} tickFormatter={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}%`} />
                  <Tooltip
                    {...TT}
                    formatter={(v: number) => [`${v >= 0 ? "+" : ""}${v.toFixed(2)}%`, "CLV"]}
                  />
                  <Line
                    type="monotone"
                    dataKey="clv"
                    stroke="#7c3aed"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, fill: "#7c3aed" }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-3 flex gap-6 text-xs text-slate-500">
              <span>
                <span className="font-semibold text-violet-400">{(clvData as any)?.pinnacleCount ?? 0}</span> Pinnacle-validated bets
              </span>
              <span>
                <span className="font-semibold text-red-400">{(clvData as any)?.contrarianCount ?? 0}</span> contrarian bets
              </span>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
