import { createHash } from 'node:crypto';
import Parser from 'rss-parser';
import { fetchWithTimeout } from './http.js';

const parser = new Parser({
  customFields: { item: [['ht:approx_traffic', 'approxTraffic']] },
});

const TRACKING_PARAM = /^(utm_|fbclid|gclid|at_|ns_|cmp|ico|ref|ocid|cvid)/i;

/** Canonical form of an article link: stable across tracking params/fragments. */
export function canonicalizeLink(link) {
  try {
    const u = new URL(link);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    const keep = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAM.test(k));
    u.search = '';
    for (const [k, v] of keep) u.searchParams.append(k, v);
    return u.toString();
  } catch {
    return link;
  }
}

export function linkId(link) {
  return createHash('sha256').update(canonicalizeLink(link)).digest('hex').slice(0, 16);
}

// RFC 2606 / RFC 6761 reserved names plus loopback. Nothing behind these is a real
// article, so a link pointing at one can only be test or placeholder data.
const PLACEHOLDER_HOST = /(^|\.)(example\.(com|net|org)|test|invalid|localhost|local)$/i;

/**
 * Guard for anything about to be shown to writers: reject links that cannot possibly
 * be a real article. This catches placeholder *hosts* only — a fabricated path on a
 * genuine host (bbc.co.uk/news/example-story) is indistinguishable here, and probing
 * the URL is not an option because Dawn and Sky answer 403 to any scripted request,
 * so a liveness check would suppress real stories. The actual guarantee comes from
 * the pipeline itself: every link it publishes was ingested from a configured feed.
 * Never post to a content channel outside that path.
 */
export function isPublishableLink(link) {
  try {
    const u = new URL(link);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    if (PLACEHOLDER_HOST.test(u.hostname)) return false;
    return u.hostname.includes('.');
  } catch {
    return false;
  }
}

/** Which feeds to poll this run: breaking every run, standard every 3rd (striped). */
export function dueFeeds(feeds, runSeq) {
  return feeds.filter((f, i) => f.tier === 'breaking' || runSeq % 3 === i % 3);
}

function asString(v) {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  if (Array.isArray(v)) return asString(v[0]);
  if (typeof v === 'object') {
    if (v._ != null) return asString(v._);
    if (v['#text'] != null) return asString(v['#text']);
    for (const [k, val] of Object.entries(v)) {
      if (k === '$') continue; // xml attributes, not content
      const s = asString(val);
      if (s) return s;
    }
    return '';
  }
  return String(v);
}

function cleanText(s, max) {
  const txt = asString(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return txt.length > max ? txt.slice(0, max - 1) + '…' : txt;
}

/** Google News titles end in " - Outlet"; strip so clustering matches the outlets' own titles. */
function stripGoogleNewsSuffix(title) {
  return title.replace(/\s+-\s+[^-]{2,60}$/, '');
}

/**
 * Fetch one feed with conditional GET. Returns { items, status } and mutates feedState
 * (etag/lastModified/lastSuccess/failCount).
 */
export async function fetchFeed(feed, feedState, now = Date.now()) {
  const headers = {
    'user-agent': 'newsdesk-bot/1.0 (+https://github.com/safasites/newsdesk)',
    accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
  };
  if (feedState.etag) headers['if-none-match'] = feedState.etag;
  if (feedState.lastModified) headers['if-modified-since'] = feedState.lastModified;
  feedState.lastAttempt = now;

  let res;
  try {
    res = await fetchWithTimeout(feed.url, { timeoutMs: 10000, headers });
  } catch (err) {
    feedState.failCount = (feedState.failCount || 0) + 1;
    return { items: [], status: `error:${err.name || 'fetch'}` };
  }

  if (res.status === 304) {
    feedState.lastSuccess = now;
    feedState.failCount = 0;
    return { items: [], status: '304' };
  }
  if (!res.ok) {
    feedState.failCount = (feedState.failCount || 0) + 1;
    return { items: [], status: `http:${res.status}` };
  }

  const etag = res.headers.get('etag');
  const lastModified = res.headers.get('last-modified');
  if (etag) feedState.etag = etag;
  if (lastModified) feedState.lastModified = lastModified;

  let parsed;
  try {
    parsed = await parser.parseString(res.text);
  } catch {
    feedState.failCount = (feedState.failCount || 0) + 1;
    return { items: [], status: 'parse-error' };
  }

  feedState.lastSuccess = now;
  feedState.failCount = 0;

  const items = (parsed.items || []).slice(0, 40).flatMap((it) => {
    try {
      const link = asString(it.link).trim();
      let title = cleanText(it.title, 250);
      if (!link || !title) return [];
      if (feed.brand === 'gnews') title = stripGoogleNewsSuffix(title);
      let publishedAt = Date.parse(asString(it.isoDate || it.pubDate)) || now;
      if (publishedAt > now) publishedAt = now;
      return [{
        id: linkId(link),
        title,
        link: canonicalizeLink(link),
        snippet: cleanText(it.contentSnippet || it.content || it.summary, 300),
        approxTraffic: asString(it.approxTraffic) || null,
        sourceId: feed.id,
        sourceName: feed.name,
        brand: feed.brand,
        category: feed.category,
        weight: feed.weight,
        corroborationOnly: !!feed.corroborationOnly,
        publishedAt,
      }];
    } catch {
      return []; // one malformed item never kills the feed
    }
  });

  return { items, status: 'ok' };
}

/** Fetch all due feeds in parallel. Returns { items, statuses: {feedId: status} }. */
export async function fetchAllFeeds(feeds, state, now = Date.now()) {
  const results = await Promise.allSettled(
    feeds.map((f) => {
      state.feeds[f.id] ||= {};
      return fetchFeed(f, state.feeds[f.id], now);
    }),
  );
  const items = [];
  const statuses = {};
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      statuses[feeds[i].id] = r.value.status;
      items.push(...r.value.items);
    } else {
      statuses[feeds[i].id] = 'rejected';
    }
  });
  return { items, statuses };
}
