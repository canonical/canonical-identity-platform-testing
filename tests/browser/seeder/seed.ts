// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

// Creates the archetype users via admin APIs and writes manifest.json, which the test runner
// reads instead of calling admin APIs. The manifest is SECRET-BEARING (passwords, TOTP secrets).
// Usage: npx tsx seeder/seed.ts [--fresh|--incremental|--purge] [--profile <name>]
//   --fresh        delete the test-plane's own records, then re-create them
//   --incremental  adopt whatever already exists (new random password each: Kratos never
//                  returns one), create only what is missing, keep recorded TOTP secrets
//   --purge        delete the test-plane's own records and stop (Hydra clients are never deleted)
// Deletes are scoped by seeder/ownership.ts. Out-of-band: point KRATOS_ADMIN_URL, HYDRA_ADMIN_URL
// and TENANT_SERVICE_URL at the deployment and set MANIFEST=<path> (tests/browser/LANES.md).

import * as fs from "node:fs";
import * as path from "node:path";

import { createIdentity, createIdentityWithOIDC, deleteIdentity, deleteIdentityCredentialType, findIdentityByEmail, deleteIdentitySessions, listIdentities, markVerified, createSessionToken, initTotpSettingsFlow, confirmTotpEnrollment, generateBackupCodes, burnBackupCodes, setIdentityPassword } from "../helpers/kratos";
import { generateTotpCode } from "../helpers/totp";
import { createTenant, deleteTenant, getServiceToken, listTenants, provisionUser } from "../helpers/tenants";
import { addUsersToGroup, ensureGroup, getHookAdminToken, listUserGroups } from "../helpers/hooks";
import { HYDRA_ADMIN_URL, activeConfig, isServiceInProfile, localUsersEnabled, GOOGLE_TEST_EMAIL, GOOGLE_TEST_SUBJECT_ID } from "../helpers/config";

import { USER_ARCHETYPES, type UserArchetype } from "./archetypes";

import {
  archetypeEmail,
  ownsIdentity,
  ownsTenant,
  provenanceFromManifest,
  TEST_TENANT_PREFIX,
  type Provenance,
} from "./ownership";

import { resolveManifestPath } from "../framework/manifest";

import { RP_CLIENT_PAYLOAD, SVC_CLIENT_PAYLOAD, HOOKS_ADMIN_CLIENT_PAYLOAD, type RegisteredClient } from "./clients";

import type { Manifest, ManifestUser, ManifestTenant, ManifestMembership, ManifestGroup, ManifestOauthClients } from "./manifest-schema";

import {
  DEX_USER_PASSWORD,
  generateTestPassword,
} from "../helpers/test-credentials";

// hook-service groups to seed. `returning-mfa` carries membership: no scenario deletes it or
// changes its email, and email is the key hook-service uses for membership.
const HOOK_GROUP_DEFS = [
  {
    ref: "platform-testers",
    name: "platform-testers",
    description: "Seeded by the browser test seeder to exercise Hydra's token hook",
    memberRefs: ["returning-mfa"],
  },
];

// --- Collect archetypes ---

function collectUserRequirements(): Map<string, UserArchetype> {
  const userMap = new Map<string, UserArchetype>();
  for (const archetype of USER_ARCHETYPES) {
    if (archetype.credentials.includes("oidc/google") && (!GOOGLE_TEST_EMAIL || !GOOGLE_TEST_SUBJECT_ID)) {
      console.log(`  Skipping ${archetype.ref}: GOOGLE_TEST_EMAIL and/or GOOGLE_TEST_SUBJECT_ID not set`);
      continue;
    }
    userMap.set(archetype.ref, archetype);
  }
  return userMap;
}

// --- Client registration ---

/** Upsert a single Hydra OAuth2 client (PUT to update, POST to create). */
async function upsertClient(payload: Record<string, unknown>): Promise<RegisteredClient> {
  const putRes = await fetch(`${HYDRA_ADMIN_URL}/admin/clients/${payload.client_id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (putRes.ok) {
    return (await putRes.json()) as RegisteredClient;
  }

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

// --- TOTP provisioning ---

// Why TOTP enrolment failed, per ref: the per-user seeders leave the cause here and the
// post-condition before the manifest write reports it.
const totpFailures = new Map<string, string>();

/** Drive a Kratos settings flow to enrol TOTP; returns the base32 secret and optionally a backup code. */
async function provisionTotp(
  email: string,
  password: string,
  identityId: string,
  withBackupCodes = false,
  lowBackupCodes = false,
): Promise<{ totpSecret: string; backupCode?: string }> {
  const sessionToken = await createSessionToken(email, password);

  const { flowId, totpSecret } = await initTotpSettingsFlow(sessionToken);

  const totpCode = await generateTotpCode(totpSecret);

  await confirmTotpEnrollment(flowId, sessionToken, totpCode);

  // Backup codes must use the SAME flow: once TOTP is configured a new settings flow needs AAL2.
  let backupCode: string | undefined;
  if (withBackupCodes) {
    try {
      const codes = await generateBackupCodes(flowId, sessionToken);
      if (codes.length > 0) {
        backupCode = codes[0];
        console.log(`  [seed] Generated ${codes.length} backup codes`);
      }
      if (lowBackupCodes && codes.length > 4) {
        // Leave exactly 4 unused; a scenario that spends one hits login-ui's regeneration prompt at 3.
        await burnBackupCodes(sessionToken, codes.slice(0, codes.length - 4));
        backupCode = codes[codes.length - 4];
        console.log(`  [seed] Burned ${codes.length - 4} backup codes (4 left)`);
      }
    } catch (err) {
      console.warn(`  ⚠ Failed to generate backup codes: ${err}`);
    }
  }

  await deleteIdentitySessions(identityId);

  return { totpSecret, backupCode };
}

async function seedPasswordUser(ref: string, user: UserArchetype): Promise<ManifestUser> {
  const email = archetypeEmail(ref);
  const password = generateTestPassword();
  const identityId = await createIdentity({
    email,
    password,
    name: "Test",
    surname: ref,
  });

  // Kratos creates identities unverified; mark verified unless the archetype opts out.
  const shouldVerify = user.verified !== false;
  if (shouldVerify) {
    await markVerified(identityId);
  }

  // lookup_secret WITHOUT totp is the post-unlink shape: Kratos only mints backup codes inside
  // TOTP enrolment, so enrol, generate the codes, then delete the totp credential.
  const totpUnlinked = user.credentials.includes("lookup_secret") && !user.credentials.includes("totp");
  let totpSecret: string | null = null;
  let backupCode: string | undefined;
  if ((user.totpConfigured || totpUnlinked) && !localUsersEnabled()) {
    // TOTP enrolment logs in with the password method, which is disabled without local users.
    console.log(`  [seed] TOTP skipped for ${ref}: local users disabled on this deployment`);
  } else if (user.totpConfigured || totpUnlinked) {
    try {
      const needsBackupCodes = user.credentials.includes("lookup_secret");
      const result = await provisionTotp(email, password, identityId, needsBackupCodes, user.lowBackupCodes ?? false);
      backupCode = result.backupCode;
      if (totpUnlinked) {
        await deleteIdentityCredentialType(identityId, "totp");
        console.log(`  [seed] TOTP provisioned then unlinked for ${ref} (backup codes remain)`);
      } else {
        totpSecret = result.totpSecret;
        console.log(`  [seed] TOTP provisioned for ${ref}`);
      }
    } catch (err) {
      // Keep the cause; the post-condition before the manifest write reports it verbatim.
      totpFailures.set(ref, err instanceof Error ? err.message : String(err));
      console.warn(`  ⚠ Failed to provision TOTP for ${ref}: ${err}`);
    }
  }

  return {
    ref,
    email,
    password,
    credentials: user.credentials,
    totpConfigured: user.totpConfigured,
    totpSecret,
    identityId,
    verified: shouldVerify,
    ...(backupCode ? { backupCode } : {}),
  };
}

/** Kratos's OIDC subject for a dex static account: base64url of the protobuf IDTokenSubject
 *  `{user_id, conn_id}` (dexidp/dex server/internal/types.proto): `0a <len> <userID> 12 05 local`. */
export function dexSubject(userId: string): string {
  return Buffer.concat([
    Buffer.from([0x0a, userId.length]),
    Buffer.from(userId),
    Buffer.from([0x12, 5]),
    Buffer.from("local"),
  ]).toString("base64");
}

async function seedDexUser(ref: string, user: UserArchetype): Promise<ManifestUser> {
  if (!user.dexUserId) throw new Error(`archetype ${ref} declares oidc/dex but no dexUserId (docker/dex/config.yml userID)`);
  const email = archetypeEmail(ref);
  const identityId = await createIdentityWithOIDC({
    email,
    provider: "dex",
    subject: dexSubject(user.dexUserId),
  });

  await markVerified(identityId);

  return {
    ref,
    email,
    password: null,
    credentials: ["oidc/dex"],
    totpConfigured: false,
    totpSecret: null,
    identityId,
    verified: true,
    dexEmail: email,
    dexPassword: DEX_USER_PASSWORD,
  };
}

async function seedGoogleUser(ref: string): Promise<ManifestUser> {
  if (!GOOGLE_TEST_EMAIL || !GOOGLE_TEST_SUBJECT_ID) {
    throw new Error(
      "Cannot seed google-user: GOOGLE_TEST_EMAIL and GOOGLE_TEST_SUBJECT_ID environment variables are required. " +
      "Set them and re-run the seeder.",
    );
  }

  // Charmed deployments register `google_canonical`; compose registers `google`.
  const provider = (activeConfig().oidc_providers ?? []).find((p) => p.startsWith("google")) ?? "google";
  const identityId = await createIdentityWithOIDC({
    email: GOOGLE_TEST_EMAIL,
    provider,
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

async function seedUser(ref: string, user: UserArchetype): Promise<ManifestUser> {
  if (user.credentials.includes("oidc/google")) {
    return seedGoogleUser(ref);
  }
  if (user.credentials.includes("oidc/dex")) {
    return seedDexUser(ref, user);
  }
  return seedPasswordUser(ref, user);
}

// --- Cleanup (fresh and purge modes) ---
// Cleanup failures are FATAL: seeding over unknown leftovers makes every downstream failure
// misattributable. Deletion is scoped by seeder/ownership.ts; foreign records are counted,
// reported and never touched.

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

// --- Main seeder ---

type SeedMode = "fresh" | "incremental" | "purge";

/** Never throws: an absent or corrupt manifest means no provenance and no preserved TOTP secrets. */
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

  const userRequirements = collectUserRequirements();
  console.log(`Seeding ${userRequirements.size} user archetypes from seeder/archetypes.ts`);

  // `--fresh` (what the gate and the matrix lane run) must not report success on a partial seed:
  // per-item failures are recorded and exit non-zero. `--incremental` stays lenient.
  const strict = mode === "fresh";
  const failures: string[] = [];
  // undici hides ECONNREFUSED/ENOTFOUND/cert errors in `cause`; a bare "fetch failed" says nothing.
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

  // Clients first: fresh-mode tenant cleanup needs a token from the svc client upserted here.
  // AUTH_CLIENT_ID/AUTH_CLIENT_SECRET are overrides, not prerequisites; cleanup never gates on them.
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

  let svcTokenPromise: Promise<string> | undefined;
  const serviceToken = (): Promise<string> => {
    if (!svcTokenPromise) {
      svcTokenPromise = !svcClientId || !svcClientSecret
        ? Promise.reject(new Error("no svc client credentials (client registration failed and AUTH_CLIENT_ID/AUTH_CLIENT_SECRET are unset)"))
        : getServiceToken(svcClientId, svcClientSecret);
    }
    return svcTokenPromise;
  };

  // Scope from seeder/ownership.ts: the reserved namespace plus ids our previous manifest recorded
  // (how google-user, a real Workspace address, stays deletable). A declared tenant-service that
  // cannot be cleaned is a failure, never a silent skip.
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

  // Purge stops here and removes the manifest naming our ids. Hydra clients are NEVER deleted:
  // upserted by fixed id, no user data, and a deployment may still be serving them.
  if (mode === "purge") {
    const manifestPath = resolveManifestPath();
    if (fs.existsSync(manifestPath)) {
      fs.rmSync(manifestPath);
      console.log(`\nManifest removed: ${manifestPath}`);
    }
    console.log("✓ purge complete — test-plane records deleted, deployment left intact");
    return;
  }

  const existingManifest: Record<string, ManifestUser> = {};
  if (mode === "incremental" && previousManifest && typeof previousManifest === "object") {
    if ("users" in previousManifest && Array.isArray(previousManifest.users)) {
      for (const u of previousManifest.users) {
        existingManifest[u.ref] = u;
      }
    }
  }

  const users: ManifestUser[] = [];
  for (const [ref, user] of userRequirements) {
    console.log(`  Creating user: ${ref}...`);
    try {
      let manifestUser: ManifestUser;

      if (mode === "incremental") {
        const email = user.credentials.includes("oidc/google")
          ? GOOGLE_TEST_EMAIL!
          : archetypeEmail(ref);
        const existingId = await findIdentityByEmail(email);

        if (existingId) {
          console.log(`  User ${ref} already exists (${email}), skipping creation`);

          const existingEntry = existingManifest[ref];
          const preservedTotpSecret = existingEntry?.totpSecret ?? null;
          const preservedBackupCode = existingEntry?.backupCode;

          // Kratos never returns a password, so an adopted identity gets a fresh one: the manifest
          // stays authoritative, and a deployment seeded before passwords were random loses the
          // public one. OIDC identities carry an unused password credential (the identifier-first
          // lookup needs it); it is rotated too, and not recorded.
          const oidcOnly = user.credentials.includes("oidc/dex") || user.credentials.includes("oidc/google");
          const password = generateTestPassword();
          await setIdentityPassword(existingId, password);

          manifestUser = {
            ref,
            email,
            password: oidcOnly ? null : password,
            credentials: user.credentials,
            totpConfigured: user.totpConfigured,
            totpSecret: preservedTotpSecret,
            identityId: existingId,
            verified: true,
            ...(preservedBackupCode ? { backupCode: preservedBackupCode } : {}),
            ...(user.credentials.includes("oidc/dex")
              ? { dexEmail: email, dexPassword: DEX_USER_PASSWORD }
              : {}),
          };

          if (user.totpConfigured && !preservedTotpSecret && !localUsersEnabled()) {
            console.log(`  [seed] TOTP backfill skipped for ${ref}: local users disabled on this deployment`);
          } else if (user.totpConfigured && !preservedTotpSecret) {
            try {
              const needsBackupCodes = user.credentials.includes("lookup_secret");
              const result = await provisionTotp(email, password, existingId, needsBackupCodes, user.lowBackupCodes ?? false);
              manifestUser.totpSecret = result.totpSecret;
              if (result.backupCode) {
                manifestUser.backupCode = result.backupCode;
              }
              console.log(`  [seed] TOTP provisioned for ${ref} (backfill)`);
            } catch (err: unknown) {
              // AAL2-required / 403 means TOTP is already enrolled and the secret cannot be read back;
              // the manifest keeps totpSecret: null and the runner re-bootstraps.
              const msg = err instanceof Error ? err.message : String(err);
              if (msg.includes("AAL2") || msg.includes("aal2") || msg.includes("already") || msg.includes("422") || msg.includes("400") || msg.includes("403")) {
                console.log(`  [seed] TOTP already configured for ${ref} (cannot retrieve existing secret via API — manifest will have null totpSecret)`);
              } else {
                totpFailures.set(ref, msg);
                console.warn(`  ⚠ Failed to provision TOTP for ${ref} (backfill): ${err}`);
              }
            }
          }
          // Backfill the unlinked-TOTP shape when the previous manifest has no backup code: the runner
          // resolves unused codes via the admin API, but an identity with NO lookup_secret is fatal.
          const totpUnlinked = user.credentials.includes("lookup_secret") && !user.credentials.includes("totp");
          if (totpUnlinked && !preservedBackupCode && localUsersEnabled()) {
            try {
              const result = await provisionTotp(email, password, existingId, true, user.lowBackupCodes ?? false);
              await deleteIdentityCredentialType(existingId, "totp");
              if (result.backupCode) {
                manifestUser.backupCode = result.backupCode;
              }
              console.log(`  [seed] TOTP provisioned then unlinked for ${ref} (backfill)`);
            } catch (err: unknown) {
              totpFailures.set(ref, err instanceof Error ? err.message : String(err));
              console.warn(`  ⚠ Failed to provision unlinked-TOTP shape for ${ref} (backfill): ${err}`);
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
      // Names carry TEST_TENANT_PREFIX so cleanup can recognise them as ours (seeder/ownership.ts).
      const tenantDefs = [
        { ref: "alpha", name: `${TEST_TENANT_PREFIX}Alpha Inc` },
        { ref: "beta", name: `${TEST_TENANT_PREFIX}Beta LLC` },
        // gamma has no members: otherwise "lists the user's tenants" and "lists every tenant"
        // are the same set and tenant enumeration would assert green.
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

      const provisionMap: Array<{ userRef: string; tenantRef: string; role: "owner" | "member" }> = [
        { userRef: "single-tenant-user", tenantRef: "alpha", role: "owner" },
        { userRef: "multi-tenant-user", tenantRef: "alpha", role: "owner" },
        { userRef: "multi-tenant-user", tenantRef: "beta", role: "member" },
        { userRef: "dex-single-tenant-user", tenantRef: "alpha", role: "member" },
        { userRef: "dex-multi-tenant-user", tenantRef: "alpha", role: "member" },
        { userRef: "dex-multi-tenant-user", tenantRef: "beta", role: "member" },
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

  // hook-service groups: Hydra's token hook stamps member group names into the `groups` claim
  // (under `ext` for access tokens); with none seeded the hook runs but contributes nothing.
  const groups: ManifestGroup[] = [];

  if (isServiceInProfile("hook-service")) {
    if (oauthClients) {
      try {
        const token = await getHookAdminToken(oauthClients.hooks.clientId, oauthClients.hooks.clientSecret);

        for (const gd of HOOK_GROUP_DEFS) {
          const group = await ensureGroup(token, gd.name, gd.description);

          // hook-service keys membership on email, not on the Kratos identity id.
          const members = users.filter((u) => gd.memberRefs.includes(u.ref));
          const added = await addUsersToGroup(token, group.id, members.map((u) => u.email));

          for (const member of members) {
            // Record what hook-service reports back, not what was requested.
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

  // Post-condition on the artifact: any route to `totpSecret: null` fails `--fresh`, not just the
  // one that warned. Gated on the declaration: a deployment without totp (core, mfa=off ⇒
  // methods_2fa: []) legitimately renders a settings flow with no totp node.
  const totpDeclared = (activeConfig().methods_2fa ?? []).includes("totp");
  for (const [ref, archetype] of userRequirements) {
    if (!archetype.totpConfigured || !localUsersEnabled() || !totpDeclared) continue;
    const seeded = users.find((u) => u.ref === ref);
    if (seeded && seeded.totpSecret === null) {
      record(
        `provision TOTP for ${ref}`,
        new Error(
          totpFailures.get(ref) ??
            "the manifest carries no secret and enrolment reported no error — " +
              "the archetype was neither enrolled nor skipped",
        ),
      );
    }
  }

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

// --- CLI entry point ---
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
