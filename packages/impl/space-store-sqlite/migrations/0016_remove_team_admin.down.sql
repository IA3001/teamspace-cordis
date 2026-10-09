-- Reintroduces a dormant compatibility column; it is not an authentication source.
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
