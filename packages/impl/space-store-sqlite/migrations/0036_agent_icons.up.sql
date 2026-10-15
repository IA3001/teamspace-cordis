-- Persist the selected SVG library icon as presentation metadata on each Agent.
ALTER TABLE agent_definitions ADD COLUMN icon_id TEXT NOT NULL DEFAULT 'UserFilled';
