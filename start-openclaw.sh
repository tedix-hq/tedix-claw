#!/bin/bash
# Startup script for OpenClaw in Cloudflare Sandbox
# This script:
# 1. Restores config from R2 backup if available
# 2. Runs openclaw onboard --non-interactive to configure from env vars
# 3. Patches config for features onboard doesn't cover (channels, gateway auth)
# 4. Starts the gateway

set -e

# Check if gateway is already running by testing the port.
# Use curl since ss/netstat may not be installed in the container.
# This check MUST come before the lockfile check — if the gateway is running,
# we exit immediately regardless of lock state.
if curl -sf --max-time 2 http://localhost:18789/ > /dev/null 2>&1; then
    echo "OpenClaw gateway is already running on port 18789, exiting."
    exit 0
fi

# Prevent multiple concurrent instances via file lock.
# The sandbox may start multiple start-openclaw.sh processes simultaneously
# from concurrent HTTP requests. Without a lock, they race to start the gateway.
LOCKFILE="/tmp/start-openclaw.lock"
if ! mkdir "$LOCKFILE" 2>/dev/null; then
    # Lock exists but gateway isn't running (checked above).
    # Previous instance was killed without cleanup (SIGKILL skips traps).
    echo "Stale lockfile detected (gateway not running), recovering..."
    rm -rf "$LOCKFILE"
    if ! mkdir "$LOCKFILE" 2>/dev/null; then
        echo "Failed to acquire lock after recovery, exiting."
        exit 1
    fi
fi
# Clean up lock on exit (including errors due to set -e)
trap 'rmdir "$LOCKFILE" 2>/dev/null' EXIT

CONFIG_DIR="/root/.openclaw"
CONFIG_FILE="$CONFIG_DIR/openclaw.json"
BACKUP_DIR="/data/openclaw"

echo "Config directory: $CONFIG_DIR"
echo "Backup directory: $BACKUP_DIR"

mkdir -p "$CONFIG_DIR"

# ============================================================
# RESTORE FROM R2 BACKUP
# ============================================================

should_restore_from_r2() {
    local R2_SYNC_FILE="$BACKUP_DIR/.last-sync"
    local LOCAL_SYNC_FILE="$CONFIG_DIR/.last-sync"

    if [ ! -f "$R2_SYNC_FILE" ]; then
        echo "No R2 sync timestamp found, skipping restore"
        return 1
    fi

    if [ ! -f "$LOCAL_SYNC_FILE" ]; then
        echo "No local sync timestamp, will restore from R2"
        return 0
    fi

    R2_TIME=$(cat "$R2_SYNC_FILE" 2>/dev/null)
    LOCAL_TIME=$(cat "$LOCAL_SYNC_FILE" 2>/dev/null)

    echo "R2 last sync: $R2_TIME"
    echo "Local last sync: $LOCAL_TIME"

    R2_EPOCH=$(date -d "$R2_TIME" +%s 2>/dev/null || echo "0")
    LOCAL_EPOCH=$(date -d "$LOCAL_TIME" +%s 2>/dev/null || echo "0")

    if [ "$R2_EPOCH" -gt "$LOCAL_EPOCH" ]; then
        echo "R2 backup is newer, will restore"
        return 0
    else
        echo "Local data is newer or same, skipping restore"
        return 1
    fi
}

# R2 restore timeout (seconds). s3fs-backed copies can hang if the mount is slow.
R2_RESTORE_TIMEOUT=60

# Check for backup data in R2
if [ -f "$BACKUP_DIR/openclaw/openclaw.json" ]; then
    if should_restore_from_r2; then
        echo "Restoring from R2 backup at $BACKUP_DIR/openclaw (timeout: ${R2_RESTORE_TIMEOUT}s)..."
        if timeout "$R2_RESTORE_TIMEOUT" cp -a "$BACKUP_DIR/openclaw/." "$CONFIG_DIR/"; then
            cp -f "$BACKUP_DIR/.last-sync" "$CONFIG_DIR/.last-sync" 2>/dev/null || true
            echo "Restored config from R2 backup"
        else
            echo "WARNING: R2 config restore timed out or failed, starting fresh"
        fi
    fi
elif [ -d "$BACKUP_DIR" ]; then
    echo "R2 mounted at $BACKUP_DIR but no backup data found yet"
else
    echo "R2 not mounted, starting fresh"
fi

# Restore workspace from R2 backup if available (only if R2 is newer)
# This includes IDENTITY.md, USER.md, MEMORY.md, memory/, and assets/
WORKSPACE_DIR="/root/clawd"
if [ -d "$BACKUP_DIR/workspace" ] && [ "$(ls -A $BACKUP_DIR/workspace 2>/dev/null)" ]; then
    if should_restore_from_r2; then
        echo "Restoring workspace from $BACKUP_DIR/workspace (timeout: ${R2_RESTORE_TIMEOUT}s)..."
        mkdir -p "$WORKSPACE_DIR"
        if timeout "$R2_RESTORE_TIMEOUT" cp -a "$BACKUP_DIR/workspace/." "$WORKSPACE_DIR/"; then
            echo "Restored workspace from R2 backup"
        else
            echo "WARNING: R2 workspace restore timed out or failed"
        fi
    fi
fi

# Restore skills from R2 backup if available (only if R2 is newer)
SKILLS_DIR="/root/clawd/skills"
if [ -d "$BACKUP_DIR/skills" ] && [ "$(ls -A $BACKUP_DIR/skills 2>/dev/null)" ]; then
    if should_restore_from_r2; then
        echo "Restoring skills from $BACKUP_DIR/skills (timeout: ${R2_RESTORE_TIMEOUT}s)..."
        mkdir -p "$SKILLS_DIR"
        if timeout "$R2_RESTORE_TIMEOUT" cp -a "$BACKUP_DIR/skills/." "$SKILLS_DIR/"; then
            echo "Restored skills from R2 backup"
        else
            echo "WARNING: R2 skills restore timed out or failed"
        fi
    fi
fi

# ============================================================
# ONBOARD (only if no config exists yet)
# ============================================================
if [ ! -f "$CONFIG_FILE" ]; then
    echo "No existing config found, running openclaw onboard..."

    AUTH_ARGS=""
    if [ -n "$CLOUDFLARE_AI_GATEWAY_API_KEY" ] && [ -n "$CF_AI_GATEWAY_ACCOUNT_ID" ] && [ -n "$CF_AI_GATEWAY_GATEWAY_ID" ]; then
        AUTH_ARGS="--auth-choice cloudflare-ai-gateway-api-key \
            --cloudflare-ai-gateway-account-id $CF_AI_GATEWAY_ACCOUNT_ID \
            --cloudflare-ai-gateway-gateway-id $CF_AI_GATEWAY_GATEWAY_ID \
            --cloudflare-ai-gateway-api-key $CLOUDFLARE_AI_GATEWAY_API_KEY"
    elif [ -n "$ANTHROPIC_API_KEY" ]; then
        AUTH_ARGS="--auth-choice apiKey --anthropic-api-key $ANTHROPIC_API_KEY"
    elif [ -n "$OPENAI_API_KEY" ]; then
        AUTH_ARGS="--auth-choice openai-api-key --openai-api-key $OPENAI_API_KEY"
    fi

    openclaw onboard --non-interactive --accept-risk \
        --mode local \
        $AUTH_ARGS \
        --gateway-port 18789 \
        --gateway-bind lan \
        --skip-channels \
        --skip-skills \
        --skip-health

    echo "Onboard completed"
else
    echo "Using existing config"
fi

# ============================================================
# PATCH CONFIG (channels, gateway auth, trusted proxies)
# ============================================================
# openclaw onboard handles provider/model config, but we need to patch in:
# - Channel config (Telegram, Discord, Slack)
# - Gateway token auth
# - Trusted proxies for sandbox networking
# - Base URL override for legacy AI Gateway path
node << 'EOFPATCH'
const fs = require('fs');

const configPath = '/root/.openclaw/openclaw.json';
console.log('Patching config at:', configPath);
let config = {};

try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
    console.log('Starting with empty config');
}

config.gateway = config.gateway || {};
config.channels = config.channels || {};

// Gateway configuration
config.gateway.port = 18789;
config.gateway.mode = 'local';
config.gateway.trustedProxies = ['10.1.0.0'];

if (process.env.OPENCLAW_GATEWAY_TOKEN) {
    config.gateway.auth = config.gateway.auth || {};
    config.gateway.auth.token = process.env.OPENCLAW_GATEWAY_TOKEN;
}

if (process.env.OPENCLAW_DEV_MODE === 'true') {
    config.gateway.controlUi = config.gateway.controlUi || {};
    config.gateway.controlUi.allowInsecureAuth = true;
}

// Enable HTTP REST endpoints for programmatic access (A2A, MCP, CLI)
// This enables the OpenAI-compatible POST /v1/chat/completions endpoint
config.gateway.http = config.gateway.http || {};
config.gateway.http.endpoints = config.gateway.http.endpoints || {};
config.gateway.http.endpoints.chatCompletions = { enabled: true };
config.gateway.http.endpoints.responses = { enabled: true };

// Legacy AI Gateway base URL override:
// ANTHROPIC_BASE_URL is picked up natively by the Anthropic SDK,
// so we don't need to patch the provider config. Writing a provider
// entry without a models array breaks OpenClaw's config validation.

// AI Gateway model override (CF_AI_GATEWAY_MODEL=provider/model-id)
// Adds a provider entry for any AI Gateway provider and sets it as default model.
// Examples:
//   workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast
//   openai/gpt-4o
//   anthropic/claude-sonnet-4-5
// Clean up stale AI Gateway providers if env vars are no longer set.
// This handles the case where AI Gateway secrets were removed but the
// R2-restored config still references them as the default model.
if (!process.env.CF_AI_GATEWAY_MODEL && !process.env.CLOUDFLARE_AI_GATEWAY_API_KEY) {
    if (config.models && config.models.providers) {
        const staleKeys = Object.keys(config.models.providers).filter(k => k.startsWith('cf-ai-gw-'));
        for (const key of staleKeys) {
            console.log('Removing stale AI Gateway provider:', key);
            delete config.models.providers[key];
        }
    }
    // Clear default model if it pointed to a removed provider
    const defaultModel = config.agents?.defaults?.model?.primary;
    if (defaultModel && defaultModel.startsWith('cf-ai-gw-')) {
        console.log('Clearing stale default model:', defaultModel);
        delete config.agents.defaults.model;
    }
}

if (process.env.CF_AI_GATEWAY_MODEL) {
    const raw = process.env.CF_AI_GATEWAY_MODEL;
    const slashIdx = raw.indexOf('/');
    if (slashIdx <= 0) {
        console.warn('CF_AI_GATEWAY_MODEL must be in provider/model-id format (e.g. "anthropic/claude-sonnet-4-5"), got: ' + raw);
    } else {
        const gwProvider = raw.substring(0, slashIdx);
        const modelId = raw.substring(slashIdx + 1);

        const accountId = process.env.CF_AI_GATEWAY_ACCOUNT_ID;
        const gatewayId = process.env.CF_AI_GATEWAY_GATEWAY_ID;
        const apiKey = process.env.CLOUDFLARE_AI_GATEWAY_API_KEY;

        let baseUrl;
        if (accountId && gatewayId) {
            baseUrl = 'https://gateway.ai.cloudflare.com/v1/' + accountId + '/' + gatewayId + '/' + gwProvider;
            if (gwProvider === 'workers-ai') baseUrl += '/v1';
        } else if (gwProvider === 'workers-ai' && process.env.CF_ACCOUNT_ID) {
            baseUrl = 'https://api.cloudflare.com/client/v4/accounts/' + process.env.CF_ACCOUNT_ID + '/ai/v1';
        }

        if (baseUrl && apiKey) {
            const api = gwProvider === 'anthropic' ? 'anthropic-messages' : 'openai-completions';
            const providerName = 'cf-ai-gw-' + gwProvider;

            config.models = config.models || {};
            config.models.providers = config.models.providers || {};
            config.models.providers[providerName] = {
                baseUrl: baseUrl,
                apiKey: apiKey,
                api: api,
                models: [{ id: modelId, name: modelId, contextWindow: 131072, maxTokens: 8192 }],
            };
            config.agents = config.agents || {};
            config.agents.defaults = config.agents.defaults || {};
            config.agents.defaults.model = { primary: providerName + '/' + modelId };
            console.log('AI Gateway model override: provider=' + providerName + ' model=' + modelId + ' via ' + baseUrl);
        } else {
            console.warn('CF_AI_GATEWAY_MODEL set but missing required config (account ID, gateway ID, or API key)');
        }
    }
}

// Channel config strategy: merge env vars into R2-restored config, filtering to known valid keys.
// This preserves user-configured settings (groups, guilds, allowlists) while preventing stale
// keys from old backups from failing OpenClaw's strict config validation.
// Valid keys derived from openclaw/src/config/types.{telegram,discord,slack}.ts (2026.2.6).
// MAINTENANCE: Update these allowlists when upgrading OpenClaw to a new version.

const VALID_TELEGRAM_KEYS = new Set([
    'name', 'capabilities', 'markdown', 'commands', 'customCommands', 'configWrites',
    'dmPolicy', 'enabled', 'botToken', 'tokenFile', 'replyToMode', 'groups',
    'allowFrom', 'groupAllowFrom', 'groupPolicy', 'historyLimit', 'dmHistoryLimit', 'dms',
    'textChunkLimit', 'chunkMode', 'blockStreaming', 'draftChunk', 'blockStreamingCoalesce',
    'streamMode', 'mediaMaxMb', 'timeoutSeconds', 'retry', 'network', 'proxy',
    'webhookUrl', 'webhookSecret', 'webhookPath', 'actions', 'reactionNotifications',
    'reactionLevel', 'heartbeat', 'linkPreview', 'responsePrefix', 'accounts',
]);

const VALID_DISCORD_KEYS = new Set([
    'name', 'capabilities', 'markdown', 'commands', 'configWrites', 'enabled', 'token',
    'allowBots', 'groupPolicy', 'textChunkLimit', 'chunkMode', 'blockStreaming',
    'blockStreamingCoalesce', 'maxLinesPerMessage', 'mediaMaxMb', 'historyLimit',
    'dmHistoryLimit', 'dms', 'retry', 'actions', 'replyToMode', 'dm', 'guilds',
    'heartbeat', 'execApprovals', 'intents', 'pluralkit', 'responsePrefix', 'accounts',
]);

const VALID_SLACK_KEYS = new Set([
    'name', 'capabilities', 'markdown', 'commands', 'configWrites', 'enabled',
    'botToken', 'appToken', 'userToken', 'userTokenReadOnly', 'allowBots',
    'requireMention', 'groupPolicy', 'historyLimit', 'dmHistoryLimit', 'dms',
    'textChunkLimit', 'chunkMode', 'blockStreaming', 'blockStreamingCoalesce',
    'mediaMaxMb', 'reactionNotifications', 'reactionAllowlist', 'replyToMode',
    'replyToModeByChatType', 'thread', 'actions', 'slashCommand', 'dm',
    'channels', 'heartbeat', 'responsePrefix', 'accounts',
]);

function filterKeys(obj, validKeys) {
    const filtered = {};
    for (const key of Object.keys(obj)) {
        if (validKeys.has(key)) filtered[key] = obj[key];
        else console.log('Stripped unknown channel key:', key);
    }
    return filtered;
}

// Telegram configuration
if (process.env.TELEGRAM_BOT_TOKEN) {
    const existing = filterKeys(config.channels.telegram || {}, VALID_TELEGRAM_KEYS);
    existing.botToken = process.env.TELEGRAM_BOT_TOKEN;
    existing.enabled = true;
    if (process.env.TELEGRAM_DM_POLICY) existing.dmPolicy = process.env.TELEGRAM_DM_POLICY;
    if (!existing.dmPolicy) existing.dmPolicy = 'pairing';
    if (process.env.TELEGRAM_DM_ALLOW_FROM) {
        existing.allowFrom = process.env.TELEGRAM_DM_ALLOW_FROM.split(',');
    } else if (existing.dmPolicy === 'open' && !existing.allowFrom) {
        existing.allowFrom = ['*'];
    }
    config.channels.telegram = existing;
}

// Discord configuration
if (process.env.DISCORD_BOT_TOKEN) {
    const existing = filterKeys(config.channels.discord || {}, VALID_DISCORD_KEYS);
    existing.token = process.env.DISCORD_BOT_TOKEN;
    existing.enabled = true;
    existing.dm = existing.dm || {};
    if (process.env.DISCORD_DM_POLICY) existing.dm.policy = process.env.DISCORD_DM_POLICY;
    if (!existing.dm.policy) existing.dm.policy = 'pairing';
    if (existing.dm.policy === 'open' && !existing.dm.allowFrom) {
        existing.dm.allowFrom = ['*'];
    }
    config.channels.discord = existing;
}

// Slack configuration
if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
    const existing = filterKeys(config.channels.slack || {}, VALID_SLACK_KEYS);
    existing.botToken = process.env.SLACK_BOT_TOKEN;
    existing.appToken = process.env.SLACK_APP_TOKEN;
    existing.enabled = true;
    config.channels.slack = existing;
}

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('Configuration patched successfully');
EOFPATCH

# ============================================================
# INJECT SETUP TOKEN (if provided via env var)
# ============================================================
# Writes CLAUDE_SETUP_TOKEN into auth-profiles.json and references it in openclaw.json.
# This avoids re-entering the token after every container restart.
if [ -n "$CLAUDE_SETUP_TOKEN" ]; then
    echo "Injecting setup token from CLAUDE_SETUP_TOKEN env var..."
    node << 'EOFTOKEN'
const fs = require('fs');

const profilesPath = '/root/.openclaw/agents/main/agent/auth-profiles.json';
const configPath = '/root/.openclaw/openclaw.json';
const provider = 'anthropic';
const profileId = provider + ':default';

// Ensure directory exists
fs.mkdirSync(require('path').dirname(profilesPath), { recursive: true });

// Read or create auth-profiles.json
let profiles = {};
try { profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8')); } catch {}
profiles.profiles = profiles.profiles || {};

// Only inject if no existing token (don't overwrite admin-set tokens)
if (!profiles.profiles[profileId] || !profiles.profiles[profileId].token) {
    profiles.profiles[profileId] = {
        type: 'token',
        provider: provider,
        token: process.env.CLAUDE_SETUP_TOKEN.trim(),
    };
    fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2));
    console.log('Setup token written to auth-profiles.json');

    // Reference in openclaw.json and ensure Anthropic provider exists
    let config = {};
    try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
    config.auth = config.auth || {};
    config.auth.profiles = config.auth.profiles || {};
    config.auth.profiles[profileId] = { provider: provider, mode: 'token' };

    // When using a setup token with no ANTHROPIC_API_KEY, onboard creates a
    // config without model providers. The gateway needs at least one provider
    // to know which models are available. Add a basic Anthropic provider entry
    // so the gateway can use the setup token credentials from auth-profiles.json.
    config.models = config.models || {};
    config.models.providers = config.models.providers || {};
    if (!config.models.providers.anthropic) {
        config.models.providers.anthropic = { api: 'anthropic-messages' };
        console.log('Added default Anthropic provider for setup token auth');
    }

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log('Config updated with token profile reference');
} else {
    console.log('Existing token found, skipping env var injection');
}
EOFTOKEN
fi

# ============================================================
# START GATEWAY
# ============================================================
echo "Starting OpenClaw Gateway..."
echo "Gateway will be available on port 18789"

rm -f /tmp/openclaw-gateway.lock 2>/dev/null || true
rm -f "$CONFIG_DIR/gateway.lock" 2>/dev/null || true

echo "Dev mode: ${OPENCLAW_DEV_MODE:-false}"

# Run gateway as a child process (not exec) so bash stays alive for the
# lockfile cleanup trap. If we used exec, bash would be replaced and the
# trap would never fire, leaving a stale lockfile that blocks future starts.
if [ -n "$OPENCLAW_GATEWAY_TOKEN" ]; then
    echo "Starting gateway with token auth..."
    openclaw gateway --port 18789 --verbose --allow-unconfigured --bind lan --token "$OPENCLAW_GATEWAY_TOKEN" &
else
    echo "Starting gateway with device pairing (no token)..."
    openclaw gateway --port 18789 --verbose --allow-unconfigured --bind lan &
fi

GATEWAY_PID=$!
echo "Gateway started with PID $GATEWAY_PID"

# Wait for the gateway process. When it exits (crash or shutdown), the
# EXIT trap will clean up the lockfile so a new start can proceed.
wait $GATEWAY_PID
EXIT_CODE=$?
echo "Gateway exited with code $EXIT_CODE"
exit $EXIT_CODE
