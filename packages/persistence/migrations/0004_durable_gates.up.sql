CREATE TABLE gates (
  id text PRIMARY KEY,
  execution_id text NOT NULL REFERENCES executions(id) ON DELETE RESTRICT,
  stage_execution_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('WAITING', 'APPROVED', 'REJECTED', 'EXPIRED')),
  expires_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT gates_stage_unique UNIQUE (stage_execution_id),
  CONSTRAINT gates_id_execution_unique UNIQUE (id, execution_id),
  CONSTRAINT gates_stage_execution_fk
    FOREIGN KEY (stage_execution_id, execution_id)
    REFERENCES stage_executions(id, execution_id)
    ON DELETE RESTRICT,
  CONSTRAINT gates_state_timestamp_consistency CHECK (
    (state = 'WAITING' AND resolved_at IS NULL)
    OR (state IN ('APPROVED', 'REJECTED', 'EXPIRED') AND resolved_at IS NOT NULL)
  )
);

CREATE INDEX gates_waiting_expiry_idx
  ON gates (expires_at, id)
  WHERE state = 'WAITING' AND expires_at IS NOT NULL;

CREATE TABLE gate_protections (
  gate_id text NOT NULL,
  execution_id text NOT NULL,
  protected_stage_execution_id text NOT NULL,
  PRIMARY KEY (gate_id, protected_stage_execution_id),
  CONSTRAINT gate_protections_gate_execution_fk
    FOREIGN KEY (gate_id, execution_id)
    REFERENCES gates(id, execution_id)
    ON DELETE RESTRICT,
  CONSTRAINT gate_protections_stage_execution_fk
    FOREIGN KEY (protected_stage_execution_id, execution_id)
    REFERENCES stage_executions(id, execution_id)
    ON DELETE RESTRICT
);

CREATE INDEX gate_protections_stage_idx
  ON gate_protections (protected_stage_execution_id, gate_id);

CREATE TABLE gate_resolutions (
  gate_id text PRIMARY KEY REFERENCES gates(id) ON DELETE RESTRICT,
  outcome text NOT NULL CHECK (outcome IN ('APPROVED', 'REJECTED', 'EXPIRED')),
  actor_id text CHECK (
    actor_id IS NULL
    OR (
      char_length(actor_id) BETWEEN 1 AND 128
      AND actor_id = btrim(actor_id)
      AND actor_id !~ E'[\\n\\r\\x00]'
    )
  ),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  resolved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT gate_resolutions_actor_consistency CHECK (
    (outcome = 'EXPIRED' AND actor_id IS NULL)
    OR (outcome IN ('APPROVED', 'REJECTED') AND actor_id IS NOT NULL)
  )
);

CREATE FUNCTION aegisflow_reject_gate_resolution_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'gate_resolutions are immutable';
END;
$$;

CREATE TRIGGER gate_resolutions_immutable
BEFORE UPDATE OR DELETE ON gate_resolutions
FOR EACH ROW EXECUTE FUNCTION aegisflow_reject_gate_resolution_mutation();

CREATE FUNCTION aegisflow_enforce_gate_protection()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.state = 'ACTIVE' AND EXISTS (
    SELECT 1
    FROM gate_protections gp
    JOIN gates g ON g.id = gp.gate_id
    WHERE gp.protected_stage_execution_id = NEW.stage_execution_id
      AND g.state <> 'APPROVED'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'StageExecution is blocked by unresolved Gate authority';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER claims_gate_protection
BEFORE INSERT OR UPDATE OF state, stage_execution_id ON claims
FOR EACH ROW EXECUTE FUNCTION aegisflow_enforce_gate_protection();
