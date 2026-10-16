# UCS-Pro R7 evidence — PR1 foundation/contracts

## Completion label

**SYNTHESIS COMPLETE — hosted verification incomplete.**

The PR1 source slice passes all executable local checks available in the current
environment. A fresh npm registry install and GitHub Actions run remain external
evidence gates and are not treated as passed until observed.

## Contract closure

Implemented hard PR1 requirements:

- standalone AegisFlow product boundary;
- TypeScript/Node workspace and toolchain;
- opaque domain IDs;
- Flow and eight bounded Stage contracts;
- Flow graph validation;
- duplicate Stage rejection;
- missing-dependency rejection;
- dependency-cycle rejection;
- unknown Stage-kind rejection;
- state vocabularies for Execution, Stage, Attempt, Gate, and Effect;
- immutable Flow-Version snapshot concept;
- architecture, persistence, state-machine, Effect, and Gate specifications;
- basic GitHub CI definition;
- architecture-boundary and secret scans.

## Verification evidence

Environment used for local evidence:

- Node.js `v22.16.0`
- npm `10.9.2`
- TypeScript `5.8.3` available in the execution environment

Executed gate:

```bash
npm run clean
npm run verify
```

Observed local results after repair:

- repository text lint: PASS;
- strict TypeScript typecheck: PASS;
- contract/falsification tests: **16/16 PASS**;
- contracts dependency-boundary scan: PASS;
- high-confidence secret scan: PASS.

## Falsification coverage applied to PR1

Applicable attacks include:

- malformed Flow and Stage input;
- unknown Stage kinds;
- duplicate Stage IDs and dependencies;
- missing dependency references;
- self-cycles and multi-Stage cycles;
- non-finite numeric JSON values;
- oversized JSON arrays;
- bounded Agent `maxSteps`;
- mutually invalid wait wake-up configuration;
- malformed domain IDs;
- post-version source mutation;
- attempted mutation of frozen version snapshots;
- prototype-pollution-shaped JSON keys;
- architecture dependency drift;
- obvious credential-pattern leakage.

Persistence failure, worker recovery, lease races, Gate restart, Effect ambiguity,
provider failure, connector timeouts, and authorization tests are not applicable
to PR1 because those runtime surfaces do not exist yet. They are mandatory in
the roadmap slices that introduce those surfaces.

## Failure / repair ledger

### F-001 — strict TypeScript compile rejected two contract implementation details

- Evidence: initial build failed under `exactOptionalPropertyTypes` and readonly
  JSON narrowing.
- Root cause: an explicit `undefined` optional property was passed where absence
  was required; TypeScript could not narrow readonly JSON arrays to `JsonObject`.
- Earliest invalidated phase: GENERATE.
- Repair: construct the options object conditionally and use the existing
  record guard for JSON-object narrowing.
- Reverification: build and full test suite passed.

### F-002 — JSON payload reconstruction had a prototype-pollution-shaped key risk

- Evidence: adversarial review identified assignment into a normal `{}` while
  accepting arbitrary JSON keys such as `__proto__`.
- Root cause: payload normalization used an object with `Object.prototype`.
- Earliest invalidated phase: SPEC/GENERATE for JSON normalization.
- Repair: reconstruct JSON objects with a null prototype and add bounded object,
  array, string, and depth limits.
- Independent reverification: dedicated test verifies `__proto__` is retained as
  data, output has a null prototype, and global object prototypes remain clean.

## Evidence gaps

1. `npm install` could not be exercised against the npm registry from this local
   execution environment. No clean-install PASS is claimed.
2. GitHub Actions must execute the committed `ci.yml` before R0/PR1 hosted CI is
   VERIFIED.
3. No PostgreSQL/runtime behavior is claimed in PR1.
4. No production-readiness, security-completeness, durability, performance, or
   exactly-once claim is made.

## Next evidence gate

Push this exact source revision on a PR branch, allow GitHub Actions to install
TypeScript and run `npm run verify`, then inspect the resulting workflow status.
Only after that run succeeds should PR1 be described as merge-ready.
