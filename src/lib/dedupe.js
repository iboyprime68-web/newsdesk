const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'of', 'for', 'with', 'by',
  'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'has', 'have', 'had',
  'it', 'its', 'this', 'that', 'these', 'those', 'he', 'she', 'they', 'we', 'you', 'his',
  'her', 'their', 'our', 'your', 'not', 'no', 'so', 'up', 'out', 'over', 'after', 'before',
  'amid', 'into', 'about', 'against', 'between', 'during', 'under', 'will', 'would', 'could',
  'can', 'may', 'might', 'says', 'say', 'said', 'new', 'latest', 'live', 'updates', 'update',
  'watch', 'video', 'news', 'report', 'reports', 'reveals', 'revealed', 'how', 'what', 'why',
  'when', 'where', 'who', 'as-it-happened', 'exclusive', 'opinion',
]);

/** Title → significant lowercase tokens for similarity matching. */
export function tokenize(title) {
  return [...new Set(
    title
      .toLowerCase()
      .replace(/[’'`]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t && !STOPWORDS.has(t) && (t.length >= 3 || /^\d+$/.test(t))),
  )];
}

function overlap(aSet, bArr) {
  let n = 0;
  for (const t of bArr) if (aSet.has(t)) n++;
  return n;
}

/**
 * Assign new (unseen) items to clusters in state, creating clusters as needed.
 * Returns the set of cluster ids touched this run.
 */
export function clusterItems(state, items, cfg, now = Date.now()) {
  const windowMs = cfg.clusterWindowHours * 3600000;
  const touched = new Set();

  for (const item of items) {
    const tokens = tokenize(item.title);
    if (tokens.length === 0) continue;

    let best = null;
    let bestScore = 0;
    for (const [cid, c] of Object.entries(state.clusters)) {
      if (now - c.lastUpdate > windowMs) continue;
      const inter = overlap(new Set(c.tokens), tokens);
      if (inter === 0) continue;
      const union = c.tokens.length + tokens.length - inter;
      const jaccard = inter / union;
      const containment = inter / Math.min(c.tokens.length, tokens.length);
      if (jaccard >= cfg.jaccardThreshold || containment >= cfg.containmentThreshold) {
        if (jaccard > bestScore) {
          bestScore = jaccard;
          best = { cid, c };
        }
      }
    }

    if (best) {
      const c = best.c;
      // One entry per brand per cluster keeps the "Also" links tidy; corroboration
      // sources only flip flags, they never become the posted link.
      if (item.corroborationOnly) {
        c.gn = true;
      } else if (!c.links.some((l) => l.link === item.link) && c.links.length < 8) {
        c.links.push({
          title: item.title, link: item.link, brand: item.brand,
          sourceId: item.sourceId, sourceName: item.sourceName, weight: item.weight,
          snippet: item.snippet, publishedAt: item.publishedAt,
        });
        if (!c.brands.includes(item.brand)) c.brands.push(item.brand);
        // A ghost cluster (Google-News-only so far) becomes real when an outlet joins.
        if (c.ghost) {
          c.ghost = false;
          c.title = item.title;
          c.cat = item.category;
        }
        for (const t of tokens) if (!c.tokens.includes(t)) c.tokens.push(t);
        if (c.tokens.length > 40) c.tokens = c.tokens.slice(-40);
        if (item.publishedAt < c.firstSeen) c.firstSeen = item.publishedAt;
      }
      c.lastUpdate = now;
      touched.add(best.cid);
    } else {
      const cid = `c_${item.id.slice(0, 10)}`;
      state.clusters[cid] = {
        title: item.title,
        tokens,
        cat: item.category,
        ghost: !!item.corroborationOnly,
        gn: !!item.corroborationOnly,
        firstSeen: item.publishedAt,
        lastUpdate: now,
        links: item.corroborationOnly ? [] : [{
          title: item.title, link: item.link, brand: item.brand,
          sourceId: item.sourceId, sourceName: item.sourceName, weight: item.weight,
          snippet: item.snippet, publishedAt: item.publishedAt,
        }],
        brands: item.corroborationOnly ? [] : [item.brand],
        score: 0,
        tier: 'SKIP',
        posted: {},
        postedBrandCount: 0,
        ai: null,
        pending: false,
      };
      touched.add(cid);
    }
  }
  return touched;
}
