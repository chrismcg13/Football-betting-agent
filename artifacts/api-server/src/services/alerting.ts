import { db, alertsTable } from "@workspace/db";
import { eq, and, gte, desc, sql, count } from "drizzle-orm";
import { logger } from "../lib/logger";

export type AlertSeverity = "critical" | "warning" | "info";
export type AlertCategory =
  | "connectivity"
  | "risk"
  | "performance"
  | "execution"
  | "anomaly"
  | "milestone"
  | "system"
  | "no_bets";

const COOLDOWN_MS: Record<AlertSeverity, number> = {
  critical: 60 * 60 * 1000,
  warning: 4 * 60 * 60 * 1000,
  info: 24 * 60 * 60 * 1000,
};

export interface CreateAlertInput {
  severity: AlertSeverity;
  category: AlertCategory;
  code: string;
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export async function createAlert(input: CreateAlertInput): Promise<number | null> {
  try {
    const cooldown = COOLDOWN_MS[input.severity];
    const cutoff = new Date(Date.now() - cooldown);

    const existing = await db
      .select({ id: alertsTable.id })
      .from(alertsTable)
      .where(
        and(
          eq(alertsTable.code, input.code),
          gte(alertsTable.createdAt, cutoff),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      return null;
    }

    const [row] = await db
      .insert(alertsTable)
      .values({
        severity: input.severity,
        category: input.category,
        code: input.code,
        title: input.title,
        message: input.message,
        metadata: input.metadata ?? null,
        acknowledged: false,
        webhookSent: false,
      })
      .returning({ id: alertsTable.id });

    logger.info(
      { severity: input.severity, code: input.code },
      `Alert created: ${input.title}`,
    );

    if (input.severity === "critical" || input.severity === "warning") {
      void sendWebhook(input, row!.id).catch(() => {});
    }

    return row!.id;
  } catch (err) {
    logger.error({ err, code: input.code }, "Failed to create alert");
    return null;
  }
}

async function sendWebhook(input: CreateAlertInput, alertId: number): Promise<void> {
  const webhookUrl = process.env["ALERT_WEBHOOK_URL"];
  if (!webhookUrl) return;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: alertId,
        severity: input.severity,
        category: input.category,
        code: input.code,
        title: input.title,
        message: input.message,
        metadata: input.metadata,
        timestamp: new Date().toISOString(),
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    await db
      .update(alertsTable)
      .set({ webhookSent: true })
      .where(eq(alertsTable.id, alertId));

    logger.info({ alertId, code: input.code }, "Alert webhook sent");
  } catch (err) {
    logger.warn({ err, alertId }, "Alert webhook delivery failed — non-fatal");
  }
}

export async function acknowledgeAlert(id: number): Promise<boolean> {
  const result = await db
    .update(alertsTable)
    .set({ acknowledged: true, acknowledgedAt: new Date() })
    .where(eq(alertsTable.id, id))
    .returning({ id: alertsTable.id });
  return result.length > 0;
}

export async function acknowledgeAlerts(ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await db
    .update(alertsTable)
    .set({ acknowledged: true, acknowledgedAt: new Date() })
    .where(sql`${alertsTable.id} = ANY(${ids})`);
  return result.rowCount ?? 0;
}

export async function acknowledgeAllAlerts(): Promise<number> {
  const result = await db
    .update(alertsTable)
    .set({ acknowledged: true, acknowledgedAt: new Date() })
    .where(eq(alertsTable.acknowledged, false));
  return result.rowCount ?? 0;
}

export async function getAlerts(opts: {
  page?: number;
  limit?: number;
  severity?: string;
  acknowledged?: boolean;
}): Promise<{
  alerts: typeof alertsTable.$inferSelect[];
  total: number;
  page: number;
  totalPages: number;
}> {
  const page = opts.page ?? 1;
  const limit = opts.limit ?? 50;
  const offset = (page - 1) * limit;

  const conditions: any[] = [];
  if (opts.severity) conditions.push(eq(alertsTable.severity, opts.severity));
  if (opts.acknowledged !== undefined)
    conditions.push(eq(alertsTable.acknowledged, opts.acknowledged));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [alerts, [countResult]] = await Promise.all([
    db
      .select()
      .from(alertsTable)
      .where(where)
      .orderBy(desc(alertsTable.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: count() })
      .from(alertsTable)
      .where(where),
  ]);

  const total = countResult?.count ?? 0;
  return {
    alerts,
    total,
    page,
    totalPages: Math.ceil(total / limit),
  };
}

export async function getUnreadCount(): Promise<{
  total: number;
  critical: number;
  warning: number;
  info: number;
}> {
  const rows = await db
    .select({
      severity: alertsTable.severity,
      count: count(),
    })
    .from(alertsTable)
    .where(eq(alertsTable.acknowledged, false))
    .groupBy(alertsTable.severity);

  const result = { total: 0, critical: 0, warning: 0, info: 0 };
  for (const row of rows) {
    const c = Number(row.count);
    result.total += c;
    if (row.severity === "critical") result.critical = c;
    else if (row.severity === "warning") result.warning = c;
    else if (row.severity === "info") result.info = c;
  }
  return result;
}

export async function cleanupOldAlerts(retentionDays = 90): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const result = await db
    .delete(alertsTable)
    .where(sql`${alertsTable.createdAt} < ${cutoff}`);
  return result.rowCount ?? 0;
}
