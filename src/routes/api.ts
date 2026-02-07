import { Hono } from "hono";
import { createAccessMiddleware } from "../auth";
import { R2_MOUNT_PATH } from "../config";
import {
  ensureGateway,
  findExistingGateway,
  mountR2Storage,
  syncToR2,
  waitForProcess,
} from "../gateway";
import type { AppEnv } from "../types";

// CLI commands can take 10-15 seconds to complete due to WebSocket connection overhead
const CLI_TIMEOUT_MS = 20000;

// Auth profiles path inside the container
const AUTH_PROFILES_PATH = "/root/.openclaw/agents/main/agent/auth-profiles.json";
const CONFIG_PATH = "/root/.openclaw/openclaw.json";

/** btoa() crashes on Unicode in Workers — use TextEncoder instead */
function toBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * API routes
 * - /api/admin/* - Protected admin API routes (Cloudflare Access required)
 *
 * Note: /api/status is now handled by publicRoutes (no auth required)
 */
const api = new Hono<AppEnv>();

/**
 * Admin API routes - all protected by Cloudflare Access
 */
const adminApi = new Hono<AppEnv>();

// Middleware: Verify Cloudflare Access JWT for all admin routes
adminApi.use("*", createAccessMiddleware({ type: "json" }));

// GET /api/admin/devices - List pending and paired devices
adminApi.get("/devices", async (c) => {
  const sandbox = c.get("sandbox");

  try {
    // Ensure openclaw is running first
    await ensureGateway(sandbox, c.env);

    // Run OpenClaw CLI to list devices
    // Must specify --url to connect to the gateway running in the same container
    const proc = await sandbox.startProcess(
      "openclaw devices list --json --url ws://localhost:18789",
    );
    await waitForProcess(proc, CLI_TIMEOUT_MS);

    const logs = await proc.getLogs();
    const stdout = logs.stdout || "";
    const stderr = logs.stderr || "";

    // Try to parse JSON output
    try {
      // Find JSON in output (may have other log lines)
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        return c.json(data);
      }

      // If no JSON found, return raw output for debugging
      return c.json({
        pending: [],
        paired: [],
        raw: stdout,
        stderr,
      });
    } catch {
      return c.json({
        pending: [],
        paired: [],
        raw: stdout,
        stderr,
        parseError: "Failed to parse CLI output",
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/devices/:requestId/approve - Approve a pending device
adminApi.post("/devices/:requestId/approve", async (c) => {
  const sandbox = c.get("sandbox");
  const requestId = c.req.param("requestId");

  if (!requestId || !/^[a-zA-Z0-9_-]+$/.test(requestId)) {
    return c.json({ error: "Invalid requestId format" }, 400);
  }

  try {
    // Ensure openclaw is running first
    await ensureGateway(sandbox, c.env);

    // Run OpenClaw CLI to approve the device
    const proc = await sandbox.startProcess(
      `openclaw devices approve ${requestId} --url ws://localhost:18789`,
    );
    await waitForProcess(proc, CLI_TIMEOUT_MS);

    const logs = await proc.getLogs();
    const stdout = logs.stdout || "";
    const stderr = logs.stderr || "";

    // Check for success indicators (case-insensitive, CLI outputs "Approved ...")
    const success = stdout.toLowerCase().includes("approved") || proc.exitCode === 0;

    return c.json({
      success,
      requestId,
      message: success ? "Device approved" : "Approval may have failed",
      stdout,
      stderr,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/devices/approve-all - Approve all pending devices
adminApi.post("/devices/approve-all", async (c) => {
  const sandbox = c.get("sandbox");

  try {
    // Ensure openclaw is running first
    await ensureGateway(sandbox, c.env);

    // First, get the list of pending devices
    const listProc = await sandbox.startProcess(
      "openclaw devices list --json --url ws://localhost:18789",
    );
    await waitForProcess(listProc, CLI_TIMEOUT_MS);

    const listLogs = await listProc.getLogs();
    const stdout = listLogs.stdout || "";

    // Parse pending devices
    let pending: Array<{ requestId: string }> = [];
    try {
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        pending = data.pending || [];
      }
    } catch {
      return c.json({ error: "Failed to parse device list", raw: stdout }, 500);
    }

    if (pending.length === 0) {
      return c.json({ approved: [], message: "No pending devices to approve" });
    }

    // Approve each pending device
    const results: Array<{ requestId: string; success: boolean; error?: string }> = [];

    for (const device of pending) {
      try {
        // eslint-disable-next-line no-await-in-loop -- sequential device approval required
        const approveProc = await sandbox.startProcess(
          `openclaw devices approve ${device.requestId} --url ws://localhost:18789`,
        );
        // eslint-disable-next-line no-await-in-loop
        await waitForProcess(approveProc, CLI_TIMEOUT_MS);

        // eslint-disable-next-line no-await-in-loop
        const approveLogs = await approveProc.getLogs();
        const success =
          approveLogs.stdout?.toLowerCase().includes("approved") || approveProc.exitCode === 0;

        results.push({ requestId: device.requestId, success });
      } catch (err) {
        results.push({
          requestId: device.requestId,
          success: false,
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }

    const approvedCount = results.filter((r) => r.success).length;
    return c.json({
      approved: results.filter((r) => r.success).map((r) => r.requestId),
      failed: results.filter((r) => !r.success),
      message: `Approved ${approvedCount} of ${pending.length} device(s)`,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/storage - Get R2 storage status and last sync time
adminApi.get("/storage", async (c) => {
  const sandbox = c.get("sandbox");
  const hasCredentials = !!(
    c.env.R2_ACCESS_KEY_ID &&
    c.env.R2_SECRET_ACCESS_KEY &&
    c.env.CF_ACCOUNT_ID
  );

  // Check which credentials are missing
  const missing: string[] = [];
  if (!c.env.R2_ACCESS_KEY_ID) missing.push("R2_ACCESS_KEY_ID");
  if (!c.env.R2_SECRET_ACCESS_KEY) missing.push("R2_SECRET_ACCESS_KEY");
  if (!c.env.CF_ACCOUNT_ID) missing.push("CF_ACCOUNT_ID");

  let lastSync: string | null = null;

  // If R2 is configured, check for last sync timestamp
  if (hasCredentials) {
    try {
      // Mount R2 if not already mounted
      await mountR2Storage(sandbox, c.env);

      // Check for sync marker file
      const proc = await sandbox.startProcess(
        `cat ${R2_MOUNT_PATH}/.last-sync 2>/dev/null || echo ""`,
      );
      await waitForProcess(proc, 5000);
      const logs = await proc.getLogs();
      const timestamp = logs.stdout?.trim();
      if (timestamp && timestamp !== "") {
        lastSync = timestamp;
      }
    } catch {
      // Ignore errors checking sync status
    }
  }

  return c.json({
    configured: hasCredentials,
    missing: missing.length > 0 ? missing : undefined,
    lastSync,
    message: hasCredentials
      ? "R2 storage is configured. Your data will persist across container restarts."
      : "R2 storage is not configured. Paired devices and conversations will be lost when the container restarts.",
  });
});

// POST /api/admin/storage/sync - Trigger a manual sync to R2
adminApi.post("/storage/sync", async (c) => {
  const sandbox = c.get("sandbox");

  const result = await syncToR2(sandbox, c.env);

  if (result.success) {
    return c.json({
      success: true,
      message: "Sync completed successfully",
      lastSync: result.lastSync,
    });
  } else {
    const status = result.error?.includes("not configured") ? 400 : 500;
    return c.json(
      {
        success: false,
        error: result.error,
        details: result.details,
      },
      status,
    );
  }
});

// POST /api/admin/gateway/restart - Kill the current gateway and start a new one
adminApi.post("/gateway/restart", async (c) => {
  const sandbox = c.get("sandbox");

  try {
    // Find and kill the existing gateway process
    const existingProcess = await findExistingGateway(sandbox);

    if (existingProcess) {
      console.log("Killing existing gateway process:", existingProcess.id);
      try {
        await existingProcess.kill();
      } catch (killErr) {
        console.error("Error killing process:", killErr);
      }
      // Wait a moment for the process to die
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Start a new gateway in the background
    const bootPromise = ensureGateway(sandbox, c.env).catch((err) => {
      console.error("Gateway restart failed:", err);
    });
    c.executionCtx.waitUntil(bootPromise);

    return c.json({
      success: true,
      message: existingProcess
        ? "Gateway process killed, new instance starting..."
        : "No existing process found, starting new instance...",
      previousProcessId: existingProcess?.id,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/auth/providers - List configured auth providers
adminApi.get("/auth/providers", async (c) => {
  const sandbox = c.get("sandbox");

  try {
    await ensureGateway(sandbox, c.env);

    const proc = await sandbox.startProcess(`cat ${AUTH_PROFILES_PATH} 2>/dev/null || echo "{}"`);
    await waitForProcess(proc, 5000);

    const logs = await proc.getLogs();
    const raw = logs.stdout?.trim() || "{}";

    let parsed: Record<string, any> = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      return c.json({ providers: [], error: "Failed to parse auth profiles" });
    }

    // Auth profiles are nested under "profiles" key; top-level has metadata like version, lastGood, usageStats
    const profilesMap: Record<string, any> = parsed.profiles || {};

    const providers = Object.entries(profilesMap).map(([id, profile]: [string, any]) => {
      const secret = profile.token || profile.key || profile.access || "";
      return {
        id,
        provider: profile.provider || "unknown",
        type: profile.type || "unknown",
        tokenPreview: secret ? `...${secret.slice(-4)}` : undefined,
        configured: true,
      };
    });

    return c.json({ providers });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return c.json({ providers: [], error: errorMessage });
  }
});

// POST /api/admin/auth/setup-token - Save an Anthropic setup token
adminApi.post("/auth/setup-token", async (c) => {
  const sandbox = c.get("sandbox");

  let body: { provider?: string; token?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }

  const provider = body.provider || "anthropic";
  const token = body.token;

  if (!token || typeof token !== "string" || token.trim().length === 0) {
    return c.json({ success: false, error: "Token is required" }, 400);
  }

  const profileId = `${provider}:default`;

  try {
    await ensureGateway(sandbox, c.env);

    // Read existing auth profiles
    const readProc = await sandbox.startProcess(
      `cat ${AUTH_PROFILES_PATH} 2>/dev/null || echo "{}"`,
    );
    await waitForProcess(readProc, 5000);
    const readLogs = await readProc.getLogs();
    let parsed: Record<string, any> = {};
    try {
      parsed = JSON.parse(readLogs.stdout?.trim() || "{}");
    } catch {
      parsed = {};
    }

    // Profiles are nested under "profiles" key
    parsed.profiles = parsed.profiles || {};
    parsed.profiles[profileId] = {
      type: "token",
      provider,
      token: token.trim(),
    };

    // Write back via base64 to avoid shell injection
    const b64 = toBase64(JSON.stringify(parsed, null, 2));
    const writeProc = await sandbox.startProcess(
      `mkdir -p "$(dirname ${AUTH_PROFILES_PATH})" && echo "${b64}" | base64 -d > ${AUTH_PROFILES_PATH}`,
    );
    await waitForProcess(writeProc, 5000);

    // Also patch openclaw.json to reference the profile
    const configProc = await sandbox.startProcess(`cat ${CONFIG_PATH} 2>/dev/null || echo "{}"`);
    await waitForProcess(configProc, 5000);
    const configLogs = await configProc.getLogs();
    let config: Record<string, any> = {};
    try {
      config = JSON.parse(configLogs.stdout?.trim() || "{}");
    } catch {
      config = {};
    }

    config.auth = config.auth || {};
    config.auth.profiles = config.auth.profiles || {};
    config.auth.profiles[profileId] = { provider, mode: "token" };

    // Also switch the primary model to use this provider
    // so the gateway actually routes requests through the new token
    if (provider === "anthropic") {
      config.agents = config.agents || {};
      config.agents.defaults = config.agents.defaults || {};
      config.agents.defaults.model = { primary: "anthropic/claude-sonnet-4-5" };
      // Ensure the anthropic provider is registered in models.providers
      config.models = config.models || {};
      config.models.providers = config.models.providers || {};
      if (!config.models.providers.anthropic) {
        config.models.providers.anthropic = {};
      }
    }

    const configB64 = toBase64(JSON.stringify(config, null, 2));
    const writeConfigProc = await sandbox.startProcess(
      `echo "${configB64}" | base64 -d > ${CONFIG_PATH}`,
    );
    await waitForProcess(writeConfigProc, 5000);

    // Restart gateway to pick up changes
    const existingProcess = await findExistingGateway(sandbox);
    if (existingProcess) {
      try {
        await existingProcess.kill();
      } catch (killErr) {
        console.error("Error killing process:", killErr);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    const bootPromise = ensureGateway(sandbox, c.env).catch((err) => {
      console.error("Gateway restart after token save failed:", err);
    });
    c.executionCtx.waitUntil(bootPromise);

    return c.json({
      success: true,
      message: `Setup token saved for ${provider}. Gateway is restarting...`,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return c.json({ success: false, error: errorMessage }, 500);
  }
});

// DELETE /api/admin/auth/providers/:profileId - Remove an auth provider
adminApi.delete("/auth/providers/:profileId", async (c) => {
  const sandbox = c.get("sandbox");
  const profileId = c.req.param("profileId");

  if (!profileId || !/^[a-zA-Z0-9_:-]+$/.test(profileId)) {
    return c.json({ success: false, error: "Invalid profileId format" }, 400);
  }

  try {
    await ensureGateway(sandbox, c.env);

    // Read existing auth profiles
    const readProc = await sandbox.startProcess(
      `cat ${AUTH_PROFILES_PATH} 2>/dev/null || echo "{}"`,
    );
    await waitForProcess(readProc, 5000);
    const readLogs = await readProc.getLogs();
    let parsed: Record<string, any> = {};
    try {
      parsed = JSON.parse(readLogs.stdout?.trim() || "{}");
    } catch {
      parsed = {};
    }

    const profilesMap: Record<string, any> = parsed.profiles || {};
    if (!(profileId in profilesMap)) {
      return c.json({ success: false, error: `Profile "${profileId}" not found` }, 404);
    }

    delete profilesMap[profileId];
    parsed.profiles = profilesMap;

    // Write back
    const b64 = toBase64(JSON.stringify(parsed, null, 2));
    const writeProc = await sandbox.startProcess(
      `echo "${b64}" | base64 -d > ${AUTH_PROFILES_PATH}`,
    );
    await waitForProcess(writeProc, 5000);

    // Also remove from openclaw.json
    const configProc = await sandbox.startProcess(`cat ${CONFIG_PATH} 2>/dev/null || echo "{}"`);
    await waitForProcess(configProc, 5000);
    const configLogs = await configProc.getLogs();
    let config: Record<string, any> = {};
    try {
      config = JSON.parse(configLogs.stdout?.trim() || "{}");
    } catch {
      config = {};
    }

    if (config.auth?.profiles?.[profileId]) {
      delete config.auth.profiles[profileId];
      const configB64 = toBase64(JSON.stringify(config, null, 2));
      const writeConfigProc = await sandbox.startProcess(
        `echo "${configB64}" | base64 -d > ${CONFIG_PATH}`,
      );
      await waitForProcess(writeConfigProc, 5000);
    }

    // Restart gateway
    const existingProcess = await findExistingGateway(sandbox);
    if (existingProcess) {
      try {
        await existingProcess.kill();
      } catch (killErr) {
        console.error("Error killing process:", killErr);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    const bootPromise = ensureGateway(sandbox, c.env).catch((err) => {
      console.error("Gateway restart after provider delete failed:", err);
    });
    c.executionCtx.waitUntil(bootPromise);

    return c.json({
      success: true,
      message: `Provider "${profileId}" removed. Gateway is restarting...`,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return c.json({ success: false, error: errorMessage }, 500);
  }
});

// Mount admin API routes under /admin
api.route("/admin", adminApi);

export { api };
