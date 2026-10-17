# Provider abstraction and Agent Stage runtime

`@aegisflow/providers` defines a vendor-neutral model-provider boundary and durable Agent Stage execution semantics.

## Provider contract

`ModelProvider` exposes a stable provider `id` and asynchronous `generate()` method. `ProviderRegistry` rejects duplicate identities and fails closed when a Stage names an unregistered provider.

Provider responses normalize to exactly one of two shapes:

- `final`: JSON-compatible output plus optional provider reference/usage;
- `tool_calls`: one or more bounded tool requests plus optional provider reference/usage.

Malformed responses, duplicate tool-call IDs, non-JSON values, unsafe numeric values, and invalid symbolic names are rejected deterministically.

## Agent authority chain

The Agent Stage definition is loaded from the Execution's pinned immutable Flow Version. The caller cannot substitute provider, instruction, tool allow-list, step budget, or output schema.

```text
pinned Flow Version
       |
       v
Agent Stage definition
       |
       v
worker Claim authority
       |
       v
provider Effect authority
       |
       v
ModelProvider.generate()
       |
       v
immutable provider result
       |
       v
output/tool validation
       |
       v
Stage completion
```

Provider invocation is an external Effect, not an untracked model call. The stable provider Effect identity is derived from `StageExecution + provider step`.

## Crash and ambiguity semantics

Provider-result evidence and successful Effect closure commit in one PostgreSQL transaction. During recovery:

- durable provider evidence is reused without calling the provider again;
- an unresolved claimed provider Effect is treated as an unknown external outcome;
- lost worker authority after a provider response quarantines the Effect;
- known provider failures become failed Effects;
- unknown transport/provider outcomes become reconciliation-required Effects.

These rules do not claim generic exactly-once model execution.

## Output schemas

The runtime supports a bounded deterministic JSON-schema-like subset including `type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`, common bounds, and metadata keywords. Unsupported keywords fail closed.

A provider may succeed externally while returning output that fails the pinned schema; the external result remains durable evidence while the Stage fails.

## Tool execution

Tool requests are normalized and validated against the Agent Stage's immutable allow-list and connector registry before any external action begins. Multi-step provider → tool → provider execution is bounded by `maxSteps`, and every external tool call runs through the Effect ledger.
