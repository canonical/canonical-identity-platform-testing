// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

import type { ScenarioRequires } from "./scenario-types";
import type { ActiveConfig } from "./active-config";

export interface SatisfiesResult {
  met: boolean;
  reason?: string;
}

/**
 * Check if a scenario's requirements are satisfied by the discovered ActiveConfig.
 */
export function satisfies(requires: ScenarioRequires, activeConfig: ActiveConfig): SatisfiesResult {
  // 1. webauthnEnabled
  if (requires.webauthnEnabled !== undefined) {
    const actual = activeConfig.webauthn_enabled ?? false;
    if (actual !== requires.webauthnEnabled) {
      return {
        met: false,
        reason: `requires webauthnEnabled=${requires.webauthnEnabled}, ActiveConfig=${actual}`,
      };
    }
  }

  // 2. multiTenancy
  if (requires.multiTenancy !== undefined) {
    const actual = activeConfig.multi_tenancy_enabled ?? false;
    if (actual !== requires.multiTenancy) {
      return {
        met: false,
        reason: `requires multiTenancy=${requires.multiTenancy}, ActiveConfig=${actual}`,
      };
    }
  }

  // 3. mfaEnforced
  if (requires.mfaEnforced !== undefined) {
    const actual = activeConfig.mfa_enforced ?? false;
    if (actual !== requires.mfaEnforced) {
      return {
        met: false,
        reason: `requires mfaEnforced=${requires.mfaEnforced}, ActiveConfig=${actual}`,
      };
    }
  }

  // 4. oidcSequencing
  if (requires.oidcSequencing !== undefined) {
    const actual = activeConfig.oidc_webauthn_sequencing_enabled ?? false;
    if (actual !== requires.oidcSequencing) {
      return {
        met: false,
        reason: `requires oidcSequencing=${requires.oidcSequencing}, ActiveConfig=${actual}`,
      };
    }
  }

  // 5. registrationEnabled
  if (requires.registrationEnabled !== undefined) {
    const actual = activeConfig.registration_enabled ?? false;
    if (actual !== requires.registrationEnabled) {
      return {
        met: false,
        reason: `requires registrationEnabled=${requires.registrationEnabled}, ActiveConfig=${actual}`,
      };
    }
  }

  // 6. localUsersEnabled
  if (requires.localUsersEnabled !== undefined) {
    const actual = activeConfig.local_users_enabled ?? false;
    if (actual !== requires.localUsersEnabled) {
      return {
        met: false,
        reason: `requires localUsersEnabled=${requires.localUsersEnabled}, ActiveConfig=${actual}`,
      };
    }
  }

  // 7. oidcEnabled
  if (requires.oidcEnabled !== undefined) {
    const actual = activeConfig.oidc_enabled ?? false;
    if (actual !== requires.oidcEnabled) {
      return {
        met: false,
        reason: `requires oidcEnabled=${requires.oidcEnabled}, ActiveConfig=${actual}`,
      };
    }
  }

  // 8. accountLinkingEnabled
  if (requires.accountLinkingEnabled !== undefined) {
    const actual = activeConfig.account_linking_enabled ?? false;
    if (actual !== requires.accountLinkingEnabled) {
      return {
        met: false,
        reason: `requires accountLinkingEnabled=${requires.accountLinkingEnabled}, ActiveConfig=${actual}`,
      };
    }
  }

  // 9. mfaEnabled (legacy fallback mapped to presence of "totp" in methods_2fa)
  if (requires.mfaEnabled !== undefined) {
    const actual = activeConfig.methods_2fa?.includes("totp") ?? false;
    if (actual !== requires.mfaEnabled) {
      return {
        met: false,
        reason: `requires mfaEnabled=${requires.mfaEnabled}, ActiveConfig=${actual}`,
      };
    }
  }

  // 10. hookService (legacy fallback mapped to hook-service presence)
  if (requires.hookService !== undefined) {
    const actual = activeConfig.services?.includes("hook-service") ?? false;
    if (actual !== requires.hookService) {
      return {
        met: false,
        reason: `requires hookService=${requires.hookService}, ActiveConfig=${actual}`,
      };
    }
  }

  // 11. oidcProviders
  if (requires.oidcProviders && requires.oidcProviders.length > 0) {
    const missing = requires.oidcProviders.filter(
      (p) =>
        !(
          activeConfig.oidc_providers?.some(
            (ap) => ap === p || ap.startsWith(`${p}_`) || ap.startsWith(`${p}-`),
          ) ?? false
        ),
    );
    if (missing.length > 0) {
      return {
        met: false,
        reason: `requires OIDC providers [${requires.oidcProviders.join(", ")}], ActiveConfig is missing [${missing.join(", ")}]`,
      };
    }
  }

  // 12. firstFactorMethods
  if (requires.firstFactorMethods && requires.firstFactorMethods.length > 0) {
    const missing = requires.firstFactorMethods.filter(
      (m) => !(activeConfig.methods_1fa?.includes(m) ?? false)
    );
    if (missing.length > 0) {
      return {
        met: false,
        reason: `requires firstFactorMethods [${requires.firstFactorMethods.join(", ")}], ActiveConfig is missing [${missing.join(", ")}]`,
      };
    }
  }

  // 13. secondFactorMethods
  if (requires.secondFactorMethods && requires.secondFactorMethods.length > 0) {
    const missing = requires.secondFactorMethods.filter(
      (m) => !(activeConfig.methods_2fa?.includes(m) ?? false)
    );
    if (missing.length > 0) {
      return {
        met: false,
        reason: `requires secondFactorMethods [${requires.secondFactorMethods.join(", ")}], ActiveConfig is missing [${missing.join(", ")}]`,
      };
    }
  }

  // 14. Service presence keys "service:<name>"
  for (const key of Object.keys(requires)) {
    if (key.startsWith("service:")) {
      const serviceName = key.substring(8);
      const expected = (requires as any)[key] as boolean;
      const actual = activeConfig.services?.includes(serviceName) ?? false;
      if (actual !== expected) {
        return {
          met: false,
          reason: `requires service:${serviceName}=${expected}, ActiveConfig=${actual}`,
        };
      }
    }
  }

  // 15. mailApi (mail_api capability — mailslurper API reachable)
  // Absent key defaults to true: mail was an unconditional assumption before it
  // became a capability, and discovery mode always fills it in explicitly.
  if (requires.mailApi !== undefined) {
    const actual = activeConfig.mail_api ?? true;
    if (actual !== requires.mailApi) {
      return {
        met: false,
        reason: `requires mailApi=${requires.mailApi}, ActiveConfig mail_api=${actual}`,
      };
    }
  }

  // 16. backupCodePromptOnUse (backup_code_prompt_on_use capability — the
  // login-ui version fork on the backup-code sign-in terminal). Absent
  // defaults to false: the v0.28.0 workload both harness backends run only
  // prompts when the identity runs low.
  if (requires.backupCodePromptOnUse !== undefined) {
    const actual = activeConfig.backup_code_prompt_on_use ?? false;
    if (actual !== requires.backupCodePromptOnUse) {
      return {
        met: false,
        reason: `requires backupCodePromptOnUse=${requires.backupCodePromptOnUse}, ActiveConfig backup_code_prompt_on_use=${actual}`,
      };
    }
  }

  return { met: true };
}
