// Copyright 2026 Canonical Ltd
// SPDX-License-Identifier: AGPL-3.0

// CDP virtual authenticator (works with `channel: 'chrome'`, unlike
// `context.addVirtualAuthenticator()`). setup() before any ceremony; removeAuthenticator() in cleanup.

import { Page, CDPSession } from "@playwright/test";

export interface WebAuthnState {
  cdpSession: CDPSession;
  authenticatorId: string;
}

export class WebAuthnHelper {
  private state: WebAuthnState | null = null;

  constructor(private page: Page) {}

  // No-op if the authenticator still exists; recreates it if detached.
  async setup(): Promise<void> {
    if (this.state) {
      try {
        await this.state.cdpSession.send("WebAuthn.getCredentials", {
          authenticatorId: this.state.authenticatorId,
        });
        return; // still alive
      } catch {
        this.state = null;
      }
    }

    const cdpSession = await this.page.context().newCDPSession(this.page);
    await cdpSession.send("WebAuthn.enable");

    const result = await cdpSession.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "usb",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });

    this.state = {
      cdpSession,
      authenticatorId: result.authenticatorId,
    };
  }

  async getCredentials(): Promise<Array<{ credentialId: string; rpId?: string; userHandle?: string }>> {
    if (!this.state) throw new Error("WebAuthn not set up — call setup() first");
    const response = await this.state.cdpSession.send("WebAuthn.getCredentials", {
      authenticatorId: this.state.authenticatorId,
    });
    return response.credentials ?? [];
  }

  async removeAllCredentials(): Promise<void> {
    if (!this.state) return;
    const credentials = await this.getCredentials();
    for (const cred of credentials) {
      await this.state.cdpSession.send("WebAuthn.removeCredential", {
        authenticatorId: this.state.authenticatorId,
        credentialId: cred.credentialId,
      });
    }
  }

  async removeAuthenticator(): Promise<void> {
    if (!this.state) return;
    try {
      await this.state.cdpSession.send("WebAuthn.removeVirtualAuthenticator", {
        authenticatorId: this.state.authenticatorId,
      });
    } catch {
      // best-effort; the session may have already closed
    }
    this.state = null;
  }

  get authenticatorId(): string | undefined {
    return this.state?.authenticatorId;
  }
}
