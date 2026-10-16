# Provider abstraction and Agent Stage runtime

PR7 adds a vendor-neutral provider boundary and the first durable Agent Stage execution path.
It deliberately does not add provider-specific SDKs, API keys, connectors, a generic tool executor,
Control API/SDK/CLI, UI, or authentication/RBAC.

## Provider contract

`ModelProvider` exposes a stable provider `id` and one asynchronous `generate()` method. A
`ProviderRegistry` rejects duplicate identities and fails closed when an Agent Stage names an
unregistered provider. Provider responses are normalized into exactly one of two shapes:

- `final`: one JSON-compatible output plus optional provider reference/usage;
- `tool_calls`: one or more bounded tool requests plus optional provider reference/usage.

Malformed responses, duplicate tool-call IDs, non-JSON values, unsafe numeric values, and invalid
symbolic names are rejected deterministically.

## Agent Stage authority chain

The Agent Stage definition is loaded from the Execution's pinned immutable Flow Version. The caller
cannot substitute provider, instruction, tool allow-list, step budget, or output schema.

```text
pinned Flow Version
       |
       v
Agent Stage definition
       |
       v
PR4 worker Claim authority
       |
       v
PR5 Effect plan + claim authority
       |
       v
ModelProvider.generate()
       |
       v
immutable agent_provider_results row
       |
       v
Effect SUCCEEDED
       |
       v
output/tool validation
       |
       v
Stage SUCCEEDED or fail-closed
```

Provider invocation is therefore treated as an external Effect, not as an untracked LLM call.
The stable Effect identity is derived from `StageExecution + provider step`.

## Crash and ambiguity semantics

A normalized provider result is persisted before the Effect is closed as `SUCCEEDED`.
On worker recovery:

- a claimed provider Effect with a matching durable result is closed/reused without calling the
  provider again;
- a claimed provider Effect without a durable result is treated as an unknown external outcome and
  moved to `RECONCILIATION_REQUIRED` rather than blindly replayed;
- if worker authority expires while the provider call is in flight, the provider Effect is
  quarantined as ambiguous;
- known provider failures become terminal failed Effects; unknown transport/provider exceptions
  become reconciliation-required Effects.

These rules do not claim generic exactly-once model execution. They guarantee fail-closed replay
semantics within the declared AegisFlow runtime boundary.

## Durable provider evidence

Migration `0005_agent_provider_results` stores one immutable result per Effect and one result per
`StageExecution + step`. PostgreSQL verifies that the result's StageExecution owns the referenced
Effect, and rejects UPDATE/DELETE of provider-result evidence.

## Output schemas

PR7 implements a deliberately small deterministic JSON-schema-like subset: `type`, `properties`,
`required`, `additionalProperties`, `items`, `enum`, `const`, string/number/array bounds, and
metadata keywords. Unsupported keywords fail closed instead of being silently ignored.

A provider call that succeeds externally but returns output that does not satisfy the pinned schema
remains durable successful external evidence while the Stage itself fails.

## Tool boundary

Provider tool requests are normalized and checked against the Agent Stage's immutable allow-list.
PR7 does not execute tools. Allowed tool requests fail with `TOOL_EXECUTION_UNAVAILABLE`; requests
outside the allow-list fail with `TOOL_NOT_ALLOWED`. Connector/tool execution begins in PR8.

## Current bounded execution model

PR7 executes provider step 1 only. Multi-step provider/tool loops require PR8 connector execution
and are intentionally not simulated in this slice, even though the public Agent contract already
contains a bounded `maxSteps` field.
