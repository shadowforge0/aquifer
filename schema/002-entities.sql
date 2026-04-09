-- Aquifer entity / knowledge graph extension
-- Requires: 001-base.sql applied first
-- Usage: replace ${schema} with actual schema name

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- =========================================================================
-- Entities: unique named concepts
-- =========================================================================
CREATE TABLE IF NOT EXISTS ${schema}.entities (
  id              BIGSERIAL    PRIMARY KEY,
  tenant_id       TEXT         NOT NULL DEFAULT 'default',
  name            TEXT         NOT NULL,
  normalized_name TEXT         NOT NULL,
  aliases         TEXT[]       NOT NULL DEFAULT '{}',
  type            TEXT         NOT NULL DEFAULT 'other'
                    CHECK (type IN ('person','project','concept','tool','metric','org',
                                    'place','event','doc','task','topic','other')),
  status          TEXT         NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','merged','deleted')),
  frequency       INT          NOT NULL DEFAULT 1,
  agent_id        TEXT         NOT NULL DEFAULT 'main',
  created_by      TEXT,
  metadata        JSONB        NOT NULL DEFAULT '{}',
  embedding       vector,
  first_seen_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, normalized_name, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_entities_tenant_agent
  ON ${schema}.entities (tenant_id, agent_id);

CREATE INDEX IF NOT EXISTS idx_entities_type
  ON ${schema}.entities (type);

CREATE INDEX IF NOT EXISTS idx_entities_last_seen
  ON ${schema}.entities (last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_entities_name_trgm
  ON ${schema}.entities USING GIN (normalized_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_entities_aliases
  ON ${schema}.entities USING GIN (aliases);

CREATE INDEX IF NOT EXISTS idx_entities_active
  ON ${schema}.entities (tenant_id, agent_id, frequency DESC)
  WHERE status = 'active';

-- =========================================================================
-- Entity mentions: links entity to session (deduped per session)
-- =========================================================================
CREATE TABLE IF NOT EXISTS ${schema}.entity_mentions (
  id                BIGSERIAL    PRIMARY KEY,
  entity_id         BIGINT       NOT NULL REFERENCES ${schema}.entities(id) ON DELETE CASCADE,
  session_row_id    BIGINT       NOT NULL REFERENCES ${schema}.sessions(id) ON DELETE CASCADE,
  turn_embedding_id BIGINT       REFERENCES ${schema}.turn_embeddings(id) ON DELETE SET NULL,
  source            TEXT,
  mention_text      TEXT,
  confidence        FLOAT        NOT NULL DEFAULT 1.0,
  occurred_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_entity_mentions_entity_id
  ON ${schema}.entity_mentions (entity_id);

CREATE INDEX IF NOT EXISTS idx_entity_mentions_session_row_id
  ON ${schema}.entity_mentions (session_row_id);

CREATE INDEX IF NOT EXISTS idx_entity_mentions_turn_embedding_id
  ON ${schema}.entity_mentions (turn_embedding_id)
  WHERE turn_embedding_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_mentions_dedup
  ON ${schema}.entity_mentions (entity_id, session_row_id);

-- =========================================================================
-- Entity relations: undirected co-occurrence (src < dst enforced)
-- =========================================================================
CREATE TABLE IF NOT EXISTS ${schema}.entity_relations (
  id                   BIGSERIAL    PRIMARY KEY,
  src_entity_id        BIGINT       NOT NULL REFERENCES ${schema}.entities(id) ON DELETE CASCADE,
  dst_entity_id        BIGINT       NOT NULL REFERENCES ${schema}.entities(id) ON DELETE CASCADE,
  co_occurrence_count  INT          NOT NULL DEFAULT 1,
  first_seen_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_seen_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CHECK (src_entity_id < dst_entity_id),
  UNIQUE (src_entity_id, dst_entity_id)
);

CREATE INDEX IF NOT EXISTS idx_entity_relations_src
  ON ${schema}.entity_relations (src_entity_id);

CREATE INDEX IF NOT EXISTS idx_entity_relations_dst
  ON ${schema}.entity_relations (dst_entity_id);

CREATE INDEX IF NOT EXISTS idx_entity_relations_cooccurrence
  ON ${schema}.entity_relations (co_occurrence_count DESC);

-- =========================================================================
-- Entity sessions: which entities appeared in which sessions (for boost scoring)
-- =========================================================================
CREATE TABLE IF NOT EXISTS ${schema}.entity_sessions (
  id             BIGSERIAL    PRIMARY KEY,
  entity_id      BIGINT       NOT NULL REFERENCES ${schema}.entities(id) ON DELETE CASCADE,
  session_row_id BIGINT       NOT NULL REFERENCES ${schema}.sessions(id) ON DELETE CASCADE,
  mention_count  INT          NOT NULL DEFAULT 1,
  occurred_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (entity_id, session_row_id)
);

CREATE INDEX IF NOT EXISTS idx_entity_sessions_entity_id
  ON ${schema}.entity_sessions (entity_id);

CREATE INDEX IF NOT EXISTS idx_entity_sessions_session_row_id
  ON ${schema}.entity_sessions (session_row_id);

CREATE INDEX IF NOT EXISTS idx_entity_sessions_frequent
  ON ${schema}.entity_sessions (session_row_id, entity_id)
  WHERE mention_count >= 2;
