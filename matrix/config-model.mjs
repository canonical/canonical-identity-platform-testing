// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0
//
// Operator-producible configuration model of the Canonical Identity Platform.
//
// This file is DATA (same philosophy as scenarios-as-data): it declares the
// dimensions a Juju deployment of the platform can actually vary, the
// constraints between them, and the named configurations we pin. It is the
// single source of truth for `matrix/generate.mjs`, which emits the pairwise
// covering array in `matrix/matrix.json` and the materialized compose rows
// under `matrix/rows/`.
//
// Ground rules:
//  - A dimension exists here ONLY if a charm option or relation can produce
//    it. Raw-service knobs the charms never render are out (see harnessGaps
//    and upstreamFindings for the audit trail).
//  - Every value and constraint cites the operator source it was read from.
//    Every upstream citation below is COMMIT-PINNED as `<org>/<repo>@<sha>
//    <path>:<lines>` and was re-verified against raw.githubusercontent.com at
//    that sha. The survey date 2026-08-01 is CONTEXT ONLY: it is how the shas
//    were chosen (default-branch HEAD at or before that date), not what
//    anchors a citation. Resolve any citation with
//    https://github.com/<org>/<repo>/blob/<sha>/<path>#L<lines>.
//
//    Pin table (short sha -> what it is; `j2` abbreviates
//    templates/kratos.yaml.j2, as used inline below):
//      canonical/kratos-operator                      @99da536  2026-07-31
//      canonical/hydra-operator                       @f7e000b  2026-07-31
//      canonical/identity-platform-login-ui-operator  @b8497db  2026-07-31
//      canonical/hook-service-operator                @186d47f  2026-07-31
//      canonical/user-verification-service-operator   @6f89b99  2026-07-31
//      canonical/kratos-external-idp-integrator       @7219838  2026-07-31
//      canonical/iam-bundle-integration               @74b2ea1  2026-07-13
//      canonical/identity-platform-login-ui           @197703c  tag v0.28.0 (the workload image the stack runs)
//      ory/kratos                                     @64e04ac  tag v25.4.0 — the exact source
//        ghcr.io/canonical/kratos:25.4.0 is built from (canonical/kratos-rock@6edfdb3
//        rockcraft.yaml: `source: https://github.com/ory/kratos`, `source-tag: v25.4.0`).
//        There is no separate Canonical kratos source fork; the rock builds upstream.

export const model = {
  version: 1,

  // ── Dimensions ────────────────────────────────────────────────────────────
  // Order is canonical: generators and row names use it.
  dimensions: [
    {
      id: "local_idp",
      values: ["on", "off"],
      source:
        "canonical/kratos-operator@99da536 charmcraft.yaml:129-132 `enable_local_idp` (charm default true; terraform module default FALSE — canonical/kratos-operator@99da536 terraform/variables.tf:17-20)",
      effect:
        "Drives kratos methods password/profile/code, recovery+verification flows, and (with mfa) totp/lookup_secret — canonical/kratos-operator@99da536 templates/kratos.yaml.j2:221-256,144,154",
    },
    {
      id: "mfa",
      values: ["enforced", "off"],
      source: "canonical/kratos-operator@99da536 charmcraft.yaml:133-138 `enforce_mfa` (default true)",
      effect:
        "totp iff local_idp∧mfa (canonical/kratos-operator@99da536 j2:241-251); lookup_secret iff sequencing∨(mfa∧local_idp) (canonical/kratos-operator@99da536 j2:253-256); SESSION_WHOAMI_REQUIRED_AAL=highest_available iff sequencing∨(local_idp∧mfa) (canonical/kratos-operator@99da536 src/configs.py:122-126). Published to login-ui as `mfa_enabled` over kratos-info (canonical/kratos-operator@99da536 src/charm.py:678, sent at :693).",
    },
    {
      id: "verification",
      values: ["on", "off"],
      source: "canonical/kratos-operator@99da536 charmcraft.yaml:139-145 `enable_verification` (default false)",
      effect:
        "flows.verification.enabled iff verification∧local_idp (canonical/kratos-operator@99da536 j2:154-161); registration gains show_verification_ui hooks (canonical/kratos-operator@99da536 j2:188-190,212-214). Published to login-ui as `verification_enabled` (canonical/kratos-operator@99da536 src/charm.py:680, sent at :695).",
    },
    {
      id: "webauthn",
      values: ["none", "passwordless", "sequencing"],
      source:
        "canonical/kratos-operator@99da536 charmcraft.yaml:156-167 `enable_passwordless_login_method` / `enable_oidc_webauthn_sequencing`. Mutual exclusion enforced: canonical/kratos-operator@99da536 src/utils.py:114-124 (`passwordless_config_is_valid`, a NOOP_CONDITION at :136) → BlockedStatus. Enum encodes that structurally.",
      effect:
        "webauthn method iff value≠none (canonical/kratos-operator@99da536 j2:257-259); passwordless flag = (value==passwordless) (canonical/kratos-operator@99da536 j2:260-265); sequencing additionally forces lookup_secret + required_aal and is published to login-ui as `oidc_webauthn_sequencing_enabled` (canonical/kratos-operator@99da536 src/charm.py:679, sent at :694). NOTE: kratos itself has no sequencing knob — there is no Canonical kratos source fork; ghcr.io/canonical/kratos:25.4.0 builds straight from upstream (canonical/kratos-rock@6edfdb3 rockcraft.yaml pins `ory/kratos` `source-tag: v25.4.0`), and `grep -ri sequencing` at ory/kratos@64e04ac: 0 matches across all 7787 files, including the authoritative config schema embedx/config.schema.json. Sequencing UX is login-ui-side.",
    },
    {
      id: "providers",
      values: ["0", "1", "2"],
      source:
        "one provider per integrator app — canonical/kratos-external-idp-integrator@7219838 src/charm.py:57 validates `[self.config]`, a single-element list; kratos requires kratos-external-idp with NO limit (canonical/kratos-operator@99da536 charmcraft.yaml:29-32) → 0..N apps. canonical/iam-bundle-integration@74b2ea1 variables.tf:6-10 defaults the integrator OFF (enable_kratos_external_idp_integrator=false) → providers=0 is a first-class shipped shape. 2 stands in for N.",
      effect:
        "oidc method iff providers>0 (canonical/kratos-operator@99da536 j2:272-286). Harness mapping: 0 → base kratos.yml only; 1 → +kratos.dex.yml (dex); 2 → +kratos.google.yml (dex+google).",
    },
    {
      id: "tenant_service",
      values: ["present", "absent"],
      source:
        "Add-on charm; absent from iam-bundle and the TF root module (canonical/iam-bundle-integration@74b2ea1 applications.tf declares no tenant-service), present in canonical/iam-bundle-integration@74b2ea1 examples/multitenancy/main.tf:116-126. login-ui: MULTI_TENANCY_ENABLED=True iff tenant-service-info relation ready (canonical/identity-platform-login-ui-operator@b8497db src/services.py:115-117).",
      effect: "Multi-tenancy on/off. Also widens the hook-service claim list when hook_service is present.",
    },
    {
      id: "hook_service",
      values: ["present", "absent"],
      source:
        "Add-on charm (canonical/iam-bundle-integration@74b2ea1 examples/custom-claims/main.tf:83-92). Token hook is pure relation topology: hook-service provides hydra-token-hook, hydra requires it (canonical/hydra-operator@f7e000b charmcraft.yaml:59-61; canonical/hook-service-operator@186d47f charmcraft.yaml:297-300). No config knob exists on either side.",
      effect:
        "hydra oauth2.token_hook + allowed_top_level_claims=[groups] rendered iff related (canonical/hydra-operator@f7e000b templates/hydra.yaml.j2:29-49); claims += tenant_id iff hook↔tenant-service also related (canonical/hook-service-operator@186d47f src/integrations.py:141-143).",
    },
    {
      id: "user_verification",
      values: ["present", "absent"],
      source:
        "Add-on charm (canonical/iam-bundle-integration@74b2ea1 examples/user-verification/main.tf:86-96). Provides kratos-registration-webhook + its error page via registration-endpoint-info (canonical/user-verification-service-operator@6f89b99 charmcraft.yaml:94-112).",
      effect:
        "Registration gains a verify webhook (/api/v0/verify). HARNESS GAP: the compose stack deploys the service but does not wire the kratos registration webhook (list-typed config; not expressible as env) — presence-only today, matching the existing profiles.",
    },
    {
      id: "access_token",
      values: ["jwt", "opaque"],
      source:
        "canonical/hydra-operator@f7e000b charmcraft.yaml:95-99 `jwt_access_tokens` (default true) → strategies.access_token (canonical/hydra-operator@f7e000b src/configs.py:77; rendered by canonical/hydra-operator@f7e000b templates/hydra.yaml.j2:51-52)",
      effect:
        "Token shape seen by relying parties. The browser suite's access-token claim assertions decode JWTs; opaque rows exercise the introspection-only contract. No existing profile varies this.",
    },
  ],

  // ── Constraints ───────────────────────────────────────────────────────────
  // A row is invalid if ALL key:value entries of any `forbid` match.
  constraints: [
    {
      id: "no-login-methods",
      forbid: { local_idp: "off", providers: "0" },
      reason:
        "No 1FA method at all — kratos renders neither password nor oidc. Producible (no charm guard exists) but degenerate: nothing can authenticate, no scenario can run.",
      evidence: "canonical/kratos-operator@99da536 j2:238-240 + :272; no guard in canonical/kratos-operator@99da536 src/utils.py:128-137 NOOP_CONDITIONS",
    },
    {
      id: "passwordless-needs-local-idp",
      forbid: { webauthn: "passwordless", local_idp: "off" },
      reason:
        "Documented requirement, NOT enforced in charm code — the template still renders webauthn passwordless with local idp off. Excluded as documented-invalid; candidate negative test.",
      evidence: "canonical/kratos-operator@99da536 charmcraft.yaml:158 (doc: `Requires `enable_local_idp=True``); canonical/kratos-operator@99da536 j2:257 renders regardless",
    },
    {
      id: "passwordless-unmaintained-upstream",
      forbid: { webauthn: "passwordless", local_idp: "on" },
      reason:
        "Kratos passkeys as a FIRST factor (webauthn passwordless) are not actively maintained upstream (team decision 2026-08-03) and the shape is broken in practice: on the charm-rendered kratos v26 config, webauthn-1FA flow creation and recovery both return HTTP 400 (row-loop preflight refusal, mx-l1m0v0wpp0t1h1u1ao). Together with passwordless-needs-local-idp this retires the value from the generated space — the charm option itself still exists, so the dimension keeps documenting it. Re-enable by deleting this constraint when upstream picks passkeys back up.",
      evidence: "verify.mjs behavior probes: 'webauthn 1FA enabled — credential step lacks webauthn (HTTP 400)', 'recovery flow enabled — HTTP 400' (2026-08-03 loop)",
    },
    {
      id: "sequencing-needs-oidc",
      forbid: { webauthn: "sequencing", providers: "0" },
      reason:
        "OIDC→WebAuthn sequencing without any OIDC provider is meaningless; charm does not guard it. Excluded as intent-invalid; candidate negative test.",
      evidence: "no provider-count condition in canonical/kratos-operator@99da536 src/utils.py:127-137 NOOP_CONDITIONS",
    },
    {
      id: "verification-needs-local-idp",
      forbid: { verification: "on", local_idp: "off" },
      reason:
        "Charm silently drops verification without local idp (template gate requires both), so the combination aliases verification=off. Excluded to avoid burning a row on an alias.",
      evidence: "canonical/kratos-operator@99da536 j2:154 `enable_verification and enable_local_idp`; canonical/kratos-operator@99da536 j2:233 code method gate",
    },
  ],

  // ── Pinned rows: the three gate profiles, in model coordinates ────────────
  // First-class MATERIALIZED rows: `make matrix-generate` emits
  // matrix/rows/<name>/docker-compose.override.yml + capabilities.json for
  // them exactly like seed/generated rows, and `make gate PROFILE=<name>`
  // consumes those artifacts (the hand-written profiles/ tree is retired).
  // They are counted as already-covered pairs (the gate runs them per-PR).
  // `webauthn: null` means the profile's real deployment holds a value the
  // operators cannot produce — webauthn enabled as a pure second factor
  // (passwordless:false, no sequencing). The materializer renders that shape
  // (see derive() in lib.mjs) but it contributes NO pair coverage.
  // `divergences` is the machine-readable audit: residual deltas between the
  // materialized row and the retired hand-written override, plus anything
  // still off-model.
  pinned: [
    {
      name: "core",
      dims: {
        local_idp: "on",
        mfa: "off",
        verification: "on",
        webauthn: null,
        providers: "1",
        tenant_service: "absent",
        hook_service: "absent",
        user_verification: "absent",
        access_token: "jwt",
      },
      divergences: [
        "webauthn: null — kratos webauthn stays enabled with passwordless:false and no sequencing, matching the retired hand-written override and base kratos.yml; not charm-producible (webauthn iff passwordless∨sequencing, canonical/kratos-operator@99da536 j2:257-259), so no pair credit.",
        "Intentional residual delta vs the retired profiles/core override: the materialized row sets SELFSERVICE_METHODS_TOTP_ENABLED=false, SELFSERVICE_METHODS_LOOKUP_SECRET_ENABLED=false and SESSION_WHOAMI_REQUIRED_AAL=aal1 — the charm-faithful enforce_mfa=false shape (canonical/kratos-operator@99da536 j2:246-256; canonical/kratos-operator@99da536 src/configs.py:122-126). The hand-written override silently inherited totp+lookup_secret+highest_available from base kratos.yml, off-model; convergence makes the model win.",
      ],
    },
    {
      name: "canonical-internal",
      dims: {
        local_idp: "on",
        mfa: "enforced",
        verification: "on",
        webauthn: "sequencing",
        providers: "2",
        tenant_service: "absent",
        hook_service: "present",
        user_verification: "present",
        access_token: "jwt",
      },
      divergences: [
        "Intentional residual delta vs the retired profiles/canonical-internal override: SELFSERVICE_METHODS_OIDC_SEQUENCING_ENABLED is DROPPED — a no-op the hand-written override carried: kratos has no such key and the charm never sets it. `grep -ri sequencing` at ory/kratos@64e04ac (tag v25.4.0, the exact source of the ghcr.io/canonical/kratos:25.4.0 image this stack runs — canonical/kratos-rock@6edfdb3 rockcraft.yaml): 0 matches across all 7787 files, embedx/config.schema.json included, so the env var binds to nothing. Sequencing is fully expressed by method config + the login-ui flag.",
        "Intentional residual delta: OAUTH2_ALLOWED_TOP_LEVEL_CLAIMS=groups is now set explicitly (charm renders allowed_top_level_claims from the relation claim list — canonical/hydra-operator@f7e000b templates/hydra.yaml.j2:29-49); the hand-written override omitted it.",
      ],
    },
    {
      name: "canonical-portal",
      dims: {
        local_idp: "on",
        mfa: "enforced",
        verification: "on",
        webauthn: null,
        providers: "1",
        tenant_service: "present",
        hook_service: "present",
        user_verification: "present",
        access_token: "jwt",
      },
      divergences: [
        "webauthn: null — runs webauthn as a pure second factor (enabled, passwordless:false, no sequencing); kratos-operator cannot produce that combination (canonical/kratos-operator@99da536 j2:257-259; recorded as a divergence here). No pair credit.",
        "Intentional residual delta vs the retired profiles/canonical-portal override: SELFSERVICE_METHODS_WEBAUTHN_CONFIG_RP_DISPLAY_NAME='Canonical Portal' is DROPPED — cosmetic only; base kratos.yml ships display_name 'Canonical' and no charm option renders a per-deployment display name.",
        "Intentional residual delta: OAUTH2_ALLOWED_TOP_LEVEL_CLAIMS is now set explicitly (charm renders it from the hook-service relations — canonical/hook-service-operator@186d47f src/integrations.py:141-143); the hand-written override omitted it. With tenant_service=absent the rendered value is `groups` alone — `tenant_id` returns when MT does.",
        "tenant_service: present — RESTORED 2026-08-14, PD-1 UNBLOCKED. The blocker was that the only published artifact (ghcr.io/canonical/tenant-service:v0.2.0, release commit canonical/tenant-service@de1d521 2026-04-28) predated canonical/tenant-service@e2cb03b `fix: add interceptors`, so its gRPC interceptor demanded a bearer token on LookupTenants while login-ui v0.28.0 sends none — enabling MT 500'd every login. v0.3.1 (tagged 2026-08-13) contains it: `compare/e2cb03b...v0.3.1` reports ahead_by 12 / behind_by 0, pkg/authentication/middleware.go:197-217 adds GRPCInterceptorExcluding, and cmd/serve.go:194-196 passes exactly \"/identity.platform.api.tenant.TenantService/LookupTenants\" — per-method, with the rest of the API still authenticated. The compose pin is now v0.3.1@sha256:2aef7ec80703d7f460665413a0a9d0d9f2c872c5c25076c262d035813a0ed62d. The local-rock workaround that once hid this stays deleted (decision D-2 — no machine-local artifact may be load-bearing); this is a published image.",
      ],
    },
  ],

  // ── Seed rows: mandatory generated rows ───────────────────────────────────
  // Every configuration-interaction defect found in the field gets its cell
  // seeded here permanently — deployment-level regression pinning.
  seeds: [
    {
      name: "pd931-single-oidc-mt",
      reason:
        "login-ui#931: single 1FA option + sequencing auto-forwards to the provider (canonical/identity-platform-login-ui@197703c ui/pages/login.tsx:469-485 — `// automatically forward to single oidc provider if it is the only option`), skipping the identifier-first page and with it tenant selection (tenant-selection sits between login-email and login-password). Charm-producible: enable_local_idp=false is even the TF module default.",
      dims: {
        local_idp: "off",
        mfa: "enforced",
        verification: "off",
        webauthn: "sequencing",
        providers: "1",
        tenant_service: "present",
        hook_service: "absent",
        user_verification: "absent",
        access_token: "jwt",
      },
    },
    {
      name: "tfdefault-oidc-only",
      reason:
        "The iam-bundle-integration root module's default shape: no local idp (canonical/kratos-operator@99da536 terraform/variables.tf:17-20), one external provider (canonical/iam-bundle-integration@74b2ea1 variables.tf:6-10 ships the integrator off, so this is the shape the moment it is enabled), no add-ons. The most common real deployment start-point; no gate profile resembles it.",
      dims: {
        local_idp: "off",
        mfa: "enforced",
        verification: "off",
        webauthn: "none",
        providers: "1",
        tenant_service: "absent",
        hook_service: "absent",
        user_verification: "absent",
        access_token: "jwt",
      },
    },
    {
      name: "deployed-core-local-mfa",
      reason:
        "The shape of the internal charmed CORE deployments, verified against https://iam.orange.canonical.com: local idp on with MFA enforced (app-config flags [password, totp, backup_codes]), one external IdP (Google via kratos-external-idp-integrator, rendering google_canonical on registration and login flows), no add-on charms, and no mailslurper/dex (mail_api=false). " +
        "The target is deployed by canonical/cd-identity-core-infrastructure#61 (merged 2026-08-21): orange-core.tfvars pins external_hostname = iam.orange.canonical.com, and orange-iam/main.tf sources iam-bundle-integration?ref=istio with enable_kratos_external_idp_integrator = true (provider google / provider_id google_canonical), which matches all 9 dimensions.",
      dims: {
        local_idp: "on",
        mfa: "enforced",
        verification: "off",
        webauthn: "none",
        providers: "1",
        tenant_service: "absent",
        hook_service: "absent",
        user_verification: "absent",
        access_token: "jwt",
      },
      // Row-level truths that are NOT dimensions because no charm option or
      // relation produces them — they are properties of the TARGET, not of the
      // platform's configuration space (the `mail_api` case harnessGaps already
      // described as "hand-writes mail_api=false").
      caps: {
        mail_api: false,
        services: ["kratos", "hydra", "login-ui"],
        oidc_providers: ["google_canonical"],
      },
      // Values this row DECLARES but the target could not initially be asked
      // about through a public ingress. Two have since become MEASURED:
      //  - verification=off: chosen to match the charm default
      //    (canonical/kratos-operator@99da536 charmcraft.yaml:139-145
      //    `enable_verification`, default false); mail_api=false gates every
      //    verification and recovery journey off regardless, so the dim does
      //    not move the executed set. Still unverifiable from outside.
      //  - access_token=jwt: MEASURED 2026-08-26 — with a seed manifest the
      //    preflight mints client_credentials with the manifest's svc client
      //    and the orange token is a decodable JWT (matrix/verify.mjs,
      //    "minted with the manifest's svc client"). Also the hydra charm
      //    default (canonical/hydra-operator@f7e000b charmcraft.yaml:95-99).
      //  - tenant_service=absent: MEASURED after the 2026-08-26 login-ui
      //    refresh — the target now reports multi_tenancy_enabled: false
      //    (the key entered /api/v0/app-config in v0.27.0, @973f960).
      unobservable: ["verification"],
      // AT FIRST CONTACT (2026-08-26, before the same-day refresh) the target
      // ran login-ui v0.24.0-v0.25.0, pinned by two independent observations of
      // its own responses — kept because it is the audit trail for the
      // identifier-first outage in upstreamFindings:
      //  - /api/v0/app-config carries `flags` but not `multi_tenancy_enabled`:
      //    `flags` arrived in v0.24.0 (present at @72d4b5b, absent at @b964996
      //    = v0.23.1) and `multi_tenancy_enabled` in v0.27.0 (@973f960) — so
      //    v0.24.0 <= version <= v0.26.0.
      //  - /self-service/registration/browser and .../verification/browser both
      //    answer a bare Go `404 page not found`: the BFF's chi route table has
      //    no registration or verification routes before v0.26.0 (17 routes at
      //    @48a7049 = v0.26.0, 11 at @ad44e9e = v0.25.0 and @72d4b5b = v0.24.0,
      //    canonical/identity-platform-login-ui pkg/kratos/handlers.go) — so
      //    version <= v0.25.0.
      // Neither 404 means a disabled kratos flow: kratos registers those routes
      // unconditionally and answers a disabled flow with an HTTP 400 JSON error
      // (ory/kratos@64e04ac selfservice/flow/registration/handler.go:81,113-115
      // and selfservice/flow/verification/handler.go:78,167-170), and
      // kratos-operator ships no option to disable registration at all
      // (canonical/kratos-operator@99da536 charmcraft.yaml:104-206). The 404s
      // are the BFF's route table, which is why the preflight must not read
      // kratos flow config off an ingress that fronts it.
      loginUiVersion: "v0.24.0-v0.25.0 at first contact; >= v0.27.0 since the 2026-08-26 refresh (multi_tenancy_enabled present, registration route present, identifier-first login works)",
    },
  ],

  // ── Known harness gaps (dimensions reality has, the compose stack cannot express yet) ──
  harnessGaps: [
    "TLS/HTTPS: hydra charm blocks on non-HTTPS public ingress unless dev=true (canonical/hydra-operator@3c8d141 src/charm.py:605-611, predicate at src/utils.py:57-58, dev_mode at src/charm.py:336-337 — re-pinned 2026-08-19; the former @f7e000b src/charm.py:646-652 pin now points at _on_run_migration). The compose stack is http://localhost, i.e. permanently dev=true. TLS behavior is untestable here.",
    "UVS registration webhook: kratos flow hooks are list-typed config not expressible as compose env vars — presence-only in the compose backend. CLOSED in the juju backend: the kratos-registration-webhook relation does the wiring (matrix/backends/juju/root).",
    "Salesforce (uvs) and Google sign-in completion need real credentials — config-presence effects are testable, credential-gated journeys are not.",
    "Custom identity_schemas (canonical/kratos-operator@99da536 charmcraft.yaml:168-201) — unmodeled; default schemas only.",
    "OAUTH2_ALLOWED_TOP_LEVEL_CLAIMS env-list binding on hydra is unverified against 25.4.0 — verify on the first hook_service=present row.",
    "WebAuthn over a bare-IP ingress: kratos derives rp.id from the public-route host and WebAuthn forbids IP RP IDs. CLOSED in the juju backend via the ingress_hostname substrate variable (nip.io locally, hosts-pinned name on CI - docs/juju-lane-runbook.md); remains a constraint only for substrates left in bare-IP mode.",
    "Mail: mailslurper ships in both backends today, but mail is capability-gated, not assumed — rows emit mail_api in capabilities.json and mail-dependent scenarios declare requires.mailApi. A mail-less target (e.g. a juju cluster without k8s manifest access for the SMTP pod) hand-writes mail_api=false and runs the remaining subset; recovery/verification/registration journeys gate off at runtime.",
  ],

  // ── Upstream findings from the survey (not this repo's bugs; need owners) ──
  upstreamFindings: [
    "CONFIRMED LIVE 2026-08-28 on teal (prodstack7, teal-iam, charms from istio/edge): KRATOS CANNOT STORE ANY IDENTITY — every POST /admin/identities answers HTTP 500 `ERROR: null value in column \"identity_id\" of relation \"identity_credential_identifiers\" violates not-null constraint (SQLSTATE 23502)`, for all 15 archetypes, in-cluster against the kratos pod's own admin port (10.100.3.124:4434), so no ingress, BFF or TLS hop is involved. This is a WORKLOAD/DATABASE VERSION SKEW in the deployment, not a payload defect: the column is added NULLable by ory/kratos@6bf18bf87e02a25bd1f87bb40af71f8439a6c0c5 (persistence/sql/migrations/sql/20251104000000000000_identifiers_devices_identity_id.up.sql) and made NOT NULL with an FK by 20251105000000000003_identity_id_not_null_fks.postgres.up.sql in the same series — files PRESENT at tag v26.2.0 and ABSENT at v25.4.0 — and kratos only writes the column from that version on: v25.4.0's CredentialIdentifier struct (ory/kratos@v25.4.0 identity/credentials.go:221) has identity_credential_id and no identity_id field at all, while master/v26 has it (identity/credentials.go:231) and the persister populates it (persistence/sql/identity/persister_identity.go:344 `IdentityID: new(cred.IdentityID)`). So teal's postgres has been migrated by kratos >= v26 while the kratos serving it writes v25-shaped inserts. The test plane cannot work around it — no request body can supply a column the writer never mentions. Owner: whoever refreshed teal-iam's kratos (align workload with the migrated schema, or re-migrate). The seeding preflight now catches it before --fresh deletes anything (scripts/seed-remote.sh probe 4).",
    "CONFIRMED LIVE 2026-08-26 on https://iam.orange.canonical.com (login-ui v0.24.0-v0.25.0): IDENTIFIER-FIRST LOGIN IS BROKEN — no local user can sign in through the UI, which is why 7 of the row's 11 live-lane executions fail. Driving the deployment's own page in a real browser, submitting the email posts `{identifier, csrf_token, method: \"password\", password: \"\"}` to POST /self-service/login?flow=… and gets HTTP 500 `invalid password` (the BFF also answers `Failed to parse login flow` for the same shape); the page renders no error and does not advance, so the failure is invisible to a human too. NOT the harness: the payload is formed by the deployment's own frontend, and the backend half is fine — POST /self-service/login/id-first with method=identifier_first on a live flow returns 200 {redirect_to}. The frontend simply never calls that endpoint at this version: `ui/api/kratos.ts` first references /self-service/login/id-first at canonical/identity-platform-login-ui@48a7049 (v0.26.0) and @197703c (v0.28.0); zero matches at @ad44e9e (v0.25.0) and @72d4b5b (v0.24.0), while /api/v0/app-config reports identifier_first_enabled: true regardless. Same version window explains the other two orange oddities — the BFF route table gains registration and verification only at v0.26.0 (11 routes at @ad44e9e, 17 at @48a7049), and multi_tenancy_enabled enters app-config only at v0.27.0 (@973f960). FIX: refresh login-ui to >= v0.26.0 (the other environments run v0.28.0). The charm comes from iam-bundle-integration?ref=istio, so the istio channel is what needs the newer revision.",
    "CONFIRMED LIVE 2026-08-27, iam.orange.canonical.com (login-ui >= v0.27), settings 'Change password' form: submitting a NEW password equal to the OLD one makes the BFF answer HTTP 500 text/plain `new password does not meet the password policy requirements: The new password must be different from the old password.` — a policy rejection collapsed to a 500 (the S-8 status-collapse class) — and the UI renders NOTHING: no error, no state change, the user cannot tell the click did anything. Weak passwords are handled correctly client-side (submit disabled + 'Password does not match requirements'), so the gap is exactly the policies only the server knows. Observed via the page's own form with the network panel open; the settings-change-password scenario avoids the shape (its new password always differs) rather than asserting the broken behavior.",
    "CONFIRMED LIVE 2026-08-27, iam.orange.canonical.com: THE SETTINGS AAL2 STEP-UP DEAD-ENDS IN A 400. Repro: TOTP-enrolled user, password submitted, TOTP screen NOT completed (an AAL1 session), then GET any /ui/manage_* page. The SPA calls /self-service/settings/browser; kratos answers with a step-up redirect whose base IS the external origin (https://iam.orange.canonical.com/self-service/login/browser?aal=aal2&…) but whose embedded return_to is the settings request URL AS KRATOS RECEIVED IT — http://kratos.orange-iam.svc.cluster.local:4433/self-service/settings/browser?… — and kratos then refuses that return_to against its own allowlist: HTTP 400 self_service_flow_return_to_forbidden, raw JSON in the browser. MECHANISM, each hop source-pinned: (1) the login-ui BFF proxies browser calls to kratos's INTERNAL endpoint (canonical/kratos-operator@def836b src/integrations.py InternalRouteData: http://{app}.{model}.svc.cluster.local:4433 — the exact observed string) and sets NO X-Forwarded-Proto/Host (zero Forwarded references under pkg/kratos at canonical/identity-platform-login-ui@197703c), so kratos self-references the request as internal; (2) kratos rebases the redirect itself onto serve.public.base_url but echoes the RAW request URL as return_to (asymmetry verified on the compose stack: Location host = base_url, not the request host); (3) the istio-track charm sets SERVE_PUBLIC_BASE_URL correctly AND an exact-origin SELFSERVICE_ALLOWED_RETURN_URLS=[\"https://<external>/\"] (canonical/kratos-operator@def836b src/integrations.py PublicRouteData.to_env_vars) — right posture, and the tripwire that surfaces the bug as a 400. NOT charm base_url misconfiguration (an earlier revision of this entry claimed that; the redirect's external base disproves it). Owner: login-ui BFF should forward proto/host (or address kratos by its public URL server-side); secondarily kratos upstream could rebase return_to like it rebases the redirect. Traefik deployments share ingredient (1) verbatim — iam.yellow's BFF dials http://kratos.yellow-iam.svc.cluster.local:4433 (its own error text, 2026-08-27) — so the same dead-end is expected wherever the allowlist excludes the internal origin; unverifiable on yellow live because yellow is currently broken one layer earlier (see next entry).",
    "OBSERVED 2026-08-27, iam.yellow.canonical.com is DOWN at the BFF→kratos hop: every /self-service/login/browser init answers HTTP 500 `failed to create login flow, err: Get \\\"http://kratos.yellow-iam.svc.cluster.local:4433/…\\\": dial tcp 10.200.115.237:4433: connect: operation not permitted` — the login-ui pod cannot reach kratos (operation not permitted = blocked, likely a NetworkPolicy), so NO user can log in on yellow at all. Deployment-operations finding, not a suite finding; reported for whoever owns yellow.",
    "RESOLVED 2026-08-27, iam.orange.canonical.com: Google external IdP is live. Both registration (/ui/register) and login (/self-service/login/flows) flows offer the `google_canonical` provider node and the 'Sign in with Google' button renders cleanly. The row now declares providers=1 with an oidc_providers override for google_canonical.",
    "iam.orange.canonical.com serves an INCOMPLETE TLS CHAIN (2026-08-26): the leaf alone, without the `YR1` intermediate or the ISRG-Root-X1-cross-signed `Root YR`. Browsers hide it by fetching them from the leaf's AIA extension; Node, Go, curl and requests do not chase AIA and cannot build a path at all, so every non-browser client fails with `unable to get local issuer certificate`. Not a harness workaround candidate — auto-fetching a deployment's missing intermediates is the silent repair the urls lane exists to refuse (docs/testing-spec.md §9). FIX: serve the intermediates from the istio ingress.",
    "CONFIRMED LIVE (2026-08-01, login-ui charm rev 205 / workload 0.28.0; re-confirmed 2026-08-02 during the attach-mode proof: refreshing local→store rev 205 with tenant-service-info still related lands the app in blocked 'Failed to replan' while the workload crash-loops; STILL PRESENT 2026-08-19 at canonical/identity-platform-login-ui-operator@aadd815 — every cited line byte-identical, TENANT_SERVICE_GRPC_ADDRESS still zero occurrences repo-wide): relating tenant-service to login-ui crash-loops the workload — `Error: cannot enable multi-tenancy without TENANT_SERVICE_GRPC_ADDRESS`. The charm renders TENANTS_SERVICE_URL and never TENANT_SERVICE_GRPC_ADDRESS (canonical/identity-platform-login-ui-operator@b8497db src/services.py:115-117), and the relation's grpc_url is loaded into TenantServiceInfoData (canonical/identity-platform-login-ui-operator@b8497db src/integrations.py:167,176,183) but read by nothing under src/ — verified by grepping every src/*.py at that sha. Charmed multi-tenancy is broken until login-ui-operator renders TENANT_SERVICE_GRPC_ADDRESS (an upstream PR NOW EXISTS and is OPEN as of 2026-08-19 — canonical/identity-platform-login-ui-operator#496 'Render TENANT_SERVICE_GRPC_ADDRESS on the tenant-service relation', head fix/tenant-service-grpc-address@0cd4f68, mergeable_state blocked, nothing merged; this supersedes the 'no upstream PR exists as of the 2026-08-01 survey' note. The tracked patch file was deleted by policy D-2 and the fix is preserved here verbatim, against canonical/identity-platform-login-ui-operator@b8497db src/services.py @@ -114,6 +114,12 @@ class PebbleService, inside `if tenant_service_info and tenant_service_info.is_ready:` immediately after the TENANTS_SERVICE_URL assignment: `+ # The workload dials tenant-service over gRPC and reads the address from TENANT_SERVICE_GRPC_ADDRESS (internal/config/specs.go); the relation publishes it as a bare host:port in grpc_url. Without this the workload exits with \\\"cannot enable multi-tenancy without TENANT_SERVICE_GRPC_ADDRESS\\\" and the unit crash-loops.` / `+ container[\\\"environment\\\"][\\\"TENANT_SERVICE_GRPC_ADDRESS\\\"] = tenant_service_info.grpc_url`); MT rows on the juju backend are blocked on that release.",
    "login-ui BFF 500 `Failed to parse login flow`: REFUTED as a product defect 2026-08-14 (reproduced on the tfdefault-oidc-only row, local_idp=off). It was a PROBE ARTIFACT — the probe posted an identifier_first body to the GENERIC login endpoint. Measured with one body and two endpoints: POST /self-service/login/id-first -> 200 {redirect_to}, POST /self-service/login -> 500 `Failed to parse login flow`. Cause: ParseLoginFlowMethodBody (pkg/kratos/service.go:1233) has no identifier_first case, so the body falls to `default:` and is decoded as UpdateLoginFlowWithOidcMethod, whose generated UnmarshalJSON requires `provider`. No client does this — ui/api/kratos.ts posts identifier_first to /self-service/login/id-first. The version comparison was ALSO wrong: neither v0.27.0 nor v0.28.0 has an identifier_first case (grep = 0 in both) and both pin kratos-client-go/v25 v25.4.0, so 0.27 cannot have handled the identical shape. What legitimately remains is that an unsupported/misrouted body returns 500 rather than 400 — that is an instance of S-8 (status collapse) and is folded into that finding, not filed separately. NOT FILED.",
    "kratos-operator: PARTIALLY REFUTED 2026-08-14 at main=10c0b62. (a) The status half is WRONG: charm status IS wired to the pebble health check — WorkloadService.is_failing() reads the pebble ready check (src/services.py:111-126, `c.failures > 0`) and src/charm.py:578-583 raises BlockedStatus('Failed to start the service, please check the … container logs'), so a crash-looping workload does not report active. (b) What remains is an input-validation nit, not the originally claimed silent outage: CharmConfigIdentitySchemaProvider._get_schemas (src/configs.py:328-338) does `json.dumps(schema)` per entry with no check that the entry is an object, so identity_schemas='{\"default\": null}' yields the literal string 'null' as a schema file body and Kratos cannot start. Operator-triggered, now visibly Blocked; worth a config-validation error rather than an issue. NOT FILED.",
    "kratos-operator (observed 2026-08-02, juju row loop; RECURRED same day: second wedge sat 90 minutes in waiting/'Container is not connected yet' with the pod Running the whole time — only an explicit config-changed hook re-rendered; update-status never recovered it): during row transitions the charm can render selfservice.flows.verification.ui_url as NULL (canonical/kratos-operator@99da536 j2:154-161, ui_url at :157 — the template interpolates it unguarded; kratos v26 schema validation is fatal: 'expected string, but got null' → container crash-loop) — likely a re-render against partial ui-endpoint-info relation data while login-ui restarts. Compounding it, the kratos-pebble-check-failed hook itself raises ops.pebble.ConnectionError when the socket is gone (container restarting), wedging the unit in error until juju's automatic hook retry; transitions then blow the settle budget. Three fixes needed upstream: guard the verification ui_url render against missing relation data, make the check-failed handler resilient to a dead pebble socket, and re-render on pebble-ready after crash-loop windows. Harness: matrix/watchdog.mjs journals wedge frequency; no automatic remediation — affected rows fail settle loudly.",
    "hook-service-operator: with authorization_enabled=false and no openfga relation the charm reports ActiveStatus but never plans a pebble layer (openfga_integration_exists — canonical/hook-service-operator@186d47f src/utils.py:54 — sits unconditionally in NOOP_CONDITIONS at canonical/hook-service-operator@186d47f src/utils.py:121-127, entry at :125, while the authorization_enabled check that should gate it lives at canonical/hook-service-operator@186d47f src/charm.py:545).",
    "kratos-external-idp-integrator: provider value 'yandex' is documented (canonical/kratos-external-idp-integrator@7219838 charmcraft.yaml:34) but the allowlist spells it 'yander' (canonical/kratos-external-idp-integrator@7219838 lib/charms/kratos_external_idp_integrator/v1/kratos_external_provider.py:159,249; zero occurrences of 'yandex' in that lib) — yandex is unusable.",
    "kratos-operator charm default enable_local_idp=true (canonical/kratos-operator@99da536 charmcraft.yaml:129-132) vs its own terraform module default false (canonical/kratos-operator@99da536 terraform/variables.tf:17-20) — the producible default depends on the deployment path.",
    "Charm-default hook-service runs authorization_enabled=true; this repo's compose stack runs it (and tenant-service) with authorization off (PD-8) — the shipped-default authz path is untested here. OBSERVED LIVE (2026-08-03, juju row loop): with authz on and no openfga tuples seeded, the token hook denies every seeded user ('access denied for user … to client browser-test-rp') and hydra fails issuance with access_denied — the shipped default cannot issue tokens for fresh users out of the box. Enforcement also appeared INTERMITTENT across identical relation topologies (pd931 runs logged zero denials while a later row denied consistently; hydra's distroless container blocks config inspection, so the render-timing question is open). The juju root now pins authorization_enabled=false for lane parity until hook-authz is a modeled dimension with openfga seeding.",
    "CONFIRMED 2026-08-14 at tenant-service v0.3.1 (commit cc6ae33), source + live; no upstream counterpart among the repo's 10 issues; draft held at /tmp/opaque_token_body.md. tenant-service (and by construction any service validating bearer tokens via hydra's JWKS): opaque access tokens (jwt_access_tokens=false) cannot authenticate service clients — the REST admin API returns 401 'invalid token' for a valid client-credentials token because it only parses JWTs (compose: AUTHENTICATION_JWKS_URL; charm: oauth relation). Observed live 2026-08-03 on an access_token=opaque row: tenant provisioning via the service client fails while the MT login path (tokenless gRPC LookupTenants) keeps working. Either the services need introspection-based validation for opaque deployments, or opaque+admin-API is a documented unsupported shape. VERIFICATION 2026-08-14: the only verifier is JWTVerifier calling oidc.IDTokenVerifier.Verify (pkg/authentication/verifier.go:19-33) and `introspect` appears nowhere in the repo, so there is no fallback for a non-parseable token. Live pair against a running v0.3.1 with the SAME client-credentials client: JWT bearer (3 segments) -> 200; opaque-shaped bearer -> 401 {\"message\":\"invalid token\",\"status\":401}. SEVERITY BOUND: this is opt-in, not out-of-the-box — docker/hydra/hydra.yml sets access_token: jwt and hydra-operator charmcraft.yaml:95-99 defaults jwt_access_tokens=True; the defect is that selecting the supported `false` option silently disables the authenticated API. Note the symptom is PARTIAL and easy to misread as an authz fault: the MT login path keeps working because LookupTenants is excluded from authentication, while provisioning, membership and listing all 401.",
  ],
};
