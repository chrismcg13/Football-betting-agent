import { useState, useMemo } from "react";
import { useModel, useNarratives } from "@/hooks/use-dashboard";
import { formatRelativeTime } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Bar, BarChart, CartesianGrid, Cell, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import {
  Activity, AlertTriangle, Brain, Target, TrendingDown, TrendingUp, Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Feature name mapping ─────────────────────────────────────────────────────

const FEATURE_LABELS: Record<string, string> = {
  home_form_last5: "Home Form (Last 5)",
  away_form_last5: "Away Form (Last 5)",
  home_form_last3: "Home Form (Last 3)",
  away_form_last3: "Away Form (Last 3)",
  home_goals_scored_avg: "Goals Scored (Home)",
  home_goals_conceded_avg: "Goals Conceded (Home)",
  away_goals_scored_avg: "Goals Scored (Away)",
  away_goals_conceded_avg: "Goals Conceded (Away)",
  home_win_rate: "Home Win Rate",
  away_win_rate: "Away Win Rate",
  h2h_home_win_rate: "Head-to-Head History",
  h2h_avg_goals: "H2H Average Goals",
  h2h_avg_home_goals: "H2H Home Goals",
  h2h_avg_away_goals: "H2H Away Goals",
  league_avg_goals: "League Average Goals",
  home_elo: "Home Team Rating",
  away_elo: "Away Team Rating",
  elo_diff: "Team Rating Difference",
  home_position: "Home League Position",
  away_position: "Away League Position",
  position_diff: "Position Difference",
  home_points_per_game: "Points Per Game (Home)",
  away_points_per_game: "Points Per Game (Away)",
  match_importance: "Match Importance",
  home_clean_sheets: "Clean Sheets (Home)",
  away_clean_sheets: "Clean Sheets (Away)",
};

function featureLabel(key: string): string {
  return (
    FEATURE_LABELS[key] ??
    key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

// ─── Narrative config ─────────────────────────────────────────────────────────

const NARRATIVE_CONFIG: Record<
  string,
  { label: string; icon: React.ReactNode; bg: string; border: string; badge: string }
> = {
  accuracy_change: {
    label: "Model Improvement",
    icon: <TrendingUp className="h-4 w-4 text-emerald-400" />,
    bg: "rgba(16,185,129,0.06)",
    border: "rgba(16,185,129,0.2)",
    badge: "bg-emerald-950 text-emerald-400 border-emerald-800",
  },
  calibration_change: {
    label: "Calibration Update",
    icon: <Activity className="h-4 w-4 text-purple-400" />,
    bg: "rgba(168,85,247,0.06)",
    border: "rgba(168,85,247,0.2)",
    badge: "bg-purple-950 text-purple-400 border-purple-800",
  },
  feature_importance_shift: {
    label: "Feature Discovery",
    icon: <Zap className="h-4 w-4 text-violet-400" />,
    bg: "rgba(139,92,246,0.06)",
    border: "rgba(139,92,246,0.2)",
    badge: "bg-violet-950 text-violet-400 border-violet-800",
  },
  strategy_best_segment: {
    label: "Confidence Signal",
    icon: <Target className="h-4 w-4 text-blue-400" />,
    bg: "rgba(59,130,246,0.06)",
    border: "rgba(59,130,246,0.2)",
    badge: "bg-blue-950 text-blue-400 border-blue-800",
  },
  strategy_worst_segment: {
    label: "Weak Spot Found",
    icon: <TrendingDown className="h-4 w-4 text-amber-400" />,
    bg: "rgba(245,158,11,0.06)",
    border: "rgba(245,158,11,0.2)",
    badge: "bg-amber-950 text-amber-400 border-amber-800",
  },
  sustained_positive_edge: {
    label: "Positive Edge",
    icon: <TrendingUp className="h-4 w-4 text-emerald-400" />,
    bg: "rgba(16,185,129,0.06)",
    border: "rgba(16,185,129,0.2)",
    badge: "bg-emerald-950 text-emerald-400 border-emerald-800",
  },
  risk_circuit_breaker: {
    label: "Risk Event",
    icon: <AlertTriangle className="h-4 w-4 text-orange-400" />,
    bg: "rgba(249,115,22,0.06)",
    border: "rgba(249,115,22,0.2)",
    badge: "bg-orange-950 text-orange-400 border-orange-800",
  },
  model_retrain: {
    label: "Model Retrained",
    icon: <Brain className="h-4 w-4 text-emerald-400" />,
    bg: "rgba(16,185,129,0.06)",
    border: "rgba(16,185,129,0.2)",
    badge: "bg-emerald-950 text-emerald-400 border-emerald-800",
  },
};

function getNarrativeConfig(type: string) {
  return (
    NARRATIVE_CONFIG[type] ?? {
      label: type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      icon: <Activity className="h-4 w-4 text-slate-400" />,
      bg: "rgba(100,116,139,0.05)",
      border: "rgba(100,116,139,0.2)",
      badge: "bg-slate-800 text-slate-400 border-slate-700",
    }
  );
}

// ─── TT style ─────────────────────────────────────────────────────────────────

const TT = {
  contentStyle: {
    background: "#0f172a",
    border: "1px solid #334155",
    borderRadius: "8px",
    fontSize: "12px",
  },
  itemStyle: { color: "#94a3b8" },
};

// ─── Narrative card ───────────────────────────────────────────────────────────

function NarrativeCard({ n }: { n: any }) {
  const cfg = getNarrativeConfig(n.narrativeType);
  const body =
    n.body && n.body !== n.narrativeType && n.body.length > 6
      ? n.body
      : n.title ?? n.narrativeType.replace(/_/g, " ");

  return (
    <div
      className="rounded-xl border flex items-start gap-4 px-5 py-4 transition-colors"
      style={{ background: cfg.bg, borderColor: cfg.border }}
      data-testid={`narrative-${n.id}`}
    >
      <div
        className="mt-0.5 shrink-0 w-8 h-8 rounded-full flex items-center justify-center border"
        style={{ background: "#1e293b", borderColor: "#334155" }}
      >
        {cfg.icon}
      </div>
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn("text-[10px] font-mono px-2 py-0.5 rounded border font-semibold", cfg.badge)}>
            {cfg.label}
          </span>
          <span className="text-xs text-slate-600">{formatRelativeTime(n.createdAt)}</span>
        </div>
        {n.title && n.title !== n.body && (
          <p className="text-sm font-semibold text-white leading-snug">{n.title}</p>
        )}
        <p className="text-sm text-slate-300 leading-relaxed">{body}</p>
      </div>
    </div>
  );
}

// ─── Model Health ─────────────────────────────────────────────────────────────

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
    if (d > 0.02) return { label: "Improving", color: "#10b981", icon: <TrendingUp className="h-3.5 w-3.5" /> };
    if (d < -0.02) return { label: "Declining", color: "#ef4444", icon: <TrendingDown className="h-3.5 w-3.5" /> };
    return { label: "Stable", color: "#f59e0b", icon: <Activity className="h-3.5 w-3.5" /> };
  }, [history]);

  const stats = [
    {
      label: "Accuracy",
      value: accuracy != null ? `${accuracy.toFixed(1)}%` : "—",
      color: accuracy != null ? (accuracy >= 55 ? "#10b981" : "#f59e0b") : undefined,
    },
    {
      label: "Calibration",
      value: calibration != null ? calibration.toFixed(3) : "—",
      color: undefined,
    },
    {
      label: "Trained on",
      value: `${trainedOn}`,
      sub: "bets",
      color: undefined,
    },
    {
      label: "Trend",
      value: trend?.label ?? "—",
      color: trend?.color,
    },
  ];

  return (
    <div
      className="rounded-xl border p-5"
      style={{ background: "#1e293b", borderColor: "#334155" }}
    >
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm font-semibold text-white">Model Health</p>
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono text-slate-500 px-2 py-0.5 rounded" style={{ background: "#0f172a" }}>
            {version}
          </span>
          {createdAt && (
            <span className="text-xs text-slate-600">
              Retrained {formatRelativeTime(createdAt)}
            </span>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {stats.map((s) => (
          <div key={s.label} className="space-y-1">
            <p className="text-[10px] uppercase tracking-wider text-slate-600 font-semibold">{s.label}</p>
            <p
              className="text-2xl font-bold font-mono"
              style={{ color: s.color ?? "#e2e8f0" }}
            >
              {s.value}
              {s.sub && <span className="text-sm font-sans text-slate-500 ml-1">{s.sub}</span>}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Feature Importances ──────────────────────────────────────────────────────

function FeatureChart({ model }: { model: any }) {
  const raw = (model?.topFeatureImportances as any[]) ?? [];
  if (raw.length === 0) {
    return (
      <div className="h-80 flex items-center justify-center text-sm text-slate-500">
        No feature data yet
      </div>
    );
  }

  const sorted = [...raw]
    .sort((a, b) => a.weight - b.weight)
    .map((f) => ({ ...f, label: featureLabel(f.feature) }));
  const maxW = Math.max(...sorted.map((f) => f.weight));

  return (
    <div className="h-80">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart layout="vertical" data={sorted} margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e3a5f" horizontal={false} />
          <XAxis
            type="number"
            stroke="#475569"
            fontSize={10}
            tickLine={false}
            axisLine={false}
            domain={[0, maxW * 1.15]}
            tickFormatter={(v) => v.toFixed(2)}
          />
          <YAxis
            type="category"
            dataKey="label"
            stroke="#475569"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            width={165}
            tick={{ fill: "#94a3b8" }}
          />
          <Tooltip {...TT} formatter={(v: number) => [v.toFixed(4), "Weight"]} />
          <Bar dataKey="weight" radius={[0, 4, 4, 0]}>
            {sorted.map((entry: any, idx: number) => {
              const intensity = entry.weight / maxW;
              return (
                <Cell
                  key={`cell-${idx}`}
                  fill={`rgba(99,102,241,${(0.4 + intensity * 0.6).toFixed(2)})`}
                />
              );
            })}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Accuracy History Chart ───────────────────────────────────────────────────

function AccuracyChart({ model }: { model: any }) {
  const data = useMemo(
    () =>
      ((model?.accuracyHistory as any[]) ?? []).map((h: any) => ({
        label: h.version?.slice(0, 14) ?? "",
        accuracy: h.accuracy != null ? Math.round(h.accuracy * 1000) / 10 : null,
        calibration: h.calibration,
      })),
    [model],
  );

  if (data.length < 2) {
    return (
      <div className="h-52 flex items-center justify-center text-sm text-slate-500">
        Needs more retraining cycles to show a trend
      </div>
    );
  }

  return (
    <div className="h-52">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 24 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e3a5f" vertical={false} />
          <XAxis
            dataKey="label"
            stroke="#475569"
            fontSize={9}
            tickLine={false}
            axisLine={false}
            angle={-20}
            textAnchor="end"
            height={40}
            tick={{ fill: "#64748b" }}
          />
          <YAxis
            stroke="#475569"
            fontSize={10}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v) => `${v}%`}
            domain={[0, 100]}
            width={44}
          />
          <Tooltip {...TT} formatter={(v: number, n: string) => [`${v.toFixed(1)}%`, n === "accuracy" ? "Accuracy" : "Calibration"]} />
          <Line type="monotone" dataKey="accuracy" stroke="#3b82f6" strokeWidth={2.5} dot={{ r: 4, fill: "#3b82f6" }} activeDot={{ r: 6 }} connectNulls />
          <Line type="monotone" dataKey="calibration" stroke="#a78bfa" strokeWidth={1.5} strokeDasharray="4 3" dot={{ r: 3, fill: "#a78bfa" }} connectNulls />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

const TYPE_OPTIONS = [
  { value: "all", label: "All types" },
  { value: "accuracy_change", label: "Model Improvement" },
  { value: "calibration_change", label: "Calibration" },
  { value: "feature_importance_shift", label: "Feature Discovery" },
  { value: "sustained_positive_edge", label: "Positive Edge" },
  { value: "strategy_best_segment", label: "Confidence Signal" },
  { value: "strategy_worst_segment", label: "Weak Spot" },
  { value: "risk_circuit_breaker", label: "Risk Event" },
  { value: "model_retrain", label: "Model Retrained" },
];

export default function Learning() {
  const [typeFilter, setTypeFilter] = useState("all");
  const { data: model, isLoading: modelLoading } = useModel();
  const { data: narrativesData, isLoading: narrativesLoading } = useNarratives();

  const narratives = useMemo(() => {
    const all = (narrativesData?.narratives as any[]) ?? [];
    if (typeFilter === "all") return all;
    return all.filter((n: any) => n.narrativeType === typeFilter);
  }, [narrativesData, typeFilter]);

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div>
        <h2 className="text-2xl font-bold text-white tracking-tight">Learning & Model</h2>
        <p className="text-sm text-slate-500 mt-1">Model health, feature importance, and agent learning narratives.</p>
      </div>

      {/* Model Health */}
      {modelLoading
        ? <Skeleton className="h-36 w-full rounded-xl" />
        : <ModelHealthCard model={model} />}

      {/* Feature importances + Accuracy history */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div
          className="rounded-xl border p-5"
          style={{ background: "#1e293b", borderColor: "#334155" }}
        >
          <p className="text-sm font-semibold text-white mb-0.5">Feature Importances</p>
          <p className="text-xs text-slate-500 mb-4">
            Top predictors — higher weight = more influence on model decisions
          </p>
          {modelLoading ? <Skeleton className="h-80 w-full" /> : <FeatureChart model={model} />}
        </div>

        <div
          className="rounded-xl border p-5"
          style={{ background: "#1e293b", borderColor: "#334155" }}
        >
          <p className="text-sm font-semibold text-white mb-0.5">Accuracy History</p>
          <p className="text-xs text-slate-500 mb-4">
            Model accuracy improving over retraining cycles
          </p>
          {modelLoading ? <Skeleton className="h-52 w-full" /> : <AccuracyChart model={model} />}
          <p className="text-xs text-slate-600 mt-2">Solid blue = accuracy · dashed purple = calibration</p>
        </div>
      </div>

      {/* Narrative Feed */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-base font-semibold text-white">Agent Narratives</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {narratives.length} {narratives.length === 1 ? "entry" : "entries"} · Generated after each retraining cycle
            </p>
          </div>
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger
              className="w-[180px] h-8 text-xs border-slate-700"
              style={{ background: "#0f172a" }}
              data-testid="select-narrative-type"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TYPE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {narrativesLoading ? (
          <div className="space-y-3">
            {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-24 w-full rounded-xl" />)}
          </div>
        ) : narratives.length === 0 ? (
          <div
            className="rounded-xl border p-12 text-center"
            style={{ background: "#1e293b", borderColor: "#334155" }}
          >
            <Brain className="h-8 w-8 text-slate-600 mx-auto mb-3" />
            <p className="text-sm text-slate-500">
              {typeFilter === "all"
                ? "No narratives yet. They appear after the first retraining cycle."
                : "No narratives of this type yet."}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {narratives.map((n: any) => <NarrativeCard key={n.id} n={n} />)}
          </div>
        )}
      </div>
    </div>
  );
}
