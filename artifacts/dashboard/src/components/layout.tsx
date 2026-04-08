import { Link, useLocation } from "wouter";
import { useSummary, useAgentControl } from "@/hooks/use-dashboard";
import { Activity, BarChart2, CheckCircle2, AlertCircle, StopCircle, Play, Pause, Square, FileText, Settings, Shield, Target } from "lucide-react";
import { formatCurrency, formatPercent } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function StatusBadge({ status }: { status: string }) {
  if (status === "running") {
    return <span className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium bg-emerald-500/10 text-emerald-500 border border-emerald-500/20"><Activity className="w-3.5 h-3.5" /> Running</span>;
  }
  if (status === "paused_manual") {
    return <span className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium bg-amber-500/10 text-amber-500 border border-amber-500/20"><AlertCircle className="w-3.5 h-3.5" /> Paused</span>;
  }
  return <span className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium bg-slate-500/10 text-slate-400 border border-slate-500/20"><StopCircle className="w-3.5 h-3.5" /> Stopped</span>;
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { data: summary } = useSummary();
  const agentControl = useAgentControl();

  const navItems = [
    { href: "/", label: "Overview", icon: Target },
    { href: "/bets", label: "Bet History", icon: FileText },
    { href: "/performance", label: "Performance", icon: BarChart2 },
    { href: "/viability", label: "Viability", icon: Activity },
    { href: "/learning", label: "Learning & Model", icon: CheckCircle2 },
    { href: "/compliance", label: "Compliance", icon: Shield },
  ];

  return (
    <div className="min-h-screen bg-background flex flex-col md:flex-row dark">
      {/* Sidebar */}
      <aside className="w-full md:w-64 border-r border-border bg-card flex flex-col shrink-0">
        <div className="p-4 border-b border-border">
          <h1 className="text-xl font-bold font-mono tracking-tight text-primary">BET_AGENT_OS</h1>
          <p className="text-xs text-muted-foreground mt-1">Paper Trading Console v1.0</p>
        </div>
        
        <nav className="p-4 space-y-1 flex-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
            return (
              <Link 
                key={item.href} 
                href={item.href}
                className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                  isActive ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                )}
                data-testid={`nav-${item.label.toLowerCase().replace(/[^a-z]/g, '')}`}
              >
                <Icon className="w-4 h-4" />
                {item.label}
              </Link>
            )
          })}
        </nav>

        <div className="p-4 border-t border-border space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Status</span>
            {summary ? <StatusBadge status={summary.agentStatus} /> : <div className="w-16 h-6 bg-secondary rounded animate-pulse" />}
          </div>
          
          <div className="grid grid-cols-3 gap-2">
            <Button 
              variant="outline" 
              size="icon"
              className={cn("w-full", summary?.agentStatus === "running" && "border-emerald-500/50 text-emerald-500")}
              onClick={() => agentControl.mutate("start")}
              disabled={agentControl.isPending || summary?.agentStatus === "running"}
              data-testid="btn-start-agent"
              title="Start Agent"
            >
              <Play className="w-4 h-4" />
            </Button>
            <Button 
              variant="outline" 
              size="icon"
              className={cn("w-full", summary?.agentStatus === "paused_manual" && "border-amber-500/50 text-amber-500")}
              onClick={() => agentControl.mutate("pause")}
              disabled={agentControl.isPending || summary?.agentStatus !== "running"}
              data-testid="btn-pause-agent"
              title="Pause Agent"
            >
              <Pause className="w-4 h-4" />
            </Button>
            <Button 
              variant="outline" 
              size="icon"
              className={cn("w-full", summary?.agentStatus === "stopped_manual" && "border-red-500/50 text-red-500")}
              onClick={() => agentControl.mutate("stop")}
              disabled={agentControl.isPending || summary?.agentStatus === "stopped_manual"}
              data-testid="btn-stop-agent"
              title="Stop Agent"
            >
              <Square className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top bar for quick stats */}
        <header className="h-14 border-b border-border bg-card flex items-center px-6 justify-between shrink-0">
          <div className="flex items-center gap-6">
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Bankroll</span>
              {summary ? (
                <span className="text-sm font-mono font-medium">{formatCurrency(summary.currentBankroll)}</span>
              ) : (
                <div className="w-20 h-4 bg-secondary rounded animate-pulse" />
              )}
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Today P&L</span>
              {summary ? (
                <span className={cn("text-sm font-mono font-medium", summary.todayPnl >= 0 ? "text-emerald-500" : "text-red-500")}>
                  {summary.todayPnl >= 0 ? '+' : ''}{formatCurrency(summary.todayPnl)}
                </span>
              ) : (
                <div className="w-16 h-4 bg-secondary rounded animate-pulse" />
              )}
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Total ROI</span>
              {summary ? (
                <span className={cn("text-sm font-mono font-medium", summary.overallRoiPct >= 0 ? "text-emerald-500" : "text-red-500")}>
                  {summary.overallRoiPct >= 0 ? '+' : ''}{summary.overallRoiPct.toFixed(2)}%
                </span>
              ) : (
                <div className="w-12 h-4 bg-secondary rounded animate-pulse" />
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-xs text-muted-foreground font-mono uppercase">Live Connection</span>
          </div>
        </header>

        {/* Scrollable page content */}
        <div className="flex-1 overflow-auto p-6">
          {children}
        </div>
      </main>
    </div>
  );
}
