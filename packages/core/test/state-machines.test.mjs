import assert from "node:assert/strict";
import test from "node:test";
import {
  GateDecisionConflictError,
  InvalidStateTransitionError,
  StateMachineInputError,
  canTransitionExecution,
  nextAttemptSequence,
  resolveDecisionBranch,
  transitionAttempt,
  transitionEffect,
  transitionExecution,
  transitionGate,
  transitionStageExecution,
} from "../dist/index.js";

test("execution transitions through wait/resume without reviving a terminal state", () => {
  assert.deepEqual(transitionExecution("PENDING", "START"), {
    from: "PENDING", event: "START", to: "RUNNING", changed: true,
  });
  assert.equal(transitionExecution("RUNNING", "WAIT").to, "WAITING");
  assert.equal(transitionExecution("WAITING", "RESUME").to, "RUNNING");
  assert.equal(transitionExecution("RUNNING", "SUCCEED").to, "SUCCEEDED");
  assert.throws(() => transitionExecution("SUCCEEDED", "START"), InvalidStateTransitionError);
  assert.equal(canTransitionExecution("SUCCEEDED", "CANCEL"), false);
});

test("cancellation is monotonic across active execution and stage states", () => {
  for (const state of ["PENDING", "RUNNING", "WAITING"]) {
    assert.equal(transitionExecution(state, "CANCEL").to, "CANCELLED");
  }
  assert.throws(() => transitionExecution("CANCELLED", "START"), InvalidStateTransitionError);
  for (const state of ["BLOCKED", "READY", "RUNNING", "WAITING"]) {
    assert.equal(transitionStageExecution(state, "CANCEL").to, "CANCELLED");
  }
  assert.throws(
    () => transitionStageExecution("CANCELLED", "UNBLOCK"),
    InvalidStateTransitionError,
  );
});

test("stage skipping is allowed only before work starts", () => {
  assert.equal(transitionStageExecution("BLOCKED", "SKIP").to, "SKIPPED");
  assert.equal(transitionStageExecution("READY", "SKIP").to, "SKIPPED");
  assert.throws(() => transitionStageExecution("RUNNING", "SKIP"), InvalidStateTransitionError);
});

test("attempts are single-use records and retries allocate a new sequence", () => {
  assert.equal(transitionAttempt("CLAIMED", "START").to, "RUNNING");
  assert.equal(transitionAttempt("RUNNING", "FAIL").to, "FAILED");
  assert.throws(() => transitionAttempt("FAILED", "START"), InvalidStateTransitionError);
  assert.equal(nextAttemptSequence(null), 1);
  assert.equal(nextAttemptSequence(1), 2);
  assert.equal(nextAttemptSequence(41), 42);
});

test("identical gate decisions are idempotent and conflicting decisions fail", () => {
  const first = transitionGate("WAITING", "APPROVE");
  assert.equal(first.to, "APPROVED");
  assert.equal(first.changed, true);
  const duplicate = transitionGate("APPROVED", "APPROVE");
  assert.equal(duplicate.to, "APPROVED");
  assert.equal(duplicate.changed, false);
  assert.throws(() => transitionGate("APPROVED", "REJECT"), GateDecisionConflictError);
  assert.throws(() => transitionGate("EXPIRED", "APPROVE"), GateDecisionConflictError);
});

test("effects do not blindly replay after ambiguous outcomes", () => {
  assert.equal(transitionEffect("PLANNED", "CLAIM").to, "CLAIMED");
  assert.equal(
    transitionEffect("CLAIMED", "REQUIRE_RECONCILIATION").to,
    "RECONCILIATION_REQUIRED",
  );
  assert.throws(
    () => transitionEffect("RECONCILIATION_REQUIRED", "CLAIM"),
    InvalidStateTransitionError,
  );
});

test("decision resolution is deterministic and does not mutate caller input", () => {
  const choices = ["approve", "reject", "escalate"];
  const result = resolveDecisionBranch(choices, "reject");
  assert.deepEqual(result, { selected: "reject", skipped: ["approve", "escalate"] });
  assert.deepEqual(choices, ["approve", "reject", "escalate"]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.skipped), true);
});

test("decision resolution rejects invalid selection contracts", () => {
  assert.throws(() => resolveDecisionBranch([], "x"), StateMachineInputError);
  assert.throws(() => resolveDecisionBranch(["a", "a"], "a"), StateMachineInputError);
  assert.throws(() => resolveDecisionBranch(["a", "b"], "c"), StateMachineInputError);
});
