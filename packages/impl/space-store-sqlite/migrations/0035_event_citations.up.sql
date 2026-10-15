-- Verified answer sources are event metadata, separate from the Markdown body.
ALTER TABLE events ADD COLUMN citations TEXT NOT NULL DEFAULT '[]';
