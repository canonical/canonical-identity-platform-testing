// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/** Every (login step × re-entry kind) cell is covered by a derived walk or named in
 *  derived-coverage.json with a reason; a registered gap the generator now covers must be removed. */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { derivedCoverage, derivedScenarios } from "../scenarios/derived-scenarios";
import { DERIVED_PINS } from "../scenarios/derived-pins";

const register = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "derived-coverage.json"), "utf8")) as { gaps: Record<string, string> };

test("every uncovered cell is a registered gap, and no registered gap is covered", () => {
  const { cells, covered } = derivedCoverage();
  const gaps = Object.keys(register.gaps);
  assert.deepEqual(cells.filter((c) => !covered.includes(c)).filter((c) => !gaps.includes(c)), [], "unregistered gaps");
  assert.deepEqual(gaps.filter((g) => covered.includes(g)), [], "registered gaps the generator now covers — remove them");
  assert.deepEqual(gaps.filter((g) => !cells.includes(g)), [], "registered gaps that are not cells");
  for (const [cell, reason] of Object.entries(register.gaps)) assert.ok(reason.trim().length > 0, `${cell} has no reason`);
});

test("every pin names a derived walk and every pinned walk is collected once", () => {
  const ids = derivedScenarios.scenarios.map((s) => s.id);
  for (const pin of DERIVED_PINS) {
    assert.equal(ids.filter((id) => id === `${pin.id} [${pin.pd}]`).length, 1, pin.id);
  }
});

test("a pin that narrows on one key leaves the spec variant on the other rows; one that holds everywhere replaces it", () => {
  const ids = derivedScenarios.scenarios.map((s) => s.id);
  // PD-11 holds everywhere: no spec variant.
  assert.ok(!ids.includes("returning-login-mfa ⟂ back@2"));
  assert.ok(ids.includes("returning-login-mfa ⟂ back@2 [PD-11]"));
  // The resubmit fork is two walks on complementary rows, one of them pinned.
  const given = derivedScenarios.scenarios.find((s) => s.id === "returning-login-mfa ⟂ back-resubmit (challenge given to kratos)");
  const kept = derivedScenarios.scenarios.find((s) => s.id === "returning-login-mfa ⟂ back-resubmit (challenge kept from kratos) [PD-12]");
  assert.equal(given?.requires.kratosLoginChallenge, true);
  assert.equal(kept?.requires.kratosLoginChallenge, false);
});
