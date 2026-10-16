# Agent collaboration seam contract updates

These contract changes are published with project version `0.1.0`. They do not introduce a database migration or alter persisted user data. Deploy the matching runtime and plugin implementation together. On rollback, revert consumers and implementations together with the seam API; no data rollback is required.

## Changes and evidence

- `space-agent`: removes the deprecated `modelRef` descriptor field in favor of administrator-managed `llmProfileRef`. Existing legacy database data is not an active model override; catalog writes discard stale overrides. `scripts/verify-agent-catalog.ts` covers this behavior.
- `space-agent-catalog`: the coding template advertises the controlled `tool.workspace.publish` capability. Migration 0039 grants it to the seeded coder; team-authored definitions remain unchanged. `scripts/verify-agent-bootstrap.ts` and `scripts/verify-agent-teamspace.ts` cover template and bootstrap configuration.
- `space-agent-inbox`: exposes background ingestion progress and removes the obsolete `onboarding-history` processing phase. `scripts/verify-agent-inbox.ts` checks visible processing phases and durable cursor behavior.
- `space-context`: adds optional stable and dynamic context sections, cache-block history mode, and per-Agent tool filtering. The legacy context shape and default history slicing remain available. `scripts/verify-context-cache.ts` and `scripts/verify-p8.ts` cover the new assembly behavior.
- `space-orchestrator`: clarifies explicit Agent mention routing and extends result receipts with citations and model interaction traces. `scripts/verify-orchestrator.ts` and `scripts/verify-agent-teamspace.ts` cover orchestration and delivered receipts.
- `space-workdir`: adds typed transfer targets and bounded file transfer operations for private and shared workspaces. Existing browse/read operations remain. `scripts/verify-agent-explorer.ts` and `scripts/verify-sandbox-tools.ts` cover shared/private boundaries and file operations.

The compatibility gate checks that each current seam digest is tied to this review and its focused verification. Changes to any of these contracts require a new compatibility review.
