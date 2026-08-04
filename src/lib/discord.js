import { fetchWithTimeout, sleep, envValue } from './http.js';

const API = 'https://discord.com/api/v10';
const POST_GAP_MS = 400;

let lastWrite = 0;

/** Discord REST call with 429/5xx retry. Never logs the token. */
export async function api(path, { method = 'GET', body, token } = {}) {
  const botToken = token || envValue('DISCORD_BOT_TOKEN');
  if (!botToken) throw new Error('DISCORD_BOT_TOKEN missing');

  for (let attempt = 0; attempt < 4; attempt++) {
    if (method !== 'GET') {
      const wait = lastWrite + POST_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastWrite = Date.now();
    }
    const res = await fetchWithTimeout(`${API}${path}`, {
      method,
      timeoutMs: 15000,
      headers: {
        authorization: `Bot ${botToken}`,
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      await sleep(Math.ceil((data.retry_after || 2) * 1000) + 250);
      continue;
    }
    if (res.status >= 500) {
      await sleep(1500);
      continue;
    }
    if (res.status === 204) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`discord ${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
    }
    return res.json();
  }
  throw new Error(`discord ${method} ${path} -> gave up after retries`);
}

export const postMessage = (channelId, payload) =>
  api(`/channels/${channelId}/messages`, { method: 'POST', body: payload });

export const editMessage = (channelId, messageId, payload) =>
  api(`/channels/${channelId}/messages/${messageId}`, { method: 'PATCH', body: payload });

/** Embed URLs of the channel's recent messages — the duplicate-post guard. */
export async function recentEmbedUrls(channelId) {
  try {
    const msgs = await api(`/channels/${channelId}/messages?limit=25`);
    const urls = new Set();
    for (const m of msgs) for (const e of m.embeds || []) if (e.url) urls.add(e.url);
    return urls;
  } catch (err) {
    // Posting still proceeds, but without the guard a repost is possible — so this must
    // never be silent. It was the one unlogged catch in the codebase.
    console.error(`  dedup guard unavailable for channel ${channelId}: ${err.message}`);
    return new Set();
  }
}

function hexColor(hex) {
  return parseInt(hex, 16);
}

export function scoreBadge(score) {
  return score >= 80 ? `🔥 ${score}` : score >= 60 ? `⚡ ${score}` : `📌 ${score}`;
}

const CATEGORY_LABEL = {
  uk: 'UK', world: 'World', southasia: 'South Asia',
  entertainment: 'Entertainment', sport: 'Sport', viral: 'Viral',
};

/** Build the message payload for a story cluster in a given channel. */
export function buildStoryMessage(cluster, channel, cfg, discordCfg) {
  const primary = [...cluster.links].sort((a, b) => b.weight - a.weight)[0];
  const others = cluster.links.filter((l) => l !== primary).slice(0, 3);
  const isBreakingChannel = channel === 'breaking-news';
  const color = hexColor(isBreakingChannel ? cfg.colors.breaking : (cfg.colors[cluster.cat] || cfg.colors.world));

  const fields = [
    { name: 'Score', value: scoreBadge(cluster.score), inline: true },
    { name: 'Coverage', value: `${cluster.brands.length} outlet${cluster.brands.length > 1 ? 's' : ''}`, inline: true },
  ];
  if (others.length) {
    fields.push({
      name: 'Also',
      value: others.map((l) => `[${l.sourceName}](${l.link})`).join(' · ').slice(0, 1024),
      inline: true,
    });
  }

  const payload = {
    embeds: [{
      title: cluster.title.slice(0, 256),
      url: primary.link,
      description: (primary.snippet || '').slice(0, 240),
      color,
      timestamp: new Date(primary.publishedAt).toISOString(),
      author: { name: `${primary.sourceName} · ${CATEGORY_LABEL[cluster.cat] || 'News'}` },
      fields,
      footer: { text: `${channel} · BritAsia news desk` },
    }],
    allowed_mentions: { parse: [] },
  };

  if (isBreakingChannel && discordCfg.roles?.breakingPing) {
    payload.content = `<@&${discordCfg.roles.breakingPing}> 🚨 **BREAKING**`;
    payload.allowed_mentions = { parse: [], roles: [discordCfg.roles.breakingPing] };
  }
  return payload;
}

/** #instagram-ideas embed for one AI-evaluated story. */
export function buildIdeaMessage(cluster, ai, cfg) {
  const primary = [...cluster.links].sort((a, b) => b.weight - a.weight)[0];
  return {
    embeds: [{
      title: `💡 ${ai.hook}`.slice(0, 256),
      url: primary.link,
      description: `**Story:** [${cluster.title.slice(0, 180)}](${primary.link})\n**Why it works:** ${ai.why}`,
      color: hexColor(cfg.colors.entertainment),
      fields: [
        { name: 'IG score', value: scoreBadge(ai.ig), inline: true },
        { name: 'Coverage', value: `${cluster.brands.length} outlet(s)`, inline: true },
      ],
      footer: { text: 'AI pick · BritAsia news desk' },
      timestamp: new Date().toISOString(),
    }],
    allowed_mentions: { parse: [] },
  };
}

export function buildTrendDigest(terms, cfg) {
  const lines = terms.map((t, i) => `**${i + 1}.** ${t.term}${t.traffic ? ` — ${t.traffic}` : ''}`);
  return {
    embeds: [{
      title: '📈 Trending in the UK right now',
      description: lines.join('\n').slice(0, 4000),
      color: hexColor(cfg.colors.viral),
      footer: { text: 'Google Trends GB · BritAsia news desk' },
      timestamp: new Date().toISOString(),
    }],
    allowed_mentions: { parse: [] },
  };
}

export function buildStatusMessage(text, cfg, ok = false) {
  return {
    embeds: [{
      description: text.slice(0, 4000),
      color: hexColor(ok ? '2ECC71' : cfg.colors.status),
      timestamp: new Date().toISOString(),
    }],
    allowed_mentions: { parse: [] },
  };
}

/**
 * Assign @Breaking-Ping to members we haven't processed before (default-on;
 * removals stick because known members are never touched again).
 * Requires the Server Members privileged intent. Returns count assigned, or -1 if unavailable.
 */
export async function sweepMembers(state, discordCfg) {
  const { guildId, roles } = discordCfg;
  if (!guildId || !roles?.breakingPing) return -1;
  let members;
  try {
    members = await api(`/guilds/${guildId}/members?limit=1000`);
  } catch (err) {
    console.error(`[sweep] cannot list members (Server Members Intent enabled?): ${err.message}`);
    return -1;
  }
  const known = new Set(state.knownMembers);
  let assigned = 0;
  for (const m of members) {
    const uid = m.user?.id;
    if (!uid || m.user?.bot || known.has(uid)) continue;
    if (!m.roles.includes(roles.breakingPing)) {
      try {
        await api(`/guilds/${guildId}/members/${uid}/roles/${roles.breakingPing}`, { method: 'PUT' });
        assigned++;
      } catch (err) {
        console.error(`[sweep] role assign failed for ${uid}: ${err.message}`);
        continue; // don't mark known; retry next sweep
      }
    }
    known.add(uid);
  }
  state.knownMembers = [...known];
  return assigned;
}
