DROP TRIGGER IF EXISTS agent_provider_results_immutable ON agent_provider_results;
DROP TRIGGER IF EXISTS agent_provider_results_validate_effect ON agent_provider_results;
DROP FUNCTION IF EXISTS aegisflow_reject_agent_provider_result_mutation();
DROP FUNCTION IF EXISTS aegisflow_validate_agent_provider_result();
DROP TABLE IF EXISTS agent_provider_results;
