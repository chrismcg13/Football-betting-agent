import { Link, useLocation } from "wouter";
import { useSummary, useAgentControl, useApiBudget } from "@/hooks/use-dashboard";
import {
  BarChart2, BookOpen, Brain, FileText, Play, Pause, Shield, Square, Target, Zap, Database,
} from "lucide-react";
import { formatCurrency } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function AgentStatusDot({ status }: { status: string }) {
  if (status === "running")
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-400">
        <span className="relative flex h-2.5 w-2.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
        </span>
        Running
      </span>
    );
  if (status?.startsWith("paused"))
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-400">
        <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
        Paused
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-400">
      <span className="h-2.5 w-2.5 rounded-full bg-slate-500" />
      Stopped
    </span>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { data: summary } = useSummary();
  const agentControl = useAgentControl();
  const { data: budget } = useApiBudget();

  const navItems = [
    { href: "/", label: "Overview", icon: Target },
    { href: "/bets", label: "Bet History", icon: BookOpen },
    { href: "/performance", label: "Performance", icon: BarChart2 },
    { href: "/viability", label: "Viability", icon: Zap },
    { href: "/learning", label: "Learning & Model", icon: Brain },
    { href: "/compliance", label: "Compliance", icon: Shield },
  ];

  const pnl = summary?.totalPnl ?? 0;
  const bankroll = summary?.currentBankroll ?? 0;
  const todayPnl = summary?.todayPnl ?? 0;
  const roi = summary?.overallRoiPct ?? 0;

  return (
    <div className="min-h-screen flex flex-col md:flex-row" style={{ background: "#0f172a" }}>
      {/* Sidebar */}
      <aside
        className="w-full md:w-60 shrink-0 flex flex-col border-r"
        style={{ background: "#1e293b", borderColor: "#334155" }}
      >
        {/* Logo */}
        <div className="px-5 py-5 border-b" style={{ borderColor: "#334155" }}>
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center shrink-0">
              <Zap className="w-4 h-4 text-white" />
            </div>
            <div>
              <h1 className="text-sm font-bold tracking-tight text-white">BET_AGENT_OS</h1>
              <p className="text-[10px] text-slate-500">Paper Trading v1.0</p>
            </div>
          </div>
        </div>

        {/* Bankroll pill */}
        <div className="px-4 py-3 border-b" style={{ borderColor: "#334155" }}>
          <div className="rounded-lg px-4 py-3" style={{ background: "#0f172a" }}>
            <p className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-1">Bankroll</p>
            <p className="text-xl font-bold font-mono text-white">
              {summary ? formatCurrency(bankroll) : <span className="text-slate-600">——</span>}
            </p>
            {summary && (
              <p className={cn("text-xs font-mono mt-0.5", pnl >= 0 ? "text-emerald-400" : "text-red-400")}>
                {pnl >= 0 ? "+" : ""}{formatCurrency(pnl)} total P&amp;L
              </p>
            )}
          </div>
        </div>

        {/* API Budget pill */}
        <div className="px-4 py-2.5 border-b" style={{ borderColor: "#334155" }}>
          <div className="flex items-center gap-2">
            <Database className="w-3 h-3 text-slate-500 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-1">
                <p className="text-[9px] uppercase tracking-wider text-slate-500 font-semibold">API Budget</p>
                <p className="text-[10px] font-mono text-slate-500">
                  {budget ? `${budget.used}/${budget.cap}` : "—/90"}
                </p>
              </div>
              <div className="w-full rounded-full h-1 bg-slate-800">
                <div
                  className="h-1 rounded-full transition-all"
                  style={{
                    width: budget ? `${Math.min(100, (budget.used / budget.cap) * 100)}%` : "0%",
                    background: budget && budget.used > 80 ? "#ef4444" : budget && budget.used > 60 ? "#f59e0b" : "#10b981",
                  }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-0.5">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive =
              location === item.href ||
              (item.href !== "/" && location.startsWith(item.href));
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150",
                  isActive
                    ? "bg-blue-600 text-white shadow-sm"
                    : "text-slate-400 hover:text-white hover:bg-slate-700/50",
                )}
                data-testid={`nav-${item.label.toLowerCase().replace(/[^a-z]/g, "")}`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* Agent controls */}
        <div className="px-4 py-4 border-t" style={{ borderColor: "#334155" }}>
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Agent</span>
            {summary ? (
              <AgentStatusDot status={summary.agentStatus} />
            ) : (
              <span className="text-xs text-slate-600">—</span>
            )}
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className={cn(
                "h-8 text-xs gap-1 border-slate-700 text-slate-400 hover:text-emerald-400 hover:border-emerald-500/50",
                summary?.agentStatus === "running" && "border-emerald-500/50 text-emerald-400 bg-emerald-950/30",
              )}
              onClick={() => agentControl.mutate("start")}
              disabled={agentControl.isPending || summary?.agentStatus === "running"}
              data-testid="btn-start-agent"
              title="Start Agent"
            >
              <Play className="w-3 h-3" />
              Start
            </Button>
            <Button
              variant="outline"
              size="sm"
              className={cn(
                "h-8 text-xs gap-1 border-slate-700 text-slate-400 hover:text-amber-400 hover:border-amber-500/50",
                summary?.agentStatus?.startsWith("paused") && "border-amber-500/50 text-amber-400 bg-amber-950/30",
              )}
              onClick={() => agentControl.mutate("pause")}
              disabled={agentControl.isPending || summary?.agentStatus !== "running"}
              data-testid="btn-pause-agent"
              title="Pause Agent"
            >
              <Pause className="w-3 h-3" />
              Pause
            </Button>
            <Button
              variant="outline"
              size="sm"
              className={cn(
                "h-8 text-xs gap-1 border-slate-700 text-slate-400 hover:text-red-400 hover:border-red-500/50",
                summary?.agentStatus === "stopped_manual" && "border-red-500/50 text-red-400 bg-red-950/30",
              )}
              onClick={() => agentControl.mutate("stop")}
              disabled={agentControl.isPending || summary?.agentStatus === "stopped_manual"}
              data-testid="btn-stop-agent"
              title="Stop Agent"
            >
              <Square className="w-3 h-3" />
              Stop
            </Button>
          </div>

          {/* Quick stats */}
          <div className="mt-3 grid grid-cols-2 gap-2">
            <div className="rounded-md px-2.5 py-2" style={{ background: "#0f172a" }}>
              <p className="text-[9px] uppercase tracking-wider text-slate-600 font-semibold">Today</p>
              <p className={cn("text-sm font-bold font-mono", todayPnl >= 0 ? "text-emerald-400" : "text-red-400")}>
                {summary ? `${todayPnl >= 0 ? "+" : ""}${formatCurrency(todayPnl)}` : "—"}
              </p>
            </div>
            <div className="rounded-md px-2.5 py-2" style={{ background: "#0f172a" }}>
              <p className="text-[9px] uppercase tracking-wider text-slate-600 font-semibold">ROI</p>
              <p className={cn("text-sm font-bold font-mono", roi >= 0 ? "text-emerald-400" : "text-red-400")}>
                {summary ? `${roi >= 0 ? "+" : ""}${roi.toFixed(1)}%` : "—"}
              </p>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top bar */}
        <header
          className="h-12 border-b flex items-center px-6 shrink-0"
          style={{ background: "#1e293b", borderColor: "#334155" }}
        >
          <div className="flex-1" />
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
            </span>
            <span className="text-[11px] text-slate-500 font-mono uppercase tracking-wider">Live</span>
          </div>
        </header>

        <div className="flex-1 overflow-auto p-6">
          {children}
        </div>
      </main>
    </div>
  );
}

export function OddsSourceBadge({ source }: { source?: string | null }) {
  if (!source || source === "synthetic") {
    return (
      <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold bg-slate-800 text-slate-400 border border-slate-700 font-mono">
        Synthetic
      </span>
    );
  }
  if (source.toLowerCase().includes("bet365")) {
    return (
      <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-950 text-emerald-400 border border-emerald-800 font-mono">
        Bet365
      </span>
    );
  }
  if (source.toLowerCase().includes("bwin")) {
    return (
      <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-950 text-blue-400 border border-blue-800 font-mono">
        Bwin
      </span>
    );
  }
  if (source.toLowerCase().includes("1xbet")) {
    return (
      <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold bg-purple-950 text-purple-400 border border-purple-800 font-mono">
        1xBet
      </span>
    );
  }
  return (
    <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold bg-slate-800 text-slate-400 border border-slate-700 font-mono">
      {source}
    </span>
  );
}

export function BetStatusBadge({ status }: { status: string }) {
  if (status === "won")
    return (
      <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-950 text-emerald-400 border border-emerald-800">
        Won
      </span>
    );
  if (status === "lost")
    return (
      <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-semibold bg-red-950 text-red-400 border border-red-800">
        Lost
      </span>
    );
  if (status === "pending")
    return (
      <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-950 text-amber-400 border border-amber-800">
        Pending
      </span>
    );
  if (status === "void")
    return (
      <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-semibold bg-slate-800 text-slate-400 border border-slate-700">
        Void
      </span>
    );
  return (
    <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-semibold bg-slate-800 text-slate-400 border border-slate-700">
      {status}
    </span>
  );
}
