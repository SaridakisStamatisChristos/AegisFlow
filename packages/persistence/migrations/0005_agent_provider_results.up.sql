CREATE TABLE agent_provider_results (
  effect_id text PRIMARY KEY,
  stage_execution_id text NOT NULL,
  step integer NOT NULL CHECK (step BETWEEN 1 AND 32),
  provider text NOT NULL CHECK (
    char_length(provider) BETWEEN 1 AND 128
    AND provider ~ '^[A-Za-z][A-Za-z0-9._:/-]{0,127}$'
  ),
  response jsonb NOT NULL CHECK (jsonb_typeof(response) = 'object'),
  provider_reference text CHECK (
    provider_reference IS NULL
    OR (
      char_length(provider_reference) BETWEEN 1 AND 512
      AND provider_reference = btrim(provider_reference)
      AND provider_reference !~ '[[:cntrl:]]'
    )
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT agent_provider_results_stage_step_unique UNIQUE (stage_execution_id, step)
);

CREATE FUNCTION aegisflow_validate_agent_provider_result()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  stored_stage_execution_id text;
BEGIN
  SELECT stage_execution_id
    INTO stored_stage_execution_id
    FROM effects
   WHERE id = NEW.effect_id
   FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'agent provider result references missing Effect';
  END IF;

  IF stored_stage_execution_id <> NEW.stage_execution_id THEN
    RAISE EXCEPTION 'agent provider result StageExecution does not own Effect';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_provider_results_validate_effect
BEFORE INSERT ON agent_provider_results
FOR EACH ROW EXECUTE FUNCTION aegisflow_validate_agent_provider_result();

CREATE FUNCTION aegisflow_reject_agent_provider_result_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'agent_provider_results are immutable';
END;
$$;

CREATE TRIGGER agent_provider_results_immutable
BEFORE UPDATE OR DELETE ON agent_provider_results
FOR EACH ROW EXECUTE FUNCTION aegisflow_reject_agent_provider_result_mutation();
