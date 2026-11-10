# goon.vc master plan
1. keep `goon.vc` a simple HTML website (this repository)
2. `relay.goon.vc` provides the GoonCitizen application hub (`star-citizen-live`)
3. `hub.fabric.pub` provides the generic Fabric hub (contract registry)
4. extend `goon.vc` to include an HTTP API servicing GoonCitizen

`goon.vc` is the zipper: it serves the public GoonSPA and forwards the Hub API
paths linked signers need (`/delegations`, `/services/delegation/mailbox`,
`/services/rpc`) so the browser origin stays `https://goon.vc`.

Do not add LiveRelay, Fabric Peer listen, Discord, or sidechain sync here.
GoonCitizen game-state patches belong on Hub / `relay.goon.vc`. Sidechain
allow-prefix `'/'` is a wildcard in `@fabric/core` — never allow it.

Developers for **this** site: [`DEVELOPERS.md`](DEVELOPERS.md). Developers for
the GoonCitizen application (relay.goon.vc): sibling
[star-citizen-live `DEVELOPERS.md`](https://github.com/GoonCitizen/star-citizen-live/blob/feature/rsi/DEVELOPERS.md).
