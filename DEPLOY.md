# Deploying GOON.VC

The production service is an `@fabric/http` HTML site plus a same-origin proxy
for Hub APIs (`/sessions`, `/device-links`, `/services/rpc`, identity cluster).
It is **not** a Fabric Hub and **not** the GoonCitizen relay. Site notes:
[`DEVELOPERS.md`](DEVELOPERS.md). GoonCitizen operators and other orgs:
[star-citizen-live `DEVELOPERS.md`](https://github.com/GoonCitizen/star-citizen-live/blob/feature/rsi/DEVELOPERS.md)
and [`docs/PRODUCTION.md`](https://github.com/GoonCitizen/star-citizen-live/blob/feature/rsi/docs/PRODUCTION.md).

```text
Browsers ──HTTPS──> Caddy (goon.vc) ──> this process :8080
                                      ├── GoonSPA (assets/index.html)
                                      └── Hub API proxy ──> hub.fabric.pub

GoonCitizen clients ──Fabric :7777──> relay.goon.vc (star-citizen-live)
Passport / desktop login on goon.vc uses POST /sessions (proxied to Hub).
```

## Prerequisites
- Ubuntu/Debian VPS with the `goon.vc` DNS A/AAAA records pointed at it
- Node.js **24.15.0** (see `.nvmrc`)
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
curl -s -X POST https://goon.vc/sessions \
  -H 'Content-Type: application/json' -H 'Origin: https://goon.vc' \
  -d '{"origin":"https://goon.vc"}'     # proxied Hub session create
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

No Fabric mnemonic is required on this host. Identity stays on Hub and on
user wallets (Passport / GoonCitizen).

**Updates** —
`cd /opt/goon.vc && sudo -u goonvc git pull && sudo -u goonvc npm install --allow-git=all && sudo -u goonvc npm run build && sudo systemctl restart goonvc`.

## Local development

```bash
npm install --allow-git=all
# optional: local Hub
FABRIC_HUB_ORIGIN=http://127.0.0.1:8081 npm start
```
