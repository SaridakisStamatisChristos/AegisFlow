DROP TRIGGER IF EXISTS claims_gate_protection ON claims;
DROP FUNCTION IF EXISTS aegisflow_enforce_gate_protection();

DROP TRIGGER IF EXISTS gate_resolutions_immutable ON gate_resolutions;
DROP FUNCTION IF EXISTS aegisflow_reject_gate_resolution_mutation();

DROP TABLE IF EXISTS gate_resolutions;
DROP TABLE IF EXISTS gate_protections;
DROP TABLE IF EXISTS gates;
