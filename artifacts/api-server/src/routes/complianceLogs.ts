import { Router } from "express";
import { db, complianceLogsTable, insertComplianceLogSchema } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

const router = Router();

// Cost-control fix (2026-05-07): compliance_logs is 250 MB / 530k rows. The
// previous unbounded select pulled the entire table on every request and
// filtered in JS. Now the actionType filter pushes to SQL and a default
// LIMIT 500 caps egress per request.
router.get("/compliance-logs", async (req, res) => {
  const { actionType, limit } = req.query;
  const cap = Math.min(Math.max(Number(limit ?? 500), 1), 5000);

  const rows = actionType
    ? await db
        .select()
        .from(complianceLogsTable)
        .where(eq(complianceLogsTable.actionType, String(actionType)))
        .orderBy(desc(complianceLogsTable.timestamp))
        .limit(cap)
    : await db
        .select()
        .from(complianceLogsTable)
        .orderBy(desc(complianceLogsTable.timestamp))
        .limit(cap);

  res.json(rows);
});

router.post("/compliance-logs", async (req, res) => {
  const parsed = insertComplianceLogSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues });
    return;
  }
  const [log] = await db.insert(complianceLogsTable).values(parsed.data).returning();
  res.status(201).json(log);
});

export default router;
