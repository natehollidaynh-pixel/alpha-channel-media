-- Migration 001: WebAuthn biometric auth + persistent creator access
-- Run this against your Railway PostgreSQL database

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- WebAuthn credentials (passkeys stored per listener per device)
CREATE TABLE IF NOT EXISTS webauthn_credentials (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    listener_id UUID NOT NULL REFERENCES listeners(id) ON DELETE CASCADE,
    credential_id TEXT NOT NULL UNIQUE,
    public_key TEXT NOT NULL,
    counter BIGINT NOT NULL DEFAULT 0,
    device_type VARCHAR(50),
    backed_up BOOLEAN DEFAULT false,
    transports TEXT[],
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webauthn_listener_id ON webauthn_credentials(listener_id);
CREATE INDEX IF NOT EXISTS idx_webauthn_credential_id ON webauthn_credentials(credential_id);

-- Persistent creator access (which creators a listener has unlocked)
CREATE TABLE IF NOT EXISTS listener_creator_access (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    listener_id UUID NOT NULL REFERENCES listeners(id) ON DELETE CASCADE,
    creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    granted_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(listener_id, creator_id)
);
CREATE INDEX IF NOT EXISTS idx_lca_listener_id ON listener_creator_access(listener_id);
CREATE INDEX IF NOT EXISTS idx_lca_creator_id ON listener_creator_access(creator_id);

-- Temporary WebAuthn challenges (short-lived, cleaned up periodically)
CREATE TABLE IF NOT EXISTS webauthn_challenges (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    listener_id UUID REFERENCES listeners(id) ON DELETE CASCADE,
    challenge TEXT NOT NULL,
    type VARCHAR(20) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_challenges_listener_id ON webauthn_challenges(listener_id);
