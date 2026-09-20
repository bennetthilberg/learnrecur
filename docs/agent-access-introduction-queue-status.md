# Agent access and introduction queue follow-up

Date: 2026-09-19

Branch: `a/import-introduction-queue-mcp`

## Delivered in this branch

- Persisted, versioned introduction queues scoped to each collection and to
  uncollected skills.
- Deterministic queue order in normal practice, read-only dashboard/preload
  previews, and custom sessions. Due introduced reviews remain ahead of new
  introductions by default.
- Queue read and reorder MCP tools with bounded pagination, stale-version
  rejection, ownership checks, consented `practice:read`/`practice:write`, and
  connection-scoped idempotency.
- Skills-page controls for moving queued skills up or down without spending an
  allowance or changing FSRS history.
- Queue records in the study-data export and a migration readiness fence.
- Safe Settings messaging for WorkOS completion failures and the standard
  authorization-server metadata proxy. The proxy forwards WorkOS metadata
  unchanged so WorkOS remains the source of truth.

## Live verification boundary

The repository-side checks pass, but the real alpha connection cannot be
completed from this checkout without changing external WorkOS state or
resolving an account mapping owned by the operator.

Observed on `https://alpha.learnrecur.com`:

- The signed-in learner returned to Settings with `agentConnection=failed` and
  had no active agent connections.
- Production completion logs for deployment
  `dpl_5Pe4VuMvBP6dm9QAmJK7in7Kj8yD` reported a WorkOS standalone
  `identity_conflict`. No mapping was changed by this branch.
- Protected-resource metadata advertises LearnRecur's application scopes, while
  the configured WorkOS authorization-server discovery response advertises only
  the standard OIDC scopes. The earlier explicit MCP authorization attempt
  therefore returned `invalid_scope`.

Do not merge identities by email, disable ownership checks, or delete mappings
to make the connection pass. Resolve the exact WorkOS user and existing
LearnRecur mapping first, then repair only an established one-to-one mapping.

Before the live acceptance run, the operator must verify in the WorkOS
environment that the exact `https://alpha.learnrecur.com/mcp` resource indicator
is configured, the appropriate default resource is set for clients that omit
`resource`, CIMD is enabled, and the MCP application permissions are accepted by
the authorization server. Then reconnect and verify both initial and refreshed
tokens carry the requested scopes and exact resource audience. WorkOS documents
the resource-indicator, CIMD, metadata, and Standalone Connect requirements in
its [MCP guide](https://workos.com/docs/authkit/mcp) and
[Standalone Connect guide](https://workos.com/docs/authkit/connect/standalone).

## Verification

Passing local checks: `npm run check:runtime-audit`, `npm run lint`,
`npx tsc --noEmit`, `npm run test:unit` (1,230 tests), focused queue/MCP/OAuth
tests, `npm run prisma:validate`, `npm run prisma:generate`, `npm run build`,
and `npm run test:e2e` (15 anonymous browser tests).

`npm run test:db` could not run against the configured local Neon branch because
the branch is read-only and still has the three pending migrations. CI uses its
own writable PostgreSQL service and applies migrations before its integration
and authenticated browser suites.
