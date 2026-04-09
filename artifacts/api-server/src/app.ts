import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { db, complianceLogsTable } from "@workspace/db";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

app.use("/api", router);

// ─── 404 handler ─────────────────────────────────────────────────────────────
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

// ─── Global error handler ─────────────────────────────────────────────────────
// Catches any unhandled errors thrown in route handlers and logs them to the
// compliance_logs table so every failure is auditable.
app.use(async (err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  const stack   = err instanceof Error ? err.stack : undefined;

  logger.error({ err, method: req.method, url: req.originalUrl }, "Unhandled API error");

  // Async compliance log — fire and forget, never throw
  void db
    .insert(complianceLogsTable)
    .values({
      actionType: "api_error",
      details: {
        method: req.method,
        url: req.originalUrl,
        message,
        stack: stack?.split("\n").slice(0, 8).join("\n"),
        timestamp: new Date().toISOString(),
      },
      timestamp: new Date(),
    })
    .catch((logErr) => logger.error({ logErr }, "Failed to write error to compliance_logs"));

  if (res.headersSent) return;

  res.status(500).json({
    error: "Internal server error",
    message: process.env["NODE_ENV"] === "development" ? message : "An unexpected error occurred",
  });
});

export default app;
