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
  title: 'How this server works',
  color: 0xc8102e,
  description: [
    'A bot reads 26 news feeds from 15 outlets, six times an hour. It groups the same story across outlets, scores it, and posts it here. Nothing is written by a person before it appears.',
    '',
    '**Scoring.** A story starts with the weight of its outlet, then gains points for each additional outlet running it, for words like *arrested*, *killed* or *resigns*, and for appearing in Google News UK top stories. It loses points as it ages. The score sets where it lands.',
    '',
    `**<#BREAKING>** takes stories at 70 or above with at least two outlets confirming, and pings <@&PING_ROLE>. That is 2 posts a run, 4 an hour, no more. You have the ping role by default. Ask a @Staff member to remove it and you keep reading everything, silently.`,
    `**<#TOP>** takes 48 and above. Every post shows the outlet count, so 4 outlets means four newsrooms independently ran it.`,
    '**Desk channels** take 22 and above, split by subject. Go here for material rather than waiting to be pinged.',
    `**<#IDEAS>** holds stories a model rated 50 or above for carousel potential, each with a hook already written.`,
    `**<#BRIEFING>** posts the 10 highest scorers of the previous 24 hours, after 08:00 London.`,
    '',
    '**Before you publish anything from <#IDEAS>, open the source link and check it.** The hook is generated. It can be wrong, and your name goes on the carousel, not the bot\'s.',
    '',
    'Reply in a thread on a post rather than in the channel, so the wire stays readable. Say in <#CHAT> which story you are taking.',
    '',
    'Badges: 🔥 is 80 or above, ⚡ is 60 to 79, 📌 is below 60. The bot shows as offline because it wakes on a schedule and does not hold a connection.',
  ].join('\n'),
  footer: { text: 'BritAsia news desk' },
};

function fill(text) {
  return text
    .replaceAll('<#BREAKING>', `<#${cfg.channels['breaking-news']}>`)
    .replaceAll('<#TOP>', `<#${cfg.channels['top-stories']}>`)
    .replaceAll('<#IDEAS>', `<#${cfg.channels['instagram-ideas']}>`)
    .replaceAll('<#BRIEFING>', `<#${cfg.channels['daily-briefing']}>`)
    .replaceAll('<#CHAT>', `<#${cfg.channels['writers-chat']}>`)
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
