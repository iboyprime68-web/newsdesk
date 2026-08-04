// Newsdesk pipeline orchestrator.
//   node src/run.js                  live run (needs config/discord.json + DISCORD_BOT_TOKEN)
//   node src/run.js --dry-run        no Discord writes; prints what would post
//   node src/run.js --dry-run --explain   also prints per-cluster score breakdowns
import { readFileSync, existsSync } from 'node:fs';

import { envValue } from './lib/http.js';
import { dueFeeds, fetchAllFeeds, isPublishableLink } from './lib/feeds.js';
import { clusterItems } from './lib/dedupe.js';
import { classifyCluster } from './lib/classify.js';
import { scoreCluster, targetChannels, allocatePosts } from './lib/score.js';
import { updateTrends } from './lib/trends.js';
import { aiEvaluate } from './lib/ai.js';
import { loadState, pruneState, saveState } from './lib/state.js';
import { briefingIfDue } from './lib/briefing.js';
import {
  postMessage, editMessage, recentEmbedUrls, sweepMembers,
  buildStoryMessage, buildIdeaMessage, buildTrendDigest, buildStatusMessage,
} from './lib/discord.js';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const EXPLAIN = args.includes('--explain');
const STATE_DIR = process.env.STATE_DIR || '.state';

const feedsCfg = JSON.parse(readFileSync('config/feeds.json', 'utf8'));
const cfg = JSON.parse(readFileSync('config/scoring.json', 'utf8'));
const discordCfg = existsSync('config/discord.json')
  ? JSON.parse(readFileSync('config/discord.json', 'utf8'))
  : null;
// Keyed by id and by name: links written before sourceId existed only carry the name.
const feedIndex = {};
for (const f of feedsCfg.feeds) {
  feedIndex[f.id] = f;
  if (f.name) feedIndex[f.name] = f;
}

const live = !DRY && !!discordCfg && !!envValue('DISCORD_BOT_TOKEN');
if (!DRY && !live) {
  console.log('note: no config/discord.json or DISCORD_BOT_TOKEN — running as dry-run');
}

const now = Date.now();
const state = loadState(STATE_DIR);
state.runSeq += 1;
const bootstrap = Object.keys(state.seenLinks).length === 0;

// ── 1. Fetch ────────────────────────────────────────────────────────────────
const due = dueFeeds(feedsCfg.feeds, state.runSeq);
const { items, statuses } = await fetchAllFeeds(due, state, now);
console.log(`run #${state.runSeq}${bootstrap ? ' (bootstrap — seeding, no posts)' : ''}: polled ${due.length} feeds`);
for (const [id, st] of Object.entries(statuses)) {
  if (st !== 'ok' && st !== '304') console.log(`  feed ${id}: ${st}`);
}

// ── 2. Split trends / news, drop seen ───────────────────────────────────────
const trendItems = items.filter((i) => feedsCfg.feeds.find((f) => f.id === i.sourceId)?.trendsOnly);
const newsItems = items.filter((i) => !trendItems.includes(i) && !state.seenLinks[i.id]);
for (const i of newsItems) state.seenLinks[i.id] = now;
console.log(`  ${items.length} items fetched, ${newsItems.length} new`);

// ── 3. Cluster + trends + score ─────────────────────────────────────────────
const touched = clusterItems(state, newsItems, cfg, now);
const { digest, terms } = updateTrends(state, trendItems, cfg, now);

// Desk comes from the story, not from whichever feed published it first. Only clusters
// that have not posted anywhere are re-judged: `posted` is keyed by channel name, so
// moving a cluster's desk after the fact leaves the old key set and the new one unset,
// and the same story goes out a second time.
const catMoves = [];
const reclassify = new Set(touched);
// A cluster the flood caps deferred is not touched again unless another outlet files on
// it, so without this it would keep whatever desk it was handed before the rules ran.
for (const [cid, c] of Object.entries(state.clusters)) {
  if (c.pending && now - c.firstSeen < cfg.pendingRetryMaxAgeMinutes * 60000) reclassify.add(cid);
}
for (const cid of reclassify) {
  const c = state.clusters[cid];
  if (!c || c.ghost || Object.keys(c.posted).length !== 0) continue;
  const cat = classifyCluster(c, cfg, feedIndex);
  if (cat !== c.cat) {
    catMoves.push({ from: c.cat, to: cat, by: 'rules', title: c.title });
    c.cat = cat;
  }
}

for (const cid of touched) {
  const c = state.clusters[cid];
  const detail = scoreCluster(c, cfg, terms, now);
  if (EXPLAIN && !c.ghost) {
    console.log(`  [${detail.tier} ${detail.total}] ${c.title.slice(0, 90)}`
      + `  (src ${detail.maxSourceWeight} + corr ${detail.corroboration} + kw ${detail.kwScore}`
      + ` + gn ${detail.gnBonus} + trend ${detail.trendBonus} + rec ${detail.recency})`);
  }
}

// ── 4. AI evaluation for newly-TOP clusters ─────────────────────────────────
// Sits ahead of allocation because the model also returns a desk, and allocation is what
// turns a category into a channel name. Moving it here costs nothing: this call already
// ran before the first Discord write.
const aiCandidates = [...touched]
  .map((cid) => ({ cid, cluster: state.clusters[cid] }))
  .filter(({ cluster: c }) => !c.ghost && !c.ai && (c.tier === 'TOP' || c.tier === 'BREAKING'))
  .sort((a, b) => b.cluster.score - a.cluster.score)
  .slice(0, cfg.ai.maxStoriesPerRun);

let aiError = null;
if (!bootstrap && aiCandidates.length) {
  const { results, error } = await aiEvaluate(aiCandidates, cfg, envValue('OPENROUTER_API_KEY'));
  aiError = error;
  if (results) {
    for (const { cid, cluster } of aiCandidates) {
      const r = results[cid];
      if (!r) continue;
      // The model reads the whole headline, so it gets the last word on the desk for the
      // stories it sees. Gated on nothing having posted yet, same as the rules pass.
      if (r.cat && r.cat !== cluster.cat && Object.keys(cluster.posted).length === 0) {
        catMoves.push({ from: cluster.cat, to: r.cat, by: 'ai', title: cluster.title });
        cluster.cat = r.cat;
      }
      cluster.ai = r;
    }
  }
}
const ideas = aiCandidates
  .filter(({ cluster: c }) => c.ai && !c.ideaPosted && c.ai.ig >= cfg.ai.minIgScoreToPost)
  .slice(0, 4);

// Every move is printed so the lexicons in config/scoring.json can be tuned against real
// output. Console only, on purpose: staff read #bot-status for problems, and a line a
// minute there would bury the alerts that matter.
for (const m of catMoves) {
  console.log(`  desk ${m.from} -> ${m.to} (${m.by}): ${m.title.slice(0, 70)}`);
}

// ── 5. Decide what to post ──────────────────────────────────────────────────
const candidates = [];
for (const [cid, c] of Object.entries(state.clusters)) {
  if (c.ghost || c.tier === 'SKIP' || c.links.length === 0) continue;
  const isTouched = touched.has(cid);
  const isPendingRetry = c.pending && now - c.firstSeen < cfg.pendingRetryMaxAgeMinutes * 60000;
  if (!isTouched && !isPendingRetry) continue;
  if (targetChannels(c).some((ch) => !c.posted[ch])) candidates.push({ cid, cluster: c });
}

const { toPost, deferred } = bootstrap ? { toPost: [], deferred: [] } : allocatePosts(candidates, cfg, state.postTimes, now);
for (const { cluster } of toPost) cluster.pending = false;
for (const cid of deferred) state.clusters[cid].pending = true;

// ── 6. Briefing ─────────────────────────────────────────────────────────────
const briefing = bootstrap ? null : briefingIfDue(state, cfg, now);

// ── 7. Execute ──────────────────────────────────────────────────────────────
const chanId = (name) => discordCfg?.channels?.[name];
let runDelivered = 0;
let runFailures = 0;

if (!live) {
  for (const { cluster, channel } of toPost) {
    console.log(`  would post [${cluster.tier} ${cluster.score}] -> #${channel}: ${cluster.title.slice(0, 80)}`);
  }
  for (const { cluster } of ideas) {
    console.log(`  would post idea (ig ${cluster.ai.ig}) -> #instagram-ideas: ${cluster.ai.hook}`);
  }
  if (digest) console.log(`  would post trend digest (${digest.length} terms) -> #viral-trending`);
  if (briefing) console.log('  would post daily briefing -> #daily-briefing');
} else {
  // Delivery bookkeeping. Nothing in this branch may mark work "done" before Discord has
  // actually accepted it — a swallowed failure that still burns a cooldown loses the
  // message permanently, and a run where every write failed must not report success.
  let delivered = 0;
  let deliveryFailures = 0;

  // Duplicate-post guard: skip anything whose link already sits in the channel's recent embeds.
  const guard = new Map();
  const channelsInvolved = [...new Set(toPost.map((p) => p.channel))];
  for (const ch of channelsInvolved) {
    if (chanId(ch)) guard.set(ch, await recentEmbedUrls(chanId(ch)));
  }

  for (const { cluster, channel } of toPost) {
    const id = chanId(channel);
    if (!id) { console.log(`  missing channel id for #${channel}, skipped`); continue; }
    const primaryLink = [...cluster.links].sort((a, b) => b.weight - a.weight)[0].link;
    if (!isPublishableLink(primaryLink)) {
      console.error(`  BLOCKED non-publisher link, not posting: ${primaryLink}`);
      cluster.posted[channel] = 'blocked';
      continue;
    }
    if (guard.get(channel)?.has(primaryLink)) {
      cluster.posted[channel] = 'dedup-guard';
      continue;
    }
    try {
      const msg = await postMessage(id, buildStoryMessage(cluster, channel, cfg, discordCfg));
      cluster.posted[channel] = msg.id;
      cluster.postedBrandCount = cluster.brands.length;
      (state.postTimes[channel] ||= []).push(now);
      delivered++;
      console.log(`  posted [${cluster.tier} ${cluster.score}] -> #${channel}: ${cluster.title.slice(0, 70)}`);
    } catch (err) {
      deliveryFailures++;
      console.error(`  post failed #${channel}: ${err.message}`);
      cluster.pending = true;
    }
  }

  for (const { cluster } of ideas) {
    const id = chanId('instagram-ideas');
    if (!id) break;
    const ideaLink = [...cluster.links].sort((a, b) => b.weight - a.weight)[0].link;
    if (!isPublishableLink(ideaLink)) {
      console.error(`  BLOCKED non-publisher link from #instagram-ideas: ${ideaLink}`);
      cluster.ideaPosted = true;
      continue;
    }
    try {
      await postMessage(id, buildIdeaMessage(cluster, cluster.ai, cfg));
      cluster.ideaPosted = true;
      (state.postTimes['instagram-ideas'] ||= []).push(now);
      delivered++;
    } catch (err) {
      deliveryFailures++;
      console.error(`  idea post failed: ${err.message}`);
    }
  }

  if (digest && chanId('viral-trending')) {
    try {
      await postMessage(chanId('viral-trending'), buildTrendDigest(digest, cfg));
      state.lastTrendDigestAt = now; // only now is the digest actually out
      delivered++;
    } catch (err) {
      deliveryFailures++;
      console.error(`  trend digest failed: ${err.message}`);
    }
  }

  if (briefing && chanId('daily-briefing')) {
    try {
      await postMessage(chanId('daily-briefing'), briefing.payload);
      // Stamping the date is what stops the briefing retrying for the rest of the day,
      // so it must never happen for a briefing that was not delivered.
      state.lastBriefingDate = briefing.date;
      delivered++;
      console.log(`  posted daily briefing -> #daily-briefing`);
    } catch (err) {
      deliveryFailures++;
      console.error(`  briefing failed (will retry next run): ${err.message}`);
    }
  }

  // Update coverage counts on already-posted BREAKING/TOP embeds as the story grows.
  for (const [, c] of Object.entries(state.clusters)) {
    if (c.ghost || c.brands.length <= (c.postedBrandCount || 0)) continue;
    let allEditsOk = true;
    for (const channel of ['breaking-news', 'top-stories']) {
      const msgId = c.posted[channel];
      if (!msgId || msgId === 'dedup-guard' || msgId === 'blocked' || !chanId(channel)) continue;
      try {
        await editMessage(chanId(channel), msgId, buildStoryMessage(c, channel, cfg, discordCfg));
        console.log(`  updated coverage on #${channel}: ${c.title.slice(0, 60)}`);
      } catch (err) {
        allEditsOk = false;
        deliveryFailures++;
        console.error(`  edit failed #${channel}: ${err.message}`);
      }
    }
    // Advancing this is what suppresses the retry, so a failed edit must not advance it
    // or the embed keeps a stale outlet count forever.
    if (allEditsOk) c.postedBrandCount = c.brands.length;
  }

  // Default-on breaking pings for members we haven't seen before. Runs before the alert
  // block so a broken sweep can be reported in the same message.
  let memberSweepFailed = false;
  if (state.runSeq % cfg.memberSweepEveryNRuns === 0) {
    const assigned = await sweepMembers(state, discordCfg);
    if (assigned < 0) memberSweepFailed = true;
    else if (assigned > 0) console.log(`  sweep: assigned @Breaking-Ping to ${assigned} member(s)`);
  }

  // Feed-health alerts, max one per feed per 24h.
  // Only alert on feeds we actually tried and that are actually failing — a gap in
  // runs (CI paused, overnight outage) must never look like a dead feed.
  // The 24h cooldowns below are only burned once the alert has actually been delivered.
  // Stamping them earlier means a single failed post silences the next 24 hours of
  // warnings — the exact way an outage stays invisible.
  const alerts = [];
  const alertedFeeds = [];
  let aiAlerted = false;
  for (const f of feedsCfg.feeds) {
    const fs = state.feeds[f.id];
    if (!fs) continue;
    const repeatedFailures = (fs.failCount || 0) >= 3;
    const staleDespiteTrying = fs.lastSuccess
      && now - fs.lastSuccess > 6 * 3600000
      && fs.lastAttempt && now - fs.lastAttempt < 30 * 60000;
    if ((repeatedFailures || staleDespiteTrying) && now - (fs.lastAlert || 0) > 86400000) {
      alertedFeeds.push(fs);
      const why = repeatedFailures ? `${fs.failCount} consecutive failures` : 'no fresh items in 6h+';
      alerts.push(`⚠️ Feed **${f.id}** — ${why} (last status: ${statuses[f.id] || 'not polled this run'})`);
    }
  }
  // AI failures are silent by design (news still flows) — surface them once a day.
  if (aiError && now - (state.lastAiAlert || 0) > 86400000) {
    aiAlerted = true;
    alerts.push(`🤖 AI layer unavailable — #instagram-ideas paused. ${aiError}`);
  }
  if (memberSweepFailed) {
    alerts.push('👥 Member sweep failed — new members are not getting @Breaking-Ping. '
      + 'Check the Server Members Intent is still enabled in the Discord Developer Portal.');
  }

  if (alerts.length && chanId('bot-status')) {
    try {
      await postMessage(chanId('bot-status'), buildStatusMessage(alerts.join('\n'), cfg));
      if (aiAlerted) state.lastAiAlert = now;
      for (const fs of alertedFeeds) fs.lastAlert = now;
      delivered++;
      console.log(`  posted status alert (${alerts.length} item(s)) -> #bot-status`);
    } catch (err) {
      deliveryFailures++;
      console.error(`  status post failed: ${err.message}`);
    }
  } else if (alerts.length) {
    deliveryFailures++;
    console.error(`  ${alerts.length} alert(s) had nowhere to go — no bot-status channel configured`);
  }

  runDelivered = delivered;
  runFailures = deliveryFailures;
}

// ── 8. Save ─────────────────────────────────────────────────────────────────
pruneState(state, now);
saveState(state, STATE_DIR);
console.log(`done: ${runDelivered} delivered, ${runFailures} failed, ${toPost.length} allocated, `
  + `${ideas.length} ideas, ${catMoves.length} recategorised, ${deferred.length} deferred, `
  + `${Object.keys(state.clusters).length} live clusters`);

// State is written above and the workflow persists it with `if: always()`, so failing the
// run here is safe. It matters because every Discord write is individually caught: without
// this, a run where nothing at all reached Discord still reports success and no one is told.
if (runFailures > 0) {
  console.error(`${runFailures} Discord delivery failure(s) — failing the run so it is not silently green`);
  process.exitCode = 1;
}
