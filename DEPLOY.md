# Deploying GOON.VC

The production service is an `@fabric/http` HTML site plus a same-origin proxy
for Hub APIs (`/delegations`, `/services/delegation/mailbox`, `/services/rpc`).
It is **not** a Fabric Hub and **not** the GoonCitizen relay. Site notes:
[`DEVELOPERS.md`](DEVELOPERS.md). GoonCitizen operators and other orgs:
[star-citizen-live `DEVELOPERS.md`](https://github.com/GoonCitizen/star-citizen-live/blob/feature/rsi/DEVELOPERS.md)
and [`docs/PRODUCTION.md`](https://github.com/GoonCitizen/star-citizen-live/blob/feature/rsi/docs/PRODUCTION.md).

```text
Browsers ──HTTPS──> Caddy (goon.vc) ──> this process :8080
                                      ├── GoonSPA (assets/index.html)
                                      └── Hub API proxy ──> hub.fabric.pub

GoonCitizen clients ──Fabric :7777──> relay.goon.vc (star-citizen-live)
Passport login (v2) is between the page, Passport, and this process: the
page gets a PASSPORT_CHALLENGE from /services/members/passport/challenges,
Passport signs a PASSPORT_ASSERTION, and the page posts it to
/services/members/passport. No Hub is involved.
```

Caddy (`deploy/Caddyfile`) or nginx (`deploy/nginx-relay.example.conf`) may
front it. Either way the process must receive the browser's `Host` and
`X-Forwarded-Proto`: session cookies are `Secure` only when the request came
in over HTTPS. Passport challenges are issued only for pinned origins, so set
`GOON_MEMBERS_ORIGINS=https://goon.vc` (otherwise `siteUrl` is used in
production); a request on any other address gets no challenge.

## Prerequisites
- Ubuntu/Debian VPS with the `goon.vc` DNS A/AAAA records pointed at it
- Node.js **26.13.0** (see `.nvmrc`)
- Caddy 2 — automatic Let's Encrypt
- A reachable Hub at `FABRIC_HUB_ORIGIN` (production: `https://hub.fabric.pub`)

`relay.goon.vc` is a **separate** LiveRelay process. Do not point that hostname
at this zipper. See `star-citizen-live/docs/PRODUCTION.md`.

## Install

```bash
sudo useradd --system --home /opt/goon.vc --shell /usr/sbin/nologin goonvc
sudo git clone https://github.com/GoonCitizen/goon.vc /opt/goon.vc
cd /opt/goon.vc
sudo -u goonvc npm install --allow-git=all
sudo -u goonvc npm run build

sudo cp deploy/env.example .env && sudo chmod 600 .env && sudo chown goonvc:goonvc .env
sudo nano .env                      # FABRIC_HUB_ORIGIN at minimum

sudo cp deploy/goonvc.service /etc/systemd/system/goonvc.service
sudo systemctl daemon-reload
sudo systemctl enable --now goonvc

sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

## Verify

```bash
systemctl status goonvc
curl -sI https://goon.vc/ | head
curl -s https://goon.vc/services/members -H 'Accept: application/json'
  # {"discord":true,"passport":true,"review":true}; discord:false = no OAuth secret
journalctl -u goonvc -f
curl -s https://goon.vc/services/idlerpg -H 'Accept: application/json'   # presentNow / uniquePlayers
```

## Configuration

| Var | Purpose |
|-----|---------|
| `FABRIC_HUB_ORIGIN` | Upstream Hub (`https://hub.fabric.pub`). Loopback allowed for local Hub. |
| `FABRIC_HUB_SEEDS` | More Hubs, comma separated, tried in order when the ones before can't be reached (default `https://hub.goon.vc`; empty for none; ignored behind a loopback Hub). |
| `FABRIC_HUB_PORT` | HTTP listen (default `8080`). Caddy proxies here. |
| `FABRIC_HUB_INTERFACE` | Bind address (default `127.0.0.1`). |
| `FABRIC_HUB_HOSTNAME` | Host header / sitemap host (default `goon.vc`). |
| `DISCORD_BOT_TOKEN` | Bot token for `/events`, `/operations` metrics, and IdleRPG. The bot posts IdleRPG announcements to `presence.announcements` (G00N SQUAD `#idlerpg`) and needs View Channel + Send Messages there. |
| `DISCORD_APP_SECRET` | OAuth client secret of the application that owns the bot token. Discord sign-in (and so the waiting area) is off without it. |
| `DISCORD_REDIRECT_URI` | Optional; defaults to `<request origin>/services/members/discord/callback`. That URL must be listed under OAuth2 → Redirects. |
| `GOON_MEMBERS_ORIGINS` | Origins Passport sign-in is issued for (`https://goon.vc`). Set it so a spoofed `Host` gets none. |
| `GOON_MEMBERS_REVIEWERS` | Discord user ids who approve new Discord sign-ins with `/goon review` (default @remaeus). `GOON_MEMBERS_REVIEW=0` turns reviews off. |
| `GOON_SCRIPTS_TOKEN` | Bearer for the DM script, campaign, and hangar roster APIs. Unset = those answer 404. |
| `GOON_TOURNAMENTS_PASSWORD` | Unlocks edits to finished tournaments. Unset = finished tournaments stay final. |
| `GOON_MARKET_NETWORK` | Pin Market escrow to one Bitcoin network (default: the Hub's). `GOON_MARKET=0` turns the Market off, `GOON_MARKET_SYNC=0` stops the forum mirror. |
| `GOON_MARKET_ARBITERS` | Account keys (`discord:<id>`, comma separated) who decide disputed escrow orders. |
| `GOON_CAMPAIGNS` | `1` enables DM campaigns, check-ins, and welcome DMs. Turn on the Server Members intent first, or Discord refuses the gateway. |
| `GOON_FABRIC_XPRV` | goon.vc's Fabric key. Unset = one is generated once and kept in `stores/fabric`. |

**Keys live in `stores/`.** goon.vc's Fabric key (`GOON_FABRIC_XPRV`, else
`stores/fabric`) derives the Fabric relay key, the alliance validator and
bridge keys, the officer and member vote keys, and every Market escrow
arbiter key. Losing it loses goon.vc's signature on open escrow orders. Back
up `stores/` before the first Market order. Never swap the key on a running
site: a different key is a different alliance federation and different
arbiters. Member identity stays in user wallets (Passport /
GoonCitizen).

**Discord application** (Developer Portal, the application that owns the bot
token):
- OAuth2 → Redirects: `https://goon.vc/services/members/discord/callback`.
- Bot → Privileged Gateway Intents: Message Content (Market forum mirror,
  Fabric relay, 1v1 leaderboard); Server Members only with `GOON_CAMPAIGNS=1`.
- Installation → User Install on, for `/market` in DMs.
- Re-invite the bot with `https://goon.vc/services/discord/invite?for=market`
  so it may post and manage threads in the Market forum, and with
  `?for=channels` for the PERMAFLEET setup scripts.

**Updates** —
`cd /opt/goon.vc && sudo -u goonvc git pull && sudo -u goonvc npm ci --allow-git=all && sudo -u goonvc npm run build && sudo systemctl restart goonvc`.
`npm ci` installs exactly the `@fabric/*` commits in `package-lock.json`.

## Local development

```bash
npm install --allow-git=all
# optional: local Hub
FABRIC_HUB_ORIGIN=http://127.0.0.1:8081 npm start
```
