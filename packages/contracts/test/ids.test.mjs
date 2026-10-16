import assert from "node:assert/strict";
import test from "node:test";

import { ContractError, parseExecutionId, parseFlowId } from "../dist/index.js";

test("opaque identifiers require the correct domain prefix", () => {
  assert.equal(parseFlowId("flow_abcdefgh"), "flow_abcdefgh");
  assert.equal(parseExecutionId("exec_abcdefgh"), "exec_abcdefgh");
  assert.throws(
    () => parseFlowId("exec_abcdefgh"),
    (error) => error instanceof ContractError && error.code === "INVALID_ID",
  );
});

test("opaque identifiers reject weak or malformed bodies", () => {
  for (const candidate of ["flow_short", "flow_UPPERCASE", "flow_bad space", 42, null]) {
    assert.throws(
      () => parseFlowId(candidate),
      (error) => error instanceof ContractError && error.code === "INVALID_ID",
    );
  }
});
