# Current-session history search tool

The `tool.session.history-search` capability gives Agents a read-only, keyword-searchable view of messages in the session that invoked the tool. It derives scope from the authenticated tool invoker, verifies active membership, and rejects caller-supplied session IDs. Results are paginated and include event ID, author, timestamp, and a bounded matching text excerpt. Voided messages and internal tool traces are excluded.

The coding starter template advances to v3 and includes the tool. Migration 0038 appends the tool ID to the built-in `agent.coder` only when missing; other Agent settings are preserved. Existing custom Agents can enable it in the configurable tool catalog.

Rollback leaves editable Agent catalog values intact, matching the project's compatibility policy. Without the plugin, the retained tool ID is unavailable until the tool-bearing release is restored.

Focused verification: `scripts/verify-session-history-search.ts`, `scripts/verify-agent-teamspace.ts`, and `scripts/verify-agent-bootstrap.ts`.
