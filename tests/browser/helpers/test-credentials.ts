// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

import { randomBytes } from "node:crypto";

/** A fresh password for each seeded identity and each password a scenario sets. Never a
 *  constant: the repo is public, so a fixed value would open every test identity on every
 *  deployment it was seeded into. The seed manifest (a secret) is the only record. The suffix
 *  meets character-class policies; an unpublished value passes Kratos's breached-password check. */
export function generateTestPassword(): string {
  return `${randomBytes(18).toString("base64url")}-Aa1`;
}

// Static Dex user from docker/dex/config.yml (mirrored in matrix/backends/juju/manifests/dex.yaml).
export const DEX_USER_EMAIL = "dex-user@test.example";
export const DEX_USER_PASSWORD = "dex-password";
