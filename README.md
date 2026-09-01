# Phone Number Validator — Global Validation & Lookup

A static, no-login web app that validates phone numbers anywhere in the world and returns a
full profile of the number: validity, carrier, line type, country and location.

Built as plain HTML/CSS/JavaScript — no framework, no build step, no backend — so it can be
served directly from GitHub Pages.

## Features

| | |
|---|---|
| **Number validation (real-time)** | Confirms the number exists and sits in an active numbering range |
| **Carrier detection** | Network operator behind the number |
| **Line type detection** | `mobile`, `landline`, `voip`, `toll_free`, `premium_rate`, `satellite`, `paging`, `special_services` |
| **Country detection** | Country name, ISO country code and dialling prefix |
| **Location detection** | Region/state/city where the numbering plan publishes it |
| **DNC complaint check (US)** | Whether a US number appears in recent FTC unwanted-call complaints — on its own page, `dnc.html` |

Plus: 237-country picker with dial codes, E.164 copy button, raw JSON view, recent-lookup
history in `localStorage`, light/dark theme, deep links (`?number=+14158586273`) and a
bring-your-own-API-key setting.

Two pages:

| Page | What it does |
|---|---|
| `index.html` | Worldwide number validation via numverify |
| `dnc.html` | US DNC complaint checker, plus a browser-local database of every number checked |

## Running locally

No build step. Serve the folder over HTTP (not `file://`, so `localStorage` works):

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Deploying to GitHub Pages

`.github/workflows/deploy.yml` publishes the repository root on every push to `main`, and can
also be run manually from the Actions tab.

One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

The site is then served at `https://<owner>.github.io/<repo>/`.

## DNC complaint check — what it is, and what it is not

The **DNC complaints (US)** tab queries the FTC's Do Not Call *complaint* dataset through
[api.data.gov](https://api.data.gov) (`api.ftc.gov/v0/dnc-complaints`).

Two limits shape what this feature can honestly do, and both are worth understanding before
you rely on it.

**1. It is not the Do Not Call Registry.** The registry — the list of consumers who opted out
of telemarketing — has no public API and is not reachable with an api.data.gov key.
Telemarketers access it by registering at
[telemarketing.donotcall.gov](https://telemarketing.donotcall.gov) for an Organization ID and
SAN and downloading per-area-code lists; consumers check their own number at
[donotcall.gov](https://www.donotcall.gov). Lawful outbound telemarketing still requires that
subscription — this is a reputation signal, not a compliance scrub.

**2. The API cannot be filtered by the number that placed the call.** Its documented filters
are `created_date`, `created_date_from`/`created_date_to`, `state`, `area_code` and
`is_robocall`. The caller's number (`company-phone-number`) comes back as a *response field*,
never as a search key. There is no way to ask "how many complaints name this number".

So the check does the closest honest thing: it pulls a recent window of complaints from the
entered number's own **area code** (up to 50 records — the endpoint's cap — over the last 30
days) and reports whether that number appears among them, along with the robocall share and
the most common subjects in the sample.

That asymmetry matters and the UI states it plainly:

- **A hit is a strong signal.** The number really was reported, and the true total is probably
  higher than the sample shows.
- **A miss is weak evidence.** It means "absent from this sample", not "clean". The FTC
  receives hundreds of thousands of complaints a month nationwide; 50 records from one area
  code over 30 days is a thin slice.

### The number database

`dnc.html` keeps every check in a database in the visitor's own browser — **IndexedDB**, with a
`localStorage` fallback for private windows and older browsers. The page names the engine
actually in use in its stats row.

Each row holds the number, whether it was found, the hit count, the sample scope, the most
recent complaint and its subject, when it was checked, plus a free-text note and a flag you
set yourself. The table supports search (number, subject, note), filtering (found / not found
/ flagged), column sorting, per-row re-check, delete, CSV and JSON export, and JSON import.
A re-check updates the result while preserving your note and flag.

This is per-browser storage, so be clear about what it is not: it is not shared between
browsers, devices or people, and clearing the site's data deletes it. Export is the way to
move a list anywhere else. If you need a list several people share, that needs a real backend
— a Cloudflare Worker, Supabase or similar — which this static site deliberately does not have.

Bulk checking runs numbers sequentially rather than in parallel, and de-duplicates the input,
because the shared api.data.gov key is rate limited and a burst is the fastest way to exhaust
it.

Implementation notes:

- `dncQueries` builds a ladder of parameter sets — area code plus date window, then area code
  alone, then unfiltered — and falls back down it if the API rejects a parameter, so an
  unsupported filter degrades the sample's scope instead of failing the lookup. The scope
  actually used is shown on the result card.
- Errors are read from both envelopes in play: api.data.gov's `{"error":{code,message}}` and
  the FTC's JSON:API `{"errors":[{status,title,detail}]}`. Missing that second shape is what
  once made a plain HTTP 400 surface as a useless "unexpected payload".
- A failure that is not JSON reports its HTTP status and a slice of the body, and a real API
  error is preferred over a later relay timeout when both occur in one fallback chain.
- Rows are read defensively (`dncRows` / `dncField`): a bare array or `data`/`results`/
  `records`, with fields on the row or under a JSON:API `attributes` object, in hyphen, snake
  or camel spelling.

## API keys

The app talks to the [numverify](https://numverify.com/documentation) API
(`apilayer.net/api/validate`) straight from the browser. The bundled demo key lives in
`assets/js/app.js`:

```js
var DEMO_KEY = 'c2ebb50af59ed2f763aeb27b5ad21d5b';
```

Two things worth knowing about that:

- **The key is public.** Any site with no backend and no login has to ship its key in the
  client, so anyone can read it from the page source and spend the quota. That is the accepted
  trade-off for a no-login static site. If the quota matters, put the key behind a small proxy
  (a Cloudflare Worker or Netlify/Vercel function) and point `API_PATH` at that instead.
- **Visitors can supply their own.** "API key settings" (in the footer and the FAQ) stores
  personal keys — numverify and api.data.gov — in the visitor's browser, taking priority over
  the bundled ones. Nothing is uploaded anywhere.

The bundled api.data.gov key sits next to it as `DNC_DEMO_KEY` and carries the same caveat.
Get your own free key at [api.data.gov/signup](https://api.data.gov/signup).

### HTTP vs HTTPS on the free plan

numverify only serves its **encrypted** endpoint on paid plans; free-plan keys are limited to
plain HTTP and answer `https://` requests with error `105`. A page served from GitHub Pages is
itself HTTPS, and browsers block plain-HTTP requests from an HTTPS page as mixed content.

`app.js` handles both cases with a transport chain (see `TRANSPORTS`):

1. `https://apilayer.net/api/validate` — used directly whenever the key allows it, so the
   request goes nowhere but numverify.
2. If and only if that fails, the request is relayed over HTTPS through a public CORS relay
   (allorigins → codetabs → corsproxy) that can reach the plain-HTTP endpoint.

The result card says which path was used. Note the relay path means the access key transits a
third-party service — another reason to use your own proxy if the key is sensitive. Errors that
would fail identically on every transport (invalid key `101`, inactive account `102`, quota
exhausted `104`) short-circuit the chain and are reported straight away.

## Project layout

```
index.html               number validator page
dnc.html                 DNC complaint checker + database page
assets/css/styles.css    theming, layout, components (shared by both pages)
assets/js/core.js        shared: helpers, transport chain, FTC client, theme, key dialog
assets/js/countries.js   237 countries: ISO code, dial code, name
assets/js/app.js         index page: numverify client, result card, lookup history
assets/js/dncdb.js       IndexedDB store (localStorage fallback) for checked numbers
assets/js/dncpage.js     DNC page: lookups, bulk checks, database table, import/export
.github/workflows/       GitHub Pages deployment
```

`core.js` loads first on both pages and exposes `window.NV`; `dncdb.js` exposes
`window.NV_DNCDB`. Nothing else is global.

## Notes

Results come from public numbering-plan data and may lag very recent porting or reassignment.
Empty carrier or location fields mean "not published for this range", not "invalid".
