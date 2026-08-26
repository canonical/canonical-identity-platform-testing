terraform {
  required_providers {
    juju = {
      source  = "juju/juju"
      version = "~> 1.0.0"
    }
  }

  required_version = ">= 1.5.0"
}

# JIMM remote-lane wiring (docs/ci-spec.md §2). Empty defaults render null, so
# the provider falls back to juju-CLI resolution and the local lane is
# unchanged. CI sets TF_VAR_jimm_* — never JUJU_CONTROLLER_ADDRESSES, which
# matrix/controller-guard.mjs refuses.
variable "jimm_url" {
  description = "JIMM controller address (host:port); empty = local juju CLI resolution"
  type        = string
  default     = ""
}

variable "jimm_client_id" {
  description = "JIMM service-account client id"
  type        = string
  default     = ""
  sensitive   = true
}

variable "jimm_client_secret" {
  description = "JIMM service-account client secret"
  type        = string
  default     = ""
  sensitive   = true
}

provider "juju" {
  controller_addresses = var.jimm_url != "" ? var.jimm_url : null
  client_id            = var.jimm_client_id != "" ? var.jimm_client_id : null
  client_secret        = var.jimm_client_secret != "" ? var.jimm_client_secret : null
}
