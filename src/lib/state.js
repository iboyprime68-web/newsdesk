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

export function pruneState(state, now = Date.now()) {
  for (const [id, ts] of Object.entries(state.seenLinks)) {
    if (now - ts > 7 * DAY) delete state.seenLinks[id];
  }
  for (const [cid, c] of Object.entries(state.clusters)) {
    if (now - c.lastUpdate > 2 * DAY) delete state.clusters[cid];
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
