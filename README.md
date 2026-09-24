# Jambo Show Hub

A single-page social hub for the Jambo Show channel, plus a serverless route that
merges every platform into one chronological feed.

```
jambo-hub/
  api/feed.js        the aggregator
  public/index.html  the site, self contained, logo embedded
  package.json
```

## Configure the links

All links live in one place: the config block at the top of the `<script>` in
`public/index.html`, around **line 454**. Search the file for `CONFIGURE EVERYTHING HERE`.

```js
const CHANNEL_ID = 'UCt_wMKrT4mW9aiLChsx3HpQ';

const LINKS = {
  youtube  : 'https://www.youtube.com/@Jamboshow-ethio',
  subscribe: 'https://www.youtube.com/@Jamboshow-ethio?sub_confirmation=1',
  x        : 'https://x.com/FIKREJamboshow1',
  tiktok   : 'https://www.tiktok.com/@jamboshow4',
  facebook : 'https://www.facebook.com/people/Jamboshow/100094772499751/',
};

const STATS = { subscribers: 1750, episodes: 60 };
```

Editing one value updates every place that link appears: the dock icon, the tile
footers, and the subscribe buttons. Nothing else needs touching.

**Removing a platform.** Set its value to `''`. The dock icon disappears, its feed
chip hides, and any inline link to it is removed. Nothing is left half broken.

**Adding a platform.** Add a key to `LINKS`, then add one anchor to the dock in the
markup using that key:

```html
<a data-link="instagram" data-tip="Instagram" aria-label="Instagram"
   target="_blank" rel="noopener">
  <svg viewBox="0 0 24 24"><path d="..."/></svg>
</a>
```

**Changing the channel.** `CHANNEL_ID` drives the video player automatically, since
the uploads playlist is always the channel ID with `UC` swapped for `UU`. Set the
same value as `YT_CHANNEL_ID` in Vercel so the feed route matches.

The hrefs are also written into the HTML as normal attributes, so every link still
works if JavaScript fails to run. The config block only overrides them.

## Deploy

```bash
cd jambo-hub
npx vercel@latest --prod
```

Framework preset is "Other". No build step, no dependencies. `public/` is served
statically and `api/feed.js` becomes a serverless function at `/api/feed`.

For local work use `npx vercel dev`, which runs the function alongside the page.
Opening `index.html` straight from the file system will show the feed as offline,
because there is no `/api/feed` to call.

## What works with zero configuration

YouTube. The route reads the channel's public Atom feed, which needs no API key
and no token:

```
https://www.youtube.com/feeds/videos.xml?channel_id=UCt_wMKrT4mW9aiLChsx3HpQ
```

That channel ID is verified against the live channel and is already the default.
Deploy as is and the feed fills with his videos, newest first, updating on its own.

## Adding the other three platforms

This is the part worth being straight about. X, TikTok, and Facebook do not
publish open feeds the way YouTube does. Each needs one of the options below.

The route reads these environment variables. Set them in the Vercel dashboard
under Settings, Environment Variables, then redeploy. Any that are missing are
simply skipped, and the rest of the feed still works.

| Variable | Purpose |
|---|---|
| `YT_CHANNEL_ID` | Override the YouTube channel. Defaults to the verified ID above. |
| `FEED_X_RSS` | Any RSS or Atom URL for the X account. |
| `FEED_TIKTOK_RSS` | Any RSS or Atom URL for the TikTok account. |
| `FEED_FACEBOOK_RSS` | Any RSS or Atom URL for the Facebook page. |
| `FB_PAGE_ID` + `FB_PAGE_TOKEN` | Official Facebook Graph API access. Overrides the RSS option. |

### X

There is no free official option. The realistic choices:

1. **Self-hosted RSSHub.** Deploy RSSHub (it has its own Vercel and Docker
   templates) and point `FEED_X_RSS` at `https://your-rsshub.app/twitter/user/FIKREJamboshow1`.
   Free, but X actively fights scrapers, so expect occasional gaps.
2. **X API Basic tier**, currently around 100 USD per month. Reliable, and
   overkill for a link hub.

If neither is set up, X still appears in the dock and the feed just does not
include his posts. That is a reasonable place to land.

### TikTok

Same situation. Point `FEED_TIKTOK_RSS` at an RSSHub route such as
`https://your-rsshub.app/tiktok/user/@jamboshow4`.

### Facebook

The clean path here depends on one thing: whether
`facebook.com/people/Jamboshow/100094772499751/` is a **Page** or a personal
**profile**.

- If it is a Page and your dad is an admin, this is the best source of the four
  after YouTube. Create an app at developers.facebook.com, generate a long-lived
  Page access token, then set `FB_PAGE_ID=100094772499751` and `FB_PAGE_TOKEN=...`.
  Official, stable, no scraping.
- If it is a personal profile, Graph API will not serve its posts to anyone, and
  no legitimate method exists. Leave it out of the feed and keep the dock link.

## Endpoint

```
GET /api/feed?limit=40
GET /api/feed?platform=youtube
```

```json
{
  "generatedAt": "2026-07-23T17:40:00.000Z",
  "sources": [{ "platform": "youtube", "count": 15, "ok": true }],
  "errors":  [{ "platform": "tiktok", "message": "HTTP 503" }],
  "items": [
    {
      "id": "youtube:AbC123",
      "platform": "youtube",
      "title": "...",
      "text": "...",
      "url": "https://www.youtube.com/watch?v=AbC123",
      "thumbnail": "https://i.ytimg.com/vi/AbC123/hqdefault.jpg",
      "published": "2026-07-22T10:00:00.000Z",
      "embed": "https://www.youtube.com/embed/AbC123"
    }
  ]
}
```

Notes on behaviour:

- Sources are fetched in parallel with a 7 second timeout each, via
  `Promise.allSettled`. One dead platform never takes down the response; it is
  reported in `errors` and the rest still returns.
- Responses carry `Cache-Control: s-maxage=900, stale-while-revalidate=3600`, so
  Vercel's edge serves a cached copy for 15 minutes and keeps serving a slightly
  stale one for an hour while it refreshes. Traffic hits the upstream feeds
  roughly four times an hour no matter how many visitors arrive, which keeps this
  comfortably inside the free tier.
- Items with no usable date sort to the bottom rather than the top.
- The client also refreshes on its own every 10 minutes.

## Page behaviour

- The feed renders skeleton rows while loading, then real items with platform
  badges, relative timestamps, and thumbnails.
- Filter chips hide themselves for platforms that returned nothing, so a chip is
  never shown for an empty source.
- If `/api/feed` is unreachable, the tile says so plainly and the dock links still
  take people to every profile.
- Clicking the emblem or any line in The Mark tile breaks the chains.

## Updating the numbers

Subscriber and episode counts are hardcoded in `public/index.html`:

```html
<span class="count" data-to="1750" data-suffix="+">0</span>
```

Making those live requires a YouTube Data API key, which is free at a low quota.
Ask if you want that wired in.
