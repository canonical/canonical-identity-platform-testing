// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Action resolver — resolves (fromState, toState) → action function.
 *
 * Looks up the transition table and throws for unknown transitions.
 * This is the core of the scenario-driven framework: the runner asks
 * "how do I get from state A to state B?" and the resolver provides
 * the answer.
 */

import type { Page } from "@playwright/test";
import type { PageStateType } from "../helpers/page-state";
import type { ManifestUser } from "../seeder/manifest-schema";

import { TRANSITION_TABLE } from "./transitions";
import type { TransitionAction, TransitionKey, ActionContext } from "./transitions";

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the action to take for a state transition.
 *
 * @param fromState The current page state (or "start" for the initial transition)
 * @param toState The expected next page state
 * @returns The transition action (description + action function)
 * @throws Error if no action is defined for the transition
 */
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

/**
 * Check if a transition is defined in the table.
 * Useful for validation without throwing.
 */
export function isTransitionDefined(
  fromState: PageStateType | "start",
  toState: PageStateType,
): boolean {
  const key: TransitionKey = `${fromState} → ${toState}`;
  return key in TRANSITION_TABLE;
}
