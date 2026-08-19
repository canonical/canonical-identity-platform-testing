// Copyright 2026 Canonical Ltd
// SPDX-License-Identifier: AGPL-3.0

/**
 * WebAuthn virtual authenticator helper.
 *
 * Uses the Chrome DevTools Protocol (CDP) to add a virtual authenticator
 * that automatically responds to WebAuthn ceremonies. This works with both
 * Playwright's built-in Chromium and real Chrome (`channel: 'chrome'`).
 *
 * The Playwright `context.addVirtualAuthenticator()` API is only available
 * in Playwright >= 1.44 and does NOT work with `channel: 'chrome'`. The CDP
 * approach works universally because it talks directly to the browser's
 * WebAuthn implementation.
 *
 * Usage:
 *   const webauthn = new WebAuthnHelper(page);
 *   await webauthn.setup();           // enable WebAuthn + add virtual authenticator
 *   // ... interact with the page (click "Add security key", etc.)
 *   await webauthn.getCredentials(); // inspect registered credentials
 *   await webauthn.removeAuthenticator(); // cleanup
 */

import { Page, CDPSession } from "@playwright/test";

/** State for a single virtual authenticator session. */
export interface WebAuthnState {
  cdpSession: CDPSession;
  authenticatorId: string;
}

export class WebAuthnHelper {
  private state: WebAuthnState | null = null;

  constructor(private page: Page) {}

  /**
   * Set up a CDP session and add a virtual authenticator.
   *
   * Call this BEFORE any WebAuthn ceremony (e.g. before clicking
   * "Add security key" or "Sign in with security key").
   *
   * If an authenticator is already set up, this is a no-op (unless
   * the previous one was removed).
   */
  async setup(): Promise<void> {
    if (this.state) {
      // Verify the authenticator still exists
      try {
        await this.state.cdpSession.send("WebAuthn.getCredentials", {
          authenticatorId: this.state.authenticatorId,
        });
        return; // still alive
      } catch {
        // Authenticator was detached — recreate
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

  /**
   * Get all credentials registered on the virtual authenticator.
   */
  async getCredentials(): Promise<Array<{ credentialId: string; rpId?: string; userHandle?: string }>> {
    if (!this.state) throw new Error("WebAuthn not set up — call setup() first");
    const response = await this.state.cdpSession.send("WebAuthn.getCredentials", {
      authenticatorId: this.state.authenticatorId,
    });
    return response.credentials ?? [];
  }

  /**
   * Remove all credentials from the virtual authenticator.
   * Useful for cleanup between test phases.
   */
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

  /**
   * Remove the virtual authenticator entirely.
   * Call this in test cleanup (afterAll / afterEach).
   */
  async removeAuthenticator(): Promise<void> {
    if (!this.state) return;
    try {
      await this.state.cdpSession.send("WebAuthn.removeVirtualAuthenticator", {
        authenticatorId: this.state.authenticatorId,
      });
    } catch {
      // best-effort — the session may have already closed
    }
    this.state = null;
  }

  /**
   * Get the authenticator ID (useful for debugging).
   */
  get authenticatorId(): string | undefined {
    return this.state?.authenticatorId;
  }
}
