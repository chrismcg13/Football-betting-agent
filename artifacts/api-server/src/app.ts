import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
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

// No-cache for API responses only — do NOT apply globally or it overrides
// the static asset cache headers on the dashboard.
app.use("/api", (_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

app.use("/api", router);

// ─── Dashboard static files ───────────────────────────────────────────────────
// Serve the pre-built dashboard SPA at /dashboard/* — works in both autoscale
// and always-on VM deployment modes where Replit's static handler may not fire.
//
// Path strategy: use import.meta.url for an absolute reference that works
// regardless of the working directory the server was started from.
// In the bundled dist/index.mjs:
//   import.meta.url → .../artifacts/api-server/dist/index.mjs
//   ../../..         → workspace root
//   + artifacts/dashboard/dist/public → correct target
const _serverDir = path.dirname(fileURLToPath(import.meta.url));
const dashboardPublicDir = path.resolve(_serverDir, "../../..", "artifacts/dashboard/dist/public");
if (fs.existsSync(dashboardPublicDir)) {
  // Serve hashed assets (JS/CSS) with long-lived immutable cache — filenames
  // change on every build so stale cache is never an issue.
  app.use("/dashboard/assets", express.static(path.join(dashboardPublicDir, "assets"), {
    maxAge: "1y",
    immutable: true,
  }));

  // Serve all other static files (favicon, opengraph, etc.) with short cache.
  // index:false prevents express.static from auto-serving index.html — the SPA
  // fallback below handles that with explicit no-cache headers instead.
  app.use("/dashboard", express.static(dashboardPublicDir, { maxAge: "1m", index: false }));

  // SPA fallback — always serve index.html with no-cache so browsers never
  // serve a stale entry point pointing to old hashed asset filenames.
  app.get(/^\/dashboard(\/.*)?$/, (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.sendFile(path.join(dashboardPublicDir, "index.html"));
  });

  logger.info({ dir: dashboardPublicDir }, "Dashboard static files registered");
} else {
  logger.warn({ dir: dashboardPublicDir }, "Dashboard dist not found — dashboard will not be served (run dashboard build first)");
}

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
