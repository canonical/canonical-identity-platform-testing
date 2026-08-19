# The juju row root: ONE deployment, rows applied as variable sets.
#
#   terraform apply -var-file=../../../rows/<row>/juju.tfvars.json
#
# Composition follows iam-bundle-integration/examples/multitenancy (module
# refs, relation topology) — the newest example plan and the only one whose
# charm revisions support multi-tenancy; UVS is added from
# examples/user-verification (v1.3.5 on the newer base = a composition no
# example ships, deliberately). All add-on applications stay DEPLOYED at all
# times; rows toggle RELATIONS (and the integrators' `enabled` config), which
# is both the fast transition and the semantically correct one — login-ui's
# multi-tenancy is literally defined by relation presence.
#
# Supersedes phase0/ (destroy that stack before applying this one: model
# names are shared on purpose).
#
# CONTROLLER: this workstation also has a production JIMM controller
# registered, and terraform-provider-juju binds the controller transitively
# through `juju show-controller` (resolution order: JUJU_MODEL >
# JUJU_CONTROLLER > switch state). The matrix harness enforces the pin via
# matrix/controller-guard.mjs; a BARE terraform command here is outside that
# guard, so run `juju show-controller` first and confirm it names
# microk8s-localhost with JUJU_MODEL unset. Always export
# JUJU_CONTROLLER=microk8s-localhost.

# ─── Core model: shared infra + offers ───────────────────────────────────────

resource "juju_model" "core" {
  name = var.core_model_name

  dynamic "cloud" {
    for_each = var.cloud_name == "" ? [] : [1]
    content {
      name   = var.cloud_name
      region = var.cloud_region == "" ? null : var.cloud_region
    }
  }
}

module "certificates" {
  source = "github.com/canonical/self-signed-certificates-operator//terraform?ref=rev443"

  model_uuid = juju_model.core.uuid
  app_name   = "self-signed-certificates"
  units      = 1
  channel    = "1/stable"
  base       = "ubuntu@24.04"

  depends_on = [juju_model.core]
}

module "traefik" {
  source = "github.com/canonical/traefik-k8s-operator//terraform?ref=rev259"

  model_uuid = juju_model.core.uuid
  app_name   = "traefik-public"
  units      = 1
  channel    = "latest/stable"
  # WebAuthn requires a domain-shaped RP ID; kratos derives rp.id from the
  # ingress host, so a bare-IP LB can never run webauthn journeys. nip.io
  # turns the pinned metallb IP into a real DNS name with zero local state
  # (rebind-protecting resolvers are the one documented exception - docs/juju-lane-runbook.md).
  config = var.ingress_hostname == "" ? {} : { external_hostname = var.ingress_hostname }

  depends_on = [juju_model.core, module.certificates]
}

# Same postgres as phase 0 — known-good on this cluster.
module "postgresql" {
  source = "github.com/shipperizer/postgresql-k8s-operator//terraform?ref=juju-tf%2F1.0"

  juju_model = juju_model.core.uuid
  app_name   = "postgresql-k8s"
  units      = 1
  channel    = "14/edge"
  base       = "ubuntu@22.04"

  storage_directives = {
    pgdata = "10G"
  }

  depends_on = [juju_model.core]
}

module "openfga" {
  source = "github.com/canonical/openfga-operator//terraform?ref=v1.6.2"

  model    = juju_model.core.uuid
  app_name = "openfga-k8s"
  units    = 1

  depends_on = [juju_model.core, module.postgresql]
}

# ─── IAM model: the platform ─────────────────────────────────────────────────

resource "juju_model" "iam" {
  name = var.model_name

  dynamic "cloud" {
    for_each = var.cloud_name == "" ? [] : [1]
    content {
      name   = var.cloud_name
      region = var.cloud_region == "" ? null : var.cloud_region
    }
  }
}

module "hydra" {
  source = "github.com/canonical/hydra-operator//terraform?ref=v3.0.2"

  model    = juju_model.iam.uuid
  app_name = "hydra"
  units    = 1
  channel  = "latest/edge"
  revision = lookup(var.charm_revisions, "hydra", 404)
  config   = var.hydra_config

  depends_on = [juju_model.iam]
}

module "kratos" {
  source = "github.com/canonical/kratos-operator//terraform?ref=v2.2.1"

  model    = juju_model.iam.uuid
  app_name = "kratos"
  units    = 1
  channel  = "latest/edge"
  revision = lookup(var.charm_revisions, "kratos", 574)
  # Workload image pinned to the edge-head resource (v26.2.0). Deployed via
  # the migration runbook: attach the resource, then `juju run kratos/0
  # run-migration` — the charm gates on "Waiting for database migration" for
  # workload version bumps, and the DB schema is now v26 (downgrade would
  # strand it). Charm-rev-attached resources would give v25.4.0.
  resources = { oci-image = var.kratos_image_revision }
  # Row config + the test plane's pinned identity schema (deployment
  # constant, not a dimension — the charm built-ins don't match the seeder's
  # archetype traits).
  config = merge(var.kratos_config, {
    identity_schemas           = jsonencode({ default = jsondecode(file("${path.module}/../../../../docker/kratos/identity.schema.json")) })
    default_identity_schema_id = "default"
  })

  depends_on = [juju_model.iam]
}

module "login_ui" {
  source = "github.com/canonical/identity-platform-login-ui-operator//terraform?ref=v2.2.1"

  model    = juju_model.iam.uuid
  app_name = "login-ui"
  units    = 1
  channel  = var.login_ui_channel
  revision = lookup(var.charm_revisions, "login_ui", 205)

  depends_on = [juju_model.iam, module.hydra, module.kratos]
}

module "tenant_service" {
  count  = var.apps_present.tenant_service ? 1 : 0
  source = "github.com/canonical/tenant-service-operator//terraform?ref=v1.1.1"

  model    = juju_model.iam.uuid
  app_name = "tenant-service"
  units    = 1
  channel  = "latest/edge"
  revision = lookup(var.charm_revisions, "tenant_service", 5)

  depends_on = [juju_model.iam, module.kratos]
}

module "hook_service" {
  count  = var.apps_present.hook_service ? 1 : 0
  source = "github.com/canonical/hook-service-operator//terraform?ref=v1.1.1"

  model    = juju_model.iam.uuid
  app_name = "hook-service"
  units    = 1
  channel  = "latest/edge"
  revision = lookup(var.charm_revisions, "hook_service", 16)
  # Charm default is authorization_enabled=true (openfga-backed per-user/
  # per-client checks on the token hook). Nobody seeds those tuples, so the
  # shipped default DENIES every seeded user ("access denied for user … to
  # client browser-test-rp") and hydra fails token issuance. The compose
  # lane runs authz off (PD-8, upstreamFindings) - keep the lanes in parity
  # until hook-authz becomes a modeled dimension with openfga seeding.
  config = { authorization_enabled = "false" }

  depends_on = [juju_model.iam, module.tenant_service]
}

# UVS needs a salesforce-credentials secret even with salesforce disabled;
# dummy values — no salesforce in this harness (recorded harness gap).
resource "juju_secret" "uvs_salesforce_credentials" {
  count = var.apps_present.user_verification_service && var.manage_secrets ? 1 : 0
  name  = "user_verification_service_salesforce_credentials"
  value = {
    consumer-key    = "matrix-dummy-key"
    consumer-secret = "matrix-dummy-secret"
  }
  info       = "Dummy Salesforce credentials — salesforce_enabled is false in the matrix harness"
  model_uuid = juju_model.iam.uuid
}

resource "juju_access_secret" "uvs_salesforce_credentials_access" {
  count        = var.apps_present.user_verification_service && var.manage_secrets ? 1 : 0
  applications = ["user-verification-service"]
  secret_id    = juju_secret.uvs_salesforce_credentials[0].secret_id
  model_uuid   = juju_model.iam.uuid
}

module "user_verification_service" {
  count  = var.apps_present.user_verification_service ? 1 : 0
  source = "git::https://github.com/canonical/user-verification-service-operator//terraform?ref=v1.3.5"

  model                            = juju_model.iam.uuid
  app_name                         = "user-verification-service"
  channel                          = "latest/edge"
  revision                         = lookup(var.charm_revisions, "user_verification_service", 11)
  salesforce_credentials_secret_id = var.manage_secrets ? juju_secret.uvs_salesforce_credentials[0].secret_id : var.uvs_salesforce_secret_id
  config = {
    salesforce_enabled = "false"
  }

  depends_on = [juju_access_secret.uvs_salesforce_credentials_access, juju_model.iam, module.kratos, module.login_ui]
}

# ─── IdP integrators: both always deployed AND related; the provider count
#     dimension toggles each one's `enabled` config (charm-supported disable
#     path: it clears the relation databag, kratos re-renders without it). ───

module "idp_dex" {
  count  = var.apps_present.idp_dex ? 1 : 0
  source = "github.com/canonical/kratos-external-idp-integrator//terraform?ref=v2.1.0"

  model    = juju_model.iam.uuid
  app_name = "idp-dex"
  units    = 1
  channel  = "latest/edge"
  revision = lookup(var.charm_revisions, "idp_dex", 299)
  config = {
    provider    = "generic"
    provider_id = "dex"
    # Button text: without a label the integrator defaults to the provider
    # TYPE ("Sign in with Generic"); the suite clicks "Sign in with Dex".
    label         = "dex"
    client_id     = "kratos"
    client_secret = "dex-client-secret"
    issuer_url    = "http://${var.node_ip}:30556/dex"
    scope         = "openid profile email"
    enabled       = var.idp_dex_enabled ? "true" : "false"
  }

  depends_on = [juju_model.iam, module.kratos]
}

module "idp_dex2" {
  count  = var.apps_present.idp_dex2 ? 1 : 0
  source = "github.com/canonical/kratos-external-idp-integrator//terraform?ref=v2.1.0"

  model    = juju_model.iam.uuid
  app_name = "idp-dex2"
  units    = 1
  channel  = "latest/edge"
  revision = lookup(var.charm_revisions, "idp_dex2", 299)
  config = {
    provider      = "generic"
    provider_id   = "dex2"
    label         = "dex2"
    client_id     = "kratos2"
    client_secret = "dex-client-secret-2"
    issuer_url    = "http://${var.node_ip}:30556/dex"
    scope         = "openid profile email"
    enabled       = var.idp_dex2_enabled ? "true" : "false"
  }

  depends_on = [juju_model.iam, module.kratos]
}
