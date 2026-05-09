#!/usr/bin/env node
/**
 * Pre-flip blocker #12 — operator-only live re-enable after auto-revert.
 *
 *   npm run live-resume -- --confirm-reason="reviewed compliance log; root cause is X; safe to resume"
 *
 * confirm-reason must be at least 10 chars. Writes compliance_logs row tagged
 * 'live_manual_resume'. Sets live_placement_enabled=true and clears
 * auto_disable_reason.
 */

const API_URL = process.env["API_URL"] ?? "http://localhost:8080";

function parseArgs(argv: string[]): { confirmReason: string | null } {
  let confirmReason: string | null = null;
  for (const a of argv) {
    if (a.startsWith("--confirm-reason=")) {
      confirmReason = a.slice("--confirm-reason=".length);
    }
  }
  return { confirmReason };
}

(async () => {
  const { confirmReason } = parseArgs(process.argv.slice(2));
  if (!confirmReason || confirmReason.trim().length < 10) {
    console.error("Usage: npm run live-resume -- --confirm-reason=\"<>=10 chars explaining why>\"");
    process.exit(2);
  }
  const r = await fetch(`${API_URL}/api/admin/live-resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm_reason: confirmReason }),
  });
  const body = (await r.json()) as { success: boolean; message?: string };
  if (!body.success) {
    console.error(`live-resume failed (HTTP ${r.status}): ${body.message ?? "unknown"}`);
    process.exit(2);
  }
  console.log(`live-resume OK — ${body.message ?? "live_placement_enabled is true"}`);
  console.log(`reason recorded: ${confirmReason}`);
})().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(3);
});
