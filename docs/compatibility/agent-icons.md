# Agent icon metadata compatibility

## Change

Migration `0036_agent_icons` adds the non-null `icon_id` presentation field to `agent_definitions`, defaulting existing rows to `UserFilled`. New or edited Agent definitions may persist an SVG library icon ID. Agent records and their existing settings remain intact.

## Upgrade and rollback

Upgrade from schema version 35 by applying migration 0036. Rollback applies its down migration, which removes only `icon_id`; icon selections are lost, while Agent definitions and other columns remain. Reapplying the migration gives existing rows the default icon.

## Verification

- `scripts/verify-agent-catalog.ts` applies migration 0036, verifies a custom icon survives catalog create/update, and verifies rollback removes only the added column.
- `scripts/verify-upgrade-fixtures.ts` upgrades a real version 31 fixture through migration 0036 and later migrations.
