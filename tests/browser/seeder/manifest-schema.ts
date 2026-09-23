// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

export interface ManifestUser {
  ref: string;
  email: string;
  password: string | null;
  /** Kratos credential types, e.g. ["password", "totp"] or ["oidc/dex"]. */
  credentials: string[];
  totpConfigured: boolean;
  totpSecret: string | null;
  identityId: string;
  verified: boolean;
  dexEmail?: string;
  dexPassword?: string;
  backupCode?: string;
  tenantRefs?: string[];
  /** hook-service group names: the `groups` claim the token hook should emit. Only on hook-service profiles. */
  groups?: string[];
}

export interface ManifestTenant {
  ref: string;
  name: string;
  id: string;
}

export interface ManifestGroup {
  ref: string;
  name: string;
  id: string;
  /** Emails — hook-service keys membership on email. */
  members: string[];
}

export interface ManifestMembership {
  userRef: string;
  tenantRef: string;
  role: "owner" | "member";
}

export interface ManifestOauthClientRp {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface ManifestOauthClientSvc {
  clientId: string;
  clientSecret: string;
}

export interface ManifestOauthClients {
  rp: ManifestOauthClientRp;
  svc: ManifestOauthClientSvc;
  /** Client-credentials client scoped `hook-service:admin`, used to seed groups. */
  hooks: ManifestOauthClientSvc;
}

export interface Manifest {
  profile: string;
  seededAt: string;
  users: ManifestUser[];
  tenants: ManifestTenant[];
  memberships: ManifestMembership[];
  groups: ManifestGroup[];
  oauthClients?: ManifestOauthClients;
}
