'use strict';

/**
 * Mailpit RPG contract for Federation import.
 * Internal identifiers use OP_* opcodes (not prose slugs).
 */

const OP = Object.freeze({
  /** Message classifiers (subject → opcode) */
  INVITE: 'OP_INVITE',
  WAITLIST: 'OP_WAITLIST',
  WALLET_RECOVERY: 'OP_WALLET_RECOVERY',
  OPS_REPORT: 'OP_OPS_REPORT',
  FALLBACK: 'OP_FALLBACK',
  /** Tick / log */
  LOG_INTEL: 'OP_LOG_INTEL',
  LOG_BLOCKED_COURIER: 'OP_LOG_BLOCKED_COURIER',
  LOG_MAINT_DRIP: 'OP_LOG_MAINT_DRIP',
  LOG_IDLE_ISSUANCE: 'OP_LOG_IDLE_ISSUANCE',
  /** Strategy phase */
  PHASE_GROWTH: 'OP_PHASE_GROWTH',
  PHASE_MAINTENANCE: 'OP_PHASE_MAINTENANCE',
  /** Doc / chain labels */
  MAILPIT_LIST: 'OP_MAILPIT_LIST',
  MAILPIT_FETCH: 'OP_MAILPIT_FETCH'
});

/** Legacy `kind` strings from v1–v2 saves → opcode */
const LEGACY_KIND_TO_OPCODE = Object.freeze({
  invitation: OP.INVITE,
  waitlist: OP.WAITLIST,
  wallet_recovery: OP.WALLET_RECOVERY,
  ops_report: OP.OPS_REPORT,
  other: OP.FALLBACK
});

const PUBLIC_SERVICES = Object.freeze([
  { opcode: 'OP_SVC_MAILPIT_UI', label: 'Mailpit (local)', baseUrl: 'http://127.0.0.1:8025' },
  { opcode: 'OP_SVC_MAILPIT_SMTP', label: 'Mailpit SMTP (local)', baseUrl: 'smtp://127.0.0.1:1025' },
  { opcode: 'OP_SVC_DISCORD_GOON', label: 'Goon Squad Discord', baseUrl: 'https://discord.com/servers/g00n-squad-1190527980120850493' },
  { opcode: 'OP_SVC_GITHUB_GOONVC', label: 'goon.vc repository', baseUrl: 'https://github.com/GoonCitizen/goon.vc' },
  { opcode: 'OP_SVC_GOONVC_HOME', label: 'goon.vc homepage', baseUrl: 'https://github.com/GoonCitizen/goon.vc#readme' },
  { opcode: 'OP_SVC_HUB_FABRIC', label: 'Fabric Hub / Playnet UX', baseUrl: 'https://hub.fabric.pub' }
]);

const rules = Object.freeze({
  version: 11,
  description: 'Mailpit RPG — Federation contract; identifiers are OP_* opcodes. Pair with stores/rpg/state.json',
  OP,
  LEGACY_KIND_TO_OPCODE,
  PUBLIC_SERVICES,
  economy: Object.freeze({
    courierCurrency: 'IBUX',
    costIntel: 1,
    scoreBase: 4,
    bonuses: Object.freeze({
      [OP.INVITE]: 18,
      [OP.WAITLIST]: 6,
      [OP.WALLET_RECOVERY]: 14,
      [OP.OPS_REPORT]: 11,
      [OP.FALLBACK]: 2
    }),
    lootByOpcode: Object.freeze({
      [OP.INVITE]: Object.freeze({ PLAY: 3 }),
      [OP.WAITLIST]: Object.freeze({ PLAY: 2, LBTC: 1 }),
      [OP.WALLET_RECOVERY]: Object.freeze({ IBUX: 4, PLAY: 3, SBTC: 1, LBTC: 1 }),
      [OP.OPS_REPORT]: Object.freeze({ IBUX: 2, SBTC: 2, LBTC: 2, PLAY: 1 }),
      [OP.FALLBACK]: Object.freeze({ PLAY: 1 })
    }),
    maintenanceDrip: Object.freeze({
      PLAY: 1
    }),
    /** Map contract loot keys → on-disk balance keys when names differ (e.g. Liquid). */
    lootKeyAliases: Object.freeze({
      LBTC: 'L-BTC'
    }),
    /**
     * IDLE — proof-of-liveness stipend currency.
     * One issuance per epoch window; mint = perActiveMemberPerIssuance × |active members|.
     */
    idleCurrency: Object.freeze({
      ticker: 'IDLE',
      issuanceIntervalMs: 600_000,
      perActiveMemberPerIssuance: 1,
      definitions: Object.freeze({
        epoch:
          'epochId = floor(unixMs / issuanceIntervalMs). The current epoch is [epochId×T, (epochId+1)×T) in UTC milliseconds.',
        verifiedSignedMessage:
          'A record in collections.members.activity with signatureValid === true, verifiable publicKey, signature, and payloadDigest per Federation crypto policy.',
        activeMember:
          'A distinct memberId that has ≥1 verifiedSignedMessage whose verifiedAtMs falls in the current epoch window [epochStart, epochEnd).',
        issuanceEvent:
          'At most one mint per epochId per node: IDLE += perActiveMemberPerIssuance × count(activeMember). Missed epochs are not backfilled.',
        treasury:
          'Balances key "IDLE" (numeric). Optional "@IDLE" string entry documents the asset.'
      }),
      statePaths: Object.freeze({
        balancesKey: 'IDLE',
        membersActivity: 'collections.members.activity',
        emissionMeta: 'collections.idle.meta'
      })
    })
  }),
  matchers: Object.freeze([
    Object.freeze({ opcode: OP.INVITE, subjectContainsAll: ['invitation'] }),
    Object.freeze({ opcode: OP.WAITLIST, subjectContainsAll: ['waitlist'] }),
    Object.freeze({ opcode: OP.WALLET_RECOVERY, subjectContainsAll: ['recovery', 'code'] }),
    Object.freeze({ opcode: OP.OPS_REPORT, subjectContainsAll: ['usage', 'report'] }),
    Object.freeze({ opcode: OP.FALLBACK, subjectContainsAll: [] })
  ]),
  sensitiveOpcodes: Object.freeze([OP.WALLET_RECOVERY]),
  import: Object.freeze({
    hint: 'mailpit ingest <file.eml> ... --smtp-addr localhost:1025'
  }),
  playbookLines: Object.freeze([
    'API: GET /api/v1/messages (OP_MAILPIT_LIST) → GET /api/v1/message/:id (OP_MAILPIT_FETCH).',
    'Economy: courier charges costIntel IBUX per OP_MAILPIT_FETCH path; score = scoreBase + bonuses[opcode]; lootByOpcode credits numeric wallets only.',
    'Quiet tick: OP_LOG_MAINT_DRIP + maintenanceDrip credits PLAY when no new mailbox rows.',
    'Precedence: OP_INVITE → OP_WALLET_RECOVERY (sensitiveOpcodes; no URLs in state) → OP_OPS_REPORT → OP_WAITLIST → OP_FALLBACK.',
    'Ingress: OP_MAILPIT_SMTP ingest for .eml → localhost:1025.',
    'Phase: OP_PHASE_GROWTH while new IDs; else OP_PHASE_MAINTENANCE.',
    'Collections: processed Mailpit IDs live at collections.messages.content (not seenMessageIds).',
    'IDLE: economy.idleCurrency — one OP_LOG_IDLE_ISSUANCE per epoch (10m); 1 IDLE per activeMember in epoch; data in collections.members.activity.',
    'Tick / IDLE: run `node stores/rpg/tick.js` with Mailpit up (UI 8025, SMTP 1025). Hub does not schedule ticks.',
    'Fabric: settings.fabric.peers (see contracts/fabric-peers.js) are passed to Hub at startup; RPG mirrors them to state.network.fabricPeers each tick.'
  ])
});

class Message {
  constructor (payload = {}) {
    this.id = payload.id || null;
    this.subject = payload.subject || '';
    this.opcode = payload.opcode || OP.FALLBACK;
    this.links = payload.links || [];
    this.sensitive = !!payload.sensitive;
    this.from = payload.from || null;
    this.to = payload.to || [];
    this.created = payload.created || null;
  }

  static fromMailpit (row, full, opcode, urls, sensitive) {
    return new Message({
      id: row.ID,
      subject: full.Subject,
      opcode,
      links: urls,
      sensitive,
      from: full.From && full.From.Address,
      to: (full.To || []).map((x) => x.Address),
      created: row.Created || full.Date
    });
  }

  toJSON () {
    return {
      id: this.id,
      subject: this.subject,
      opcode: this.opcode,
      links: this.links,
      sensitive: this.sensitive,
      from: this.from,
      to: this.to,
      created: this.created
    };
  }
}

class Tree {
  constructor (store) {
    this.store = store;
    if (!Array.isArray(this.store.ledger)) this.store.ledger = [];
    if (this.store.tip === undefined) this.store.tip = null;
  }

  append (entry) {
    const row = Object.assign({ parent: this.store.tip }, entry);
    this.store.ledger.push(row);
    this.store.tip = entry.messageId != null ? entry.messageId : this.store.tip;
    return row;
  }

  toJSON () {
    return { tip: this.store.tip, ledger: this.store.ledger.slice() };
  }
}

class Filesystem {
  constructor (chainStore) {
    if (!chainStore.ledger) chainStore.ledger = [];
    if (chainStore.tip === undefined) chainStore.tip = null;
    this.tree = new Tree(chainStore);
  }

  get chain () {
    return this.tree.toJSON();
  }

  record (clockGeneration, messageId, opcode, meta = {}) {
    return this.tree.append(
      Object.assign(
        {
          generation: clockGeneration,
          messageId,
          opcode,
          t: new Date().toISOString()
        },
        meta
      )
    );
  }
}

module.exports = {
  OP,
  LEGACY_KIND_TO_OPCODE,
  rules,
  contract: rules,
  default: rules,
  Message,
  Tree,
  Filesystem,
  PUBLIC_SERVICES
};
