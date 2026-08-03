/** Category → Discord channel name. */
export const CATEGORY_CHANNEL = {
  uk: 'uk-news',
  world: 'world-news',
  southasia: 'south-asia',
  entertainment: 'entertainment',
  sport: 'sport-cricket',
  viral: 'viral-trending',
};

function keywordHits(cluster, keywords) {
  const text = [cluster.title, ...cluster.links.map((l) => l.title)].join(' ').toLowerCase();
  let hits = 0;
  for (const kw of keywords) if (text.includes(kw)) hits++;
  return hits;
}

function trendMatch(cluster, trendTerms) {
  const text = cluster.title.toLowerCase();
  return trendTerms.some((t) => t.length >= 4 && text.includes(t.toLowerCase()));
}

/** Recompute score + tier for one cluster. Returns an explanation object. */
export function scoreCluster(cluster, cfg, trendTerms, now = Date.now()) {
  const w = cfg.weights;
  if (cluster.ghost || cluster.links.length === 0) {
    cluster.score = 0;
    cluster.tier = 'SKIP';
    return { ghost: true };
  }

  const maxSourceWeight = Math.max(...cluster.links.map((l) => l.weight));
  const distinctBrands = cluster.brands.length;
  const corroboration = w.corroborationPerBrand * Math.min(w.corroborationMaxBrands, distinctBrands - 1);
  const hits = keywordHits(cluster, cfg.keywords);
  const kwScore = w.keywordHit * Math.min(w.keywordMaxHits, hits);
  const gnBonus = cluster.gn ? w.googleNewsTopBonus : 0;
  const trendBonus = trendMatch(cluster, trendTerms) ? w.trendMatchBonus : 0;
  if (trendBonus) cluster.trendHit = true;
  const ageMinutes = Math.max(0, (now - cluster.firstSeen) / 60000);
  const recency = Math.max(0, w.recencyMax - ageMinutes / w.recencyMinutesPerPoint);

  const score = maxSourceWeight + corroboration + kwScore + gnBonus + trendBonus + recency;
  cluster.score = Math.round(score);

  const t = cfg.thresholds;
  const br = cfg.breakingRequires;
  if (score >= t.breaking && (distinctBrands >= br.minBrands || hits >= br.orMinKeywordHits)) {
    cluster.tier = 'BREAKING';
  } else if (score >= t.top) {
    cluster.tier = 'TOP';
  } else if (score >= t.normal) {
    cluster.tier = 'NORMAL';
  } else {
    cluster.tier = 'SKIP';
  }

  return { maxSourceWeight, distinctBrands, corroboration, hits, kwScore, gnBonus, trendBonus, recency: Math.round(recency), total: cluster.score, tier: cluster.tier };
}

/** Channels a cluster belongs in, given its tier. */
export function targetChannels(cluster) {
  const cat = CATEGORY_CHANNEL[cluster.cat] || 'world-news';
  const chans = [];
  if (cluster.tier === 'BREAKING') chans.push('breaking-news', cat);
  else if (cluster.tier === 'TOP') chans.push('top-stories', cat);
  else if (cluster.tier === 'NORMAL') chans.push(cat);
  if (cluster.trendHit && cat !== 'viral-trending' && cluster.tier !== 'SKIP') chans.push('viral-trending');
  return chans;
}

function capFor(channel, caps) {
  return caps[channel] || caps.default;
}

/**
 * Decide what actually gets posted this run, respecting per-run and per-hour caps.
 * candidates: [{cid, cluster}] not yet posted anywhere. Highest score wins slots.
 * Returns { toPost: [{cid, cluster, channel}], deferred: [cid] }.
 */
export function allocatePosts(candidates, cfg, postTimes, now = Date.now()) {
  const hourAgo = now - 3600000;
  const used = {}; // channel -> count this run
  const toPost = [];
  const deferred = [];

  const sorted = [...candidates].sort((a, b) => b.cluster.score - a.cluster.score);
  for (const cand of sorted) {
    const channels = targetChannels(cand.cluster);
    let postedAnywhere = false;
    let blocked = false;
    for (const channel of channels) {
      if (cand.cluster.posted[channel]) continue;
      const cap = capFor(channel, cfg.caps);
      const hourCount = (postTimes[channel] || []).filter((t) => t > hourAgo).length;
      if ((used[channel] || 0) >= cap.perRun || hourCount + (used[channel] || 0) >= cap.perHour) {
        blocked = true;
        continue;
      }
      used[channel] = (used[channel] || 0) + 1;
      toPost.push({ cid: cand.cid, cluster: cand.cluster, channel });
      postedAnywhere = true;
    }
    if (!postedAnywhere && blocked) deferred.push(cand.cid);
  }
  return { toPost, deferred };
}
