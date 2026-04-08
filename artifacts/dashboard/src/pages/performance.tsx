import { usePerformance } from "@/hooks/use-dashboard";
import { formatCurrency } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export default function Performance() {
  const { data: perfData, isLoading } = usePerformance();

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-7xl mx-auto p-6">
        <div className="h-8 w-48 bg-secondary rounded animate-pulse" />
        <div className="h-[400px] w-full bg-secondary rounded animate-pulse" />
        <div className="h-[300px] w-full bg-secondary rounded animate-pulse" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-col gap-2">
        <h2 className="text-3xl font-bold tracking-tight">Performance Analytics</h2>
        <p className="text-muted-foreground">Historical returns and statistical edge analysis.</p>
      </div>

      {/* Cumulative P&L Area Chart */}
      <Card>
        <CardHeader>
          <CardTitle>Cumulative P&L</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-[400px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={perfData?.cumulativeProfit || []} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorCumPnl" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis 
                  dataKey="date" 
                  stroke="hsl(var(--muted-foreground))" 
                  fontSize={12} 
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(val) => new Date(val).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' })}
                />
                <YAxis 
                  stroke="hsl(var(--muted-foreground))" 
                  fontSize={12} 
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(val) => `£${val}`}
                />
                <Tooltip 
                  contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))' }}
                  itemStyle={{ color: 'hsl(var(--foreground))' }}
                  formatter={(value: number) => [formatCurrency(value), 'Cumulative P&L']}
                  labelFormatter={(label) => new Date(label).toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' })}
                />
                <Area 
                  type="monotone" 
                  dataKey="cumPnl" 
                  stroke="hsl(var(--primary))" 
                  strokeWidth={2}
                  fillOpacity={1} 
                  fill="url(#colorCumPnl)" 
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Daily P&L Bar Chart */}
        <Card>
          <CardHeader>
            <CardTitle>Daily Returns</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={perfData?.dailyPnl || []} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis 
                    dataKey="date" 
                    stroke="hsl(var(--muted-foreground))" 
                    fontSize={12} 
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(val) => new Date(val).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' })}
                  />
                  <YAxis 
                    stroke="hsl(var(--muted-foreground))" 
                    fontSize={12} 
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(val) => `£${val}`}
                  />
                  <Tooltip 
                    contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))' }}
                    cursor={{ fill: 'hsl(var(--secondary))' }}
                    formatter={(value: number) => [formatCurrency(value), 'Daily P&L']}
                  />
                  <Bar 
                    dataKey="pnl" 
                    radius={[4, 4, 4, 4]}
                  >
                    {
                      (perfData?.dailyPnl || []).map((entry: any, index: number) => (
                        <cell key={`cell-${index}`} fill={entry.pnl >= 0 ? 'hsl(var(--success))' : 'hsl(var(--destructive))'} />
                      ))
                    }
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        {/* Weekly Win Rate Table */}
        <Card>
          <CardHeader>
            <CardTitle>Weekly Summary</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Week</TableHead>
                  <TableHead className="text-right">Bets</TableHead>
                  <TableHead className="text-right">Win Rate</TableHead>
                  <TableHead className="text-right">P&L</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {perfData?.weeklyWinRate?.map((w: any) => (
                  <TableRow key={w.week}>
                    <TableCell className="font-medium text-sm">{w.week}</TableCell>
                    <TableCell className="text-right font-mono text-sm">{w.bets}</TableCell>
                    <TableCell className="text-right font-mono text-sm">{(w.winRate * 100).toFixed(1)}%</TableCell>
                    <TableCell className={w.pnl >= 0 ? "text-right font-mono text-sm text-emerald-500" : "text-right font-mono text-sm text-red-500"}>
                      {w.pnl >= 0 ? '+' : ''}{formatCurrency(w.pnl)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
