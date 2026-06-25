-- Add auth_provider column to track how a user last authenticated
-- Values: 'local', 'saml', 'oidc'
ALTER TABLE users ADD COLUMN auth_provider TEXT NOT NULL DEFAULT 'local';
