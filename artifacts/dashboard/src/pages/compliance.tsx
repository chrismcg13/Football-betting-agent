import { Fragment, useState } from "react";
import { useComplianceLogs, useComplianceStats } from "@/hooks/use-dashboard";
import { formatRelativeTime } from "@/lib/format";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertTriangle, BarChart2, ChevronDown, ChevronLeft, ChevronRight, ChevronUp,
  DollarSign, Download, FileText, PlayCircle, Settings, Shield, TrendingUp, XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Action badge config ──────────────────────────────────────────────────────

const ACTION_CONFIG: Record<string, { label: string; badge: string; icon: React.ReactNode }> = {
  bet_placed: {
    label: "BET PLACED",
    badge: "bg-blue-950 text-blue-400 border-blue-800",
    icon: <TrendingUp className="h-3 w-3" />,
  },
  bet_settled: {
    label: "BET SETTLED",
    badge: "bg-emerald-950 text-emerald-400 border-emerald-800",
    icon: <DollarSign className="h-3 w-3" />,
  },
  bet_rejected: {
    label: "REJECTED",
    badge: "bg-amber-950 text-amber-400 border-amber-800",
    icon: <XCircle className="h-3 w-3" />,
  },
  risk_event: {
    label: "RISK EVENT",
    badge: "bg-orange-950 text-orange-400 border-orange-800",
    icon: <AlertTriangle className="h-3 w-3" />,
  },
  agent_control: {
    label: "AGENT CTRL",
    badge: "bg-slate-800 text-slate-400 border-slate-700",
    icon: <PlayCircle className="h-3 w-3" />,
  },
  decision: {
    label: "DECISION",
    badge: "bg-slate-800 text-slate-400 border-slate-700",
    icon: <FileText className="h-3 w-3" />,
  },
  config_change: {
    label: "CONFIG",
    badge: "bg-purple-950 text-purple-400 border-purple-800",
    icon: <Settings className="h-3 w-3" />,
  },
  bankroll_updated: {
    label: "BANKROLL",
    badge: "bg-teal-950 text-teal-400 border-teal-800",
    icon: <DollarSign className="h-3 w-3" />,
  },
  value_detection_evaluation: {
    label: "VALUE SCAN",
    badge: "bg-violet-950 text-violet-400 border-violet-800",
    icon: <BarChart2 className="h-3 w-3" />,
  },
  api_error: {
    label: "API ERROR",
    badge: "bg-red-950 text-red-400 border-red-800",
    icon: <AlertTriangle className="h-3 w-3" />,
  },
};

function getActionConfig(type: string) {
  return (
    ACTION_CONFIG[type] ?? {
      label: type.toUpperCase().replace(/_/g, " "),
      badge: "bg-slate-800 text-slate-400 border-slate-700",
      icon: <FileText className="h-3 w-3" />,
    }
  );
}

function ActionBadge({ type }: { type: string }) {
  const cfg = getActionConfig(type);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[10px] font-mono font-semibold px-2 py-0.5 rounded border whitespace-nowrap",
        cfg.badge,
      )}
    >
      {cfg.icon}
      {cfg.label}
    </span>
  );
}

// ─── Auto-summarise ───────────────────────────────────────────────────────────

function summarise(actionType: string, details: any): string {
  if (!details || typeof details !== "object") return String(details ?? "—");
  try {
    switch (actionType) {
      case "bet_placed":
        return `Placed £${Number(details.stake ?? 0).toFixed(2)} BACK on "${details.selectionName}" at ${Number(details.backOdds ?? 0).toFixed(2)} odds. Edge: ${(Number(details.edge ?? 0) * 100).toFixed(1)}%.`;
      case "bet_settled": {
        const pnl = Number(details.pnl ?? 0);
        return `Settled "${details.selectionName}" — ${details.outcome ?? "unknown"}. P&L: ${pnl >= 0 ? "+" : ""}£${pnl.toFixed(2)}.`;
      }
      case "bet_rejected":
        return `Rejected bet on "${details.selectionName ?? "—"}": ${details.reason ?? "unknown reason"}.`;
      case "risk_event": {
        const reason = details.reason ?? details.message ?? details.type ?? "unknown";
        const bankroll = details.bankroll != null ? ` Bankroll: £${Number(details.bankroll).toFixed(2)}.` : "";
        const status = details.newStatus ? ` Status → ${details.newStatus}.` : "";
        return `Risk event: ${reason}.${bankroll}${status}`;
      }
      case "decision": {
        const action = details.action ?? "unknown";
        const dur = details.duration_ms != null ? ` Duration: ${(details.duration_ms / 1000).toFixed(1)}s.` : "";
        if (action === "data_ingestion_complete") return `Data ingestion complete.${dur}`;
        if (action === "data_ingestion_start") return "Data ingestion started.";
        return `Decision: ${action}`;
      }
      case "agent_control":
        return `Agent ${details.action ?? "—"} by ${details.initiatedBy ?? "api"}. Status: ${details.previousStatus ?? "—"} → ${details.newStatus ?? "—"}.`;
      case "config_change": {
        const keys = Object.keys(details.changed ?? {});
        if (keys.length === 0) return "Configuration update.";
        const parts = keys.map((k) => {
          const c = details.changed[k];
          return `${k}: ${c.from ?? "—"} → ${c.to}`;
        });
        return `Config updated: ${parts.join(", ")}.`;
      }
      case "bankroll_updated": {
        const before = Number(details.bankrollBefore ?? 0).toFixed(2);
        const after = Number(details.bankrollAfter ?? 0).toFixed(2);
        return `Bankroll: £${before} → £${after}. Reason: ${details.reason ?? "settlement"}.`;
      }
      case "value_detection_evaluation":
        return `Evaluated ${details.matchId ?? "match"} for ${details.marketType ?? "—"}: ${details.verdict ?? "no value found"}.`;
      case "api_error":
        return `API error on ${details.method ?? "—"} ${details.path ?? details.url ?? "—"}: ${details.message ?? "unknown error"}.`;
      default:
        return Object.entries(details)
          .slice(0, 3)
          .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
          .join(" · ");
    }
  } catch {
    return "—";
  }
}

// ─── Stats Bar ────────────────────────────────────────────────────────────────

function StatsBar({ stats }: { stats: any }) {
  const items = [
    {
      label: "Total Logged Events",
      value: stats?.totalEvents?.toLocaleString() ?? "—",
      color: "#e2e8f0",
    },
    {
      label: "Events Today",
      value: stats?.eventsToday?.toLocaleString() ?? "—",
      color: "#e2e8f0",
    },
    {
      label: "Circuit Breaker Activations",
      value: stats?.circuitBreakerActivations?.toLocaleString() ?? "—",
      color: (stats?.circuitBreakerActivations ?? 0) > 0 ? "#f97316" : "#e2e8f0",
    },
  ];

  return (
    <div
      className="rounded-xl border p-5 grid grid-cols-2 sm:grid-cols-3 gap-5"
      style={{ background: "#1e293b", borderColor: "#334155" }}
    >
      {items.map((item) => (
        <div key={item.label}>
          <p className="text-[10px] uppercase tracking-widest text-slate-600 font-semibold mb-1">
            {item.label}
          </p>
          <p className="text-2xl font-bold font-mono" style={{ color: item.color }}>
            {item.value}
          </p>
        </div>
      ))}
    </div>
  );
}

// ─── Expanded JSON ────────────────────────────────────────────────────────────

function ExpandedDetails({ details }: { details: any }) {
  const fmt =
    typeof details === "object" ? JSON.stringify(details, null, 2) : String(details ?? "{}");
  return (
    <tr>
      <td
        colSpan={4}
        className="pb-0 pt-0 px-4"
      >
        <div
          className="mx-0 my-2 rounded-lg border overflow-hidden"
          style={{ background: "#0a1020", borderColor: "#334155" }}
        >
          <div
            className="flex items-center justify-between px-4 py-2 border-b"
            style={{ background: "#0f172a", borderColor: "#334155" }}
          >
            <span className="text-[10px] font-mono text-slate-600 uppercase tracking-wider">
              Raw JSON
            </span>
            <Shield className="h-3 w-3 text-slate-700" />
          </div>
          <pre className="text-[11px] font-mono text-slate-300 px-4 py-3 leading-relaxed overflow-x-auto max-h-64">
            {fmt}
          </pre>
        </div>
      </td>
    </tr>
  );
}

// ─── Action options ───────────────────────────────────────────────────────────

const ACTION_OPTIONS = [
  { value: "all", label: "All action types" },
  { value: "bet_placed", label: "Bet Placed" },
  { value: "bet_settled", label: "Bet Settled" },
  { value: "bet_rejected", label: "Bet Rejected" },
  { value: "risk_event", label: "Risk Event" },
  { value: "agent_control", label: "Agent Control" },
  { value: "config_change", label: "Config Change" },
  { value: "bankroll_updated", label: "Bankroll Updated" },
  { value: "value_detection_evaluation", label: "Value Detection" },
  { value: "decision", label: "System Decision" },
  { value: "api_error", label: "API Error" },
];

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Compliance() {
  const [page, setPage] = useState(1);
  const [actionType, setActionType] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const { data: logsData, isLoading } = useComplianceLogs(
    page, 25, actionType, dateFrom || undefined, dateTo || undefined,
  );
  const { data: stats } = useComplianceStats();

  const resetFilters = () => {
    setActionType("all");
    setDateFrom("");
    setDateTo("");
    setPage(1);
  };

  const hasFilters = actionType !== "all" || dateFrom || dateTo;
  const totalPages = logsData?.totalPages ?? 1;
  const total = logsData?.total ?? 0;
  const logs = (logsData?.logs as any[]) ?? [];

  function handleExport() {
    const a = document.createElement("a");
    a.href = "/api/compliance/export?format=csv";
    a.download = "";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-white tracking-tight">Compliance & Audit</h2>
          <p className="text-sm text-slate-500 mt-1">
            Full audit trail of all automated decisions. Exportable for regulatory purposes.
          </p>
        </div>
        <Button
          onClick={handleExport}
          className="shrink-0 gap-2 bg-slate-700 hover:bg-slate-600 text-white border-slate-600 text-xs"
          variant="outline"
          data-testid="btn-export-csv"
        >
          <Download className="w-4 h-4" />
          Export to CSV
        </Button>
      </div>

      {/* Stats Bar */}
      <StatsBar stats={stats} />

      {/* Main Table Card */}
      <div
        className="rounded-xl border overflow-hidden"
        style={{ background: "#1e293b", borderColor: "#334155" }}
      >
        {/* Filter Bar */}
        <div
          className="px-4 py-3 border-b flex flex-wrap items-center gap-3"
          style={{ background: "#172033", borderColor: "#334155" }}
        >
          <Select
            value={actionType}
            onValueChange={(v) => { setActionType(v); setPage(1); }}
          >
            <SelectTrigger
              className="w-[195px] h-8 text-xs border-slate-700"
              style={{ background: "#0f172a" }}
              data-testid="select-action-type"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACTION_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex items-center gap-2">
            <span className="text-[11px] text-slate-600 font-mono">From</span>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => { setDateFrom(e.target.value); setPage(1); }}
              className="h-8 px-2.5 text-xs font-mono rounded text-slate-200 border [color-scheme:dark]"
              style={{ background: "#0f172a", borderColor: "#334155" }}
              data-testid="input-date-from"
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[11px] text-slate-600 font-mono">To</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => { setDateTo(e.target.value); setPage(1); }}
              className="h-8 px-2.5 text-xs font-mono rounded text-slate-200 border [color-scheme:dark]"
              style={{ background: "#0f172a", borderColor: "#334155" }}
              data-testid="input-date-to"
            />
          </div>

          {hasFilters && (
            <button
              onClick={resetFilters}
              className="text-xs text-slate-500 hover:text-slate-300 underline underline-offset-2"
            >
              Clear
            </button>
          )}

          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-slate-600 font-mono whitespace-nowrap">
              {total.toLocaleString()} {total === 1 ? "event" : "events"}
              {totalPages > 1 && ` · p${page}/${totalPages}`}
            </span>
            <div className="flex gap-1">
              <Button
                variant="outline"
                size="icon"
                className="h-7 w-7 border-slate-700"
                style={{ background: "#0f172a" }}
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                data-testid="btn-prev-logs"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-7 w-7 border-slate-700"
                style={{ background: "#0f172a" }}
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
                data-testid="btn-next-logs"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </div>

        {/* Table */}
        {isLoading ? (
          <div className="p-5 space-y-3">
            {[...Array(10)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        ) : logs.length === 0 ? (
          <div className="py-20 text-center">
            <FileText className="h-8 w-8 text-slate-700 mx-auto mb-3" />
            <p className="text-sm text-slate-500">No compliance logs found for the current filters.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b" style={{ borderColor: "#334155" }}>
                  <th className="w-8 py-3 pl-3" />
                  <th className="py-3 px-3 text-left text-[11px] uppercase tracking-wider text-slate-500 font-semibold w-36">
                    Time
                  </th>
                  <th className="py-3 px-3 text-left text-[11px] uppercase tracking-wider text-slate-500 font-semibold w-36">
                    Action
                  </th>
                  <th className="py-3 px-3 text-left text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
                    Summary
                  </th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log: any) => {
                  const details =
                    typeof log.details === "string"
                      ? (() => { try { return JSON.parse(log.details); } catch { return {}; } })()
                      : (log.details ?? {});
                  const summary = summarise(log.actionType, details);
                  const isExpanded = expandedId === log.id;

                  return (
                    <Fragment key={log.id}>
                      <tr
                        className={cn(
                          "cursor-pointer border-b transition-colors",
                          isExpanded
                            ? "border-b-0"
                            : "hover:bg-slate-800/20",
                        )}
                        style={{
                          borderColor: "#1e3a5f",
                          background: isExpanded ? "rgba(255,255,255,0.03)" : undefined,
                        }}
                        onClick={() => setExpandedId((p) => (p === log.id ? null : log.id))}
                        data-testid={`row-log-${log.id}`}
                      >
                        <td className="pl-4 py-3 w-8">
                          {isExpanded
                            ? <ChevronUp className="h-3 w-3 text-slate-600" />
                            : <ChevronDown className="h-3 w-3 text-slate-600" />}
                        </td>
                        <td className="py-3 px-3 font-mono text-[11px] text-slate-500 whitespace-nowrap">
                          {formatRelativeTime(log.timestamp)}
                        </td>
                        <td className="py-3 px-3">
                          <ActionBadge type={log.actionType} />
                        </td>
                        <td className="py-3 px-3 pr-5 text-sm text-slate-300 leading-snug">
                          {summary}
                        </td>
                      </tr>
                      {isExpanded && <ExpandedDetails details={details} />}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination footer */}
        {totalPages > 1 && (
          <div
            className="px-5 py-3 border-t flex items-center justify-between"
            style={{ borderColor: "#334155" }}
          >
            <span className="text-xs text-slate-600 font-mono">
              {((page - 1) * 25 + 1).toLocaleString()}–{Math.min(page * 25, total).toLocaleString()} of {total.toLocaleString()}
            </span>
            <div className="flex gap-1">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1 border-slate-700 bg-slate-800/50"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                <ChevronLeft className="h-3 w-3" /> Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1 border-slate-700 bg-slate-800/50"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next <ChevronRight className="h-3 w-3" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
