# Contributing

AegisFlow is developed as a sequence of small, evidence-gated changes.

Before opening a pull request:

```bash
npm install
npm run verify
```

A change that alters a public contract must include tests demonstrating both
accepted and rejected behavior. Architectural changes should update the relevant
ADR or architecture document. Runtime claims such as durable recovery,
idempotency, security, or performance require executable evidence; prose is not
sufficient.
