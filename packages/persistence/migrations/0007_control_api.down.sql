DROP TRIGGER IF EXISTS signals_immutable ON signals;
DROP TRIGGER IF EXISTS signals_execution_integrity ON signals;
DROP FUNCTION IF EXISTS aegisflow_reject_signal_mutation();
DROP FUNCTION IF EXISTS aegisflow_validate_signal_execution();
DROP TABLE IF EXISTS signals;
DROP TABLE IF EXISTS api_idempotency;
