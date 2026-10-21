# `goon.vc`
Public GOON SQUAD website. This process serves HTML and reverse-proxies the
Hub API paths used for Fabric site login (Passport / GoonCitizen desktop).

| Host | Role |
|------|------|
| **goon.vc** | This repo — GoonSPA + Hub API zipper |
| **relay.goon.vc** | GoonCitizen LiveRelay |
| **hub.fabric.pub** | Fabric Hub |

Favicon is the G00N SQUAD skull, the org logo on RSI (`logoUrl` in
`contracts/organizations.json`): `favicon.ico` (16/32/48), `favicon.png`, and
`apple-touch-icon.png` in `assets/`.

## Quick Start
```bash
npm i --allow-git=all
npm run build    # write assets/index.html from types/GoonSPA.js
npm start        # HTTP on 127.0.0.1:8080
```

Site copy (title, Discord widget, Bitcoin, footer) is `settings/local.js` → `site.*`.
Hub upstream is `FABRIC_HUB_ORIGIN` (must be allowlisted). See `DEPLOY.md`.
This tree’s contributor notes: [`DEVELOPERS.md`](DEVELOPERS.md). GoonCitizen
(LiveRelay, call for G00N / PERMAFLEET / other orgs):
[star-citizen-live `DEVELOPERS.md`](https://github.com/GoonCitizen/star-citizen-live/blob/feature/rsi/DEVELOPERS.md).
