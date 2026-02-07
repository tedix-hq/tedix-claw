# Product Requirements Doc (PRD)

## Summary

`tedix-claw` runs OpenClaw inside a Cloudflare Sandbox container, orchestrated by a Cloudflare Worker. The Worker is intentionally thin: it proxies HTTP/WebSocket traffic to the gateway, exposes admin APIs, and manages container lifecycle. Durable state primarily lives inside the container filesystem, with optional persistence via R2 backup/restore.

## Goals

- Run a multi-agent, MCP-native assistant runtime (OpenClaw) in an isolated, sandboxed container at the edge.
- Preserve OpenClaw state across container restarts with minimal moving parts.
- Keep the Worker stateless by default, so scaling/operation stays simple.

## Non-Goals

- Replacing OpenClaw’s internal persistence model (it is file-based and owned by OpenClaw).
- Building a multi-tenant SaaS control plane yet (tenant routing, billing, analytics, policy).

## Governance Control Plane Strategy (Per-Gateway First)

Given the current direction (multiple gateways, each disposable), the next step is a **config-driven governance control plane per gateway**, not a multi-tenant SaaS dashboard.

Rationale:

- Matches the “cattle” model: gateways can be destroyed/recreated; durable state lives in R2 + Git.
- Avoids duplicating OpenClaw’s runtime UI (agents/skills/cron/tools/memory). The Worker admin UI should focus on governance, not re-implementing the assistant UI.
- Keeps blast radius small: governance mistakes affect one gateway, not the entire fleet.
- Ships faster: you can get a safe self-improvement loop working without building orgs/billing/provisioning.

### What “Config-Driven Governance” Covers

The Worker-owned governance config should define policy and safety constraints for that gateway:

1. Operators and access:
   - Who can administer this gateway (you/cofounder).
   - Where approvals are delivered (e.g., forward exec approvals to a Telegram DM).
2. Tool policy and sandboxing baselines:
   - Global allow/deny profiles per gateway (personal vs company).
   - Per-agent and per-channel overrides (company agents should be more restrictive than personal).
3. Self-modification rules:
   - What changes require PR review vs what can be applied automatically.
   - Rollback strategy (last-known-good configs/skills).
4. Budgets and caps:
   - Daily token/cost budget, max iterations per task, max cron/heartbeat frequency, browser rendering limits.
5. Persistence source-of-truth:
   - Which state is OpenClaw-owned (filesystem) vs Worker-owned (governance).
   - How Git-backed “skill packs” and workspaces are promoted (PR-first), with R2 as runtime cache/backup.

## When A Multi-Tenant SaaS Dashboard Makes Sense

Build a multi-tenant SaaS dashboard when you have **deployments you don’t personally operate** and need centralized fleet control:

- Orgs/members/roles, invitation flows, SSO.
- Centralized audit/metering and billing across gateways.
- Provisioning: create/destroy gateways, rotate secrets, enforce policy baselines.
- Aggregated observability and reporting across many gateways.

Until those are true, a SaaS dashboard adds surface area and creates a second “assistant UI” to maintain.

## Pragmatic Evolution Path

1. Per-gateway governance config + admin UI (now).
2. Optional “central index” service (later):
   - Minimal registry of gateways (owner/org, health, pointers to R2/Git), without re-implementing OpenClaw UI.
3. Full multi-tenant SaaS control plane (only when justified by team size/customer need).

## Architecture (State Ownership)

Current (single-tenant / personal deployment):

- Worker: routing, auth (Cloudflare Access), request proxying, admin APIs, cron-triggered backups.
- Container filesystem: OpenClaw config, paired devices, conversations, workspace, skills.
- R2: backup/restore safety net for the container filesystem (`/data/openclaw` mount + periodic `rsync`).

## When A Database Makes Sense

Add a Worker-owned database when the Worker needs durable state that must survive container lifecycle events and be queryable/authoritative independently of OpenClaw.

Concrete triggers:

1. Multi-tenancy: tenants/users/orgs, per-tenant settings, access control, mapping tenant → sandbox/container identity.
2. Audit and usage tracking: structured logs for “who did what, when” at the proxy layer (requests, latency, tokens/cost).
3. Worker-side sessions and policy: allowlists/revocations, token rotation, rate limits that must apply even if the container is cold, sleeping, or replaced.
4. Billing and metering: quotas, entitlements, usage-based enforcement, chargeback reporting.

## DO SQLite vs D1 (Recommended Path)

This project already uses a Durable Object (`Sandbox`) and Wrangler enables SQLite for it (`new_sqlite_classes`). That gives two storage options before introducing a separate database product.

- DO SQLite (inside the `Sandbox` Durable Object):
  - Best for: low-footprint Worker-owned state tightly coupled to the sandbox instance, quick wins like audit/event logs, last-seen timestamps, simple policy caches.
  - Tradeoff: scoped to the DO instance; not ideal for cross-tenant analytics or global querying.

- D1 (SQLite as a managed database service):
  - Best for: multi-tenant control plane data, global querying/reporting, joins across users/orgs, operational dashboards, billing/metering queries.
  - Tradeoff: adds a second durable system and schema/migration surface area; avoid until you have a clear Worker-owned state model.

Role split to keep clean:

- Worker + DO SQLite / D1: identity, tenancy, policy, audit, metering.
- Container filesystem + R2: OpenClaw-owned state (config, conversations, workspace, skills).
