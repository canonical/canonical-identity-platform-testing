// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0

import type { BrowserContext } from "@playwright/test";

/**
 * Videos of failed tests are uploaded as public CI artifacts (nightly-live.yml). Passwords are
 * random per seed and drawn as dots, but anything on screen that works as a second factor or a
 * credential must not be published either: the TOTP secret and its QR code, backup codes, and
 * the RP consumer's tokens (a refresh token plus the repo's public client secret is a login).
 *
 * The mask makes that text transparent and those images invisible before the frame is painted
 * (MutationObserver callbacks run before rendering). Nothing is removed from the DOM:
 * `innerText`, `inputValue()` and Playwright's visibility checks see the page exactly as before,
 * so what the suite reads and asserts is unchanged. It errs towards masking too much: an ordinary
 * 8-character lowercase word is hidden along with the backup codes that share its shape.
 */
export async function maskSecretsOnScreen(context: BrowserContext): Promise<void> {
  await context.addInitScript(maskSecretsInPage);
}

// Serialized into every frame by addInitScript: it must not reference anything outside itself.
function maskSecretsInPage(): void {
  const MARK = "data-test-masked";
  const SECRET_TEXT: RegExp[] = [
    /eyJ[\w-]{8,}\.[\w-]{8,}/, // JWT: access and ID tokens
    /\bory_[a-z]{2}_[\w.-]{8,}/, // opaque Ory tokens and authorization codes
    /^[A-Z2-7 ]{16,}$/, // base32 TOTP secret on the enrolment page
    /^[a-z0-9]{8}$/, // a backup code: the shape transitions.ts harvests them by
  ];
  const isSecret = (text: string): boolean => {
    const t = text.trim();
    return t.length >= 8 && SECRET_TEXT.some((re) => re.test(t));
  };
  const hide = (el: Element | null, property: "color" | "opacity"): void => {
    if (!(el instanceof HTMLElement || el instanceof SVGElement) || el.hasAttribute(MARK)) return;
    el.setAttribute(MARK, "");
    if (property === "opacity") {
      el.style.setProperty("opacity", "0", "important");
    } else {
      el.style.setProperty("color", "transparent", "important");
      el.style.setProperty("-webkit-text-fill-color", "transparent", "important");
      el.style.setProperty("text-shadow", "none", "important");
    }
  };
  // Kratos serves the TOTP QR as a data: URI (login-ui NodeImage renders node/image/totp_qr).
  const isQr = (el: Element): boolean =>
    el instanceof HTMLImageElement &&
    ((el.getAttribute("src") ?? "").startsWith("data:") || (el.dataset.testid ?? "").includes("totp_qr"));
  const checkElement = (el: Element): void => {
    if (isQr(el)) hide(el, "opacity");
    else if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && isSecret(el.value)) hide(el, "color");
  };
  const scan = (root: Node): void => {
    if (root.nodeType === Node.TEXT_NODE) {
      if (isSecret((root as Text).data)) hide(root.parentElement, "color");
      return;
    }
    if (root instanceof Element) checkElement(root);
    if (!(root instanceof Element || root instanceof Document || root instanceof DocumentFragment)) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === Node.TEXT_NODE) {
        if (isSecret((n as Text).data)) hide(n.parentElement, "color");
      } else {
        checkElement(n as Element);
      }
    }
  };
  try {
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "childList") r.addedNodes.forEach(scan);
        else scan(r.target);
      }
    }).observe(document, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["src", "value"] });
    // Typed values change a property, not the DOM: filled backup codes arrive as input events.
    document.addEventListener("input", (e) => { if (e.target instanceof Element) checkElement(e.target); }, true);
    scan(document);
  } catch {
    // Never let the mask break the page under test.
  }
}
