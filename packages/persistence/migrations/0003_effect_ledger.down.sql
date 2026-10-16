DROP TRIGGER IF EXISTS effect_reconciliations_immutable ON effect_reconciliations;
DROP FUNCTION IF EXISTS aegisflow_reject_effect_reconciliation_mutation();
DROP TABLE IF EXISTS effect_reconciliations;
DROP TABLE IF EXISTS effects;
ALTER TABLE stage_executions
  DROP CONSTRAINT IF EXISTS stage_executions_id_execution_unique;
