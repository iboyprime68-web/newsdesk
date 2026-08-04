import { fetchWithTimeout } from './http.js';

const SYSTEM_PROMPT = `You are the content editor for BritAsia News' Instagram news page. The audience is British South-Asians in the UK (18-40): UK news, world news, South Asia (India/Pakistan/Bangladesh), Bollywood and entertainment, sport including cricket, and viral moments.

You will receive a JSON array of news stories. For each story, judge how strong it would be as an Instagram carousel post for this audience, and write a hook.

Reply ONLY with JSON: {"stories":[{"id":"...","ig":0-100,"hook":"...","why":"..."}]}
- "ig": Instagram-worthiness 0-100 for THIS audience (emotional pull, shareability, visual potential, relevance). Be discriminating: most stories are 30-60, reserve 80+ for certain bangers.
- "hook": a scroll-stopping headline, max 80 chars. Punchy, curiosity-driven, accurate — never invent facts not in the story.
- "why": max 110 chars on why it works (or doesn't) for the audience.`;

/**
 * One batched OpenRouter call scoring clusters for IG-worthiness.
 * Returns { results, error }: results is { [cid]: {ig, hook, why} } when it worked,
 * error is a human-readable reason when it didn't. Callers degrade gracefully either way.
 */
export async function aiEvaluate(candidates, cfg, apiKey) {
  if (!cfg.ai.enabled) return { results: null, error: null };
  if (!apiKey) return { results: null, error: 'OPENROUTER_API_KEY not set' };
  if (candidates.length === 0) return { results: null, error: null };

  const payload = candidates.slice(0, cfg.ai.maxStoriesPerRun).map(({ cid, cluster }) => ({
    id: cid,
    headline: cluster.title,
    snippet: (cluster.links[0]?.snippet || '').slice(0, 220),
    outlets: cluster.brands,
    category: cluster.cat,
  }));

  let res;
  try {
    res = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      timeoutMs: cfg.ai.timeoutMs,
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'x-title': 'newsdesk',
      },
      body: JSON.stringify({
        model: cfg.ai.models[0],
        models: cfg.ai.models,
        temperature: cfg.ai.temperature,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Stories as JSON:\n${JSON.stringify(payload)}` },
        ],
      }),
    });
  } catch (err) {
    const error = `request failed: ${err.message}`;
    console.error(`[ai] ${error}`);
    return { results: null, error };
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    let detail = raw.slice(0, 200);
    try {
      const parsed = JSON.parse(raw);
      detail = parsed.error?.message || detail;
      // A provider allowlist on the OpenRouter account blocks every model regardless
      // of the slug we ask for — worth spelling out, it looks like a model typo.
      const requested = parsed.error?.metadata?.requested_providers;
      if (requested?.length) {
        detail += ` (your OpenRouter account only allows provider(s): ${requested.join(', ')} — `
          + 'clear the Allowed Providers restriction at openrouter.ai/settings/preferences)';
      }
    } catch { /* keep the raw snippet */ }
    const error = `HTTP ${res.status} — ${detail}`;
    console.error(`[ai] ${error}`);
    return { results: null, error };
  }

  try {
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '';
    const parsed = JSON.parse(content);
    const out = {};
    for (const s of parsed.stories || []) {
      if (!s.id) continue;
      out[s.id] = {
        ig: Math.max(0, Math.min(100, Math.round(Number(s.ig) || 0))),
        hook: String(s.hook || '').slice(0, 90),
        why: String(s.why || '').slice(0, 120),
      };
    }
    return Object.keys(out).length
      ? { results: out, error: null }
      : { results: null, error: 'model returned no usable stories' };
  } catch (err) {
    const error = `bad response: ${err.message}`;
    console.error(`[ai] ${error}`);
    return { results: null, error };
  }
}

/** Draft a 7-slide IG carousel script for one story (used by phase-2 /carousel). */
export const CAROUSEL_PROMPT = `You write Instagram carousel scripts for BritAsia News (British South-Asian audience, UK). Given a news story, produce a 7-slide carousel script: slide 1 is a bold hook (max 12 words), slides 2-6 tell the story in short punchy lines (max 25 words each), slide 7 is a call-to-action/summary. Accurate to the source — never invent facts. Reply as plain text with "SLIDE N:" prefixes.`;
