/** Fetch with a hard timeout. Returns the Response; throws on network error/timeout. */
export async function fetchWithTimeout(url, { timeoutMs = 10000, headers = {}, method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method,
      headers,
      body,
      redirect: 'follow',
      signal: controller.signal,
    });
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
