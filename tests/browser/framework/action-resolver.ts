// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

import type { PageStateType } from "../helpers/page-state";
import { TRANSITION_TABLE } from "./transitions";
import type { TransitionAction, TransitionKey } from "./transitions";

export function resolveAction(
  fromState: PageStateType | "start",
  toState: PageStateType,
): TransitionAction {
  const key: TransitionKey = `${fromState} → ${toState}`;
  const entry = TRANSITION_TABLE[key];

  if (!entry) {
    throw new Error(
      `No action defined for transition: ${key}. ` +
      `Either add it to the transition table or check the scenario's expectedPath.`
    );
  }

  return entry;
}
