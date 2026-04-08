import { useModel } from "@/hooks/use-dashboard";
import { formatDate } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Line,
  LineChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  BarChart,
  Bar,
} from "recharts";
import { Badge } from "@/components/ui/badge";

export default function Learning() {
  const { data: model, isLoading } = useModel();

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-7xl mx-auto p-6">
        <div className="h-32 w-full bg-secondary rounded animate-pulse" />
        <div className="grid grid-cols-2 gap-6">
          <div className="h-[400px] w-full bg-secondary rounded animate-pulse" />
          <div className="h-[400px] w-full bg-secondary rounded animate-pulse" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-col gap-2">
        <h2 className="text-3xl font-bold tracking-tight">Model Health</h2>
        <p className="text-muted-foreground">Logistic regression state and feature importance tracking.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="col-span-1">
          <CardContent className="p-6 space-y-4">
            <span className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Active Model</span>
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-2xl font-bold font-mono">v{model?.currentVersion}</span>
                <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20">LIVE</Badge>
              </div>
              <p className="text-xs text-muted-foreground">Created: {formatDate(model?.createdAt)}</p>
            </div>
          </CardContent>
        </Card>
        
        <Card className="col-span-1">
          <CardContent className="p-6 space-y-4">
            <span className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Accuracy Score</span>
            <div className="flex items-end gap-2">
              <span className="text-3xl font-bold font-mono">{(model?.accuracyScore * 100).toFixed(1)}%</span>
            </div>
          </CardContent>
        </Card>

        <Card className="col-span-1">
          <CardContent className="p-6 space-y-4">
            <span className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Calibration Score</span>
            <div className="flex items-end gap-2">
              <span className="text-3xl font-bold font-mono">{model?.calibrationScore.toFixed(3)}</span>
            </div>
          </CardContent>
        </Card>

        <Card className="col-span-1">
          <CardContent className="p-6 space-y-4">
            <span className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Training Corpus</span>
            <div className="flex items-end gap-2">
              <span className="text-3xl font-bold font-mono">{model?.totalBetsTrainedOn}</span>
              <span className="text-sm text-muted-foreground mb-1">samples</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Feature Importances</CardTitle>
            <CardDescription>Top weights in the current active model</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[400px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart layout="vertical" data={model?.topFeatureImportances || []} margin={{ top: 0, right: 30, left: 60, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={true} vertical={false} />
                  <XAxis type="number" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                  <YAxis dataKey="feature" type="category" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} width={120} />
                  <Tooltip 
                    contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))' }}
                    cursor={{ fill: 'hsl(var(--secondary))' }}
                  />
                  <Bar dataKey="weight" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Accuracy History</CardTitle>
            <CardDescription>Model performance progression across retraining cycles</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[400px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={model?.accuracyHistory || []} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis 
                    dataKey="version" 
                    stroke="hsl(var(--muted-foreground))" 
                    fontSize={12} 
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={v => `v${v}`}
                  />
                  <YAxis 
                    stroke="hsl(var(--muted-foreground))" 
                    fontSize={12} 
                    tickLine={false}
                    axisLine={false}
                    domain={['auto', 'auto']}
                    tickFormatter={v => `${(v * 100).toFixed(0)}%`}
                  />
                  <Tooltip 
                    contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))' }}
                    labelFormatter={v => `Version ${v}`}
                  />
                  <Line type="monotone" dataKey="accuracy" stroke="hsl(var(--success))" strokeWidth={2} dot={{ fill: 'hsl(var(--success))', r: 4 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
