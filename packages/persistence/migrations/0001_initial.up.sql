CREATE TABLE flows (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE flow_versions (
  id text PRIMARY KEY,
  flow_id text NOT NULL REFERENCES flows(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT flow_versions_number_unique UNIQUE (flow_id, version),
  CONSTRAINT flow_versions_identity_pair UNIQUE (id, flow_id)
);

CREATE FUNCTION aegisflow_reject_flow_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'flow_versions are immutable';
END;
$$;

CREATE TRIGGER flow_versions_immutable
BEFORE UPDATE OR DELETE ON flow_versions
FOR EACH ROW EXECUTE FUNCTION aegisflow_reject_flow_version_mutation();

CREATE TABLE executions (
  id text PRIMARY KEY,
  flow_id text NOT NULL,
  flow_version_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('PENDING', 'RUNNING', 'WAITING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT executions_flow_version_fk
    FOREIGN KEY (flow_version_id, flow_id)
    REFERENCES flow_versions(id, flow_id)
    ON DELETE RESTRICT
);

CREATE TABLE stage_executions (
  id text PRIMARY KEY,
  execution_id text NOT NULL REFERENCES executions(id) ON DELETE RESTRICT,
  stage_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('BLOCKED', 'READY', 'RUNNING', 'WAITING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stage_executions_logical_stage_unique UNIQUE (execution_id, stage_id)
);

CREATE TABLE attempts (
  id text PRIMARY KEY,
  stage_execution_id text NOT NULL REFERENCES stage_executions(id) ON DELETE RESTRICT,
  sequence integer NOT NULL CHECK (sequence > 0),
  state text NOT NULL CHECK (state IN ('CLAIMED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attempts_sequence_unique UNIQUE (stage_execution_id, sequence)
);

CREATE TABLE execution_events (
  position bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id text NOT NULL UNIQUE,
  execution_id text NOT NULL REFERENCES executions(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 128),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX execution_events_execution_position_idx
  ON execution_events (execution_id, position);
