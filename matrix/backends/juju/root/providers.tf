terraform {
  required_providers {
    juju = {
      source  = "juju/juju"
      version = "~> 1.0.0"
    }
  }

  required_version = ">= 1.5.0"
}

# ── Remote-controller (JIMM/JAAS) wiring — docs/ci-spec.md ──────────────────
# All three variables default to "" and render as null below, which leaves the
# provider exactly where it has always been: the juju CLI fallback, resolved
# through `juju show-controller` and vetted by matrix/controller-guard.mjs.
# The local lane is byte-identical with these unset.
#
# The remote lane sets them as TF_VAR_jimm_url / TF_VAR_jimm_client_id /
# TF_VAR_jimm_client_secret so terraform reaches a JIMM controller with
# service-account client credentials — the pattern identity-team's
# charm-deploy.yaml uses. Provider ATTRIBUTES are used deliberately instead of
# JUJU_CONTROLLER_ADDRESSES, which the controller guard refuses because that
# env makes the provider bypass the CLI resolution the guard observes
# (matrix/controller-guard.mjs, items 1 and 3). The juju CLI itself
# authenticates with the same credentials via JUJU_CLIENT_ID/JUJU_CLIENT_SECRET
# (juju/juju#20716, juju 3.6) — envs the guard does not and need not refuse.
variable "jimm_url" {
  description = "JIMM controller address (host:port) for the remote lane; empty = local juju CLI resolution"
  type        = string
  default     = ""
}

variable "jimm_client_id" {
  description = "JIMM service-account OAuth client id (remote lane only)"
  type        = string
  default     = ""
  sensitive   = true
}

variable "jimm_client_secret" {
  description = "JIMM service-account OAuth client secret (remote lane only)"
  type        = string
  default     = ""
  sensitive   = true
}

provider "juju" {
  controller_addresses = var.jimm_url != "" ? var.jimm_url : null
  client_id            = var.jimm_client_id != "" ? var.jimm_client_id : null
  client_secret        = var.jimm_client_secret != "" ? var.jimm_client_secret : null
}
