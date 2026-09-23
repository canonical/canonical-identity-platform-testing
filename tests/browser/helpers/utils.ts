// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

// Both generators stay inside the seeder ownership namespace so leaked runs get cleaned up.

import { TEST_EMAIL_DOMAIN, TEST_TENANT_PREFIX } from "../seeder/ownership";

export function randomNameSuffix(): string {
  return (Math.random() + 1).toString(36).substring(7);
}

export function uniqueEmail(prefix: string = "test"): string {
  return `${prefix}-${Date.now()}-${randomNameSuffix()}@${TEST_EMAIL_DOMAIN}`;
}

export function uniqueTenantName(prefix: string = "Tenant"): string {
  return `${TEST_TENANT_PREFIX}${prefix} ${randomNameSuffix()}`;
}
