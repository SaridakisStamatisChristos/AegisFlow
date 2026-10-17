CREATE TABLE agent_tool_results (
  effect_id text PRIMARY KEY,
  stage_execution_id text NOT NULL,
  provider_step integer NOT NULL CHECK (provider_step BETWEEN 1 AND 32),
  call_id text NOT NULL CHECK (
    char_length(call_id) BETWEEN 1 AND 128
    AND call_id = btrim(call_id)
    AND call_id !~ '[[:cntrl:]]'
  ),
  tool_name text NOT NULL CHECK (
    char_length(tool_name) BETWEEN 1 AND 128
    AND tool_name ~ '^[A-Za-z][A-Za-z0-9._:/-]{0,127}$'
  ),
  output jsonb NOT NULL,
  external_reference text CHECK (
    external_reference IS NULL
    OR (
      char_length(external_reference) BETWEEN 1 AND 512
      AND external_reference = btrim(external_reference)
      AND external_reference !~ '[[:cntrl:]]'
    )
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT agent_tool_results_stage_step_call_unique
    UNIQUE (stage_execution_id, provider_step, call_id)
);

CREATE FUNCTION aegisflow_validate_agent_tool_result()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  stored_stage_execution_id text;
  stored_state text;
BEGIN
  SELECT stage_execution_id, state
    INTO stored_stage_execution_id, stored_state
    FROM effects
   WHERE id = NEW.effect_id
   FOR KEY SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'agent tool result references missing Effect';
  END IF;

  IF stored_stage_execution_id <> NEW.stage_execution_id THEN
    RAISE EXCEPTION 'agent tool result StageExecution does not own Effect';
  END IF;

  IF stored_state <> 'CLAIMED' THEN
    RAISE EXCEPTION 'agent tool result requires a CLAIMED Effect';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_tool_results_validate_effect
BEFORE INSERT ON agent_tool_results
FOR EACH ROW EXECUTE FUNCTION aegisflow_validate_agent_tool_result();

CREATE FUNCTION aegisflow_reject_agent_tool_result_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'agent_tool_results are immutable';
END;
$$;

CREATE TRIGGER agent_tool_results_immutable
BEFORE UPDATE OR DELETE ON agent_tool_results
FOR EACH ROW EXECUTE FUNCTION aegisflow_reject_agent_tool_result_mutation();
