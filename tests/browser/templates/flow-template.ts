// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Test template for the generate-browser-test skill.
 *
 * This template is used when generating new Playwright tests from
 * natural language flow descriptions. It provides the standard structure,
 * imports, and setup/teardown patterns.
 *
 * Usage: Copy this template and fill in the placeholders.
 * Place generated tests in: tests/browser/specs/<name>.spec.ts
 */

import { test, expect } from '@playwright/test';

// --- Helper Imports ---
// Uncomment and adjust based on the flow being tested:
// import { createIdentity, deleteIdentity } from '../helpers/kratos';
// import { createOAuth2Client, deleteOAuth2Client } from '../helpers/hydra';
// import { loginWithPassword } from '../helpers/login';
// import { createTenant, deleteTenant } from '../helpers/tenants';
// import { completeTotpSetup, verifyTotp } from '../helpers/totp';
// import { readLatestEmail } from '../helpers/mail';
// import { startOidcFlow } from '../helpers/oidc';
// import { isServiceInProfile } from '../helpers/config';

// --- Test Data ---
// Define test data constants here. Use the seed-test-data script
// for pre-seeded data, or create ad-hoc data in beforeAll.

test.describe('<FLOW_NAME>', () => {
  // Skip if required services are not in the active profile
  // test.skip(() => !isServiceInProfile('tenant-service'), 'tenant-service not in profile');

  // --- Setup ---
  test.beforeAll(async () => {
    // Create test resources (identities, tenants, OAuth2 clients)
    // Example:
    // const identity = await createIdentity({
    //   email: 'test@example.com',
    //   password: 'Test-Password-123!',
    //   traits: { name: 'Test', surname: 'User' },
    // });
    // testEmail = identity.email;
    // identityId = identity.id;
  });

  // --- Teardown ---
  test.afterAll(async () => {
    // Clean up test resources
    // Example:
    // if (identityId) await deleteIdentity(identityId);
  });

  // --- Test Cases ---

  test('<TEST_DESCRIPTION>', async ({ page }) => {
    // Step 1: Navigate to starting URL
    // await page.goto('/login');

    // Step 2: Interact with the page
    // await page.getByTestId('email-input').fill(testEmail);
    // await page.getByTestId('password-input').fill(testPassword);
    // await page.getByTestId('submit-button').click();

    // Step 3: Assert expected outcome
    // await expect(page).toHaveURL(/dashboard/);
    // await expect(page.getByText('Welcome')).toBeVisible();
  });

  // --- Additional Test Cases ---
  // Add edge cases, error states, and alternative flows here.
  // Example:
  // test('shows error for invalid credentials', async ({ page }) => {
  //   await page.goto('/login');
  //   await page.getByTestId('email-input').fill('invalid@example.com');
  //   await page.getByTestId('password-input').fill('wrong-password');
  //   await page.getByTestId('submit-button').click();
  //   await expect(page.getByText(/invalid credentials/i)).toBeVisible();
  // });
});
