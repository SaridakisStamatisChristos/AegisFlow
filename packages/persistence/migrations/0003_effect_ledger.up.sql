ALTER TABLE stage_executions
  ADD CONSTRAINT stage_executions_id_execution_unique UNIQUE (id, execution_id);

CREATE TABLE effects (
  id text PRIMARY KEY,
  execution_id text NOT NULL REFERENCES executions(id) ON DELETE RESTRICT,
  stage_execution_id text NOT NULL,
  effect_key text NOT NULL CHECK (
    char_length(effect_key) BETWEEN 1 AND 256
    AND effect_key = btrim(effect_key)
  ),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (
    state IN ('PLANNED', 'CLAIMED', 'SUCCEEDED', 'FAILED', 'RECONCILIATION_REQUIRED')
  ),
  claimed_at timestamptz,
  resolved_at timestamptz,
  resolution_code text CHECK (
    resolution_code IS NULL
    OR (char_length(resolution_code) BETWEEN 1 AND 128 AND resolution_code = btrim(resolution_code))
  ),
  external_reference text CHECK (
    external_reference IS NULL
    OR (char_length(external_reference) BETWEEN 1 AND 512 AND external_reference = btrim(external_reference))
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT effects_execution_key_unique UNIQUE (execution_id, effect_key),
  CONSTRAINT effects_stage_execution_fk
    FOREIGN KEY (stage_execution_id, execution_id)
    REFERENCES stage_executions(id, execution_id)
    ON DELETE RESTRICT,
  CONSTRAINT effects_state_timestamp_consistency CHECK (
    (state = 'PLANNED' AND claimed_at IS NULL AND resolved_at IS NULL AND resolution_code IS NULL)
    OR
    (state = 'CLAIMED' AND claimed_at IS NOT NULL AND resolved_at IS NULL AND resolution_code IS NULL)
    OR
    (state IN ('SUCCEEDED', 'FAILED', 'RECONCILIATION_REQUIRED')
      AND claimed_at IS NOT NULL AND resolved_at IS NOT NULL AND resolution_code IS NOT NULL)
  )
);

CREATE INDEX effects_stage_idx ON effects (stage_execution_id);
CREATE INDEX effects_state_idx ON effects (state);

CREATE TABLE effect_reconciliations (
  effect_id text PRIMARY KEY REFERENCES effects(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN ('CONFIRMED_SUCCEEDED', 'CONFIRMED_FAILED')),
  reconciled_by text NOT NULL CHECK (
    char_length(reconciled_by) BETWEEN 1 AND 128
    AND reconciled_by = btrim(reconciled_by)
  ),
  external_reference text CHECK (
    external_reference IS NULL
    OR (char_length(external_reference) BETWEEN 1 AND 512 AND external_reference = btrim(external_reference))
  ),
  reconciled_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION aegisflow_reject_effect_reconciliation_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'effect_reconciliations are immutable';
END;
$$;

CREATE TRIGGER effect_reconciliations_immutable
BEFORE UPDATE OR DELETE ON effect_reconciliations
FOR EACH ROW EXECUTE FUNCTION aegisflow_reject_effect_reconciliation_mutation();
