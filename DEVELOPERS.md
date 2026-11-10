# `goon.vc` Developers

Public GOON SQUAD site. The Node process is an `@fabric/http` server:

- **HTML** — `types/GoonSPA.js` and `components/` compiled to
  `assets/index.html` and `assets/scripts/` (`npm run build`); edit the
  components, never the build output
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
nvm use           # 26.13.0
npm i --allow-git=all
npm run link:http # sibling ~/fabric-http (same pin as Hub: 7536341)
npm run build
npm test
npm start         # loopback :8080 behind Caddy
```

CI (`.github/workflows/test.yml`) runs `npm test` twice: on the commits
`package-lock.json` records (required, and checks `npm run build` leaves
`assets/` unchanged), and on the current tip of every Fabric branch pin
(advisory, and weekly), so upstream drift shows up before the next
`npm run report:install`. Suites that load a sibling `../doorman` or
`../fabric-clean` run there against the installed copies
(`FABRIC_DOORMAN`, `FABRIC_CORE`).
