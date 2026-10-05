# `goon.vc` Developers

Карта проекта (что есть и как работает): [`ARCHITECTURE.md`](ARCHITECTURE.md).

Public GOON SQUAD site. The Node process is an `@fabric/http` server:

- **HTML** — `types/GoonSPA.js` compiled to `assets/index.html` (`npm run build`)
- **Hub APIs** — `functions/hubApiProxy.js` forwards allowlisted paths to
  `FABRIC_HUB_ORIGIN` (default `https://hub.fabric.pub`)

GoonCitizen (`/services/star-citizen`, Fabric `:7777`) runs on **relay.goon.vc**,
not here. The generic Hub UI and Beacon live on **hub.fabric.pub**.

**Call for GoonCitizen developers** (G00N SQUAD, PERMAFLEET, other orgs who
want a LiveRelay + Fabric Peer) is in the sibling repo:
[star-citizen-live `DEVELOPERS.md`](https://github.com/GoonCitizen/star-citizen-live/blob/feature/rsi/DEVELOPERS.md)
([`docs/APPLICATION.md`](https://github.com/GoonCitizen/star-citizen-live/blob/feature/rsi/docs/APPLICATION.md)
— why LiveRelay is the app basis). Do not grow this tree into that relay
(`PLAN.md`, `AGENTS.md`).

Site deploy: [`DEPLOY.md`](DEPLOY.md). Topology: [`PLAN.md`](PLAN.md).

```bash
nvm use           # 24.15.0
npm i --allow-git=all
npm run link:http # sibling ~/fabric-http (same pin as Hub: 7536341)
npm run build
npm test
npm start         # loopback :8080 behind Caddy
```
