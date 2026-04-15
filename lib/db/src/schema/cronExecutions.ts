import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  boolean,
} from "drizzle-orm/pg-core";

export const cronExecutionsTable = pgTable("cron_executions", {
  id: serial("id").primaryKey(),
  jobName: text("job_name").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  success: boolean("success"),
  recordsProcessed: integer("records_processed").default(0),
  errorMessage: text("error_message"),
  durationMs: integer("duration_ms"),
});
