-- vault.db schema. All BLOB columns store binary buffers directly.

CREATE TABLE IF NOT EXISTS vault_meta (
    key   TEXT PRIMARY KEY,
    value BLOB NOT NULL
);
-- Rows: 'salt' (kdf salt), 'wrapped_dek' (Sealed-encoded DEK), 'verifier' (Sealed of a known plaintext)

CREATE TABLE IF NOT EXISTS vault_secrets (
    name       TEXT PRIMARY KEY,
    nonce      BLOB NOT NULL,
    tag        BLOB NOT NULL,
    ciphertext BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vault_rules (
    id            TEXT PRIMARY KEY,
    host_pattern  TEXT NOT NULL,
    placeholder   TEXT NOT NULL,
    secret_name   TEXT NOT NULL,
    inject_into   TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    FOREIGN KEY (secret_name) REFERENCES vault_secrets(name) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_vault_rules_host ON vault_rules(host_pattern);

CREATE TABLE IF NOT EXISTS vault_tokens (
    token_hash  TEXT PRIMARY KEY,
    label       TEXT NOT NULL,
    scope       TEXT NOT NULL,
    expires_at  INTEGER,
    revoked     INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vault_tokens_label ON vault_tokens(label);

CREATE TABLE IF NOT EXISTS vault_audit (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts_ms        INTEGER NOT NULL,
    actor_token  TEXT NOT NULL,
    action       TEXT NOT NULL,
    resource     TEXT,
    outcome      TEXT NOT NULL,
    metadata     TEXT,
    chain_hmac   BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vault_audit_ts ON vault_audit(ts_ms);
