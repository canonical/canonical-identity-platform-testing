# Relation topology, copied from iam-bundle-integration/examples/multitenancy
# (always-on set) plus examples/user-verification (UVS set). Row-toggled
# relations carry `count` driven by the row variables — these ARE the
# presence dimensions in the juju backend.
#
# Optional-app infra relations are additionally gated by `apps_present`
# (attach mode: never create relations for apps a shared cluster lacks).
# Row toggles conjoin with presence; the runner refuses row/cluster
# mismatches loudly before terraform ever runs.

# ─── Core offers ─────────────────────────────────────────────────────────────

resource "juju_offer" "traefik_route" {
  name             = "traefik-route"
  application_name = module.traefik.app_name
  endpoints        = ["traefik-route"]
  model_uuid       = juju_model.core.uuid
}

resource "juju_offer" "postgresql" {
  name             = "postgresql"
  application_name = module.postgresql.application_name
  endpoints        = ["database"]
  model_uuid       = juju_model.core.uuid
}

resource "juju_offer" "send_ca_certificate" {
  name             = "send-ca-cert"
  application_name = module.certificates.app_name
  endpoints        = ["send-ca-cert"]
  model_uuid       = juju_model.core.uuid
}

resource "juju_offer" "openfga" {
  name             = "openfga"
  application_name = module.openfga.app_name
  endpoints        = ["openfga"]
  model_uuid       = juju_model.core.uuid
}

# ─── Core integrations ───────────────────────────────────────────────────────

resource "juju_integration" "traefik_certs" {
  application {
    name     = module.traefik.app_name
    endpoint = "certificates"
  }
  application {
    name     = module.certificates.app_name
    endpoint = "certificates"
  }
  model_uuid = juju_model.core.uuid
}

resource "juju_integration" "openfga_db" {
  application {
    name     = module.postgresql.application_name
    endpoint = "database"
  }
  application {
    name     = module.openfga.app_name
    endpoint = "database"
  }
  model_uuid = juju_model.core.uuid
}

# ─── Public routes ───────────────────────────────────────────────────────────

resource "juju_integration" "hydra_public_route" {
  model_uuid = juju_model.iam.uuid
  application {
    offer_url = juju_offer.traefik_route.url
  }
  application {
    name     = module.hydra.app_name
    endpoint = "public-route"
  }
}

resource "juju_integration" "kratos_public_route" {
  model_uuid = juju_model.iam.uuid
  application {
    offer_url = juju_offer.traefik_route.url
  }
  application {
    name     = module.kratos.app_name
    endpoint = "public-route"
  }
}

resource "juju_integration" "login_ui_public_route" {
  model_uuid = juju_model.iam.uuid
  application {
    offer_url = juju_offer.traefik_route.url
  }
  application {
    name     = module.login_ui.app_name
    endpoint = "public-route"
  }
}

resource "juju_integration" "uvs_public_route" {
  count      = var.apps_present.user_verification_service ? 1 : 0
  model_uuid = juju_model.iam.uuid
  application {
    offer_url = juju_offer.traefik_route.url
  }
  application {
    name     = module.user_verification_service[0].app_name
    endpoint = "ingress"
  }
}

# ─── Databases ───────────────────────────────────────────────────────────────

resource "juju_integration" "hydra_database" {
  model_uuid = juju_model.iam.uuid
  application {
    offer_url = juju_offer.postgresql.url
  }
  application {
    name     = module.hydra.app_name
    endpoint = "pg-database"
  }
}

resource "juju_integration" "kratos_database" {
  model_uuid = juju_model.iam.uuid
  application {
    offer_url = juju_offer.postgresql.url
  }
  application {
    name     = module.kratos.app_name
    endpoint = "pg-database"
  }
}

resource "juju_integration" "tenant_service_database" {
  count      = var.apps_present.tenant_service ? 1 : 0
  model_uuid = juju_model.iam.uuid
  application {
    offer_url = juju_offer.postgresql.url
  }
  application {
    name     = module.tenant_service[0].app_name
    endpoint = "pg-database"
  }
}

resource "juju_integration" "hook_service_database" {
  count      = var.apps_present.hook_service ? 1 : 0
  model_uuid = juju_model.iam.uuid
  application {
    offer_url = juju_offer.postgresql.url
  }
  application {
    name     = module.hook_service[0].app_name
    endpoint = "pg-database"
  }
}

# ─── CA certificates (hydra exposes no receive-ca-cert endpoint) ─────────────

resource "juju_integration" "kratos_ca_cert" {
  model_uuid = juju_model.iam.uuid
  application {
    offer_url = juju_offer.send_ca_certificate.url
  }
  application {
    name     = module.kratos.app_name
    endpoint = "receive-ca-cert"
  }
}

resource "juju_integration" "login_ui_ca_cert" {
  model_uuid = juju_model.iam.uuid
  application {
    offer_url = juju_offer.send_ca_certificate.url
  }
  application {
    name     = module.login_ui.app_name
    endpoint = "receive-ca-cert"
  }
}

resource "juju_integration" "tenant_service_ca_cert" {
  count      = var.apps_present.tenant_service ? 1 : 0
  model_uuid = juju_model.iam.uuid
  application {
    offer_url = juju_offer.send_ca_certificate.url
  }
  application {
    name     = module.tenant_service[0].app_name
    endpoint = "receive-ca-cert"
  }
}

resource "juju_integration" "hook_service_ca_cert" {
  count      = var.apps_present.hook_service ? 1 : 0
  model_uuid = juju_model.iam.uuid
  application {
    offer_url = juju_offer.send_ca_certificate.url
  }
  application {
    name     = module.hook_service[0].app_name
    endpoint = "receive-ca-cert"
  }
}

# ─── Platform internal mesh (always on) ──────────────────────────────────────

resource "juju_integration" "kratos_hydra_endpoint_info" {
  model_uuid = juju_model.iam.uuid
  application {
    name     = module.hydra.app_name
    endpoint = "hydra-endpoint-info"
  }
  application {
    name     = module.kratos.app_name
    endpoint = "hydra-endpoint-info"
  }
}

resource "juju_integration" "login_ui_hydra_endpoint_info" {
  model_uuid = juju_model.iam.uuid
  application {
    name     = module.hydra.app_name
    endpoint = "hydra-endpoint-info"
  }
  application {
    name = module.login_ui.app_name
  }
}

resource "juju_integration" "login_ui_kratos_info" {
  model_uuid = juju_model.iam.uuid
  application {
    name     = module.kratos.app_name
    endpoint = "kratos-info"
  }
  application {
    name     = module.login_ui.app_name
    endpoint = "kratos-info"
  }
}

resource "juju_integration" "kratos_login_ui_endpoint_info" {
  model_uuid = juju_model.iam.uuid
  application {
    name     = module.login_ui.app_name
    endpoint = "ui-endpoint-info"
  }
  application {
    name     = module.kratos.app_name
    endpoint = "ui-endpoint-info"
  }
}

resource "juju_integration" "hydra_login_ui_endpoint_info" {
  model_uuid = juju_model.iam.uuid
  application {
    name     = module.login_ui.app_name
    endpoint = "ui-endpoint-info"
  }
  application {
    name = module.hydra.app_name
  }
}

resource "juju_integration" "uvs_login_ui_endpoint_info" {
  count      = var.apps_present.user_verification_service ? 1 : 0
  model_uuid = juju_model.iam.uuid
  application {
    name     = module.login_ui.app_name
    endpoint = "ui-endpoint-info"
  }
  application {
    name     = module.user_verification_service[0].app_name
    endpoint = "ui-endpoint-info"
  }
}

# ─── Add-on service plumbing (always on: apps stay deployed and functional) ──

resource "juju_integration" "tenant_service_oauth" {
  count      = var.apps_present.tenant_service ? 1 : 0
  model_uuid = juju_model.iam.uuid
  application {
    name     = module.hydra.app_name
    endpoint = "oauth"
  }
  application {
    name     = module.tenant_service[0].app_name
    endpoint = "oauth"
  }
}

resource "juju_integration" "tenant_service_openfga" {
  count      = var.apps_present.tenant_service ? 1 : 0
  model_uuid = juju_model.iam.uuid
  application {
    offer_url = juju_offer.openfga.url
  }
  application {
    name     = module.tenant_service[0].app_name
    endpoint = "openfga"
  }
}

resource "juju_integration" "tenant_service_kratos_info" {
  count      = var.apps_present.tenant_service ? 1 : 0
  model_uuid = juju_model.iam.uuid
  application {
    name     = module.kratos.app_name
    endpoint = "kratos-info"
  }
  application {
    name     = module.tenant_service[0].app_name
    endpoint = "kratos-info"
  }
}

resource "juju_integration" "hook_service_openfga" {
  count      = var.apps_present.hook_service ? 1 : 0
  model_uuid = juju_model.iam.uuid
  application {
    offer_url = juju_offer.openfga.url
  }
  application {
    name     = module.hook_service[0].app_name
    endpoint = "openfga"
  }
}

resource "juju_integration" "hook_service_oauth" {
  count      = var.apps_present.hook_service ? 1 : 0
  model_uuid = juju_model.iam.uuid
  application {
    name     = module.hydra.app_name
    endpoint = "oauth"
  }
  application {
    name     = module.hook_service[0].app_name
    endpoint = "oauth"
  }
}

# ─── IdP integrators (always related; provider count toggles their config) ──

resource "juju_integration" "kratos_idp_dex" {
  count      = var.apps_present.idp_dex ? 1 : 0
  model_uuid = juju_model.iam.uuid
  application {
    name     = module.idp_dex[0].app_name
    endpoint = "kratos-external-idp"
  }
  application {
    name     = module.kratos.app_name
    endpoint = "kratos-external-idp"
  }
}

resource "juju_integration" "kratos_idp_dex2" {
  count      = var.apps_present.idp_dex2 ? 1 : 0
  model_uuid = juju_model.iam.uuid
  application {
    name     = module.idp_dex2[0].app_name
    endpoint = "kratos-external-idp"
  }
  application {
    name     = module.kratos.app_name
    endpoint = "kratos-external-idp"
  }
}

# ─── ROW-TOGGLED relations: the presence dimensions ──────────────────────────

resource "juju_integration" "login_ui_tenant_service_info" {
  count      = var.relate_tenant && var.apps_present.tenant_service ? 1 : 0
  model_uuid = juju_model.iam.uuid
  application {
    name     = module.tenant_service[0].app_name
    endpoint = "tenant-service-info"
  }
  application {
    name     = module.login_ui.app_name
    endpoint = "tenant-service-info"
  }
}

resource "juju_integration" "tenant_service_kratos_registration_webhook" {
  count      = var.relate_tenant && var.apps_present.tenant_service ? 1 : 0
  model_uuid = juju_model.iam.uuid
  application {
    name     = module.tenant_service[0].app_name
    endpoint = "kratos-registration-webhook"
  }
  application {
    name     = module.kratos.app_name
    endpoint = "kratos-registration-webhook"
  }
}

resource "juju_integration" "tenant_service_kratos_login_webhook" {
  count      = var.relate_tenant && var.apps_present.tenant_service ? 1 : 0
  model_uuid = juju_model.iam.uuid
  application {
    name     = module.tenant_service[0].app_name
    endpoint = "kratos-login-webhook"
  }
  application {
    name     = module.kratos.app_name
    endpoint = "kratos-login-webhook"
  }
}

resource "juju_integration" "hook_service_hydra_token_hook" {
  count      = var.relate_hook && var.apps_present.hook_service ? 1 : 0
  model_uuid = juju_model.iam.uuid
  application {
    name     = module.hook_service[0].app_name
    endpoint = "hydra-token-hook"
  }
  application {
    name     = module.hydra.app_name
    endpoint = "hydra-token-hook"
  }
}

# tenant_id claim: hook-service widens its claim list iff it can see
# tenant-service — the cross-charm pair the survey flagged.
resource "juju_integration" "hook_service_tenant_service_info" {
  count      = var.relate_tenant && var.relate_hook && var.apps_present.tenant_service && var.apps_present.hook_service ? 1 : 0
  model_uuid = juju_model.iam.uuid
  application {
    name     = module.tenant_service[0].app_name
    endpoint = "tenant-service-info"
  }
  application {
    name     = module.hook_service[0].app_name
    endpoint = "tenant-service-info"
  }
}

resource "juju_integration" "uvs_kratos_registration_webhook" {
  count      = var.relate_uvs && var.apps_present.user_verification_service ? 1 : 0
  model_uuid = juju_model.iam.uuid
  application {
    name     = module.user_verification_service[0].app_name
    endpoint = "kratos-registration-webhook"
  }
  application {
    name     = module.kratos.app_name
    endpoint = "kratos-registration-webhook"
  }
}

resource "juju_integration" "uvs_kratos_registration_endpoint_info" {
  count      = var.relate_uvs && var.apps_present.user_verification_service ? 1 : 0
  model_uuid = juju_model.iam.uuid
  application {
    name     = module.user_verification_service[0].app_name
    endpoint = "registration-endpoint-info"
  }
  application {
    name     = module.kratos.app_name
    endpoint = "ui-endpoint-info"
  }
}
