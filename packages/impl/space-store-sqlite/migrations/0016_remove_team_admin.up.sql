-- Admin privileges now use admin_accounts/admin_sessions and never Team users.
ALTER TABLE users DROP COLUMN is_admin;
