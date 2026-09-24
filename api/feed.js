/**
 * GET /api/feed
 *
 * Pulls every Jambo Show source server side, normalizes them into one
 * chronological list, and caches the result at the edge.
 *
 * Query params:
 *   ?limit=30            how many items to return (default 30, max 100)
 *   ?platform=youtube    restrict to a single platform
 *
 * Response:
 *   { items: [...], sources: [...], generatedAt: "ISO", errors: [...] }
 *
 * No dependencies. Node 18+ (global fetch, AbortSignal.timeout).
 */

const YT_CHANNEL_ID = process.env.YT_CHANNEL_ID || 'UCt_wMKrT4mW9aiLChsx3HpQ';

/* Optional extra sources. Any of these can be left unset.
   Each expects an RSS or Atom URL. See README for how to get them. */
const EXTRA = [
  { platform: 'x',        url: process.env.FEED_X_RSS },
  { platform: 'tiktok',   url: process.env.FEED_TIKTOK_RSS },
  { platform: 'facebook', url: process.env.FEED_FACEBOOK_RSS },
];

/* Optional Facebook Graph source, used when a real Page token exists. */
const FB_PAGE_ID = process.env.FB_PAGE_ID;
const FB_TOKEN = process.env.FB_PAGE_TOKEN;

const FETCH_TIMEOUT_MS = 7000;
const UA = 'JamboShowHub/1.0 (+https://jamboshow.com)';

/* ------------------------------------------------------------------ *
 * Tiny tolerant XML helpers. Enough for Atom and RSS 2.0, no library. *
 * ------------------------------------------------------------------ */

function blocks(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

function text(block, tag) {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(block);
  return m ? decode(strip(m[1])) : '';
}

function attr(block, tag, name) {
  const m = new RegExp(`<${tag}\\s[^>]*${name}=["']([^"']+)["'][^>]*>`, 'i').exec(block);
  return m ? decode(m[1]) : '';
}

function strip(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decode(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function firstImage(html) {
  const m = /<img[^>]+src=["']([^"']+)["']/i.exec(html || '');
  return m ? decode(m[1]) : '';
}

function toISO(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString();
}

/* ------------------------------------------------------------------ *
 * Fetching                                                            *
 * ------------------------------------------------------------------ */

async function getText(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function getJSON(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
  return body;
}

/* ------------------------------------------------------------------ *
 * Adapters. Each returns an array of normalized items.                *
 * ------------------------------------------------------------------ */

async function youtube() {
  const xml = await getText(`https://www.youtube.com/feeds/videos.xml?channel_id=${YT_CHANNEL_ID}`);
  return blocks(xml, 'entry').map((e) => {
    const id = text(e, 'yt:videoId') || text(e, 'id').split(':').pop();
    return {
      id: `youtube:${id}`,
      platform: 'youtube',
      title: text(e, 'title'),
      text: text(e, 'media:description').slice(0, 400),
      url: attr(e, 'link', 'href') || `https://www.youtube.com/watch?v=${id}`,
      thumbnail: attr(e, 'media:thumbnail', 'url') || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      published: toISO(text(e, 'published') || text(e, 'updated')),
      embed: `https://www.youtube.com/embed/${id}`,
    };
  });
}

/* Generic RSS or Atom reader, used for whatever you point it at. */
async function genericFeed(platform, url) {
  const xml = await getText(url);
  const isAtom = /<feed[\s>]/i.test(xml);
  const raw = isAtom ? blocks(xml, 'entry') : blocks(xml, 'item');

  return raw.map((e, i) => {
    const link = isAtom ? (attr(e, 'link', 'href') || text(e, 'id')) : text(e, 'link');
    const body = new RegExp('<(?:content:encoded|content|description|summary)(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:content:encoded|content|description|summary)>', 'i').exec(e);
    const rawBody = body ? body[1] : '';
    const title = text(e, 'title');

    return {
      id: `${platform}:${text(e, 'guid') || text(e, 'id') || link || i}`,
      platform,
      title: title || strip(rawBody).slice(0, 90),
      text: strip(rawBody).slice(0, 400),
      url: link,
      thumbnail:
        attr(e, 'media:thumbnail', 'url') ||
        attr(e, 'media:content', 'url') ||
        attr(e, 'enclosure', 'url') ||
        firstImage(rawBody),
      published: toISO(text(e, 'pubDate') || text(e, 'published') || text(e, 'updated')),
    };
  });
}

/* Facebook Graph. Only runs when a Page id and token are configured. */
async function facebookGraph() {
  const fields = 'id,message,story,created_time,permalink_url,full_picture';
  const url = `https://graph.facebook.com/v20.0/${FB_PAGE_ID}/posts?fields=${fields}&limit=15&access_token=${FB_TOKEN}`;
  const data = await getJSON(url);
  return (data.data || []).map((p) => ({
    id: `facebook:${p.id}`,
    platform: 'facebook',
    title: (p.message || p.story || 'Facebook post').split('\n')[0].slice(0, 90),
    text: (p.message || p.story || '').slice(0, 400),
    url: p.permalink_url,
    thumbnail: p.full_picture || '',
    published: toISO(p.created_time),
  }));
}

/* ------------------------------------------------------------------ *
 * Handler                                                             *
 * ------------------------------------------------------------------ */

export default async function handler(req, res) {
  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
  const only = (req.query.platform || '').toLowerCase();

  const jobs = [{ platform: 'youtube', run: youtube }];

  for (const src of EXTRA) {
    if (src.url) jobs.push({ platform: src.platform, run: () => genericFeed(src.platform, src.url) });
  }
  if (FB_PAGE_ID && FB_TOKEN) {
    jobs.push({ platform: 'facebook', run: facebookGraph });
  }

  const active = only ? jobs.filter((j) => j.platform === only) : jobs;

  const settled = await Promise.allSettled(active.map((j) => j.run()));

  const items = [];
  const errors = [];
  const sources = [];

  settled.forEach((r, i) => {
    const platform = active[i].platform;
    if (r.status === 'fulfilled') {
      const clean = r.value.filter((it) => it.url);
      sources.push({ platform, count: clean.length, ok: true });
      items.push(...clean);
    } else {
      sources.push({ platform, count: 0, ok: false });
      errors.push({ platform, message: String(r.reason?.message || r.reason) });
    }
  });

  /* Newest first. Items with no date sink to the bottom rather than the top. */
  items.sort((a, b) => {
    if (!a.published) return 1;
    if (!b.published) return -1;
    return new Date(b.published) - new Date(a.published);
  });

  /* Cache at the edge for 15 minutes, serve stale for an hour while revalidating. */
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=3600');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');

  res.status(200).json({
    generatedAt: new Date().toISOString(),
    sources,
    errors,
    items: items.slice(0, limit),
  });
}
