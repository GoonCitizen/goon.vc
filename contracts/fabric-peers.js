'use strict';

/**
 * HTTPS Hub bootstrap descriptors (RPG / site metadata).
 * These are NOT Fabric TCP dial targets — Hub Peer uses top-level `settings.peers`
 * as `host:port` strings (see DEFAULT_FABRIC_TCP_PEERS).
 *
 * Override or extend via settings/local.js → fabric.peers.
 */
const DEFAULT_FABRIC_PEERS = Object.freeze([
  {
    opcode: 'OP_PEER_HUB_FABRIC',
    host: 'hub.fabric.pub',
    port: 443,
    secure: true,
    httpBaseUrl: 'https://hub.fabric.pub'
  },
  {
    opcode: 'OP_PEER_HUB_GOON',
    host: 'hub.goon.vc',
    port: 443,
    secure: true,
    httpBaseUrl: 'https://hub.goon.vc'
  }
]);

/**
 * Default Fabric TCP / NOISE mesh seeds for relay.goon.vc (star network).
 * Hub Peer dials these so chat / CONTRACT_* / gossip fan out across hubs
 * even when a leaf only reaches one side of the star.
 */
const DEFAULT_FABRIC_TCP_PEERS = Object.freeze([
  'hub.fabric.pub:7777',
  'hub.goon.vc:7777',
  'relay.goon.vc:7777'
]);

module.exports = {
  DEFAULT_FABRIC_PEERS,
  DEFAULT_FABRIC_TCP_PEERS
};
