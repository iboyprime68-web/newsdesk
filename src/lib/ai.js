import { fetchWithTimeout } from './http.js';

const SYSTEM_PROMPT = `You are the content editor for BritAsia News' Instagram news page. The audience is British South-Asians in the UK (18-40): UK news, world news, South Asia (India/Pakistan/Bangladesh), Bollywood and entertainment, sport including cricket, and viral moments.

You will receive a JSON array of news stories. For each story, judge how strong it would be as an Instagram carousel post for this audience, and write a hook.

Reply ONLY with JSON: {"stories":[{"id":"...","ig":0-100,"hook":"...","why":"..."}]}
- "ig": Instagram-worthiness 0-100 for THIS audience (emotional pull, shareability, visual potential, relevance). Be discriminating: most stories are 30-60, reserve 80+ for certain bangers.
- "hook": a scroll-stopping headline, max 80 chars. Punchy, curiosity-driven, accurate — never invent facts not in the story.
- "why": max 110 chars on why it works (or doesn't) for the audience.`;

/**
 * One batched OpenRouter call scoring clusters for IG-worthiness.
 * Returns { [cid]: {ig, hook, why} } or null on any failure (caller degrades gracefully).
 */
export async function aiEvaluate(candidates, cfg, apiKey) {
  if (!cfg.ai.enabled || !apiKey || candidates.length === 0) return null;

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
    console.error(`[ai] request failed: ${err.message}`);
    return null;
  }

  if (!res.ok) {
    console.error(`[ai] http ${res.status}`);
    return null;
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
    return Object.keys(out).length ? out : null;
  } catch (err) {
    console.error(`[ai] bad response: ${err.message}`);
    return null;
  }
}

/** Draft a 7-slide IG carousel script for one story (used by phase-2 /carousel). */
export const CAROUSEL_PROMPT = `You write Instagram carousel scripts for BritAsia News (British South-Asian audience, UK). Given a news story, produce a 7-slide carousel script: slide 1 is a bold hook (max 12 words), slides 2-6 tell the story in short punchy lines (max 25 words each), slide 7 is a call-to-action/summary. Accurate to the source — never invent facts. Reply as plain text with "SLIDE N:" prefixes.`;
