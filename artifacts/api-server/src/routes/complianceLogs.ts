import { Router } from "express";
import { db, complianceLogsTable, insertComplianceLogSchema } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

const router = Router();

router.get("/compliance-logs", async (req, res) => {
  const { actionType } = req.query;
  let rows = await db.select().from(complianceLogsTable).orderBy(desc(complianceLogsTable.timestamp));

  if (actionType) {
    rows = rows.filter((l) => l.actionType === String(actionType));
  }

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
