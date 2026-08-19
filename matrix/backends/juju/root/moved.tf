# State-only renames from the presence-gating refactor (count added to the
# optional-app modules and their relations: module.X -> module.X[0]).
# Purely address bookkeeping - no infrastructure is touched. Safe to delete
# once every long-lived state (this workstation, CI cluster) has applied it.

moved {
  from = module.tenant_service
  to   = module.tenant_service[0]
}

moved {
  from = module.hook_service
  to   = module.hook_service[0]
}

moved {
  from = module.user_verification_service
  to   = module.user_verification_service[0]
}

moved {
  from = module.idp_dex
  to   = module.idp_dex[0]
}

moved {
  from = module.idp_dex2
  to   = module.idp_dex2[0]
}

moved {
  from = juju_secret.uvs_salesforce_credentials
  to   = juju_secret.uvs_salesforce_credentials[0]
}

moved {
  from = juju_access_secret.uvs_salesforce_credentials_access
  to   = juju_access_secret.uvs_salesforce_credentials_access[0]
}

moved {
  from = juju_integration.uvs_public_route
  to   = juju_integration.uvs_public_route[0]
}

moved {
  from = juju_integration.uvs_login_ui_endpoint_info
  to   = juju_integration.uvs_login_ui_endpoint_info[0]
}

moved {
  from = juju_integration.tenant_service_database
  to   = juju_integration.tenant_service_database[0]
}

moved {
  from = juju_integration.tenant_service_ca_cert
  to   = juju_integration.tenant_service_ca_cert[0]
}

moved {
  from = juju_integration.tenant_service_oauth
  to   = juju_integration.tenant_service_oauth[0]
}

moved {
  from = juju_integration.tenant_service_openfga
  to   = juju_integration.tenant_service_openfga[0]
}

moved {
  from = juju_integration.tenant_service_kratos_info
  to   = juju_integration.tenant_service_kratos_info[0]
}

moved {
  from = juju_integration.hook_service_database
  to   = juju_integration.hook_service_database[0]
}

moved {
  from = juju_integration.hook_service_ca_cert
  to   = juju_integration.hook_service_ca_cert[0]
}

moved {
  from = juju_integration.hook_service_openfga
  to   = juju_integration.hook_service_openfga[0]
}

moved {
  from = juju_integration.hook_service_oauth
  to   = juju_integration.hook_service_oauth[0]
}

moved {
  from = juju_integration.kratos_idp_dex
  to   = juju_integration.kratos_idp_dex[0]
}

moved {
  from = juju_integration.kratos_idp_dex2
  to   = juju_integration.kratos_idp_dex2[0]
}
