// Posts (or refreshes) the #welcome instructions message. Run: npm run setup:welcome
import { readFileSync, writeFileSync } from 'node:fs';
import { api, postMessage, editMessage } from '../src/lib/discord.js';

const cfg = JSON.parse(readFileSync('config/discord.json', 'utf8'));
const welcomeId = cfg.channels['welcome'];
if (!welcomeId) {
  console.error('No #welcome channel in config/discord.json — run setup:server first');
  process.exit(1);
}

const embed = {
  title: '👋 Welcome to the BritAsia news desk',
  color: 0xc8102e,
  description: [
    'This server is your **always-on news wire** — the latest, most clickworthy stories, pulled from 25+ major outlets every few minutes, scored and deduplicated so you only see what matters.',
    '',
    '**🚨 <#BREAKING>** — only genuinely major stories land here, and they ping <@&PING_ROLE>. Everyone has pings **on by default**; ask a @Staff member to remove your Breaking-Ping role if you want them off (you can still read everything).',
    '**⭐ <#TOP>** — the biggest stories right now, each showing how many outlets are covering it.',
    '**🗂️ Desk channels** — UK, World, South Asia, Entertainment, Sport, Viral. Browse when you need material.',
    '**💡 <#IDEAS>** — AI-picked stories with ready-made Instagram hooks, scored for how well they\'d perform as carousels.',
    '**☕ <#BRIEFING>** — top 10 of the last 24h, every morning at 8am UK.',
    '',
    '💬 Want to discuss a story? **Open a thread** on its post — keeps the wire clean.',
    '🤖 The bot appears **offline** — that\'s normal, it posts on a schedule rather than sitting in the server.',
    '📊 Score badges: 🔥 80+ major · ⚡ 60+ strong · 📌 solid.',
  ].join('\n'),
  footer: { text: 'BritAsia news desk' },
};

function fill(text) {
  return text
    .replaceAll('<#BREAKING>', `<#${cfg.channels['breaking-news']}>`)
    .replaceAll('<#TOP>', `<#${cfg.channels['top-stories']}>`)
    .replaceAll('<#IDEAS>', `<#${cfg.channels['instagram-ideas']}>`)
    .replaceAll('<#BRIEFING>', `<#${cfg.channels['daily-briefing']}>`)
    .replaceAll('<@&PING_ROLE>', `<@&${cfg.roles.breakingPing}>`);
}
embed.description = fill(embed.description);

const payload = { embeds: [embed], allowed_mentions: { parse: [] } };

if (cfg.welcomeMessageId) {
  await editMessage(welcomeId, cfg.welcomeMessageId, payload);
  console.log('welcome message refreshed');
} else {
  const msg = await postMessage(welcomeId, payload);
  await api(`/channels/${welcomeId}/pins/${msg.id}`, { method: 'PUT' }).catch(() => {});
  cfg.welcomeMessageId = msg.id;
  writeFileSync('config/discord.json', JSON.stringify(cfg, null, 2));
  console.log('welcome message posted and pinned');
}
