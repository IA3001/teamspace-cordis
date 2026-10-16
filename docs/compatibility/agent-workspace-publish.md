# Agent workspace publishing compatibility

## Change

The generic coding Agent can now explicitly publish a complete project directory from its personal `projects/` workspace to the team shared workspace using `tool.workspace.publish`. Publication is bounded to 1 MiB per file, 200 files, and 10 MiB total; symlinks and special files are rejected. A same-filesystem staged directory is renamed into place so readers do not see a partial tree. Existing shared targets are rejected without replacement. Other Agents continue to read published files through `tool.workspace.read` with `scope: "shared"` and cannot read the publisher's private workspace.

## Upgrade

Migration `0039_agent_workspace_publish` appends `tool.workspace.publish` to the seeded `agent.coder` tool list if it is not already present. Other Agent tool assignments and existing files are unchanged. New coding templates include the publish tool; existing custom Agent definitions remain under team configuration control.

## Rollback

Migration `0039_agent_workspace_publish.down.sql` removes only `tool.workspace.publish` from the seeded coder's tool list. Published project files remain in the shared workspace. The publish handler can remain registered but the seeded coder no longer receives permission through its configured tool list.

## Verification

- `scripts/verify-upgrade-fixtures.ts` upgrades the version 31 fixture through migration 0039, verifies the seeded coder capability, rolls it back while preserving the pre-existing write and execution tools, and reapplies it.
- `scripts/verify-sandbox-tools.ts` publishes a multi-file project, reads it as another Agent through shared scope, checks personal isolation, and rejects target conflicts, symlinks, invalid source roots, and oversized files.
- `scripts/verify-agent-bootstrap.ts` and `scripts/verify-agent-teamspace.ts` check seeded and template configuration.
