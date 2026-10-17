CREATE UNIQUE INDEX flows_name_unique
  ON flows (name);

CREATE TABLE api_idempotency (
  scope text NOT NULL CHECK (char_length(scope) BETWEEN 1 AND 128),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  resource_id text NOT NULL CHECK (char_length(resource_id) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (scope, idempotency_key)
);

CREATE TABLE signals (
  id text PRIMARY KEY,
  execution_id text NOT NULL,
  signal_name text NOT NULL CHECK (char_length(signal_name) BETWEEN 1 AND 128),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT signals_delivery_unique UNIQUE (execution_id, signal_name, idempotency_key)
);

CREATE INDEX signals_execution_created_idx
  ON signals (execution_id, created_at, id);

CREATE FUNCTION aegisflow_validate_signal_execution()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM executions WHERE id = NEW.execution_id) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'Signal execution does not exist';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER signals_execution_integrity
BEFORE INSERT ON signals
FOR EACH ROW EXECUTE FUNCTION aegisflow_validate_signal_execution();

CREATE FUNCTION aegisflow_reject_signal_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'signals are immutable';
END;
$$;

CREATE TRIGGER signals_immutable
BEFORE UPDATE OR DELETE ON signals
FOR EACH ROW EXECUTE FUNCTION aegisflow_reject_signal_mutation();
