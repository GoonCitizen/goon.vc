'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const net = require('net');
const Key = require('@fabric/core/types/key');
const HTTPServer = require('@fabric/http/types/server');
const Members = require('../services/members');

let client = null;
try {
  client = require('@fabric/http/functions/passportPeerClient');
} catch (_) {}

function ephemeralPort () {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.on('error', reject);
  });
}

describe('Members: Passport peer sign-in by the relay key', function () {
  this.timeout(120000);
  let members;
  let http;
  let storePath;
  let port;
  const relayKey = new Key();

  before(async function () {
    storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'goon-members-peer-'));
    members = new Members({ path: storePath, siteUrl: 'https://goon.vc', peerKey: () => relayKey });
    await members.start();
    const peer = members.passportPeer();
    if (!peer || !client) return this.skip();
    port = await ephemeralPort();
    http = new HTTPServer({
      port,
      host: '127.0.0.1',
      interface: '127.0.0.1',
      hostname: '127.0.0.1',
      listen: true,
      accessLog: path.join(os.tmpdir(), `goon-members-peer-${port}.log`),
      middlewares: { members: members.middleware() }
    });
    http.attachPassportPeer(peer);
    await http.start();
  });

  after(async function () {
    if (http) await http.stop();
    if (members) await members.stop();
    if (storePath) fs.rmSync(storePath, { recursive: true, force: true });
  });

  it('makes a member from a peer sign-in and answers /session for its signed requests', async function () {
    const base = `http://127.0.0.1:${port}`;
    const user = new Key();
    const session = await client.openPeerSession({
      transport: client.httpTransport(base),
      peer: relayKey.pubkey,
      sign: client.signWithKey(user, { network: 'regtest' })
    });
    const res = await session.fetch(`${base}/services/members/session`);
    const body = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(body));
    assert.ok(body.member && body.member.id, 'a member');
    const again = await (await session.fetch(`${base}/services/members/session`)).json();
    assert.strictEqual(again.member.id, body.member.id, 'the same member each time');
    const anonymous = await fetch(`${base}/services/members/session`);
    assert.strictEqual(anonymous.status, 401);
  });
});
