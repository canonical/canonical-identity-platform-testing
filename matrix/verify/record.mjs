// Copyright 2026 Canonical Ltd.
// SPDX-License-Identifier: AGPL-3.0
//
// The verifier's check ledger and its HTTP primitive, shared by every layer.

const results = [];

export function record(layer, check, ok, detail, { warn = false } = {}) {
  results.push({ layer, check, ok, warn, detail });
  const mark = ok ? "✓" : warn ? "⚠" : "✗";
  console.log(`  ${mark} [${layer}] ${check}${detail ? ` — ${detail}` : ""}`);
}

/** The results buffer is module state (one verifier process may verify many
 *  rows), so each verification clears it and offline tests read it back to
 *  assert that a probe RECORDED a failure instead of throwing. */
export function resetResults() {
  results.length = 0;
}

export function recordedResults() {
  return results.slice();
}

export async function fetchJson(url, opts = {}) {
  let res;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(opts.timeout ?? 8000),
      headers: { Accept: "application/json", ...(opts.headers ?? {}) },
      method: opts.method ?? "GET",
      body: opts.body,
    });
  } catch (err) {
    // Network failure is a CHECK RESULT (status 0), never a crash: a probe
    // against an unreachable deployment must record and continue.
    return { status: 0, body: null, error: err?.cause?.message ?? err?.message ?? String(err) };
  }
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON body: callers that need it read `text` */
  }
  return { status: res.status, body, text };
}

export async function reachable(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.status > 0;
  } catch {
    return false;
  }
}
