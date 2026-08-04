/**
 * Google Trends GB handling: keep the current trending terms in state and decide
 * when a "Trending in the UK" digest is worth posting.
 */
export function updateTrends(state, trendItems, cfg, now = Date.now()) {
  if (trendItems.length === 0) return { digest: null, terms: state.trendTerms };

  const terms = trendItems.slice(0, cfg.trends.maxTermsTracked).map((it) => ({
    term: it.title,
    traffic: it.approxTraffic || '',
  }));
  const newNames = terms.map((t) => t.term.toLowerCase());
  const oldNames = new Set(state.trendTerms.map((t) => t.toLowerCase()));
  const freshCount = newNames.filter((n) => !oldNames.has(n)).length;

  state.trendTerms = terms.map((t) => t.term);

  const gapMs = cfg.trends.digestMinGapHours * 3600000;
  let digest = null;
  // lastTrendDigestAt is stamped by the caller after the post lands — setting it here
  // would suppress the digest for hours when the post failed.
  if (freshCount >= cfg.trends.digestMinNewTerms && now - (state.lastTrendDigestAt || 0) > gapMs) {
    digest = terms.slice(0, 10);
  }
  return { digest, terms: state.trendTerms };
}
