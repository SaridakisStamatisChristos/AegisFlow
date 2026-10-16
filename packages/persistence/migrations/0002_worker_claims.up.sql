CREATE TABLE claims (
  attempt_id text PRIMARY KEY REFERENCES attempts(id) ON DELETE RESTRICT,
  stage_execution_id text NOT NULL REFERENCES stage_executions(id) ON DELETE RESTRICT,
  owner_id text NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 128),
  generation bigint NOT NULL CHECK (generation > 0),
  state text NOT NULL CHECK (state IN ('ACTIVE', 'COMPLETED', 'EXPIRED')),
  lease_expires_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  CONSTRAINT claims_stage_generation_unique UNIQUE (stage_execution_id, generation),
  CONSTRAINT claims_finished_consistency CHECK (
    (state = 'ACTIVE' AND finished_at IS NULL)
    OR (state IN ('COMPLETED', 'EXPIRED') AND finished_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX claims_one_active_per_stage_idx
  ON claims (stage_execution_id)
  WHERE state = 'ACTIVE';

CREATE INDEX claims_active_expiry_idx
  ON claims (lease_expires_at)
  WHERE state = 'ACTIVE';
