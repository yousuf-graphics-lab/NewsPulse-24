# Monetization

NewsPulse 24 runs a **first-party ad engine**. No third-party ad server is required, but the
site interoperates with AdSense through a valid `ads.txt`.

---

## The twelve slots

Declared in `config.adSlots` — code, not a database table, so a slot can never be created by
accident or by an advertiser.

| Slot | Position | Devices | Typical size |
| --- | --- | --- | --- |
| `top-leaderboard` | Above the masthead | All | 970×90 / 320×50 |
| `below-ticker` | Under the breaking-news ticker | All | 970×90 |
| `sidebar-top` | Top of the right rail | Desktop, tablet | 300×250 |
| `sidebar-sticky` | Sticks while scrolling | Desktop | 300×600 |
| `in-article` | After the third paragraph | All | 336×280 / fluid |
| `after-article` | Below the article body | All | 970×250 |
| `between-cards` | Every N cards in a listing | All | fluid native |
| `mobile-banner` | Sticky bottom bar | Mobile | 320×50 |
| `mobile-inline` | Inside mobile listings | Mobile | fluid |
| `interstitial` | Full-screen, frequency-capped | Mobile | 320×480 |
| `footer-banner` | Above the footer | All | 728×90 |
| `native-sponsored` | Styled as a card, always labelled | All | fluid |

**Every creative is labelled "বিজ্ঞাপন" (Advertisement).** A reader must never mistake an
advertisement for reporting — this is both an ethics requirement and an AdSense policy one.

---

## Targeting

A campaign can be constrained by:

- **Slot** — which of the twelve positions it may appear in.
- **Device** — `desktop`, `mobile`, `tablet` (CSV).
- **Country** — ISO codes (CSV). Empty means everywhere.
- **Category** — only on certain section pages.
- **Date window** — `starts_at` / `ends_at`.
- **Daily cap** — `daily_cap` impressions, reset at midnight Asia/Dhaka (`served_today`,
  `cap_reset_day`).
- **Priority** — higher wins.
- **Weight** — weighted random among campaigns of equal priority, so two advertisers on the
  same priority split inventory fairly.

Selection lives in `ads.activeForSlot()`. It is deliberately cheap: one indexed query plus
in-memory filtering, on every page view.

---

## Creative types and their sandbox

| Kind | Rendered | Isolation |
| --- | --- | --- |
| `image` | Inline `<img>` in a labelled link | None needed |
| `text` | Inline house-style card | None needed |
| `video` | Lazy `iframe` to a privacy-enhanced player | Cross-origin frame |
| `html` | `/ads/frame/:id` | Sandboxed iframe, no same-origin |
| `script` | `/ads/frame/:id` | Sandboxed iframe + host allowlist |

**First-party image and text creatives are rendered inline.** They are trusted content that an
editor uploaded, so framing them would cost performance for nothing.

**Third-party `html` and `script` creatives are never allowed into the main document.** They
are served from `/ads/frame/:id` and loaded as:

```html
<iframe src="/ads/frame/42" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
        referrerpolicy="no-referrer" scrolling="no"></iframe>
```

The absence of `allow-same-origin` is the whole point: the frame is treated as a unique
origin, so it cannot read our cookies, our DOM, or our localStorage — even if the creative is
hostile.

The frame sets its own policy:

```
Content-Security-Policy: default-src 'none';
  script-src 'unsafe-inline' https://pagead2.googlesyndication.com
    https://tpc.googlesyndication.com https://cdn.ampproject.org;
  style-src 'unsafe-inline'; img-src * data:; media-src *; frame-src *; connect-src *
```

and re-checks the script host against `config.ads.scriptAllowlist` before emitting anything.
An off-allowlist creative is refused **twice** — when an admin tries to save it, and with a
403 if one somehow reaches render time.

---

## Measurement

`GET /api/ad/impression` and `GET /api/ad/click` are 1×1 GIF beacons writing `ad_events`
with the ad id, slot, kind, hashed IP, country, device and article id.

Counters are maintained on the campaign row too (`impressions`, `clicks`, `served_today`), so
the admin dashboard can show CTR without aggregating the event table.

`/admin/ads` reports impressions, clicks and CTR per campaign, per slot and per country.
That country breakdown is what you sell with — an advertiser buying Bangladeshi reach wants
to see BD traffic, not global traffic.

---

## AdSense

`/ads.txt` is generated from live campaigns by `ads.adsTxt()`:

```
# NewsPulse 24 — ads.txt
# https://iabtechlab.com/ads-txt/

# Direct-sold inventory
<your-publisher-id>, DIRECT, f08c47fec0942fa0
```

Set your publisher ID at **/admin/settings → AdSense publisher ID** (it is stored in the
`settings` table as `adsense_publisher_id`, not in `.env`). `/ads.txt` then emits:

```
google.com, pub-0000000000000000, DIRECT, f08c47fec0942fa0
```

Leave the field empty and no google.com line is written, which is correct until you have an
account. Then paste the AdSense snippet into a `script`-kind campaign. The script host must
be on the allowlist — `pagead2.googlesyndication.com`, `tpc.googlesyndication.com` and
`cdn.ampproject.org` already are.

Verify:

```bash
curl -s http://localhost:3000/ads.txt
```

> AdSense policy requires ads to be clearly distinguishable from content. The mandatory
> "বিজ্ঞাপন" label on every slot is what keeps the account in good standing. Do not remove it.

---

## Other revenue surfaces

**Sponsored content.** `articles.is_sponsored` plus `sponsor_label` renders a visible
"স্পনসরড" chip on the card and the article page, and the `native-sponsored` slot styles it as
a card while still labelling it. Never let a sponsored article be indistinguishable from
reporting.

**Newsletter sponsorships.** `campaigns` supports a sponsored issue with its own tracking. A
newsletter with a measurable open rate is often worth more per impression than display.

**Classifieds / jobs.** `pages` plus a category is enough to launch a paid listings section
without new code.

---

## Editorial firewall

Stated on `/advertise` and enforced in the data model: **advertising staff cannot see
editorial analytics, and editorial staff cannot see advertiser data.** The RBAC roles are
separate — `ads.manage` is not granted to `editor`, and `article.editAny` is not granted to
`ad_manager`.

This is not just ethics. Advertisers who believe they can influence coverage stop buying, and
readers who believe coverage is for sale stop reading.

---

## Performance budget for ads

Ads are the easiest way to destroy the thing that makes a news site valuable. Hard rules:

- Every `iframe` is `loading="lazy"`.
- No ad slot may delay first paint — slots render as empty labelled containers and fill in.
- The interstitial is frequency-capped and never fires on an article page.
- The sticky mobile banner is dismissible and never covers the ticker.
- Total third-party weight per page should stay under ~150 KB. Check it in DevTools after
  adding any new campaign type.
