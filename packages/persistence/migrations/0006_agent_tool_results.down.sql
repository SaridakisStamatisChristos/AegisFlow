DROP TRIGGER IF EXISTS agent_tool_results_immutable ON agent_tool_results;
DROP FUNCTION IF EXISTS aegisflow_reject_agent_tool_result_mutation();
DROP TRIGGER IF EXISTS agent_tool_results_validate_effect ON agent_tool_results;
DROP FUNCTION IF EXISTS aegisflow_validate_agent_tool_result();
DROP TABLE IF EXISTS agent_tool_results;
