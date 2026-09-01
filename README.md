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

Plus: 237-country picker with dial codes, E.164 copy button, raw JSON view, recent-lookup
history in `localStorage`, light/dark theme, deep links (`?number=+14158586273`) and a
bring-your-own-API-key setting.

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

## API key

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
- **Visitors can supply their own.** "API key settings" (in the footer and the FAQ) stores a
  personal access key in the visitor's browser, which takes priority over the demo key. Nothing
  is uploaded anywhere.

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
index.html               markup for the whole page
assets/css/styles.css    theming, layout, components
assets/js/countries.js   237 countries: ISO code, dial code, name
assets/js/app.js         lookup transport chain, rendering, history, settings
.github/workflows/       GitHub Pages deployment
```

## Notes

Results come from public numbering-plan data and may lag very recent porting or reassignment.
Empty carrier or location fields mean "not published for this range", not "invalid".
