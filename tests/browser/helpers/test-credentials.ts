// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Shared test credentials — one definition each.
 *
 * These values are contracts with things outside the suite: the password must
 * satisfy the Kratos password policy every profile ships, and the Dex user is
 * the static identity declared in `docker/dex/config.yml` (and mirrored in
 * `matrix/backends/juju/manifests/dex.yaml`). Never copy them into consumers:
 * a policy change or a Dex config change must have exactly one place to land.
 */

/** Password the seeder sets on every local identity it creates. */
export const DEFAULT_TEST_PASSWORD = "Secure-Password-123!";

/** Static Dex test user configured in docker/dex/config.yml. */
export const DEX_USER_EMAIL = "dex-user@test.example";
export const DEX_USER_PASSWORD = "dex-password";

/** Dex static user ID — becomes the OIDC subject in Kratos credentials.
 *  Dex encodes userID + connector into a federated protobuf subject.
 *  This value was extracted from the Kratos OIDC callback logs. */
export const DEX_USER_ID =
  "CiQwOGE4Njg0Yi1kYjg4LTRiNzMtOTBhOS0zY2QxNjYxZjU0NjYSBWxvY2Fs";
