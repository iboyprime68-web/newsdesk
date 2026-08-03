// Live posting rehearsal: sends three synthetic stories (one per tier) to #bot-status
// through the real embed builders, then exercises the edit path. Safe to re-run.
import { readFileSync } from 'node:fs';
import { postMessage, editMessage, buildStoryMessage } from '../src/lib/discord.js';

const cfg = JSON.parse(readFileSync('config/scoring.json', 'utf8'));
const discordCfg = JSON.parse(readFileSync('config/discord.json', 'utf8'));
const statusChan = discordCfg.channels['bot-status'];
if (!statusChan) {
  console.error('no #bot-status channel — run setup:server first');
  process.exit(1);
}

const mk = (title, cat, score, tier, brands) => ({
  title, cat, score, tier,
  brands,
  gn: true,
  trendHit: false,
  posted: {},
  links: brands.map((b, i) => ({
    title, brand: b, sourceName: b.toUpperCase(), weight: 25 - i,
    link: `https://example.com/${b}/story`, snippet: 'Synthetic rehearsal story — this is what a real post will look like. If you can read this, embeds render correctly.',
    publishedAt: Date.now(),
  })),
});

const stories = [
  mk('🧪 REHEARSAL: Major incident declared after test embed renders perfectly', 'uk', 87, 'BREAKING', ['bbc', 'sky', 'aljazeera', 'guardian']),
  mk('🧪 REHEARSAL: Top story lands with multi-outlet coverage', 'southasia', 61, 'TOP', ['ndtv', 'dawn']),
  mk('🧪 REHEARSAL: Normal desk story posts quietly', 'entertainment', 34, 'NORMAL', ['hungama']),
];

// Breaking rehearsal goes through the breaking-news channel builder so the role
// mention path is exercised — but it posts into #bot-status (staff only see it).
const channelsAs = ['breaking-news', 'top-stories', 'entertainment'];

let firstMsg = null;
for (let i = 0; i < stories.length; i++) {
  const payload = buildStoryMessage(stories[i], channelsAs[i], cfg, discordCfg);
  const msg = await postMessage(statusChan, payload);
  if (!firstMsg) firstMsg = msg;
  console.log(`posted ${stories[i].tier} rehearsal (message ${msg.id})`);
}

// Edit path: grow the breaking story's coverage and update the embed.
stories[0].brands.push('toi');
stories[0].links.push({
  title: stories[0].title, brand: 'toi', sourceName: 'Times of India', weight: 18,
  link: 'https://example.com/toi/story', snippet: '', publishedAt: Date.now(),
});
await editMessage(statusChan, firstMsg.id, buildStoryMessage(stories[0], 'breaking-news', cfg, discordCfg));
console.log('edit path verified (coverage 4 → 5 outlets)');
console.log('rehearsal complete — check #bot-status in Discord');
