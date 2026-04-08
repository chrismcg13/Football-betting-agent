import { useState, useMemo } from "react";
import { usePerformance, useBetsByLeague, useBetsByMarket, useModel } from "@/hooks/use-dashboard";
import { formatCurrency } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const CHART_STYLE = {
  tooltip: {
    contentStyle: {
      backgroundColor: "hsl(222 47% 10%)",
      borderColor: "hsl(217 33% 22%)",
      borderRadius: "6px",
      fontSize: "12px",
    },
    itemStyle: { color: "hsl(210 40% 92%)" },
    labelStyle: { color: "hsl(215 20% 65%)", fontWeight: 600 },
  },
  grid: { strokeDasharray: "3 3", stroke: "hsl(217 33% 18%)", vertical: false },
  axis: { stroke: "hsl(215 20% 45%)", fontSize: 11, tickLine: false, axisLine: false },
};

const DATE_RANGES = [
  { label: "7d", days: 7 },
  { label: "14d", days: 14 },
  { label: "30d", days: 30 },
];

function DateRangeSelector({ value, onChange }: { value: number; onChange: (d: number) => void }) {
  return (
    <div className="flex items-center gap-1 bg-slate-800 rounded-md p-0.5">
      {DATE_RANGES.map(({ label, days }) => (
        <button
          key={days}
          onClick={() => onChange(days)}
          data-testid={`btn-range-${label}`}
          className={`text-xs px-2.5 py-1 rounded transition-all font-medium ${
            value === days
              ? "bg-blue-600 text-white"
              : "text-slate-400 hover:text-slate-200"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function ROIBarChart({ data, xKey, valueKey, label }: {
  data: any[];
  xKey: string;
  valueKey: string;
  label: string;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 40 }} layout="vertical">
        <CartesianGrid {...CHART_STYLE.grid} horizontal={false} vertical />
        <XAxis
          type="number"
          {...CHART_STYLE.axis}
          tickFormatter={(v) => `${v}%`}
          domain={["auto", "auto"]}
        />
        <YAxis
          type="category"
          dataKey={xKey}
          {...CHART_STYLE.axis}
          width={110}
          tick={{ fontSize: 11, fill: "hsl(215 20% 65%)" }}
        />
        <Tooltip
          {...CHART_STYLE.tooltip}
          formatter={(value: number) => [`${value.toFixed(1)}%`, label]}
          cursor={{ fill: "hsl(217 33% 18%)" }}
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

  const cumulativeSliced = useMemo(() => {
    if (!perfData?.cumulativeProfit) return [];
    const arr = perfData.cumulativeProfit as any[];
    return arr.slice(Math.max(0, arr.length - dateRange));
  }, [perfData, dateRange]);

  const weeklyWinRateData = useMemo(() => {
    if (!perfData?.weeklyWinRate) return [];
    return (perfData.weeklyWinRate as any[]).map((w: any) => ({
      ...w,
      winRatePct: w.winRate,
    }));
  }, [perfData]);

  const accuracyHistory = useMemo(() => {
    if (!modelData?.accuracyHistory) return [];
    return (modelData.accuracyHistory as any[]).map((h: any) => ({
      label: h.version?.slice(0, 16) ?? "",
      accuracy: h.accuracy != null ? Math.round(h.accuracy * 1000) / 10 : null,
      calibration: h.calibration,
      trainedOn: h.trainedOn,
    }));
  }, [modelData]);

  const leagueROI = useMemo(() => {
    if (!byLeague) return [];
    return [...(byLeague as any[])].sort((a, b) => b.roi - a.roi);
  }, [byLeague]);

  const marketROI = useMemo(() => {
    if (!byMarket) return [];
    return [...(byMarket as any[])].sort((a, b) => b.roi - a.roi);
  }, [byMarket]);

  const statsTable = useMemo(() => {
    const rows: any[] = [];
    if (byLeague) {
      for (const l of byLeague as any[]) {
        rows.push({
          segment: l.league,
          type: "League",
          count: l.count,
          wins: l.wins,
          losses: l.losses,
          winPct: l.wins + l.losses > 0 ? (l.wins / (l.wins + l.losses)) * 100 : 0,
          roi: l.roi,
          totalPnl: l.totalPnl,
        });
      }
    }
    if (byMarket) {
      for (const m of byMarket as any[]) {
        rows.push({
          segment: m.marketType,
          type: "Market",
          count: m.count,
          wins: m.wins,
          losses: m.losses,
          winPct: m.wins + m.losses > 0 ? (m.wins / (m.wins + m.losses)) * 100 : 0,
          roi: m.roi,
          totalPnl: m.totalPnl,
        });
      }
    }
    return rows.sort((a, b) => b.roi - a.roi);
  }, [byLeague, byMarket]);

  const isLoading = perfLoading;

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-7xl mx-auto">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-80" />
        </div>
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
      <div className="flex flex-col gap-2">
        <h2 className="text-3xl font-bold tracking-tight">Performance Analytics</h2>
        <p className="text-muted-foreground">Historical returns, edge analysis, and model health.</p>
      </div>

      {/* Row 1: Cumulative P&L */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <div>
            <CardTitle>Cumulative P&L</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">Net profit after 2% Betfair commission</p>
          </div>
          <DateRangeSelector value={dateRange} onChange={setDateRange} />
        </CardHeader>
        <CardContent>
          <div className="h-[380px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={cumulativeSliced} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                <defs>
                  <linearGradient id="cumPnlGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="cumPnlGradNeg" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#ef4444" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#ef4444" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid {...CHART_STYLE.grid} />
                <XAxis
                  dataKey="date"
                  {...CHART_STYLE.axis}
                  tickFormatter={(v) =>
                    new Date(v).toLocaleDateString("en-GB", { month: "short", day: "numeric" })
                  }
                />
                <YAxis
                  {...CHART_STYLE.axis}
                  tickFormatter={(v) => `£${v}`}
                  width={50}
                />
                <Tooltip
                  {...CHART_STYLE.tooltip}
                  formatter={(value: number) => [formatCurrency(value), "Cumulative P&L"]}
                  labelFormatter={(label) =>
                    new Date(label).toLocaleDateString("en-GB", {
                      year: "numeric",
                      month: "long",
                      day: "numeric",
                    })
                  }
                />
                <Area
                  type="monotone"
                  dataKey="cumPnl"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url(#cumPnlGrad)"
                  dot={false}
                  activeDot={{ r: 4, fill: "#3b82f6" }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* Row 2: ROI by League + ROI by Market */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">ROI by League</CardTitle>
            <p className="text-xs text-muted-foreground">Return on investment per competition</p>
          </CardHeader>
          <CardContent>
            {leagueLoading ? (
              <Skeleton className="h-[260px] w-full" />
            ) : (
              <div className="h-[260px] w-full">
                <ROIBarChart data={leagueROI} xKey="league" valueKey="roi" label="ROI" />
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">ROI by Market Type</CardTitle>
            <p className="text-xs text-muted-foreground">Return on investment per market</p>
          </CardHeader>
          <CardContent>
            {marketLoading ? (
              <Skeleton className="h-[260px] w-full" />
            ) : (
              <div className="h-[260px] w-full">
                <ROIBarChart data={marketROI} xKey="marketType" valueKey="roi" label="ROI" />
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Row 3: Weekly Win Rate + Model Accuracy */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Win Rate by Week</CardTitle>
            <p className="text-xs text-muted-foreground">Weekly settled bet win percentage</p>
          </CardHeader>
          <CardContent>
            <div className="h-[260px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={weeklyWinRateData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid {...CHART_STYLE.grid} />
                  <XAxis
                    dataKey="week"
                    {...CHART_STYLE.axis}
                    tick={{ fontSize: 10, fill: "hsl(215 20% 55%)" }}
                    angle={-30}
                    textAnchor="end"
                    height={40}
                  />
                  <YAxis
                    {...CHART_STYLE.axis}
                    tickFormatter={(v) => `${v}%`}
                    domain={[0, 100]}
                    width={44}
                  />
                  <Tooltip
                    {...CHART_STYLE.tooltip}
                    formatter={(value: number, name: string) => [
                      name === "winRatePct" ? `${value.toFixed(1)}%` : value,
                      name === "winRatePct" ? "Win Rate" : "Bets",
                    ]}
                  />
                  <Line
                    type="monotone"
                    dataKey="winRatePct"
                    stroke="#10b981"
                    strokeWidth={2}
                    dot={{ r: 3, fill: "#10b981" }}
                    activeDot={{ r: 5 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="bets"
                    stroke="#64748b"
                    strokeWidth={1}
                    strokeDasharray="4 2"
                    dot={false}
                    yAxisId={0}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <p className="text-xs text-muted-foreground mt-1">Solid = win rate (%), dashed = bet count</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Model Accuracy over Time</CardTitle>
            <p className="text-xs text-muted-foreground">Accuracy score across retraining cycles</p>
          </CardHeader>
          <CardContent>
            {modelLoading ? (
              <Skeleton className="h-[260px] w-full" />
            ) : accuracyHistory.length === 0 ? (
              <div className="h-[260px] flex items-center justify-center text-sm text-muted-foreground">
                No model history yet
              </div>
            ) : (
              <div className="h-[260px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={accuracyHistory} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid {...CHART_STYLE.grid} />
                    <XAxis
                      dataKey="label"
                      {...CHART_STYLE.axis}
                      tick={{ fontSize: 10, fill: "hsl(215 20% 55%)" }}
                      angle={-20}
                      textAnchor="end"
                      height={40}
                    />
                    <YAxis
                      {...CHART_STYLE.axis}
                      tickFormatter={(v) => `${v}%`}
                      domain={[0, 100]}
                      width={44}
                    />
                    <Tooltip
                      {...CHART_STYLE.tooltip}
                      formatter={(value: number, name: string) => [
                        `${value.toFixed(1)}%`,
                        name === "accuracy" ? "Accuracy" : "Calibration",
                      ]}
                    />
                    <Line
                      type="monotone"
                      dataKey="accuracy"
                      stroke="#3b82f6"
                      strokeWidth={2}
                      dot={{ r: 4, fill: "#3b82f6" }}
                      activeDot={{ r: 6 }}
                      connectNulls
                    />
                    <Line
                      type="monotone"
                      dataKey="calibration"
                      stroke="#a78bfa"
                      strokeWidth={1.5}
                      strokeDasharray="4 2"
                      dot={{ r: 3, fill: "#a78bfa" }}
                      connectNulls
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
            <p className="text-xs text-muted-foreground mt-1">Solid blue = accuracy, dashed purple = calibration</p>
          </CardContent>
        </Card>
      </div>

      {/* Row 4: Segment Stats Table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Edge Analysis by Segment</CardTitle>
          <p className="text-xs text-muted-foreground">
            Where is the agent finding value? Sorted by ROI descending.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {leagueLoading || marketLoading ? (
            <div className="p-6 space-y-3">
              {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-b border-slate-700">
                  <TableHead className="text-xs uppercase tracking-wider pl-4">Segment</TableHead>
                  <TableHead className="text-xs uppercase tracking-wider">Type</TableHead>
                  <TableHead className="text-xs uppercase tracking-wider text-right">Bets</TableHead>
                  <TableHead className="text-xs uppercase tracking-wider text-right">Wins</TableHead>
                  <TableHead className="text-xs uppercase tracking-wider text-right">Losses</TableHead>
                  <TableHead className="text-xs uppercase tracking-wider text-right">Win%</TableHead>
                  <TableHead className="text-xs uppercase tracking-wider text-right">ROI%</TableHead>
                  <TableHead className="text-xs uppercase tracking-wider text-right pr-4">Total P&L</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {statsTable.map((row, i) => (
                  <TableRow key={i} className="hover:bg-slate-800/30 transition-colors">
                    <TableCell className="font-medium text-sm pl-4">{row.segment}</TableCell>
                    <TableCell>
                      <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${
                        row.type === "League"
                          ? "bg-blue-900/40 text-blue-300"
                          : "bg-purple-900/40 text-purple-300"
                      }`}>
                        {row.type}
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">{row.count}</TableCell>
                    <TableCell className="text-right font-mono text-sm text-emerald-400">{row.wins}</TableCell>
                    <TableCell className="text-right font-mono text-sm text-red-400">{row.losses}</TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      <span className={row.winPct >= 50 ? "text-emerald-400" : "text-red-400"}>
                        {row.winPct.toFixed(1)}%
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm font-semibold">
                      <span className={row.roi >= 0 ? "text-emerald-400" : "text-red-400"}>
                        {row.roi >= 0 ? "+" : ""}{row.roi.toFixed(1)}%
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm pr-4">
                      <span className={row.totalPnl >= 0 ? "text-emerald-400" : "text-red-400"}>
                        {row.totalPnl >= 0 ? "+" : ""}{formatCurrency(row.totalPnl)}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
                {statsTable.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground py-8 text-sm">
                      No settled bets yet
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
