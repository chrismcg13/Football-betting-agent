import { Fragment, useState } from "react";
import { useComplianceLogs, useComplianceStats } from "@/hooks/use-dashboard";
import { formatDate } from "@/lib/format";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Download,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  FileText,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Settings,
  PlayCircle,
  XCircle,
  BarChart2,
  DollarSign,
  Shield,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Action type config ───────────────────────────────────────────────────────

const ACTION_CONFIG: Record<
  string,
  { label: string; badge: string; icon: React.ReactNode }
> = {
  bet_placed: {
    label: "BET PLACED",
    badge: "bg-blue-950/60 text-blue-300 border-blue-700/50",
    icon: <TrendingUp className="h-3 w-3" />,
  },
  bet_settled: {
    label: "BET SETTLED",
    badge: "bg-emerald-950/60 text-emerald-300 border-emerald-700/50",
    icon: <DollarSign className="h-3 w-3" />,
  },
  bet_rejected: {
    label: "BET REJECTED",
    badge: "bg-amber-950/60 text-amber-300 border-amber-700/50",
    icon: <XCircle className="h-3 w-3" />,
  },
  risk_event: {
    label: "RISK EVENT",
    badge: "bg-orange-950/60 text-orange-300 border-orange-700/50",
    icon: <AlertTriangle className="h-3 w-3" />,
  },
  agent_control: {
    label: "AGENT CONTROL",
    badge: "bg-slate-800/80 text-slate-300 border-slate-600/50",
    icon: <PlayCircle className="h-3 w-3" />,
  },
  decision: {
    label: "DECISION",
    badge: "bg-slate-800/80 text-slate-300 border-slate-600/50",
    icon: <FileText className="h-3 w-3" />,
  },
  config_change: {
    label: "CONFIG CHANGE",
    badge: "bg-purple-950/60 text-purple-300 border-purple-700/50",
    icon: <Settings className="h-3 w-3" />,
  },
  bankroll_updated: {
    label: "BANKROLL",
    badge: "bg-teal-950/60 text-teal-300 border-teal-700/50",
    icon: <DollarSign className="h-3 w-3" />,
  },
  value_detection_evaluation: {
    label: "VALUE DETECTION",
    badge: "bg-violet-950/60 text-violet-300 border-violet-700/50",
    icon: <BarChart2 className="h-3 w-3" />,
  },
};

function getActionConfig(type: string) {
  return (
    ACTION_CONFIG[type] ?? {
      label: type.toUpperCase().replace(/_/g, " "),
      badge: "bg-slate-800 text-slate-300 border-slate-600",
      icon: <FileText className="h-3 w-3" />,
    }
  );
}

// ─── Auto-generate a human-readable summary from the details object ───────────

function summarise(actionType: string, details: any): string {
  if (!details || typeof details !== "object") return String(details ?? "—");
  try {
    switch (actionType) {
      case "bet_placed":
        return `Placed £${Number(details.stake ?? 0).toFixed(2)} BACK on "${details.selectionName}" at ${Number(details.backOdds ?? 0).toFixed(2)} odds. Edge: ${(Number(details.edge ?? 0) * 100).toFixed(1)}%. Kelly stake applied.`;

      case "bet_settled": {
        const pnl = Number(details.pnl ?? 0);
        const sign = pnl >= 0 ? "+" : "";
        return `Settled "${details.selectionName}" — ${details.outcome ?? "unknown"}. P&L: ${sign}£${pnl.toFixed(2)}. Status: ${details.newStatus ?? "—"}.`;
      }

      case "bet_rejected":
        return `Rejected bet on "${details.selectionName ?? "—"}": ${details.reason ?? "unknown reason"}.`;

      case "risk_event": {
        const reason = details.reason ?? details.message ?? details.type ?? "unknown";
        const status = details.newStatus ?? details.action ?? null;
        const bankroll = details.bankroll != null ? ` Bankroll: £${Number(details.bankroll).toFixed(2)}.` : "";
        const statusStr = status ? ` Status → ${status}.` : "";
        return `Risk event: ${reason}.${bankroll}${statusStr}`;
      }

      case "decision": {
        const action = details.action ?? "unknown";
        const sources = Array.isArray(details.data_sources)
          ? details.data_sources.join(", ")
          : details.data_sources ?? null;
        if (action === "data_ingestion_complete") {
          const dur = details.duration_ms != null ? ` Duration: ${(details.duration_ms / 1000).toFixed(1)}s.` : "";
          return `Data ingestion complete.${dur}${sources ? ` Sources: ${sources}.` : ""}`;
        }
        if (action === "data_ingestion_start") {
          return `Data ingestion started.${sources ? ` Sources: ${sources}.` : ""}`;
        }
        return `Decision: ${action}`;
      }

      case "agent_control":
        return `Agent ${details.action ?? "—"} by ${details.initiatedBy ?? "api"}. Status: ${details.previousStatus ?? "—"} → ${details.newStatus ?? "—"}.`;

      case "config_change": {
        const keys = Object.keys(details.changed ?? {});
        if (keys.length === 0) return "Configuration update with no changes.";
        const parts = keys.map((k) => {
          const c = details.changed[k];
          return `${k}: ${c.from ?? "—"} → ${c.to}`;
        });
        return `Config updated: ${parts.join(", ")}.`;
      }

      case "bankroll_updated": {
        const before = Number(details.bankrollBefore ?? 0).toFixed(2);
        const after = Number(details.bankrollAfter ?? 0).toFixed(2);
        return `Bankroll updated: £${before} → £${after}. Reason: ${details.reason ?? "settlement"}.`;
      }

      case "value_detection_evaluation":
        return `Evaluated ${details.matchId ?? "match"} for ${details.marketType ?? "—"}: ${details.verdict ?? "no value found"}.`;

      default:
        return Object.entries(details)
          .slice(0, 4)
          .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
          .join(" · ");
    }
  } catch {
    return "—";
  }
}

// ─── Action Type Badge ────────────────────────────────────────────────────────

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

// ─── Expanded JSON row ────────────────────────────────────────────────────────

function ExpandedDetails({ details }: { details: any }) {
  const formatted =
    typeof details === "object"
      ? JSON.stringify(details, null, 2)
      : String(details ?? "{}");

  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={4} className="px-0 pb-0 pt-0 border-b border-slate-700/50">
        <div className="mx-4 my-3 rounded-md border border-slate-700/60 bg-slate-950/70 overflow-auto max-h-72">
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-700/60 bg-slate-900/50">
            <span className="text-[10px] font-mono text-slate-500 uppercase tracking-wider">
              Full Details JSON
            </span>
            <Shield className="h-3 w-3 text-slate-600" />
          </div>
          <pre className="text-[11px] font-mono text-slate-300 px-4 py-3 leading-relaxed whitespace-pre overflow-x-auto">
            {formatted}
          </pre>
        </div>
      </TableCell>
    </TableRow>
  );
}

// ─── Stats Bar ────────────────────────────────────────────────────────────────

function StatsBar({ stats }: { stats: any }) {
  const [lastExport, setLastExport] = useState<string | null>(() =>
    localStorage.getItem("compliance_last_export"),
  );

  const handleExport = () => {
    const url = "/api/compliance/export?format=csv";
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    const now = new Date().toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    localStorage.setItem("compliance_last_export", now);
    setLastExport(now);
  };

  return (
    <div className="rounded-lg border border-slate-700/50 bg-slate-800/30 px-6 py-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-6">
        <div className="space-y-0.5">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
            Total Logged Events
          </p>
          <p className="text-2xl font-bold font-mono text-slate-100">
            {stats?.totalEvents ?? "—"}
          </p>
        </div>
        <div className="space-y-0.5">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
            Events Today
          </p>
          <p className="text-2xl font-bold font-mono text-slate-100">
            {stats?.eventsToday ?? "—"}
          </p>
        </div>
        <div className="space-y-0.5">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
            Circuit Breaker Activations
          </p>
          <p className={cn(
            "text-2xl font-bold font-mono",
            (stats?.circuitBreakerActivations ?? 0) > 0 ? "text-orange-400" : "text-slate-100",
          )}>
            {stats?.circuitBreakerActivations ?? "—"}
          </p>
        </div>
        <div className="space-y-0.5">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
            Last Export
          </p>
          <div className="flex items-center gap-2">
            <p className="text-sm font-mono text-slate-300 truncate">
              {lastExport ?? "Never"}
            </p>
            <button
              onClick={handleExport}
              className="text-[10px] text-blue-400 hover:text-blue-300 underline underline-offset-2 whitespace-nowrap"
              data-testid="btn-export-csv-stats"
            >
              Export now
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Filter Bar ───────────────────────────────────────────────────────────────

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
];

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Compliance() {
  const [page, setPage] = useState(1);
  const [actionType, setActionType] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const { data: logsData, isLoading } = useComplianceLogs(
    page,
    25,
    actionType,
    dateFrom || undefined,
    dateTo || undefined,
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

  const toggleExpand = (id: number) =>
    setExpandedId((prev) => (prev === id ? null : id));

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <h2 className="text-3xl font-bold tracking-tight">Compliance & Audit</h2>
          <p className="text-muted-foreground text-sm">
            Full audit trail of all automated decisions. Exportable for regulatory purposes.
          </p>
        </div>
        <Button
          onClick={() => {
            const url = "/api/compliance/export?format=csv";
            const a = document.createElement("a");
            a.href = url;
            a.download = "";
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            const now = new Date().toLocaleString("en-GB", {
              day: "2-digit", month: "short", year: "numeric",
              hour: "2-digit", minute: "2-digit",
            });
            localStorage.setItem("compliance_last_export", now);
          }}
          variant="outline"
          className="shrink-0 gap-2 font-mono text-xs"
          data-testid="btn-export-csv"
        >
          <Download className="w-4 h-4" />
          Export to CSV
        </Button>
      </div>

      {/* Log Table Card */}
      <Card className="overflow-hidden">
        {/* Filter Bar */}
        <div className="px-4 py-3 border-b border-slate-700/50 bg-slate-800/40 flex flex-wrap items-center gap-3">
          <Select
            value={actionType}
            onValueChange={(v) => { setActionType(v); setPage(1); }}
          >
            <SelectTrigger className="w-[210px] h-8 text-xs" data-testid="select-action-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACTION_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value} className="text-xs">
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground font-mono">From</span>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => { setDateFrom(e.target.value); setPage(1); }}
              className="h-8 px-2 text-xs font-mono bg-slate-800 border border-slate-700 rounded text-slate-200 [color-scheme:dark]"
              data-testid="input-date-from"
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground font-mono">To</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => { setDateTo(e.target.value); setPage(1); }}
              className="h-8 px-2 text-xs font-mono bg-slate-800 border border-slate-700 rounded text-slate-200 [color-scheme:dark]"
              data-testid="input-date-to"
            />
          </div>

          {hasFilters && (
            <button
              onClick={resetFilters}
              className="text-xs text-slate-400 hover:text-slate-200 underline underline-offset-2 ml-1"
            >
              Clear filters
            </button>
          )}

          {/* Right side: count + pagination */}
          <div className="ml-auto flex items-center gap-3">
            <span className="text-xs text-muted-foreground font-mono whitespace-nowrap">
              {total.toLocaleString()} {total === 1 ? "event" : "events"}
              {totalPages > 1 && ` · Page ${page} of ${totalPages}`}
            </span>
            <div className="flex gap-1">
              <Button
                variant="outline"
                size="icon"
                className="h-7 w-7"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                data-testid="btn-prev-logs"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-7 w-7"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
                data-testid="btn-next-logs"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </div>

        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-5 space-y-3">
              {[...Array(12)].map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : logs.length === 0 ? (
            <div className="py-20 text-center">
              <FileText className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">
                No compliance logs found for the current filters.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-slate-700/50 hover:bg-transparent">
                  <TableHead className="w-8 pl-3" />
                  <TableHead className="w-[170px] text-xs uppercase tracking-wider font-semibold">
                    Timestamp
                  </TableHead>
                  <TableHead className="w-[170px] text-xs uppercase tracking-wider font-semibold">
                    Action Type
                  </TableHead>
                  <TableHead className="text-xs uppercase tracking-wider font-semibold">
                    Summary
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((log: any) => {
                  const details =
                    typeof log.details === "string"
                      ? JSON.parse(log.details)
                      : log.details ?? {};
                  const summary = summarise(log.actionType, details);
                  const isExpanded = expandedId === log.id;

                  return (
                    <Fragment key={log.id}>
                      <TableRow
                        className={cn(
                          "cursor-pointer border-slate-700/30 transition-colors",
                          isExpanded
                            ? "bg-slate-800/60 border-b-0"
                            : "hover:bg-slate-800/30",
                        )}
                        onClick={() => toggleExpand(log.id)}
                        data-testid={`row-log-${log.id}`}
                      >
                        {/* Expand chevron */}
                        <TableCell className="pl-3 pr-1 py-3 w-8">
                          {isExpanded ? (
                            <ChevronUp className="h-3 w-3 text-muted-foreground" />
                          ) : (
                            <ChevronDown className="h-3 w-3 text-muted-foreground" />
                          )}
                        </TableCell>

                        {/* Timestamp */}
                        <TableCell className="py-3 font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                          {formatDate(log.timestamp)}
                        </TableCell>

                        {/* Action Type Badge */}
                        <TableCell className="py-3">
                          <ActionBadge type={log.actionType} />
                        </TableCell>

                        {/* Summary */}
                        <TableCell className="py-3 text-sm text-slate-300 pr-6 leading-snug">
                          {summary}
                        </TableCell>
                      </TableRow>

                      {/* Expanded details */}
                      {isExpanded && <ExpandedDetails details={details} />}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>

        {/* Bottom pagination */}
        {totalPages > 1 && (
          <div className="px-4 py-3 border-t border-slate-700/50 bg-slate-800/20 flex items-center justify-between">
            <span className="text-xs text-muted-foreground font-mono">
              Showing {(page - 1) * 25 + 1}–{Math.min(page * 25, total)} of {total.toLocaleString()} events
            </span>
            <div className="flex gap-1">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                <ChevronLeft className="h-3 w-3" /> Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next <ChevronRight className="h-3 w-3" />
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* Stats Bar */}
      <StatsBar stats={stats} />
    </div>
  );
}
