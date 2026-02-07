import { Hono } from "hono";
import { GATEWAY_PORT } from "../config";
import { findExistingGateway } from "../gateway";
import type { AppEnv } from "../types";

/**
 * Public routes - NO Cloudflare Access authentication required
 *
 * These routes are mounted BEFORE the auth middleware is applied.
 * Includes: health checks, static assets, and public API endpoints.
 */
const publicRoutes = new Hono<AppEnv>();

// GET /sandbox-health - Health check endpoint
publicRoutes.get("/sandbox-health", (c) => {
  return c.json({
    status: "ok",
    service: "tedix-claw",
    gateway_port: GATEWAY_PORT,
  });
});

// GET /logo.png - Serve logo from ASSETS binding
publicRoutes.get("/logo.png", (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// GET /logo-small.png - Serve small logo from ASSETS binding
publicRoutes.get("/logo-small.png", (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// GET /api/status - Public health check for gateway status (no auth required)
publicRoutes.get("/api/status", async (c) => {
  const sandbox = c.get("sandbox");

  try {
    // List all processes for diagnostics
    let allProcesses: Array<{ id: string; command: string; status: string }> = [];
    try {
      const procs = await sandbox.listProcesses();
      allProcesses = procs.map((p) => ({ id: p.id, command: p.command, status: p.status }));
    } catch {
      /* ignore */
    }

    const process = await findExistingGateway(sandbox);
    if (!process) {
      // Check for recently failed gateway processes and get their logs
      const failedGateway = allProcesses.find(
        (p) =>
          p.status === "failed" &&
          (p.command.includes("start-openclaw.sh") || p.command.includes("openclaw gateway")),
      );
      let failedLogs: string | null = null;
      if (failedGateway) {
        try {
          const rawLogs = await sandbox.getProcessLogs(failedGateway.id);
          failedLogs = typeof rawLogs === "string" ? rawLogs : JSON.stringify(rawLogs);
        } catch {
          /* ignore */
        }
      }
      return c.json({
        ok: false,
        status: "not_running",
        processes: allProcesses,
        failedLogs: typeof failedLogs === "string" ? failedLogs.slice(-3000) : failedLogs,
      });
    }

    // Get process logs for diagnostics
    let logs: string | null = null;
    try {
      const rawLogs = await sandbox.getProcessLogs(process.id);
      logs = typeof rawLogs === "string" ? rawLogs : JSON.stringify(rawLogs);
    } catch {
      /* ignore */
    }

    // Run diagnostic commands inside the sandbox container when gateway isn't responding
    // Note: sandbox.exec() runs commands in the container, not on the host - no injection risk
    const diag: Record<string, string> = {};
    const runDiag = async (name: string, cmd: string) => {
      try {
        const result = await sandbox.exec(cmd, { timeout: 5000 });
        diag[name] = (result.stdout || "") + (result.stderr || "");
      } catch (e) {
        diag[name] = `error: ${e}`;
      }
    };

    // Process exists, check if it's actually responding
    // Try to reach the gateway with a short timeout
    try {
      await process.waitForPort(18789, { mode: "tcp", timeout: 5000 });
      return c.json({
        ok: true,
        status: "running",
        processId: process.id,
        processes: allProcesses,
      });
    } catch {
      // Run diagnostics in parallel inside the sandbox container
      await Promise.all([
        runDiag(
          "port_check",
          "curl -sf --max-time 2 http://localhost:18789/ && echo 'reachable' || echo 'unreachable'",
        ),
        runDiag("config_check", "head -100 /root/.openclaw/openclaw.json"),
        runDiag("ps", "ps aux 2>&1 | head -30"),
      ]);

      return c.json({
        ok: false,
        status: "not_responding",
        processId: process.id,
        processStatus: process.status,
        processes: allProcesses,
        diag,
        logs: typeof logs === "string" ? logs.slice(-3000) : logs,
      });
    }
  } catch (err) {
    return c.json({
      ok: false,
      status: "error",
      error: err instanceof Error ? err.message : "Unknown error",
    });
  }
});

// GET /_admin/assets/* - Admin UI static assets (CSS, JS need to load for login redirect)
// Assets are built to dist/client with base "/_admin/"
publicRoutes.get("/_admin/assets/*", async (c) => {
  const url = new URL(c.req.url);
  // Rewrite /_admin/assets/* to /assets/* for the ASSETS binding
  const assetPath = url.pathname.replace("/_admin/assets/", "/assets/");
  const assetUrl = new URL(assetPath, url.origin);
  return c.env.ASSETS.fetch(new Request(assetUrl.toString(), c.req.raw));
});

export { publicRoutes };
