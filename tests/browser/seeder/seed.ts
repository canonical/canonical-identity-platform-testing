// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

/**
 * Seeder — creates users via admin APIs and writes a manifest file.
 *
 * Usage:
 *   npx tsx seeder/seed.ts [--fresh|--incremental|--purge] [--profile <name>]
 *
 * The seeder is independent of scenario definitions. Which users to create
 * is determined by seeder/archetypes.ts, not by importing scenario files.
 * The test runner reads the output manifest.json and never calls admin APIs.
 *
 * Every mode that deletes is scoped by seeder/ownership.ts, so an admin can run
 * this out of band against a deployment that already has real users on it:
 *
 *   --fresh        delete the test-plane's own records, then re-create them
 *   --incremental  adopt whatever already exists, create only what is missing
 *   --purge        delete the test-plane's own records and stop
 *
 * Admin/out-of-band use: point KRATOS_ADMIN_URL, HYDRA_ADMIN_URL and
 * TENANT_SERVICE_URL at the deployment, and set MANIFEST=<path> to write the
 * manifest somewhere the test runner can later read it (tests/browser/LANES.md).
 */

import * as fs from "node:fs";
import * as path from "node:path";

// Helpers (reuse the existing ones)
import { createIdentity, createIdentityWithOIDC, deleteIdentity, findIdentityByEmail, deleteIdentitySessions, listIdentities, markVerified, createSessionToken, initTotpSettingsFlow, confirmTotpEnrollment, generateBackupCodes, burnBackupCodes } from "../helpers/kratos";
import { generateTotpCode } from "../helpers/totp";
import { createTenant, deleteTenant, getServiceToken, listTenants, provisionUser } from "../helpers/tenants";
import { addUsersToGroup, ensureGroup, getHookAdminToken, listUserGroups } from "../helpers/hooks";
import { HYDRA_ADMIN_URL, isServiceInProfile, localUsersEnabled, GOOGLE_TEST_EMAIL, GOOGLE_TEST_SUBJECT_ID } from "../helpers/config";

// Archetype definitions — the authoritative list of users to seed
import { USER_ARCHETYPES, type UserArchetype } from "./archetypes";

// Ownership — the only thing that authorises a delete
import {
  archetypeEmail,
  ownsIdentity,
  ownsTenant,
  provenanceFromManifest,
  TEST_TENANT_PREFIX,
  type Provenance,
} from "./ownership";

// Manifest location — one resolver, shared with the test runner
import { resolveManifestPath } from "../framework/manifest";

// Client definitions — the authoritative payloads for Hydra OAuth2 clients
import { RP_CLIENT_PAYLOAD, SVC_CLIENT_PAYLOAD, HOOKS_ADMIN_CLIENT_PAYLOAD, type RegisteredClient } from "./clients";

// Manifest types
import type { Manifest, ManifestUser, ManifestTenant, ManifestMembership, ManifestGroup, ManifestOauthClients } from "./manifest-schema";

// Credentials — one definition, shared with the specs and the transition table
import {
  DEFAULT_TEST_PASSWORD,
  DEX_USER_EMAIL,
  DEX_USER_ID,
  DEX_USER_PASSWORD,
} from "../helpers/test-credentials";

/**
 * hook-service groups to seed, and which archetypes belong to them.
 *
 * `returning-mfa` is the general-purpose "already enrolled" login identity: it
 * is exercised by the login, error, session and recovery scenarios, none of
 * which delete it or change its email — and email is the key hook-service uses
 * for membership. The registration and verification archetypes are deleted or
 * consumed by their scenarios, and the tenant archetypes carry tenant state
 * that would confound a groups assertion, so they are poor carriers for this.
 */
const HOOK_GROUP_DEFS = [
  {
    ref: "platform-testers",
    name: "platform-testers",
    description: "Seeded by the browser test seeder to exercise Hydra's token hook",
    memberRefs: ["returning-mfa"],
  },
];

// ---------------------------------------------------------------------------
// Collect archetypes
// ---------------------------------------------------------------------------

/** Return the archetype map to use for seeding. */
function collectUserRequirements(): Map<string, UserArchetype> {
  const userMap = new Map<string, UserArchetype>();
  for (const archetype of USER_ARCHETYPES) {
    // Skip google-user when Google credentials are not configured
    if (archetype.credentials.includes("oidc/google") && (!GOOGLE_TEST_EMAIL || !GOOGLE_TEST_SUBJECT_ID)) {
      console.log(`  Skipping ${archetype.ref}: GOOGLE_TEST_EMAIL and/or GOOGLE_TEST_SUBJECT_ID not set`);
      continue;
    }
    userMap.set(archetype.ref, archetype);
  }
  return userMap;
}

// ---------------------------------------------------------------------------
// Client registration
// ---------------------------------------------------------------------------

/** Upsert a single Hydra OAuth2 client (PUT to update, POST to create). */
async function upsertClient(payload: Record<string, unknown>): Promise<RegisteredClient> {
  // Try PUT first (update existing client)
  const putRes = await fetch(`${HYDRA_ADMIN_URL}/admin/clients/${payload.client_id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (putRes.ok) {
    return (await putRes.json()) as RegisteredClient;
  }

  // If client doesn't exist (404), fall back to POST (create)
  if (putRes.status === 404) {
    const postRes = await fetch(`${HYDRA_ADMIN_URL}/admin/clients`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!postRes.ok) {
      const text = await postRes.text();
      throw new Error(`failed to create client ${payload.client_id}: ${postRes.status} ${text}`);
    }

    return (await postRes.json()) as RegisteredClient;
  }

  const text = await putRes.text();
  throw new Error(`failed to upsert client ${payload.client_id}: ${putRes.status} ${text}`);
}

/** Register the test OAuth2 clients (RP + service + hook-service admin) with Hydra. */
async function seedClients(): Promise<ManifestOauthClients> {
  console.log("Registering OAuth2 clients with Hydra...");

  const rp = await upsertClient(RP_CLIENT_PAYLOAD as Record<string, unknown>);
  console.log(`  ✓ Registered RP client: ${rp.client_id}`);

  const svc = await upsertClient(SVC_CLIENT_PAYLOAD as Record<string, unknown>);
  console.log(`  ✓ Registered service client: ${svc.client_id}`);

  const hooks = await upsertClient(HOOKS_ADMIN_CLIENT_PAYLOAD as Record<string, unknown>);
  console.log(`  ✓ Registered hook-service admin client: ${hooks.client_id}`);

  return {
    rp: {
      clientId: rp.client_id,
      clientSecret: rp.client_secret,
      redirectUri: rp.redirect_uris?.[0] ?? "http://127.0.0.1:4446/callback",
    },
    svc: {
      clientId: svc.client_id,
      clientSecret: svc.client_secret,
    },
    hooks: {
      clientId: hooks.client_id,
      clientSecret: hooks.client_secret,
    },
  };
}

// ---------------------------------------------------------------------------
// Seeding functions
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// TOTP provisioning
// ---------------------------------------------------------------------------

/**
 * Provision TOTP for a seeded user by driving a Kratos settings flow.
 *
 * Orchestrates: createSessionToken → initTotpSettingsFlow →
 * generate TOTP code from extracted secret → confirmTotpEnrollment →
 * optionally generateBackupCodes.
 *
 * Returns the base32 TOTP secret and optionally a backup code.
 *
 * @param email — The user's email (login identifier).
 * @param password — The user's password.
 * @param identityId — The Kratos identity UUID (for session cleanup).
 * @param withBackupCodes — Whether to also generate backup codes (lookup_secret).
 */
async function provisionTotp(
  email: string,
  password: string,
  identityId: string,
  withBackupCodes = false,
  lowBackupCodes = false,
): Promise<{ totpSecret: string; backupCode?: string }> {
  // Step 1: Create a session token by logging in via the native API
  const sessionToken = await createSessionToken(email, password);

  // Step 2: Initiate a TOTP settings flow and extract the secret
  const { flowId, totpSecret } = await initTotpSettingsFlow(sessionToken);

  // Step 3: Generate a valid TOTP code from the extracted secret
  const totpCode = await generateTotpCode(totpSecret);

  // Step 4: Confirm the TOTP enrollment
  await confirmTotpEnrollment(flowId, sessionToken, totpCode);

  // Step 5: Generate backup codes if requested
  // Must use the SAME flow as TOTP confirmation, because after TOTP is
  // configured, creating a new settings flow requires AAL2 authentication.
  let backupCode: string | undefined;
  if (withBackupCodes) {
    try {
      const codes = await generateBackupCodes(flowId, sessionToken);
      if (codes.length > 0) {
        backupCode = codes[0];
        console.log(`  [seed] Generated ${codes.length} backup codes`);
      }
      if (lowBackupCodes && codes.length > 4) {
        // Leave exactly 4 unused: a scenario that spends one leaves 3, which is
        // the threshold at which login-ui offers the regeneration prompt.
        await burnBackupCodes(sessionToken, codes.slice(0, codes.length - 4));
        backupCode = codes[codes.length - 4];
        console.log(`  [seed] Burned ${codes.length - 4} backup codes (4 left)`);
      }
    } catch (err) {
      console.warn(`  ⚠ Failed to generate backup codes: ${err}`);
    }
  }

  // Step 6: Clean up the session
  await deleteIdentitySessions(identityId);

  return { totpSecret, backupCode };
}

/** Create a password-only user. */
async function seedPasswordUser(ref: string, user: UserArchetype): Promise<ManifestUser> {
  const email = archetypeEmail(ref);
  const identityId = await createIdentity({
    email,
    password: DEFAULT_TEST_PASSWORD,
    name: "Test",
    surname: ref,
  });

  // By default, Kratos creates identities with verified=false.
  // If the scenario doesn't explicitly require unverified, mark as verified.
  const shouldVerify = user.verified !== false;
  if (shouldVerify) {
    await markVerified(identityId);
  }

  // Provision TOTP if the archetype requires it
  let totpSecret: string | null = null;
  let backupCode: string | undefined;
  if (user.totpConfigured && !localUsersEnabled()) {
    // TOTP enrolment logs in with the password method; without local users the
    // self-service login endpoint is disabled and the attempt can only 404.
    console.log(`  [seed] TOTP skipped for ${ref}: local users disabled on this deployment`);
  } else if (user.totpConfigured) {
    try {
      const needsBackupCodes = user.credentials.includes("lookup_secret");
      const result = await provisionTotp(email, DEFAULT_TEST_PASSWORD, identityId, needsBackupCodes, user.lowBackupCodes ?? false);
      totpSecret = result.totpSecret;
      backupCode = result.backupCode;
      console.log(`  [seed] TOTP provisioned for ${ref}`);
    } catch (err) {
      console.warn(`  ⚠ Failed to provision TOTP for ${ref}: ${err}`);
    }
  }

  return {
    ref,
    email,
    password: DEFAULT_TEST_PASSWORD,
    credentials: user.credentials,
    totpConfigured: user.totpConfigured,
    totpSecret,
    identityId,
    verified: shouldVerify,
    ...(backupCode ? { backupCode } : {}),
  };
}

/** Create an OIDC/Dex user. */
async function seedDexUser(ref: string, user: UserArchetype): Promise<ManifestUser> {
  const identityId = await createIdentityWithOIDC({
    email: DEX_USER_EMAIL,
    provider: "dex",
    subject: DEX_USER_ID,
  });

  // Mark OIDC users as verified by default
  await markVerified(identityId);

  return {
    ref,
    email: DEX_USER_EMAIL,
    password: null,
    credentials: ["oidc/dex"],
    totpConfigured: false,
    totpSecret: null,
    identityId,
    verified: true,
    dexEmail: DEX_USER_EMAIL,
    dexPassword: DEX_USER_PASSWORD,
  };
}

/** Create a Google OIDC user. Requires GOOGLE_TEST_EMAIL and GOOGLE_TEST_SUBJECT_ID env vars. */
async function seedGoogleUser(ref: string, user: UserArchetype): Promise<ManifestUser> {
  if (!GOOGLE_TEST_EMAIL || !GOOGLE_TEST_SUBJECT_ID) {
    throw new Error(
      "Cannot seed google-user: GOOGLE_TEST_EMAIL and GOOGLE_TEST_SUBJECT_ID environment variables are required. " +
      "Set them and re-run the seeder.",
    );
  }

  const identityId = await createIdentityWithOIDC({
    email: GOOGLE_TEST_EMAIL,
    provider: "google",
    subject: GOOGLE_TEST_SUBJECT_ID,
  });

  await markVerified(identityId);

  return {
    ref,
    email: GOOGLE_TEST_EMAIL,
    password: null,
    credentials: ["oidc/google"],
    totpConfigured: false,
    totpSecret: null,
    identityId,
    verified: true,
  };
}

/** Create a user based on their credential type. */
async function seedUser(ref: string, user: UserArchetype): Promise<ManifestUser> {
  if (user.credentials.includes("oidc/google")) {
    return seedGoogleUser(ref, user);
  }
  if (user.credentials.includes("oidc/dex")) {
    return seedDexUser(ref, user);
  }
  return seedPasswordUser(ref, user);
}

// ---------------------------------------------------------------------------
// Cleanup (fresh and purge modes)
// ---------------------------------------------------------------------------
//
// Cleanup failures are FATAL, never warnings: seeding on top of unknown
// leftover state produces a manifest that does not describe the deployment, and
// every test failure downstream is then misattributable.
//
// Deletion is scoped by seeder/ownership.ts. Anything the test plane did not
// create is counted and reported, never touched — that is what makes it safe to
// point this script at a deployment that already has real users on it.

/** Delete every test-plane-owned Kratos identity. Throws if a delete fails. */
async function cleanupOwnedIdentities(provenance: Provenance): Promise<void> {
  console.log("Cleaning test-plane identities...");
  const identities = await listIdentities();
  const owned = identities.filter((i) => ownsIdentity(i, provenance));
  const foreign = identities.length - owned.length;

  const undeleted: string[] = [];
  for (const identity of owned) {
    await deleteIdentitySessions(identity.id).catch(() => {});
    try {
      await deleteIdentity(identity.id);
    } catch (err) {
      console.error(`  ✗ Could not delete identity ${identity.id}: ${err}`);
      undeleted.push(identity.id);
    }
  }
  if (undeleted.length > 0) {
    throw new Error(`${undeleted.length} identit(ies) survived cleanup: ${undeleted.join(", ")}`);
  }
  console.log(
    `  ✓ Deleted ${owned.length} test identities` +
    (foreign > 0 ? `; left ${foreign} pre-existing identit(ies) untouched` : ""),
  );
}

/** Delete every test-plane-owned tenant. Throws if a delete fails.
 *
 *  A cleanup that no-ops while claiming success accumulates tenants across
 *  every gate run and matrix night. tenant-service exposes a paginated list on
 *  the admin API; the token comes from the svc client this run just upserted. */
async function cleanupOwnedTenants(token: string, provenance: Provenance): Promise<void> {
  console.log("Cleaning test-plane tenants...");
  const tenants = await listTenants(token);
  const owned = tenants.filter((t) => ownsTenant(t, provenance));
  const foreign = tenants.length - owned.length;

  const undeleted: string[] = [];
  for (const t of owned) {
    try {
      await deleteTenant(token, t.id);
    } catch (err) {
      console.error(`  ✗ Could not delete tenant ${t.name} (${t.id}): ${err}`);
      undeleted.push(t.id);
    }
  }
  if (undeleted.length > 0) {
    throw new Error(`${undeleted.length} tenant(s) survived cleanup: ${undeleted.join(", ")}`);
  }
  console.log(
    `  ✓ Deleted ${owned.length} test tenants` +
    (foreign > 0 ? `; left ${foreign} pre-existing tenant(s) untouched` : ""),
  );
}

// ---------------------------------------------------------------------------
// Main seeder
// ---------------------------------------------------------------------------

type SeedMode = "fresh" | "incremental" | "purge";

/** Read the manifest this test plane last wrote. Never throws: an absent or
 *  corrupt manifest just means no provenance and no preserved TOTP secrets. */
function readPreviousManifest(): unknown {
  const manifestPath = resolveManifestPath();
  if (!fs.existsSync(manifestPath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch {
    return undefined;
  }
}

async function seed(mode: SeedMode, profile?: string): Promise<void> {
  const activeProfile = profile ?? process.env.ACTIVE_PROFILE ?? "core";
  console.log(`Seeding test data for profile: ${activeProfile} (mode: ${mode})`);

  // Collect user requirements from archetypes
  const userRequirements = collectUserRequirements();
  console.log(`Seeding ${userRequirements.size} user archetypes from seeder/archetypes.ts`);

  // --- Exit discipline -----------------------------------------------------
  // `--fresh` is what the gate and the matrix lane run: it must not report
  // success on a partial seed. Cleanup failures abort immediately (see above);
  // every other per-item failure is recorded and re-printed before a non-zero
  // exit. `--incremental` is the dev convenience and stays lenient.
  const strict = mode === "fresh";
  const failures: string[] = [];
  // undici hides the useful part (ECONNREFUSED, ENOTFOUND, cert errors) in
  // `cause`; a bare "fetch failed" tells an operator nothing.
  const describe = (err: unknown): string => {
    if (!(err instanceof Error)) return String(err);
    const cause: unknown = "cause" in err ? err.cause : undefined;
    const causeText = cause instanceof Error ? cause.message : cause ? String(cause) : "";
    return causeText && !err.message.includes(causeText) ? `${err.message} (${causeText})` : err.message;
  };
  const record = (step: string, err: unknown): void => {
    const line = `${step}: ${describe(err)}`;
    console.warn(`  ✗ ${line}`);
    if (strict) failures.push(line);
  };
  const abort = (step: string, err: unknown): never => {
    console.error(`✗ ${step}: ${describe(err)}`);
    console.error("  refusing to seed over unknown leftover state");
    process.exit(1);
  };

  // Seed OAuth2 clients with Hydra FIRST: fresh-mode tenant cleanup needs a
  // client-credentials token, and the svc client this upserts is where it comes
  // from (AUTH_CLIENT_ID/AUTH_CLIENT_SECRET are overrides, not prerequisites —
  // no Makefile target sets them, so cleanup must never be gated on them).
  let oauthClients: ManifestOauthClients | undefined;
  try {
    oauthClients = await seedClients();
  } catch (err) {
    record("register OAuth2 clients", err);
    console.warn(`  ⚠ Tenant creation and OIDC tests may fail without seeded clients`);
  }

  const svcClientId = process.env.AUTH_CLIENT_ID || oauthClients?.svc.clientId;
  const svcClientSecret = process.env.AUTH_CLIENT_SECRET || oauthClients?.svc.clientSecret;
  const tenantServiceDeclared = isServiceInProfile("tenant-service");

  /** Client-credentials token for the tenant admin API, minted once. */
  let svcTokenPromise: Promise<string> | undefined;
  const serviceToken = (): Promise<string> => {
    if (!svcTokenPromise) {
      svcTokenPromise = !svcClientId || !svcClientSecret
        ? Promise.reject(new Error("no svc client credentials (client registration failed and AUTH_CLIENT_ID/AUTH_CLIENT_SECRET are unset)"))
        : getServiceToken(svcClientId, svcClientSecret);
    }
    return svcTokenPromise;
  };

  // Fresh and purge modes delete first. Scope comes from seeder/ownership.ts:
  // the reserved `@test.example` namespace, widened by the ids our own previous
  // manifest recorded (that is what makes google-user, whose email is a real
  // Workspace account, deletable without ever inferring it from the address).
  // A declared tenant-service that cannot be cleaned is a failure, never a
  // silent skip.
  const previousManifest = readPreviousManifest();
  if (mode === "fresh" || mode === "purge") {
    const provenance: Provenance = provenanceFromManifest(previousManifest);
    try {
      await cleanupOwnedIdentities(provenance);
    } catch (err) {
      abort("identity cleanup failed", err);
    }
    if (tenantServiceDeclared) {
      try {
        await cleanupOwnedTenants(await serviceToken(), provenance);
      } catch (err) {
        abort("tenant cleanup failed (tenant-service is declared present)", err);
      }
    }
  }

  // Purge stops here: the deployment keeps its own users, and the manifest that
  // named ours is removed so nothing downstream reads identity ids that are
  // gone. The Hydra clients stay — they are upserted by fixed id, carry no user
  // data, and a deployment may legitimately still be serving them.
  if (mode === "purge") {
    const manifestPath = resolveManifestPath();
    if (fs.existsSync(manifestPath)) {
      fs.rmSync(manifestPath);
      console.log(`\nManifest removed: ${manifestPath}`);
    }
    console.log("✓ purge complete — test-plane records deleted, deployment left intact");
    return;
  }

  // In incremental mode, reuse the existing manifest to preserve TOTP secrets
  const existingManifest: Record<string, ManifestUser> = {};
  if (mode === "incremental" && previousManifest && typeof previousManifest === "object") {
    if ("users" in previousManifest && Array.isArray(previousManifest.users)) {
      for (const u of previousManifest.users) {
        existingManifest[u.ref] = u;
      }
    }
  }

  // Seed users
  const users: ManifestUser[] = [];
  for (const [ref, user] of userRequirements) {
    console.log(`  Creating user: ${ref}...`);
    try {
      let manifestUser: ManifestUser;

      if (mode === "incremental") {
        // In incremental mode, check if the user already exists
        const email = user.credentials.includes("oidc/google")
          ? GOOGLE_TEST_EMAIL!
          : user.credentials.includes("oidc/dex")
            ? DEX_USER_EMAIL
            : archetypeEmail(ref);
        const existingId = await findIdentityByEmail(email);

        if (existingId) {
          // User exists — build a manifest entry from the existing identity
          console.log(`  User ${ref} already exists (${email}), skipping creation`);

          // Preserve the existing TOTP secret and backup code from the previous manifest
          const existingEntry = existingManifest[ref];
          const preservedTotpSecret = existingEntry?.totpSecret ?? null;
          const preservedBackupCode = existingEntry?.backupCode;

          manifestUser = {
            ref,
            email,
            password: (user.credentials.includes("oidc/dex") || user.credentials.includes("oidc/google")) ? null : DEFAULT_TEST_PASSWORD,
            credentials: user.credentials,
            totpConfigured: user.totpConfigured,
            totpSecret: preservedTotpSecret,
            identityId: existingId,
            verified: true,
            ...(preservedBackupCode ? { backupCode: preservedBackupCode } : {}),
            ...(user.credentials.includes("oidc/dex")
              ? { dexEmail: DEX_USER_EMAIL, dexPassword: DEX_USER_PASSWORD }
              : {}),
          };

          // Backfill TOTP only if the user should have it but doesn't have a secret yet
          if (user.totpConfigured && !preservedTotpSecret && !localUsersEnabled()) {
            console.log(`  [seed] TOTP backfill skipped for ${ref}: local users disabled on this deployment`);
          } else if (user.totpConfigured && !preservedTotpSecret) {
            try {
              const needsBackupCodes = user.credentials.includes("lookup_secret");
              const result = await provisionTotp(email, DEFAULT_TEST_PASSWORD, existingId, needsBackupCodes, user.lowBackupCodes ?? false);
              manifestUser.totpSecret = result.totpSecret;
              if (result.backupCode) {
                manifestUser.backupCode = result.backupCode;
              }
              console.log(`  [seed] TOTP provisioned for ${ref} (backfill)`);
            } catch (err: unknown) {
              // Several expected scenarios when TOTP is already configured:
              // 1. createSessionToken throws "requires AAL2" — login succeeded but
              //    TOTP verification was required, meaning TOTP is already enrolled.
              // 2. initTotpSettingsFlow returns 403 "session_aal2_required" — same.
              // In both cases, the user already has TOTP configured and we can't
              // retrieve the existing secret via the API. The manifest will have
              // totpSecret: null, which means the runner will need to re-bootstrap.
              const msg = err instanceof Error ? err.message : String(err);
              if (msg.includes("AAL2") || msg.includes("aal2") || msg.includes("already") || msg.includes("422") || msg.includes("400") || msg.includes("403")) {
                console.log(`  [seed] TOTP already configured for ${ref} (cannot retrieve existing secret via API — manifest will have null totpSecret)`);
              } else {
                console.warn(`  ⚠ Failed to provision TOTP for ${ref} (backfill): ${err}`);
              }
            }
          }

          users.push(manifestUser);
          continue;
        }
      }

      manifestUser = await seedUser(ref, user);
      users.push(manifestUser);
      console.log(`  ✓ Created ${ref} (${manifestUser.email})`);
    } catch (err) {
      record(`create archetype ${ref}`, err);
    }
  }

  // Seed tenants (multi-tenant profiles only)
  const tenants: ManifestTenant[] = [];
  const memberships: ManifestMembership[] = [];

  if (tenantServiceDeclared) {
    let token: string | undefined;
    try {
      token = await serviceToken();
    } catch (err) {
      record("mint svc token for tenant seeding", err);
    }
    if (token) {
      // Create tenants for multi-tenant scenarios
      // Names carry TEST_TENANT_PREFIX so cleanup can recognise them as ours
      // on a deployment whose other tenants must survive (seeder/ownership.ts).
      const tenantDefs = [
        { ref: "alpha", name: `${TEST_TENANT_PREFIX}Alpha Inc` },
        { ref: "beta", name: `${TEST_TENANT_PREFIX}Beta LLC` },
        // Deliberately left with no members. multi-tenant-user belongs to both
        // of the above, so without a tenant that nobody is in, "the selection
        // page lists the user's tenants" and "lists every tenant that exists"
        // are the same set — and tenant enumeration would assert green.
        { ref: "gamma", name: `${TEST_TENANT_PREFIX}Gamma Ltd` },
      ];

      for (const td of tenantDefs) {
        try {
          const t = await createTenant(token, td.name);
          tenants.push({ ref: td.ref, name: td.name, id: t.id });
          console.log(`  ✓ Created tenant: ${td.name} (${t.id})`);
        } catch (err) {
          record(`create tenant ${td.name}`, err);
        }
      }

      // Provision users into tenants
      const provisionMap: Array<{ userRef: string; tenantRef: string; role: "owner" | "member" }> = [
        { userRef: "single-tenant-user", tenantRef: "alpha", role: "owner" },
        { userRef: "multi-tenant-user", tenantRef: "alpha", role: "owner" },
        { userRef: "multi-tenant-user", tenantRef: "beta", role: "member" },
      ];

      for (const pm of provisionMap) {
        const user = users.find((u) => u.ref === pm.userRef);
        const tenant = tenants.find((t) => t.ref === pm.tenantRef);
        if (!user || !tenant) {
          record(`provision ${pm.userRef} into ${pm.tenantRef}`, new Error(`${user ? "tenant" : "user"} was not seeded`));
          continue;
        }
        try {
          await provisionUser(token, tenant.id, user.email);
          memberships.push({ userRef: pm.userRef, tenantRef: pm.tenantRef, role: pm.role });
          user.tenantRefs = [...(user.tenantRefs ?? []), pm.tenantRef];
          console.log(`  ✓ Provisioned ${user.email} into ${tenant.name} as ${pm.role}`);
        } catch (err) {
          record(`provision ${user.email} into ${tenant.name}`, err);
        }
      }
    }
  }

  // Seed hook-service groups (profiles that deploy hook-service only).
  //
  // This is what makes the `groups` profile observably different from `core`:
  // Hydra calls hook-service's token hook on every issuance, and hook-service
  // stamps the member's group names into the `groups` claim (under `ext` for
  // access tokens). With no group seeded the hook runs but contributes nothing.
  const groups: ManifestGroup[] = [];

  if (isServiceInProfile("hook-service")) {
    if (oauthClients) {
      try {
        const token = await getHookAdminToken(oauthClients.hooks.clientId, oauthClients.hooks.clientSecret);

        for (const gd of HOOK_GROUP_DEFS) {
          const group = await ensureGroup(token, gd.name, gd.description);

          // hook-service keys membership on email, not on the Kratos identity ID.
          const members = users.filter((u) => gd.memberRefs.includes(u.ref));
          const added = await addUsersToGroup(token, group.id, members.map((u) => u.email));

          for (const member of members) {
            // Record what hook-service actually reports back, so the manifest
            // states observed state rather than an assumption.
            const memberGroups = await listUserGroups(token, member.email);
            member.groups = memberGroups.map((g) => g.name);
          }

          groups.push({ ref: gd.ref, name: group.name, id: group.id, members: members.map((u) => u.email) });
          console.log(
            `  ✓ Group ${group.name} (${group.id}): ${members.length} member(s), ${added.length} added this run`,
          );
        }
      } catch (err) {
        record("seed hook-service groups", err);
      }
    } else {
      record("seed hook-service groups", new Error("OAuth2 clients were not registered"));
    }
  }

  // Post-condition on the artifact, not on the steps that built it. TOTP
  // enrolment drives a live login + settings flow and its failure was only ever
  // a console.warn, so `--fresh` reported success while writing
  // `totpSecret: null` — and every MFA scenario then died on "totpSecret is
  // null in the manifest … re-seed", pointing the operator at the seeder
  // instead of at whatever actually broke (on a real deployment: a
  // KRATOS_PUBLIC_URL aimed at an ingress that fronts the login-ui BFF, which
  // serves no native /self-service/login/api at all). Checking the manifest
  // catches every route to a null secret, not just the one that warned.
  for (const [ref, archetype] of userRequirements) {
    if (!archetype.totpConfigured || !localUsersEnabled()) continue;
    const seeded = users.find((u) => u.ref === ref);
    if (seeded && seeded.totpSecret === null) {
      record(
        `provision TOTP for ${ref}`,
        new Error(
          "archetype declares totpConfigured but the manifest carries no secret — " +
          "KRATOS_PUBLIC_URL must serve kratos's own native API (/self-service/login/api)",
        ),
      );
    }
  }

  // Write manifest
  const manifest: Manifest = {
    profile: activeProfile,
    seededAt: new Date().toISOString(),
    users,
    tenants,
    memberships,
    groups,
    ...(oauthClients ? { oauthClients } : {}),
  };

  const manifestPath = resolveManifestPath();
  const dir = path.dirname(manifestPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  console.log(`\nManifest written to: ${manifestPath}`);
  console.log(
    `Users: ${users.length}, Tenants: ${tenants.length}, Memberships: ${memberships.length}, Groups: ${groups.length}`,
  );

  if (failures.length > 0) {
    console.error(`\n✗ seeding failed: ${failures.length} step(s) did not complete (--fresh is strict — a partial seed makes every downstream failure misattributable):`);
    for (const f of failures) console.error(`    ${f}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

// Parse args and run
const args = process.argv.slice(2);
let mode: SeedMode = "fresh";
let profile: string | undefined;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--fresh") mode = "fresh";
  else if (args[i] === "--incremental") mode = "incremental";
  else if (args[i] === "--purge") mode = "purge";
  else if (args[i] === "--profile" && args[i + 1]) profile = args[++i];
}

seed(mode, profile).catch((err) => {
  console.error("Seeding failed:", err);
  process.exit(1);
});
