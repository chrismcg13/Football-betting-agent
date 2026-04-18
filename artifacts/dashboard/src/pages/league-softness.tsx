import { useState } from "react";
import { useLeagueSoftness } from "@/hooks/use-dashboard";
import { Skeleton } from "@/components/ui/skeleton";
import { TrendingUp, TrendingDown, Minus, Info } from "lucide-react";

type Row = {
  league: string;
  placed: number;
  settled: number;
  wins: number;
  losses: number;
  winRate: number;
  stake: number;
  pnl: number;
  roi: number;
  avgClv: number | null;
  clvCoveragePct: number;
  avgEdgePct: number | null;
  avgSlippage: number | null;
  softnessScore: number;
};

function softnessColor(score: number): string {
  if (score >= 30) return "#10b981";
  if (score >= 10) return "#22c55e";
  if (score >= 0) return "#84cc16";
  if (score >= -15) return "#f59e0b";
  return "#ef4444";
}

function clvColor(clv: number | null): string {
  if (clv == null) return "#64748b";
  if (clv >= 5) return "#10b981";
  if (clv >= 0) return "#22c55e";
  if (clv >= -5) return "#f59e0b";
  return "#ef4444";
}

function fmt(n: number | null | undefined, suffix = ""): string {
  if (n == null) return "—";
  const v = Math.round(n * 100) / 100;
  return `${v >= 0 && suffix === "%" ? "+" : ""}${v}${suffix}`;
}

function fmtMoney(n: number): string {
  return `${n < 0 ? "−" : ""}£${Math.abs(n).toFixed(2)}`;
}

export default function LeagueSoftness() {
  const [days, setDays] = useState(30);
  const [minBets, setMinBets] = useState(3);
  const { data, isLoading } = useLeagueSoftness(days, minBets);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-32" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  const leagues: Row[] = data?.leagues ?? [];
  const top = leagues.slice(0, 10);
  const bottom = [...leagues].reverse().slice(0, 5);
  const totalLeagues = leagues.length;
  const avgClvAll = leagues.filter((l) => l.avgClv != null).reduce((s, l) => s + (l.avgClv ?? 0), 0) /
    Math.max(1, leagues.filter((l) => l.avgClv != null).length);

  return (
    <div className="space-y-8 max-w-7xl mx-auto">
      <div>
        <h2 className="text-2xl font-bold text-white tracking-tight">League Softness Map</h2>
        <p className="text-sm text-slate-500 mt-1 max-w-3xl">
          Where our edge actually exists. Soft money on the exchange clusters in lower-tier leagues. Closing Line Value (CLV) is the
          cleanest signal: positive CLV means the market subsequently agreed with our price — that's where the soft counterparty lives.
          Live Betfair bets only.
        </p>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2 text-slate-400">
          Window:
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-white"
          >
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
            <option value={365}>All time</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-slate-400">
          Min bets:
          <select
            value={minBets}
            onChange={(e) => setMinBets(Number(e.target.value))}
            className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-white"
          >
            <option value={1}>1</option>
            <option value={3}>3</option>
            <option value={5}>5</option>
            <option value={10}>10</option>
            <option value={20}>20</option>
          </select>
        </label>
        <span className="text-slate-500">{totalLeagues} leagues with bets in window</span>
      </div>

      {/* Headline */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-xl border p-5" style={{ background: "#172033", borderColor: "#334155" }}>
          <p className="text-[11px] uppercase tracking-wider text-slate-500 mb-1">Avg CLV across leagues</p>
          <p className="text-3xl font-mono font-bold" style={{ color: clvColor(avgClvAll) }}>
            {fmt(avgClvAll, "%")}
          </p>
          <p className="text-xs text-slate-500 mt-1">Weighted avg of all leagues with ≥{minBets} bets</p>
        </div>
        <div className="rounded-xl border p-5" style={{ background: "#172033", borderColor: "#334155" }}>
          <p className="text-[11px] uppercase tracking-wider text-slate-500 mb-1">Best league (by softness)</p>
          <p className="text-xl font-bold text-white truncate">{leagues[0]?.league ?? "—"}</p>
          <p className="text-xs text-slate-500 mt-1">
            CLV {fmt(leagues[0]?.avgClv ?? null, "%")} • ROI {fmt(leagues[0]?.roi, "%")} • {leagues[0]?.placed ?? 0} bets
          </p>
        </div>
        <div className="rounded-xl border p-5" style={{ background: "#172033", borderColor: "#334155" }}>
          <p className="text-[11px] uppercase tracking-wider text-slate-500 mb-1">Worst league (by softness)</p>
          <p className="text-xl font-bold text-white truncate">{leagues[leagues.length - 1]?.league ?? "—"}</p>
          <p className="text-xs text-slate-500 mt-1">
            CLV {fmt(leagues[leagues.length - 1]?.avgClv ?? null, "%")} • ROI {fmt(leagues[leagues.length - 1]?.roi, "%")} • {leagues[leagues.length - 1]?.placed ?? 0} bets
          </p>
        </div>
      </div>

      {/* Methodology note */}
      <div className="rounded-xl border px-5 py-3 flex items-start gap-3" style={{ background: "#1e293b", borderColor: "#334155" }}>
        <Info className="h-4 w-4 text-slate-400 mt-0.5 flex-shrink-0" />
        <p className="text-xs text-slate-400 leading-relaxed">
          <strong className="text-slate-300">Softness score</strong> = weighted blend of avg CLV (70%) and ROI bonus (30%, settled ≥5),
          scaled by sample size (capped at 20 bets). CLV-rich leagues with positive ROI rank highest. Sample-size weighted to avoid
          1-bet noise dominating.
        </p>
      </div>

      {/* Top 10 table */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">
          Top 10 — where to lean in
        </h3>
        <SoftnessTable rows={top} highlightTop />
      </div>

      {/* Bottom 5 table */}
      {bottom.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">
            Bottom 5 — where edge is leaking
          </h3>
          <SoftnessTable rows={bottom} />
        </div>
      )}
    </div>
  );
}

function SoftnessTable({ rows, highlightTop = false }: { rows: Row[]; highlightTop?: boolean }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border p-8 text-center text-slate-500" style={{ background: "#172033", borderColor: "#334155" }}>
        No leagues match the current filters.
      </div>
    );
  }
  return (
    <div className="rounded-xl border overflow-hidden" style={{ background: "#1e293b", borderColor: "#334155" }}>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b" style={{ borderColor: "#334155" }}>
            <th className="py-2.5 pl-5 pr-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">League</th>
            <th className="py-2.5 px-3 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-500">Bets</th>
            <th className="py-2.5 px-3 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-500">W-L</th>
            <th className="py-2.5 px-3 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-500">PnL</th>
            <th className="py-2.5 px-3 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-500">ROI</th>
            <th className="py-2.5 px-3 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-500">Avg CLV</th>
            <th className="py-2.5 px-3 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-500">CLV Coverage</th>
            <th className="py-2.5 px-3 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-500">Avg Edge</th>
            <th className="py-2.5 px-3 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-500">Slip</th>
            <th className="py-2.5 pr-5 pl-3 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-500">Softness</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const trend = r.avgClv == null ? Minus : r.avgClv >= 0 ? TrendingUp : TrendingDown;
            const TrendIcon = trend;
            return (
              <tr
                key={r.league}
                className="border-b transition-colors hover:bg-slate-800/30"
                style={{ borderColor: "#1e3a5f" }}
              >
                <td className="py-3 pl-5 pr-3 text-slate-200 font-medium">
                  <div className="flex items-center gap-2">
                    {highlightTop && i < 3 && (
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                        #{i + 1}
                      </span>
                    )}
                    <span className="truncate max-w-[280px]">{r.league}</span>
                  </div>
                </td>
                <td className="py-3 px-3 text-right font-mono text-slate-400">
                  {r.placed} <span className="text-slate-600">({r.settled})</span>
                </td>
                <td className="py-3 px-3 text-right font-mono text-slate-400">
                  <span className="text-emerald-400">{r.wins}</span>-<span className="text-red-400">{r.losses}</span>
                </td>
                <td className="py-3 px-3 text-right font-mono" style={{ color: r.pnl >= 0 ? "#10b981" : "#ef4444" }}>
                  {fmtMoney(r.pnl)}
                </td>
                <td className="py-3 px-3 text-right font-mono" style={{ color: r.roi >= 0 ? "#10b981" : "#ef4444" }}>
                  {fmt(r.roi, "%")}
                </td>
                <td className="py-3 px-3 text-right font-mono" style={{ color: clvColor(r.avgClv) }}>
                  <span className="inline-flex items-center gap-1.5">
                    <TrendIcon className="h-3 w-3" />
                    {fmt(r.avgClv, "%")}
                  </span>
                </td>
                <td className="py-3 px-3 text-right font-mono text-slate-500">{r.clvCoveragePct.toFixed(0)}%</td>
                <td className="py-3 px-3 text-right font-mono text-slate-400">{fmt(r.avgEdgePct, "%")}</td>
                <td className="py-3 px-3 text-right font-mono text-slate-500">
                  {r.avgSlippage != null ? `${r.avgSlippage >= 0 ? "+" : ""}${r.avgSlippage.toFixed(2)}` : "—"}
                </td>
                <td className="py-3 pr-5 pl-3 text-right">
                  <span
                    className="inline-block font-mono font-bold text-sm px-2 py-0.5 rounded"
                    style={{
                      background: `${softnessColor(r.softnessScore)}20`,
                      color: softnessColor(r.softnessScore),
                      border: `1px solid ${softnessColor(r.softnessScore)}40`,
                    }}
                  >
                    {r.softnessScore.toFixed(1)}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
