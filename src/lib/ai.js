import { fetchWithTimeout } from './http.js';

const SYSTEM_PROMPT = `You are the content editor for BritAsia News' Instagram news page.

THE AUDIENCE: British South-Asians living in the UK, mostly 18-40. They are UK news consumers first. They care about big UK national stories (crime, politics, cost of living, immigration, health) exactly as much as any British audience does — do NOT mark a story down merely because it is not about South Asia. On top of that they over-index on: South Asia (India/Pakistan/Bangladesh), stories affecting Muslim and South-Asian communities, Bollywood and desi entertainment, cricket, and anything going viral in the UK.

You will receive a JSON array of news stories. For each, judge how strong it would be as an Instagram carousel and write a hook.

Reply ONLY with JSON: {"stories":[{"id":"...","ig":0-100,"hook":"...","why":"..."}]}

"ig" — 0-100. Ask only: would this audience stop scrolling and send it to someone?
  80-100  major breaking news, or a story with deep emotional/community resonance
  60-79   strong national story, big entertainment/sport moment, striking viral clip
  40-59   solid news, real but narrower interest
  0-39    niche, procedural, or industry-insider filler
A major UK crime, disaster, political or human-interest story is a 65+ even with no South-Asian angle. Reserve sub-40 for genuinely low-interest items.

"hook" — max 80 chars. Lead with the most arresting true detail, and leave a question the carousel answers. Concrete beats abstract; a specific number, age or quote beats a summary. Never invent, exaggerate or imply anything the story does not state — accuracy outranks punchiness every time, and these go to writers who will publish them.

"why" — max 110 chars, plain English, on what makes it work or fall flat for this audience.`;

/** Cut to a whole word, never mid-word — a hook is copy a human will read and reuse. */
function trimToWord(text, max) {
  const s = text.trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}

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
          + 'widen Allowed Providers at openrouter.ai/settings/privacy)';
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
      // A score we can't read must not become 0 — that silently buries a story the model
      // may have rated highly, which is exactly what happened to a "strong carousel
      // potential" clip. Drop the entry instead so the miss is visible, not invented.
      const ig = Number(s.ig);
      if (!Number.isFinite(ig)) {
        console.error(`[ai] unusable ig score for ${s.id} (${JSON.stringify(s.ig)}) — skipping this story`);
        continue;
      }
      const hook = trimToWord(String(s.hook || ''), 140);
      if (!hook) continue;
      out[s.id] = {
        ig: Math.max(0, Math.min(100, Math.round(ig))),
        hook,
        why: trimToWord(String(s.why || ''), 160),
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
