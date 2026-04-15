import { useState } from "react";
import {
  useAlerts,
  useUnreadAlertCount,
  useAcknowledgeAlert,
  useAcknowledgeAllAlerts,
  useFireTestAlert,
  useRunAlertDetection,
} from "@/hooks/use-dashboard";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronLeft, ChevronRight, Bell, AlertTriangle, Info, XCircle, CheckCircle } from "lucide-react";

const SEVERITY_CONFIG: Record<string, { icon: React.ElementType; color: string; bg: string; border: string; label: string }> = {
  critical: { icon: XCircle, color: "text-red-400", bg: "bg-red-950/30", border: "border-red-800/50", label: "Critical" },
  warning: { icon: AlertTriangle, color: "text-amber-400", bg: "bg-amber-950/20", border: "border-amber-800/40", label: "Warning" },
  info: { icon: Info, color: "text-blue-400", bg: "bg-blue-950/20", border: "border-blue-800/30", label: "Info" },
};

function SeverityBadge({ severity }: { severity: string }) {
  const config = SEVERITY_CONFIG[severity] ?? SEVERITY_CONFIG.info!;
  const Icon = config.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wider", config.color, config.bg, "border", config.border)}>
      <Icon className="h-3 w-3" />
      {config.label}
    </span>
  );
}

function AlertRow({ alert, onAcknowledge }: { alert: any; onAcknowledge: (id: number) => void }) {
  const config = SEVERITY_CONFIG[alert.severity] ?? SEVERITY_CONFIG.info!;
  const timeAgo = formatTimeAgo(alert.createdAt);

  return (
    <div
      className={cn(
        "rounded-lg border p-4 transition-all",
        alert.acknowledged ? "opacity-50" : "",
        config.bg,
        config.border,
      )}
    >
      <div className="flex items-start gap-3">
        <div className="shrink-0 mt-0.5">
          <config.icon className={cn("h-5 w-5", config.color)} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <SeverityBadge severity={alert.severity} />
            <span className="text-[10px] text-slate-500 font-mono uppercase">{alert.category}</span>
            <span className="text-[10px] text-slate-600 font-mono">{alert.code}</span>
            <span className="ml-auto text-[11px] text-slate-500">{timeAgo}</span>
          </div>
          <h4 className="text-sm font-semibold text-white mt-1.5">{alert.title}</h4>
          <p className="text-xs text-slate-400 mt-1 leading-relaxed">{alert.message}</p>
          {alert.metadata && Object.keys(alert.metadata).length > 0 && !alert.metadata.test && (
            <div className="mt-2 flex flex-wrap gap-2">
              {Object.entries(alert.metadata).map(([key, val]) => (
                <span key={key} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700">
                  {key}: {typeof val === "number" ? (Number.isInteger(val) ? val : (val as number).toFixed(2)) : String(val)}
                </span>
              ))}
            </div>
          )}
        </div>
        {!alert.acknowledged && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-slate-500 hover:text-white shrink-0"
            onClick={(e) => { e.stopPropagation(); onAcknowledge(alert.id); }}
          >
            <CheckCircle className="h-3.5 w-3.5 mr-1" /> Dismiss
          </Button>
        )}
      </div>
    </div>
  );
}

function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString("en-GB", { dateStyle: "medium" });
}

export default function Alerts() {
  const [page, setPage] = useState(1);
  const [severityFilter, setSeverityFilter] = useState("all");
  const [showAcknowledged, setShowAcknowledged] = useState(false);

  const { data: unread } = useUnreadAlertCount();
  const { data: alertsData, isLoading } = useAlerts({
    page,
    limit: 30,
    severity: severityFilter !== "all" ? severityFilter : undefined,
    acknowledged: showAcknowledged ? undefined : false,
  });
  const ackMutation = useAcknowledgeAlert();
  const ackAllMutation = useAcknowledgeAllAlerts();
  const testMutation = useFireTestAlert();
  const detectionMutation = useRunAlertDetection();

  const alerts = alertsData?.alerts ?? [];

  return (
    <div className="space-y-5 max-w-4xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white tracking-tight flex items-center gap-2">
            <Bell className="h-6 w-6" />
            Alerts
            {(unread?.total ?? 0) > 0 && (
              <span className="text-sm font-bold px-2 py-0.5 rounded-full bg-red-600 text-white">
                {unread!.total}
              </span>
            )}
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            System alerts, risk warnings, and anomaly detection
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs border-slate-700 gap-1"
            disabled={detectionMutation.isPending}
            onClick={() => detectionMutation.mutate()}
          >
            {detectionMutation.isPending ? "Scanning..." : "Run Detection"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs border-slate-700 gap-1"
            disabled={ackAllMutation.isPending || (unread?.total ?? 0) === 0}
            onClick={() => ackAllMutation.mutate()}
          >
            Dismiss All
          </Button>
        </div>
      </div>

      {unread && (unread.critical > 0 || unread.warning > 0) && (
        <div className="grid grid-cols-3 gap-3">
          <div className={cn("rounded-lg border p-3", unread.critical > 0 ? "bg-red-950/30 border-red-800/50" : "bg-slate-800/30 border-slate-700/50")}>
            <p className="text-[10px] text-slate-500 uppercase font-semibold">Critical</p>
            <p className={cn("text-2xl font-bold font-mono", unread.critical > 0 ? "text-red-400" : "text-slate-600")}>{unread.critical}</p>
          </div>
          <div className={cn("rounded-lg border p-3", unread.warning > 0 ? "bg-amber-950/20 border-amber-800/40" : "bg-slate-800/30 border-slate-700/50")}>
            <p className="text-[10px] text-slate-500 uppercase font-semibold">Warning</p>
            <p className={cn("text-2xl font-bold font-mono", unread.warning > 0 ? "text-amber-400" : "text-slate-600")}>{unread.warning}</p>
          </div>
          <div className="rounded-lg border p-3 bg-slate-800/30 border-slate-700/50">
            <p className="text-[10px] text-slate-500 uppercase font-semibold">Info</p>
            <p className="text-2xl font-bold font-mono text-blue-400">{unread.info}</p>
          </div>
        </div>
      )}

      <div className="rounded-xl border px-4 py-3 flex flex-wrap gap-3 items-center" style={{ background: "#1e293b", borderColor: "#334155" }}>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-slate-500 uppercase tracking-wider font-semibold">Severity</span>
          <Select value={severityFilter} onValueChange={(v) => { setSeverityFilter(v); setPage(1); }}>
            <SelectTrigger className="w-[130px] h-8 text-xs border-slate-700 bg-slate-800/50">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="critical">Critical</SelectItem>
              <SelectItem value="warning">Warning</SelectItem>
              <SelectItem value="info">Info</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer">
          <input
            type="checkbox"
            checked={showAcknowledged}
            onChange={(e) => { setShowAcknowledged(e.target.checked); setPage(1); }}
            className="rounded border-slate-600 bg-slate-800"
          />
          Show dismissed
        </label>

        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-slate-600">
            {alertsData?.total ?? 0} alerts
          </span>
          <div className="flex gap-1">
            <Button variant="outline" size="icon" className="h-7 w-7 border-slate-700 bg-slate-800/50"
              disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeft className="h-3 w-3" />
            </Button>
            <Button variant="outline" size="icon" className="h-7 w-7 border-slate-700 bg-slate-800/50"
              disabled={page >= (alertsData?.totalPages ?? 1)} onClick={() => setPage((p) => p + 1)}>
              <ChevronRight className="h-3 w-3" />
            </Button>
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-24 rounded-lg animate-pulse" style={{ background: "#1e293b" }} />
          ))}
        </div>
      ) : alerts.length === 0 ? (
        <div className="rounded-xl border p-12 text-center" style={{ background: "#1e293b", borderColor: "#334155" }}>
          <Bell className="h-10 w-10 text-slate-600 mx-auto mb-3" />
          <p className="text-sm text-slate-500">
            {showAcknowledged ? "No alerts match the current filters." : "All clear — no unacknowledged alerts."}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {alerts.map((alert: any) => (
            <AlertRow
              key={alert.id}
              alert={alert}
              onAcknowledge={(id) => ackMutation.mutate(id)}
            />
          ))}
        </div>
      )}

      <div className="rounded-xl border p-4" style={{ background: "#1e293b", borderColor: "#334155" }}>
        <p className="text-xs text-slate-500 mb-3 font-semibold uppercase tracking-wider">Test Alerts</p>
        <p className="text-xs text-slate-400 mb-3">Fire a test alert of each severity to verify the pipeline works end-to-end.</p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs border-red-800/50 text-red-400 hover:bg-red-950/30"
            disabled={testMutation.isPending}
            onClick={() => testMutation.mutate("critical")}
          >
            Test Critical
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs border-amber-800/50 text-amber-400 hover:bg-amber-950/30"
            disabled={testMutation.isPending}
            onClick={() => testMutation.mutate("warning")}
          >
            Test Warning
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs border-blue-800/50 text-blue-400 hover:bg-blue-950/30"
            disabled={testMutation.isPending}
            onClick={() => testMutation.mutate("info")}
          >
            Test Info
          </Button>
        </div>
      </div>
    </div>
  );
}
