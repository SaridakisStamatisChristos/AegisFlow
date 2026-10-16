import assert from "node:assert/strict";
import test from "node:test";
import {
  InvalidStateTransitionError,
  StateMachineInputError,
  nextAttemptSequence,
  transitionAttempt,
  transitionEffect,
  transitionExecution,
  transitionStageExecution,
} from "../dist/index.js";

const executionTerminals = ["SUCCEEDED", "FAILED", "CANCELLED"];
const executionEvents = ["START", "WAIT", "RESUME", "SUCCEED", "FAIL", "CANCEL"];
const stageTerminals = ["SUCCEEDED", "FAILED", "SKIPPED", "CANCELLED"];
const stageEvents = ["UNBLOCK", "START", "WAIT", "RESUME", "SUCCEED", "FAIL", "SKIP", "CANCEL"];
const attemptTerminals = ["SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELLED"];
const attemptEvents = ["START", "SUCCEED", "FAIL", "TIMEOUT", "CANCEL"];
const effectTerminals = ["SUCCEEDED", "FAILED", "RECONCILIATION_REQUIRED"];
const effectEvents = ["CLAIM", "SUCCEED", "FAIL", "REQUIRE_RECONCILIATION"];

test("terminal execution states reject every event", () => {
  for (const state of executionTerminals) {
    for (const event of executionEvents) {
      assert.throws(() => transitionExecution(state, event), InvalidStateTransitionError);
    }
  }
});

test("terminal stage states reject every event", () => {
  for (const state of stageTerminals) {
    for (const event of stageEvents) {
      assert.throws(() => transitionStageExecution(state, event), InvalidStateTransitionError);
    }
  }
});

test("terminal attempt records reject every event", () => {
  for (const state of attemptTerminals) {
    for (const event of attemptEvents) {
      assert.throws(() => transitionAttempt(state, event), InvalidStateTransitionError);
    }
  }
});

test("terminal effect records reject every event", () => {
  for (const state of effectTerminals) {
    for (const event of effectEvents) {
      assert.throws(() => transitionEffect(state, event), InvalidStateTransitionError);
    }
  }
});

test("attempt sequence rejects malformed, unsafe, and overflowing values", () => {
  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => nextAttemptSequence(value), StateMachineInputError);
  }
  assert.throws(() => nextAttemptSequence(Number.MAX_SAFE_INTEGER), StateMachineInputError);
});

test("malformed runtime state and event values fail closed rather than throwing incidental TypeError", () => {
  assert.throws(() => transitionExecution("BOGUS", "START"), InvalidStateTransitionError);
  assert.throws(() => transitionExecution("PENDING", "BOGUS"), InvalidStateTransitionError);
  assert.throws(() => transitionEffect("BOGUS", "CLAIM"), InvalidStateTransitionError);
});
