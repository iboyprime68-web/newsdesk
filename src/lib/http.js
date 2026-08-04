/**
 * Fetch and read the whole body under ONE deadline.
 *
 * The timeout has to cover body reading, not just the connection. Awaiting `fetch`
 * resolves as soon as response headers arrive, so clearing the timer there leaves the
 * body read unbounded — a server that answers 200 and then stalls mid-stream hangs the
 * process forever. That is not theoretical: it burned a full 8-minute CI job.
 *
 * Returns a plain object rather than a Response because the body is already consumed.
 */
export async function fetchWithTimeout(url, { timeoutMs = 10000, headers = {}, method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      redirect: 'follow',
      signal: controller.signal,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, headers: res.headers, text };
  } finally {
    clearTimeout(timer);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Read a secret from the environment, tolerating the invisible junk that survives a
 * copy-paste or a shell pipe (a leading BOM makes fetch throw on the auth header).
 */
export function envValue(name) {
  return (process.env[name] || '').replace(/^﻿/, '').trim();
}
