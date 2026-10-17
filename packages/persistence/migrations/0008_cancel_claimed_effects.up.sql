CREATE OR REPLACE FUNCTION aegisflow_quarantine_claimed_effects_on_stage_cancel()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.state <> 'CANCELLED' AND NEW.state = 'CANCELLED' THEN
    UPDATE effects
       SET state = 'RECONCILIATION_REQUIRED',
           resolved_at = clock_timestamp(),
           resolution_code = 'stage_cancelled_while_claimed',
           updated_at = clock_timestamp()
     WHERE stage_execution_id = NEW.id
       AND state = 'CLAIMED';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stage_executions_quarantine_claimed_effects_on_cancel ON stage_executions;
CREATE TRIGGER stage_executions_quarantine_claimed_effects_on_cancel
AFTER UPDATE OF state ON stage_executions
FOR EACH ROW
EXECUTE FUNCTION aegisflow_quarantine_claimed_effects_on_stage_cancel();
