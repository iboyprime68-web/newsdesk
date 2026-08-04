import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DAY = 86400000;

const DEFAULT_STATE = () => ({
  version: 1,
  runSeq: 0,
  lastBriefingDate: '',
  lastTrendDigestAt: 0,
  trendTerms: [],
  knownMembers: [],
  feeds: {},
  seenLinks: {},
  clusters: {},
  postTimes: {},
});

export function loadState(stateDir) {
  try {
    const raw = readFileSync(join(stateDir, 'state.json'), 'utf8');
    return { ...DEFAULT_STATE(), ...JSON.parse(raw) };
  } catch {
    return DEFAULT_STATE();
  }
}

// State is committed to git every run, so its size compounds across thousands of
// commits. Retention is set by what the pipeline actually needs, not by generosity:
// feeds only expose ~40 recent items, so a link can't resurface after a couple of days,
// and the briefing only looks back 24h.
const SEEN_LINK_RETENTION = 3 * DAY;
const CLUSTER_RETENTION = 30 * 3600000;
const CLUSTER_DETAIL_RETENTION = 6 * 3600000; // matches the clustering window

export function pruneState(state, now = Date.now()) {
  for (const [id, ts] of Object.entries(state.seenLinks)) {
    if (now - ts > SEEN_LINK_RETENTION) delete state.seenLinks[id];
  }
  for (const [cid, c] of Object.entries(state.clusters)) {
    if (now - c.lastUpdate > CLUSTER_RETENTION) {
      delete state.clusters[cid];
      continue;
    }
    // Past the clustering window nothing will merge into this cluster again, so the
    // matching tokens and article snippets are dead weight. Keep only what the
    // coverage-edit path and the daily briefing still read.
    if (now - c.lastUpdate > CLUSTER_DETAIL_RETENTION) {
      if (c.tokens?.length) c.tokens = [];
      // The primary link's snippet is the embed description, and coverage edits
      // rebuild that embed — so keep that one and drop the rest.
      const primary = [...c.links].sort((a, b) => b.weight - a.weight)[0];
      for (const l of c.links) if (l !== primary) delete l.snippet;
    }
  }
  for (const [chan, times] of Object.entries(state.postTimes)) {
    const kept = times.filter((t) => now - t < 2 * 3600000);
    if (kept.length) state.postTimes[chan] = kept;
    else delete state.postTimes[chan];
  }
  return state;
}

/** Writes state to the working state dir AND a scratch copy used by the CI push-retry step. */
export function saveState(state, stateDir) {
  const json = JSON.stringify(state, null, 1);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'state.json'), json);
  mkdirSync('state-out', { recursive: true });
  writeFileSync(join('state-out', 'state.json'), json);
}
