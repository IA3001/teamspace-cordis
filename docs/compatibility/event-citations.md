# Chat citation metadata compatibility

## Change

Agent replies now store verified references in `events.citations` and expose them as event metadata. The Markdown answer body no longer includes a generated `参考来源` section. Older stored replies remain readable: the chat UI lifts their legacy Markdown source list into the same system citation module. The former `formatCitedAnswer(answer, hits)` export remains as a deprecated compatibility wrapper and now returns only the clean body; callers that need references should migrate to `extractCitedAnswer`.

## Upgrade

The oldest supported database fixture is schema version 34. Migration `0035_event_citations` adds a non-null JSON text column with the default `[]`; existing event bodies and all other event fields remain untouched. New application code reads an empty list for legacy rows and writes citations as structured metadata. Older clients can ignore the additional event property.

## Rollback

Migration `0035_event_citations.down.sql` drops only the added column. This removes structured citation metadata written after upgrade, while preserving event text and existing event records. Before rolling back an upgraded application, export any citation metadata that must be retained. Legacy Markdown citations already stored in event text remain readable by older code.

## Verification

- `scripts/verify-upgrade-fixtures.ts` upgrades a version 31 database through version 35, checks the default citation list, and exercises rollback/reapply while verifying the event body survives.
- `scripts/verify-rag.ts` verifies that only evidence-backed markers become structured citations and that event persistence returns them separately from Markdown text.
- `scripts/verify-agent-teamspace.ts` verifies citation transport through the Agent dispatcher and conversion of legacy Markdown citations for display.
