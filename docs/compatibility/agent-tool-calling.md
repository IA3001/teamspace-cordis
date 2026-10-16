# Agent structured tool call compatibility

## Change

The `space-llm` chat options accept OpenAI-compatible function definitions for Agent runtime calls. The adapter translates provider `tool_calls` responses into the existing private Agent tool envelope; the execution graph still checks the Agent tool allowlist and dispatches through `ctx.tools.invoke`. DSML text remains a fallback. Workspace read, write, and sandbox execution tools now publish JSON parameter schemas for providers that support structured tools.

## Upgrade

No database, event, or workspace format changes are made. Existing DSML-capable models retain the text fallback. Providers that support OpenAI-compatible function calling receive the Agent's configured tool list and can return structured calls.

## Rollback

Revert the Agent runtime, LLM seam/adapter, and tool-schema changes together, then restart the service. The prior runtime does not send provider tool definitions and continues to use its existing DSML/JSON text parsing behavior. No persisted data needs reverting.

## Verification

- `scripts/verify-llm-stream.ts` simulates streamed provider-native tool-call deltas, checks routing through the Cordis executor, and verifies DSML compatibility.
- The same verifier checks malformed, duplicate, over-limit, and failed calls do not produce a completed Agent answer.
- `scripts/verify-agent-teamspace.ts` covers the Agent execution receipt and workdir flow.
