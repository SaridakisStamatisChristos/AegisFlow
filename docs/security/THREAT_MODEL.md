# AegisFlow Control Plane — AegisCore threat model

## Assets, actors and boundaries

Assets: Flow definitions, run state, approval Gates, Effect reconciliation authority, Signal payloads, evidence and PostgreSQL. Actors: legitimate service client, operator, human approver via a separately authenticated gateway, reconciler, unauthenticated network caller, holder of stolen token, compromised browser. Boundaries: API/SDK/CLI HTTP ingress; browser console/reverse proxy; API/PostgreSQL; workers and external connectors.

| Attack | Implemented defense | Residual risk |
| --- | --- | --- |
| Unauthenticated API mutation/read | Bearer authentication for all /v1 routes, startup fail closed | Health probes and network DoS still exposed |
| Token forgery or client-supplied actor headers | SHA-256 digest verifier, timing-safe equality, untrusted headers ignored | Stolen tokens remain valid until expiry/restart-backed revocation |
| Horizontal/vertical privilege misuse | Route-specific read/execute/approve/reconcile checks | No organization/tenant/resource isolation |
| Operator impersonates approver or reconciler | Role checks and principal-matching actor attribution | Shared console token is not human identity |
| Exposed bearer over network | SDK disallows remote plaintext HTTP | Server-side TLS termination and edge protections external |
| Browser console bypass | Strict loopback-only bind; proxy flag cannot authorize remote binding | Port forwarding/proxy/browser login still unverified; remote deployment prohibited |
| Stale credentials after rotation | Config replacement/restart and per-request expiry | No dynamic revocation or distributed key management |

The agent runtime itself never confers API authority. No changes to Graph eligibility, Gate/effect durable state machines, worker fencing or provider tools. These controls do not supply delegated OAuth access or federated OIDC identity. Review independent auth proxy, TLS, secret rotation, service identity ownership, least-privilege key distribution, request limits and tenant model before public SaaS exposure.

## Independent verification targets

Unit/endpoint positives: correct role can read/execute/approve. Negatives: missing/malformed/wrong/expired token, role escalation, forged actor/reconciler, config duplicates, missing config and unauthenticated side effects. Integration: existing PostgreSQL API workflows with authenticated SDK should continue working. CI must run; hosted deployment, ingress/TLS policies and real browser identity remain unverified until exercised.
