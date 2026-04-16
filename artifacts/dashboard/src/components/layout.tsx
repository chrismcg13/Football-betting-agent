import { Link, useLocation } from "wouter";
import { useSummary, useAgentControl, useApiBudget, useOddspapiBudget, useScanStats, useLiveSummary, useUnreadAlertCount } from "@/hooks/use-dashboard";
import {
  BarChart2, Bell, BookOpen, Brain, FileText, FlaskConical, Play, Pause, Shield, Square, Target, Zap, Database, TrendingUp, Radio, Rocket,
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

const RISK_LEVEL_LABELS: Record<number, { label: string; color: string }> = {
  1: { label: "Conservative", color: "#3b82f6" },
  2: { label: "Moderate", color: "#22c55e" },
  3: { label: "Confident", color: "#f59e0b" },
  4: { label: "Aggressive", color: "#ef4444" },
};

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { data: summary } = useSummary();
  const { data: liveSummary } = useLiveSummary();
  const agentControl = useAgentControl();
  const { data: budget } = useApiBudget();
  const { data: oddsBudget } = useOddspapiBudget();
  const { data: scanStats } = useScanStats();
  const { data: unreadAlerts } = useUnreadAlertCount();

  const navItems = [
    { href: "/", label: "Overview", icon: Target },
    { href: "/bets", label: "Bet History", icon: BookOpen },
    { href: "/performance", label: "Live Performance", icon: TrendingUp },
    { href: "/learning", label: "Agent Brain", icon: Brain },
    { href: "/compliance", label: "Audit Trail", icon: Shield },
    { href: "/experiments", label: "Experiment Lab", icon: FlaskConical },
    { href: "/alerts", label: "Alerts", icon: Bell, badge: unreadAlerts?.total ?? 0 },
    { href: "/launch", label: "Launch", icon: Rocket },
  ];

  const pnl = summary?.totalPnl ?? 0;
  const bankroll = summary?.currentBankroll ?? 0;
  const todayPnl = summary?.todayPnl ?? 0;
  const roi = summary?.overallRoiPct ?? 0;
  const pendingExposure = (summary as any)?.pendingExposure ?? 0;
  const maxExposure = (summary as any)?.maxExposure ?? 0;
  const exposurePct = (summary as any)?.exposurePct ?? 0;
  const exposureColor = exposurePct >= 87.5 ? "#ef4444" : exposurePct >= 62.5 ? "#f59e0b" : "#10b981";
  const isLive = (summary as any)?.isLive === true;
  const riskLevel = (summary as any)?.riskLevel ?? null;
  const riskCfg = riskLevel ? RISK_LEVEL_LABELS[riskLevel] ?? { label: `Level ${riskLevel}`, color: "#64748b" } : null;
  const bfBalance = (summary as any)?.betfairBalance ?? null;

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
              <p className="text-[10px] text-slate-500">{isLive ? "Live Trading" : "Paper Trading"}</p>
            </div>
          </div>
        </div>

        {/* Bankroll pill */}
        <div className="px-4 py-3 border-b" style={{ borderColor: "#334155" }}>
          <div className="rounded-lg px-4 py-3" style={{ background: "#0f172a" }}>
            <div className="flex items-center justify-between mb-1">
              <p className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
                {isLive && bfBalance ? "Betfair Balance" : "Bankroll"}
              </p>
              {isLive && bfBalance && bfBalance.stale && (
                <span className="text-[8px] px-1 py-0.5 rounded bg-amber-900/50 text-amber-400">Stale</span>
              )}
            </div>
            <p className="text-xl font-bold font-mono text-white">
              {summary ? formatCurrency(isLive && bfBalance ? bfBalance.available : bankroll) : <span className="text-slate-600">——</span>}
            </p>
            {summary && (
              <p className={cn("text-xs font-mono mt-0.5", pnl >= 0 ? "text-emerald-400" : "text-red-400")}>
                {pnl >= 0 ? "+" : ""}{formatCurrency(pnl)} total P&amp;L
              </p>
            )}
            {isLive && bfBalance && (
              <p className="text-[10px] text-slate-600 mt-0.5">
                £{bfBalance.available.toFixed(2)} available · £{bfBalance.exposure.toFixed(2)} at risk
              </p>
            )}
          </div>
        </div>

        {/* Risk level pill (live only) */}
        {riskCfg && (
          <div className="px-4 py-2 border-b" style={{ borderColor: "#334155" }}>
            <div className="flex items-center justify-between">
              <p className="text-[9px] uppercase tracking-wider font-semibold" style={{ color: riskCfg.color }}>Risk Level {riskLevel}</p>
              <p className="text-[10px] font-semibold" style={{ color: riskCfg.color }}>{riskCfg.label}</p>
            </div>
          </div>
        )}

        {/* Exposure pill */}
        <div className="px-4 py-2.5 border-b" style={{ borderColor: "#334155" }}>
          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-1">
                <p className="text-[9px] uppercase tracking-wider font-semibold" style={{ color: exposureColor }}>Exposure</p>
                <p className="text-[10px] font-mono" style={{ color: exposureColor }}>
                  {summary ? `${exposurePct.toFixed(0)}%` : "—"}
                </p>
              </div>
              <div className="w-full rounded-full h-1.5 bg-slate-800">
                <div
                  className="h-1.5 rounded-full transition-all"
                  style={{ width: `${Math.min(100, exposurePct)}%`, background: exposureColor }}
                />
              </div>
              <p className="text-[9px] font-mono mt-1" style={{ color: exposurePct >= 100 ? "#ef4444" : "#64748b" }}>
                {summary
                  ? exposurePct >= 100
                    ? "Exposure limit reached — waiting for bets to settle"
                    : `£${pendingExposure.toLocaleString("en-GB", { maximumFractionDigits: 0 })} / £${maxExposure.toLocaleString("en-GB", { maximumFractionDigits: 0 })} unsettled`
                  : "—"}
              </p>
            </div>
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
                  {budget ? `${budget.used.toLocaleString()}/${budget.cap.toLocaleString()}` : "—/75,000"}
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
              {budget?.projectedPct != null && (
                <p className="text-[9px] mt-0.5">
                  <span className={budget.throttled ? "text-red-400 font-semibold" : budget.projectedPct >= 80 ? "text-amber-400" : "text-slate-500"}>
                    proj {budget.projectedPct}% of month{budget.throttled ? " ⚠ THROTTLED" : ""}
                  </span>
                </p>
              )}
            </div>
          </div>
        </div>

        {/* OddsPapi (Pinnacle) budget pill */}
        <div className="px-4 py-2 border-b" style={{ borderColor: "#334155" }}>
          <div className="flex items-center gap-2">
            <Database className="w-3 h-3 text-violet-500 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-1">
                <p className="text-[9px] uppercase tracking-wider text-violet-400 font-semibold">Pinnacle</p>
                <p className="text-[10px] font-mono text-slate-500">
                  {oddsBudget ? `${oddsBudget.todayCount ?? 0}/${oddsBudget.dailyCap ?? 7}/d` : "—/7/d"}
                </p>
              </div>
              <div className="w-full rounded-full h-1 bg-slate-800">
                <div
                  className="h-1 rounded-full transition-all"
                  style={{
                    width: oddsBudget
                      ? `${Math.min(100, ((oddsBudget.monthCount ?? 0) / (oddsBudget.monthlyCap ?? 240)) * 100)}%`
                      : "0%",
                    background:
                      oddsBudget && (oddsBudget.monthCount ?? 0) > 200
                        ? "#ef4444"
                        : oddsBudget && (oddsBudget.monthCount ?? 0) > 150
                        ? "#f59e0b"
                        : "#7c3aed",
                  }}
                />
              </div>
              <p className="text-[9px] text-slate-600 mt-0.5">
                {oddsBudget ? `${oddsBudget.monthCount ?? 0}/${oddsBudget.monthlyCap ?? 240} this month` : "—/240 this month"}
                {oddsBudget?.projectedPct != null && (
                  <span className={oddsBudget.throttled ? "text-red-400 font-semibold" : oddsBudget.projectedPct >= 80 ? "text-amber-400" : "text-slate-500"}>
                    {" "}· proj {oddsBudget.projectedPct}%{oddsBudget.throttled ? " ⚠ THROTTLED" : ""}
                  </span>
                )}
              </p>
            </div>
          </div>
        </div>

        {/* Scan stats */}
        <div className="px-4 py-2 border-b" style={{ borderColor: "#334155" }}>
          <p className="text-[9px] uppercase tracking-wider text-slate-500 font-semibold mb-1.5">Market Coverage</p>
          <div className="grid grid-cols-3 gap-1">
            <div className="text-center">
              <p className="text-[11px] font-mono font-bold text-emerald-400">{scanStats?.leaguesActive ?? "—"}</p>
              <p className="text-[8px] text-slate-600">Leagues</p>
            </div>
            <div className="text-center">
              <p className="text-[11px] font-mono font-bold text-blue-400">{scanStats?.marketsPerFixture ?? "—"}</p>
              <p className="text-[8px] text-slate-600">Mkts/Match</p>
            </div>
            <div className="text-center">
              <p className="text-[11px] font-mono font-bold text-amber-400">{scanStats?.lineMovementsToday ?? "—"}</p>
              <p className="text-[8px] text-slate-600">Movements</p>
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
                {(item as any).badge > 0 && (
                  <span className={cn(
                    "ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[20px] text-center",
                    (unreadAlerts?.critical ?? 0) > 0 ? "bg-red-600 text-white" : "bg-amber-600 text-white",
                  )}>
                    {(item as any).badge}
                  </span>
                )}
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
          className="h-12 border-b flex items-center px-6 shrink-0 gap-4"
          style={{ background: "#1e293b", borderColor: "#334155" }}
        >
          <div className="flex-1" />
          {isLive ? (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-green-500/15 border border-green-500/30 text-green-400 text-[11px] font-bold tracking-wide">
              <Radio className="w-3 h-3 animate-pulse" />
              LIVE TRADING
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-400 text-[11px] font-bold tracking-wide">
              PAPER MODE
            </span>
          )}
          {liveSummary?.relayConfigured && (
            <span className={cn(
              "inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-0.5 rounded",
              liveSummary.relayHealthy ? "bg-emerald-900/30 text-emerald-400" : "bg-red-900/30 text-red-400",
            )}>
              <span className={cn("w-1.5 h-1.5 rounded-full", liveSummary.relayHealthy ? "bg-emerald-400" : "bg-red-400")} />
              VPS {liveSummary.relayHealthy ? "Connected" : "Offline"}
            </span>
          )}
          {liveSummary?.qualityGate != null && (
            <span className="text-[10px] text-slate-500 font-mono">
              Quality Gate: {liveSummary.qualityGate}+
            </span>
          )}
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

export function LiveTierBadge({ tier }: { tier?: string | null }) {
  if (!tier) return null;
  const styles: Record<string, { bg: string; text: string; label: string }> = {
    "tier1_real": { bg: "#052e16", text: "#22c55e", label: "Tier 1 · Real Money" },
    "tier2_paper": { bg: "#1e1b4b", text: "#c4b5fd", label: "Tier 2 · Paper" },
  };
  const s = styles[tier] ?? { bg: "#374151", text: "#9ca3af", label: tier };
  return (
    <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold" style={{ background: s.bg, color: s.text }}>
      {s.label}
    </span>
  );
}

export function InfoTooltip({ text }: { text: string }) {
  return (
    <span className="relative group inline-flex ml-1 align-middle">
      <span className="text-slate-500 hover:text-slate-300 cursor-help text-[10px]">?</span>
      <span className="invisible group-hover:visible absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 z-50 rounded-lg border p-2 text-[11px] text-slate-300 leading-relaxed shadow-xl whitespace-normal"
        style={{ background: "#0f172a", borderColor: "#334155", width: "220px" }}>
        {text}
        <span className="absolute top-full left-1/2 -translate-x-1/2 w-1.5 h-1.5 rotate-45 border-r border-b" style={{ background: "#0f172a", borderColor: "#334155" }} />
      </span>
    </span>
  );
}
