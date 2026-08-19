// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Utility helpers — random name generation, etc.
 *
 * Ported from login-ui/ui/tests/helpers/name.ts.
 *
 * Both generators stay inside the test plane's ownership namespace
 * (seeder/ownership.ts) so anything a crashed run leaks is still recognisable
 * as ours and gets cleaned up, without the seeder ever having to guess.
 */

import { TEST_EMAIL_DOMAIN, TEST_TENANT_PREFIX } from "../seeder/ownership";

/** Generate a random suffix for unique test names. */
export function randomNameSuffix(): string {
  return (Math.random() + 1).toString(36).substring(7);
}

/** Generate a unique email for testing. */
export function uniqueEmail(prefix: string = "test"): string {
  return `${prefix}-${Date.now()}-${randomNameSuffix()}@${TEST_EMAIL_DOMAIN}`;
}

/** Generate a unique tenant name for testing. */
export function uniqueTenantName(prefix: string = "Tenant"): string {
  return `${TEST_TENANT_PREFIX}${prefix} ${randomNameSuffix()}`;
}
