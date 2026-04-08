import { useState, useMemo } from "react";
import { useModel, useNarratives } from "@/hooks/use-dashboard";
import { formatDate } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  Zap,
  BarChart2,
  Brain,
  Activity,
  Target,
  Info,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Narrative type config ────────────────────────────────────────────────────

const NARRATIVE_TYPES: Record<
  string,
  {
    label: string;
    badge: string;
    bg: string;
    border: string;
    icon: React.ReactNode;
  }
> = {
  accuracy_change: {
    label: "Model Improvement",
    badge: "bg-emerald-900/60 text-emerald-300 border-emerald-700/50",
    bg: "bg-emerald-950/20",
    border: "border-emerald-800/30",
    icon: <TrendingUp className="h-4 w-4 text-emerald-400" />,
  },
  calibration_change: {
    label: "Calibration",
    badge: "bg-purple-900/60 text-purple-300 border-purple-700/50",
    bg: "bg-purple-950/20",
    border: "border-purple-800/30",
    icon: <Activity className="h-4 w-4 text-purple-400" />,
  },
  feature_importance_shift: {
    label: "Feature Discovery",
    badge: "bg-violet-900/60 text-violet-300 border-violet-700/50",
    bg: "bg-violet-950/20",
    border: "border-violet-800/30",
    icon: <Zap className="h-4 w-4 text-violet-400" />,
  },
  strategy_best_segment: {
    label: "Confidence Signal",
    badge: "bg-blue-900/60 text-blue-300 border-blue-700/50",
    bg: "bg-blue-950/20",
    border: "border-blue-800/30",
    icon: <Target className="h-4 w-4 text-blue-400" />,
  },
  strategy_worst_segment: {
    label: "Strategy Shift",
    badge: "bg-amber-900/60 text-amber-300 border-amber-700/50",
    bg: "bg-amber-950/20",
    border: "border-amber-800/30",
    icon: <BarChart2 className="h-4 w-4 text-amber-400" />,
  },
  sustained_positive_edge: {
    label: "Confidence Signal",
    badge: "bg-emerald-900/60 text-emerald-300 border-emerald-700/50",
    bg: "bg-emerald-950/20",
    border: "border-emerald-800/30",
    icon: <TrendingUp className="h-4 w-4 text-emerald-400" />,
  },
  risk_circuit_breaker: {
    label: "Risk Event",
    badge: "bg-orange-900/60 text-orange-300 border-orange-700/50",
    bg: "bg-orange-950/20",
    border: "border-orange-800/30",
    icon: <AlertTriangle className="h-4 w-4 text-orange-400" />,
  },
  model_retrain: {
    label: "Model Improvement",
    badge: "bg-emerald-900/60 text-emerald-300 border-emerald-700/50",
    bg: "bg-emerald-950/20",
    border: "border-emerald-800/30",
    icon: <Brain className="h-4 w-4 text-emerald-400" />,
  },
  default: {
    label: "Signal",
    badge: "bg-slate-800 text-slate-300 border-slate-700",
    bg: "bg-slate-800/20",
    border: "border-slate-700/30",
    icon: <Info className="h-4 w-4 text-slate-400" />,
  },
};

function getNarrativeConfig(type: string) {
  return NARRATIVE_TYPES[type] ?? NARRATIVE_TYPES.default;
}

// ─── Narrative Entry ──────────────────────────────────────────────────────────

function NarrativeEntry({ n }: { n: any }) {
  const cfg = getNarrativeConfig(n.narrativeType);

  return (
    <div
      className={cn(
        "flex gap-4 rounded-lg border px-5 py-4 transition-colors hover:bg-slate-800/30",
        cfg.bg,
        cfg.border,
      )}
      data-testid={`narrative-${n.id}`}
    >
      {/* Icon */}
      <div className="mt-0.5 shrink-0 w-8 h-8 rounded-full bg-slate-800/80 flex items-center justify-center border border-slate-700/50">
        {cfg.icon}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "text-[11px] font-mono px-2 py-0.5 rounded border font-medium",
              cfg.badge,
            )}
          >
            {cfg.label}
          </span>
          <span className="text-xs text-muted-foreground font-mono">
            {formatDate(n.createdAt)}
          </span>
        </div>

        {n.title && (
          <p className="text-sm font-semibold text-slate-100 leading-snug">
            {n.title}
          </p>
        )}

        <p className="text-sm text-slate-300 leading-relaxed">{n.body}</p>
      </div>
    </div>
  );
}

// ─── Model Health Card ────────────────────────────────────────────────────────

function ModelHealthCard({ model }: { model: any }) {
  const accuracy = model?.accuracyScore != null ? model.accuracyScore * 100 : null;
  const calibration = model?.calibrationScore ?? null;
  const trainedOn = model?.totalBetsTrainedOn ?? 0;
  const version = model?.currentVersion ?? "—";
  const createdAt = model?.createdAt;

  const history = (model?.accuracyHistory as any[]) ?? [];
  const trend = useMemo(() => {
    if (history.length < 2) return null;
    const d = (history[history.length - 1]?.accuracy ?? 0) - (history[0]?.accuracy ?? 0);
    if (d > 0.02) return { label: "Improving", color: "text-emerald-400", icon: <TrendingUp className="h-3.5 w-3.5" /> };
    if (d < -0.02) return { label: "Declining", color: "text-red-400", icon: <TrendingDown className="h-3.5 w-3.5" /> };
    return { label: "Stable", color: "text-amber-400", icon: <Activity className="h-3.5 w-3.5" /> };
  }, [history]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Model Health</CardTitle>
          <span className="text-xs font-mono text-muted-foreground bg-slate-800 px-2 py-0.5 rounded">
            {version}
          </span>
        </div>
        {createdAt && (
          <CardDescription>Last retrained {formatDate(createdAt)}</CardDescription>
        )}
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="space-y-1">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
              Accuracy
            </p>
            <p className="text-2xl font-bold font-mono text-slate-100">
              {accuracy != null ? `${accuracy.toFixed(1)}%` : "—"}
            </p>
          </div>
          <div className="space-y-1">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
              Calibration
            </p>
            <p className="text-2xl font-bold font-mono text-slate-100">
              {calibration != null ? calibration.toFixed(3) : "—"}
            </p>
          </div>
          <div className="space-y-1">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
              Trained on
            </p>
            <p className="text-2xl font-bold font-mono text-slate-100">
              {trainedOn} <span className="text-sm font-sans text-muted-foreground">bets</span>
            </p>
          </div>
          <div className="space-y-1">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
              Trend
            </p>
            {trend ? (
              <div className={cn("flex items-center gap-1.5 text-base font-semibold", trend.color)}>
                {trend.icon}
                {trend.label}
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">Not enough data</p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Feature Importances Chart ────────────────────────────────────────────────

function FeatureImportancesChart({ model }: { model: any }) {
  const features = (model?.topFeatureImportances as any[]) ?? [];

  if (features.length === 0) {
    return (
      <div className="h-[320px] flex items-center justify-center text-sm text-muted-foreground">
        No feature data yet
      </div>
    );
  }

  // Sort ascending so highest is at top in horizontal bar
  const sorted = [...features].sort((a, b) => a.weight - b.weight);
  const maxWeight = Math.max(...sorted.map((f) => f.weight));

  return (
    <div className="h-[320px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          layout="vertical"
          data={sorted}
          margin={{ top: 4, right: 16, left: 8, bottom: 4 }}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="hsl(217 33% 17%)"
            horizontal={false}
          />
          <XAxis
            type="number"
            stroke="hsl(215 20% 45%)"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            domain={[0, maxWeight * 1.1]}
            tickFormatter={(v) => v.toFixed(2)}
          />
          <YAxis
            type="category"
            dataKey="feature"
            stroke="hsl(215 20% 45%)"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            width={145}
            tick={{ fill: "hsl(215 20% 65%)" }}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "hsl(222 47% 10%)",
              borderColor: "hsl(217 33% 22%)",
              borderRadius: "6px",
              fontSize: "12px",
            }}
            itemStyle={{ color: "hsl(210 40% 92%)" }}
            formatter={(value: number) => [value.toFixed(4), "Weight"]}
          />
          <Bar dataKey="weight" radius={[0, 4, 4, 0]}>
            {sorted.map((entry: any, idx: number) => {
              const intensity = entry.weight / maxWeight;
              const alpha = Math.round(55 + intensity * 200);
              return (
                <Cell
                  key={`cell-${idx}`}
                  fill={`rgba(99,102,241,${(alpha / 255).toFixed(2)})`}
                />
              );
            })}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

const ALL_TYPES = "all";

const TYPE_OPTIONS = [
  { value: ALL_TYPES, label: "All types" },
  { value: "accuracy_change", label: "Model Improvement" },
  { value: "calibration_change", label: "Calibration" },
  { value: "feature_importance_shift", label: "Feature Discovery" },
  { value: "sustained_positive_edge", label: "Confidence Signal" },
  { value: "strategy_best_segment", label: "Strategy Signal" },
  { value: "strategy_worst_segment", label: "Strategy Shift" },
  { value: "risk_circuit_breaker", label: "Risk Event" },
];

export default function Learning() {
  const [typeFilter, setTypeFilter] = useState(ALL_TYPES);

  const { data: model, isLoading: modelLoading } = useModel();
  const { data: narrativesData, isLoading: narrativesLoading } = useNarratives();

  const narratives = useMemo(() => {
    const all = (narrativesData?.narratives as any[]) ?? [];
    if (typeFilter === ALL_TYPES) return all;
    return all.filter((n: any) => n.narrativeType === typeFilter);
  }, [narrativesData, typeFilter]);

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="flex flex-col gap-2">
        <h2 className="text-3xl font-bold tracking-tight">Learning & Model</h2>
        <p className="text-muted-foreground">
          Model health, feature importance, and agent learning narratives.
        </p>
      </div>

      {/* Model Health */}
      {modelLoading ? (
        <Skeleton className="h-36 w-full" />
      ) : (
        <ModelHealthCard model={model} />
      )}

      {/* Feature Importances */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Feature Importances</CardTitle>
          <CardDescription>
            Top 10 model weights — higher = more predictive power
          </CardDescription>
        </CardHeader>
        <CardContent>
          {modelLoading ? (
            <Skeleton className="h-[320px] w-full" />
          ) : (
            <FeatureImportancesChart model={model} />
          )}
        </CardContent>
      </Card>

      {/* Narratives Feed */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold">Agent Narratives</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Learning signals generated after each retraining cycle
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              {narratives.length} {narratives.length === 1 ? "entry" : "entries"}
            </span>
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="w-[180px] h-8 text-sm" data-testid="select-narrative-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {narrativesLoading ? (
          <div className="space-y-3">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-24 w-full rounded-lg" />
            ))}
          </div>
        ) : narratives.length === 0 ? (
          <div className="rounded-lg border border-slate-700/50 bg-slate-800/20 p-12 text-center">
            <Brain className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">
              {typeFilter === ALL_TYPES
                ? "No narratives yet. They appear after the first retraining cycle."
                : "No narratives of this type yet."}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {narratives.map((n: any) => (
              <NarrativeEntry key={n.id} n={n} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
