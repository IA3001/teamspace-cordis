-- Team roles belong to Team identities, not Admin accounts or session membership.
ALTER TABLE users ADD COLUMN team_role TEXT NOT NULL DEFAULT 'member'
  CHECK (team_role IN ('dri','member'));
UPDATE users SET team_role = 'dri' WHERE id = 'u_dri' AND kind = 'human';
