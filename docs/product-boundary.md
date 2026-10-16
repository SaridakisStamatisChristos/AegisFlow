# Product boundary

AegisFlow is its own product and runtime. It may learn from adjacent portfolio
projects, but it does not import their code, contracts, or deployment model.

## In scope for the product

- immutable versioned Flows;
- deterministic and model-mediated Stages;
- durable execution state;
- explicit policy and human Gates;
- external actions represented as Effects;
- waits and durable Signals;
- retries with preserved attempt history;
- structured Evidence;
- providers and typed connectors;
- API, SDK, CLI, and later an operator console.

## Explicit non-goals for V1

- n8n compatibility or a clone of its node catalogue/UI;
- arbitrary code execution;
- dynamic graph mutation;
- general loops/subflows/compensation graphs;
- hundreds of connectors;
- Redis/Kafka/Kubernetes without demonstrated need;
- exactly-once external side-effect claims;
- LLM-controlled authorization;
- enterprise IAM, billing, or SSO before core runtime correctness.

## Authority boundary

A model may recommend an operation, but the runtime decides whether that
operation is allowed, denied, or requires a Gate. A model response never becomes
an external side effect merely because the model requested it.
