import { Router } from "express";
import { db, agentConfigTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

router.get("/agent-config", async (req, res) => {
  const rows = await db.select().from(agentConfigTable);
  const config: Record<string, string> = {};
  for (const row of rows) {
    config[row.key] = row.value;
  }
  res.json(config);
});

router.put("/agent-config/:key", async (req, res) => {
  const { key } = req.params;
  const { value } = req.body as { value: string };

  if (typeof value !== "string") {
    res.status(400).json({ error: "value must be a string" });
    return;
  }

  const [updated] = await db
    .update(agentConfigTable)
    .set({ value, updatedAt: new Date() })
    .where(eq(agentConfigTable.key, key))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Config key not found" });
    return;
  }

  res.json({ key: updated.key, value: updated.value });
});

export default router;
