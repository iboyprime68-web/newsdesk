import { CATEGORY_CHANNEL } from './score.js';

// Checked before geography, so a Real Madrid story from Al Jazeera's all.xml lands in
// sport rather than world. Order matters: sport wins a story that trips both lists.
const TOPIC_DESKS = ['sport', 'entertainment'];
// A desk defined by where the story happened rather than what it is about.
const GEO_DESKS = ['southasia', 'uk', 'world'];

const compiled = new WeakMap();

function escapeTerm(term) {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * One list of terms → { ci, cs }. Plain terms match on word boundaries and ignore case;
 * terms prefixed with `re:` are raw expressions kept case-sensitive, which is the only
 * way to tell the country "US" from the pronoun "us" in a headline.
 */
function compileList(terms) {
  const words = [];
  const raw = [];
  for (const term of terms || []) {
    if (typeof term !== 'string' || !term) continue;
    if (term.startsWith('re:')) raw.push(term.slice(3));
    else words.push(escapeTerm(term));
  }
  return {
    ci: words.length ? new RegExp(`\\b(?:${words.join('|')})\\b`, 'i') : null,
    cs: raw.length ? new RegExp(raw.join('|')) : null,
  };
}

function listsFor(cfg) {
  let lists = compiled.get(cfg.classify);
  if (!lists) {
    lists = {};
    for (const desk of [...TOPIC_DESKS, ...GEO_DESKS]) {
      lists[desk] = compileList(cfg.classify[desk]);
    }
    compiled.set(cfg.classify, lists);
  }
  return lists;
}

function hits(lists, desk, text) {
  const l = lists[desk];
  if (!l) return false;
  return !!((l.ci && l.ci.test(text)) || (l.cs && l.cs.test(text)));
}

const known = (cat) => Object.prototype.hasOwnProperty.call(CATEGORY_CHANNEL, cat);

function heaviest(feeds) {
  return feeds.reduce((a, b) => (b.weight > a.weight ? b : a));
}

/**
 * Desk a cluster belongs in, judged from its headlines rather than from whichever feed
 * happened to publish it first.
 *
 * Only feeds flagged `broad` in feeds.json are second-guessed. A section feed such as
 * bbc-sport carries one subject by construction, and overriding it does real damage: a
 * BBC UK story rarely contains the word "UK", so a content test moves it to world.
 *
 * feedIndex maps both feed id and feed name to the feed, so a link stored either way
 * resolves. Returns the category to use; callers compare it against cluster.cat.
 */
export function classifyCluster(cluster, cfg, feedIndex) {
  const cc = cfg.classify;
  if (!cc || cc.enabled === false) return cluster.cat;

  const links = cluster.links || [];
  // sourceName is the fallback because links stored before sourceId existed still carry
  // it, which lets the backlog already in state be judged instead of waiting 30h for it
  // to age out. The index holds both keys.
  const feeds = links.map((l) => feedIndex[l.sourceId] || feedIndex[l.sourceName]).filter(Boolean);
  if (feeds.length === 0) return cluster.cat;

  // A section feed joined this cluster, so its label is trustworthy and settles it.
  // This is also what fixes a cluster whose desk and posted link disagree, such as a
  // Dawn-created cricket story whose embed links to BBC Cricket on the higher weight.
  const sectioned = feeds.filter((f) => !f.broad);
  if (sectioned.length) {
    const cat = heaviest(sectioned).category;
    return known(cat) ? cat : cluster.cat;
  }

  const text = [cluster.title, ...links.map((l) => l.title)].join(' ');
  const lists = listsFor(cfg);

  for (const desk of TOPIC_DESKS) {
    if (hits(lists, desk, text)) return desk;
  }

  const home = heaviest(feeds);
  const homeCat = home.homeDesk || home.category;
  if (!known(homeCat)) return cluster.cat;
  if (!GEO_DESKS.includes(homeCat)) return homeCat;

  // A geographic desk is only left when the story names somewhere else and names
  // nothing of its own. Requiring evidence both ways is what keeps "Crocodile rescued
  // from flood-hit area in Ferozewala" in south-asia: it never says "Pakistan".
  if (hits(lists, homeCat, text)) return homeCat;
  for (const desk of GEO_DESKS) {
    if (desk !== homeCat && hits(lists, desk, text)) return desk;
  }
  return homeCat;
}
