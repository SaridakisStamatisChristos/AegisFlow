# Verification evidence

The repository's deterministic suite exercises the current AegisFlow runtime through real public/runtime boundaries rather than mocked state transitions alone.

## Executed semantic coverage

- flagship Incident Response Flow contract validation and materialization;
- deterministic Stage execution through API, queue authority, durable state, and SDK inspection;
- deterministic Agent reasoning with provider Effect evidence;
- durable human Gate approval and duplicate-decision handling;
- connector Effect duplicate suppression;
- lease timeout followed by a new retry Attempt;
- actual child-process worker crash and recovery;
- stale-generation fencing;
- durable Signal resume and duplicate delivery idempotency;
- ambiguous external Effect quarantine and explicit reconciliation.

## Evidence principles

- Scenario timing is observational and is not used as a superiority claim.
- Worker-crash verification uses a real child process on Linux CI.
- Existing unit, integration, migration, package-boundary, secret-scan, and dependency-audit gates run alongside the deterministic scenarios.
- Artifact and dependency manifests detect unreviewed verification-surface drift.
- Historical milestone-specific evidence remains available in Git history rather than cluttering the current product tree.

## Current claim boundary

The suite supports claims about deterministic runtime semantics, durable recovery, authority fencing, and evidence integrity within the tested reference configuration. It does not establish production authentication, HA/disaster-recovery readiness, external-service exactly-once behavior, or performance superiority.
