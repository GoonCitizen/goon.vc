'use strict';

const SCRIPT = 'member-review';
const REQUIREMENT = 'goon.vc reviewer';
const SOURCE = 'goon.members.pending';
const ACTION = 'members.review';
const MINUTE = 60 * 1000;
const DISCORD_ID = /^\d{5,25}$/;

function errorMessage (error) {
  return error && error.message ? error.message : String(error);
}

function fail (status, message) {
  return Object.assign(new Error(message), { status });
}

// A script action failure whose message is shown to the reviewer.
function exposed (message) {
  return Object.assign(new Error(message), { expose: true });
}

function userOf (session) {
  const match = /^discord\/users\/(\d+)$/.exec(String(session && session.user));
  return match ? match[1] : null;
}

function people (n) {
  return `${n} ${n === 1 ? 'person' : 'people'}`;
}

function ago (iso, now) {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return 'a while';
  const minutes = Math.round(Math.max(0, ms) / MINUTE);
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

/**
 * The waiting area's reviewers. Nothing is sent on its own: a reviewer runs
 * `/goon review` and gets the `member-review` DM script. It shows one waiting
 * officer at a time, with Approve, Turn away, and Leave waiting. Approving
 * one does not decide the others. Reviewers are Discord user ids; the script
 * `requires` "goon.vc reviewer", checked at start and again before anything
 * changes.
 */
class Reviews {
  /**
   * @param {Object} [settings]
   * @param {Object} [settings.members] Members service (reviews on).
   * @param {Object} [settings.community] Community service (its Scripts plugin DMs).
   * @param {string[]} [settings.reviewers] Discord user ids.
   * @param {string} [settings.waitingPath] SPA page for members awaiting review.
   * @param {Function} [settings.now] Clock (tests).
   */
  constructor (settings = {}) {
    this.settings = Object.assign({
      members: null,
      community: null,
      reviewers: [],
      waitingPath: '/waiting',
      now: () => Date.now(),
      officerOf: () => []
    }, Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)));
    this.reviewers = Array.from(new Set([].concat(this.settings.reviewers || [])
      .map((id) => String(id).trim())
      .filter((id) => DISCORD_ID.test(id))));
    this._listeners = {};
    this._started = false;
    this._onReview = () => {
      this.emit('log', 'GOON.VC', 'reviews: someone is waiting for review; a reviewer runs `/goon review` to see them');
    };
  }

  on (event, handler) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(handler);
    return this;
  }

  emit (event, ...args) {
    for (const handler of this._listeners[event] || []) {
      try { handler(...args); } catch (_) { /* listener errors stay local */ }
    }
    return this;
  }

  get members () {
    return this.settings.members;
  }

  get scripts () {
    const community = this.settings.community;
    return (community && community.scripts) || null;
  }

  /** Whether reviews can reach anyone: reviews on, DM scripts running, reviewers named. */
  get available () {
    if (!this._started || !this.members || !this.members.reviewsEnabled || !this.scripts || !this.reviewers.length) return false;
    try {
      return !!this.scripts.definition(SCRIPT);
    } catch (_) {
      return false;
    }
  }

  isReviewer (userId) {
    return this.reviewers.includes(String(userId));
  }

  async start () {
    const community = this.settings.community;
    if (!this.members || !this.members.reviewsEnabled || !this.scripts) return this;
    this.scripts.source(SOURCE, (scope, step) => this.choices(scope, step));
    this.scripts.action(ACTION, (session) => this.apply(session));
    community.requirement(REQUIREMENT, (session) => this.isReviewer(userOf(session)));
    this.members.on('review', this._onReview);
    this._started = true;
    if (!this.reviewers.length) this.emit('log', 'GOON.VC', 'reviews: no reviewers configured; sign-ins wait without anyone being able to review them');
    return this;
  }

  async stop () {
    if (this.members && typeof this.members.removeListener === 'function') this.members.removeListener('review', this._onReview);
    this._started = false;
    return this;
  }

  async _begin (reviewerId, pending, name = null) {
    let displayName = name;
    if (!displayName) {
      const member = await this.members.resolve(`discord:${reviewerId}`).catch(() => null);
      displayName = (member && member.displayName) || null;
    }
    const community = this.settings.community;
    const siteUrl = String(community.settings && community.settings.siteUrl ? community.settings.siteUrl : '').replace(/\/+$/, '');
    return community.beginScript(SCRIPT, {
      user: `discord/users/${reviewerId}`,
      name: displayName,
      context: {
        reviewer: String(reviewerId),
        waiting: people(pending.length),
        waitingUrl: `${siteUrl}${this.settings.waitingPath}`,
        card: '',
        result: '',
        done: 'no',
        handled: [],
        showing: null,
        awaiting: 'no',
        lines: []
      }
    });
  }

  /**
   * `/goon review`: send this reviewer everyone waiting now.
   * @param {string} userId Discord user id.
   * @param {string} [name] Display name.
   * @returns {Promise<{ pending: number }>}
   */
  async begin (userId, name = null) {
    if (!this.available) throw fail(503, 'Sign-in reviews are not running right now.');
    if (!this.isReviewer(userId)) throw fail(403, 'Only goon.vc’s sign-in reviewers can review sign-ins.');
    const pending = await this.members.pendingReviews();
    if (!pending.length) return { pending: 0 };
    await this._begin(String(userId), pending, name);
    await this.members.noteReviewsSent(pending.map((member) => member.id));
    return { pending: pending.length };
  }

  /** The member's name as reviewers see it. */
  name (member) {
    const discord = (member.accounts || []).find((account) => account.platform === 'discord');
    const profile = (discord && discord.profile) || {};
    const name = member.displayName || profile.globalName || profile.username || 'Unnamed member';
    return profile.username && profile.username !== name ? `${name} (@${profile.username})` : name;
  }

  officerOf (member) {
    const listed = this.settings.officerOf(member);
    return Array.isArray(listed) ? listed.map(String) : [];
  }

  _card (member, waiting) {
    const discord = (member.accounts || []).find((account) => account.platform === 'discord');
    const profile = (discord && discord.profile) || {};
    const orgs = this.officerOf(member);
    const rsi = (member.accounts || []).filter((account) => account.platform === 'rsi').map((account) => account.id);
    const lines = [
      `**${waiting}** ${waiting === 1 ? 'officer is' : 'officers are'} waiting. This is the one who has waited longest.`,
      '',
      this.name(member),
      discord ? `Discord @${profile.username || 'unknown'} (${discord.id})` : 'No Discord account on the profile',
      orgs.length ? `Officer of ${orgs.join(', ')}` : 'Officer on record',
      member.inGuild ? 'In the G00N SQUAD Discord' : 'Not in the G00N SQUAD Discord',
      rsi.length ? `RSI ${rsi.join(', ')}` : null,
      `Waiting ${ago(member.review && member.review.requestedAt, this.settings.now())}`,
      '',
      'Approve lets them claim an RSI handle. Turn away refuses this sign-in. Leave waiting keeps them in line and shows the next officer. Nobody else is changed.'
    ];
    return lines.filter((line) => line !== null).join('\n');
  }

  /**
   * One decision from a button: `approve-<memberId>`, `deny-<memberId>`, or
   * `skip-<memberId>`. Skip leaves that officer waiting.
   * @param {string} action
   * @param {string} id
   * @param {string} reviewer Discord user id.
   * @param {Object} context Live script context.
   * @returns {Promise<void>}
   */
  async _decide (action, id, reviewer, context) {
    if (action === 'skip') {
      context.handled.push(id);
      const member = await this.members.resolve(id);
      context.lines.push(`${member ? this.name(member) : 'This officer'} left waiting.`);
      return;
    }
    const status = action === 'approve' ? 'approved' : 'denied';
    const result = await this.members.decideReview(id, status, { by: `discord:${reviewer}` }).catch(() => null);
    const name = result && result.member ? this.name(result.member) : 'This officer';
    if (!result) context.lines.push(`Could not update ${name}.`);
    else if (!result.changed) context.lines.push(`${name} was already ${result.status}.`);
    else context.lines.push(status === 'approved' ? `Approved ${name}.` : `Turned away ${name}.`);
  }

  /**
   * `goon.members.pending` choices: Approve, Turn away, and Leave waiting for
   * the officer who has waited longest. The previous button is applied here,
   * before the next officer is shown, so one decision cannot include the rest.
   * An empty list ends the script.
   * @param {Object} scope Script scope. `context` and `answers` are the live session.
   * @returns {Promise<Array<Object>>}
   */
  async choices (scope) {
    const context = (scope && scope.context) || {};
    const answers = (scope && scope.answers) || {};
    if (!Array.isArray(context.handled)) context.handled = [];
    if (!Array.isArray(context.lines)) context.lines = [];
    const reviewer = String(context.reviewer || '');
    if (!this.isReviewer(reviewer)) {
      context.done = 'yes';
      context.awaiting = 'no';
      context.result = 'Only goon.vc’s sign-in reviewers can review sign-ins.';
      context.card = context.result;
      return [];
    }
    const matched = /^(approve|deny|skip)-([0-9a-f]{16})$/.exec(String(answers.decide || ''));
    if (matched) {
      await this._decide(matched[1], matched[2], reviewer, context);
      answers.decide = null;
    } else if (context.awaiting === 'yes' && context.showing) {
      await this._decide('skip', context.showing, reviewer, context);
    }
    const pending = (await this.members.pendingReviews()).filter((member) => !context.handled.includes(member.id));
    if (!pending.length) {
      context.done = 'yes';
      context.showing = null;
      context.awaiting = 'no';
      const left = (await this.members.pendingReviews()).length;
      const summary = context.lines.length ? context.lines.join('\n') : 'Nobody was waiting.';
      const noun = `${left} ${left === 1 ? 'officer' : 'officers'}`;
      context.result = left
        ? `${summary}\n${noun} still waiting. Run \`/goon review\` for the next.`
        : `${summary}\nNobody else is waiting.`;
      context.card = context.result;
      return [];
    }
    const member = pending[0];
    context.done = 'no';
    context.showing = member.id;
    context.awaiting = 'yes';
    context.card = this._card(member, pending.length);
    return [
      { id: `approve-${member.id}`, label: 'Approve' },
      { id: `deny-${member.id}`, label: 'Turn away' },
      { id: `skip-${member.id}`, label: 'Leave waiting' }
    ];
  }

  /**
   * `members.review`: the buttons were already applied one officer at a time.
   * A decision still sitting on the session (the script ended without showing
   * another officer) is applied here, and only that one.
   * @param {Object} session Script session view.
   * @returns {Promise<{ labels: { result: string } }>}
   */
  async apply (session) {
    const reviewer = userOf(session) || String(session && session.context && session.context.reviewer || '');
    if (!this.isReviewer(reviewer)) throw exposed('Only goon.vc’s sign-in reviewers can review sign-ins.');
    const answers = (session && session.answers) || {};
    const matched = /^(approve|deny|skip)-([0-9a-f]{16})$/.exec(String(answers.decide || ''));
    if (matched && matched[1] !== 'skip') {
      await this.members.decideReview(matched[2], matched[1] === 'approve' ? 'approved' : 'denied', { by: `discord:${reviewer}` });
    }
    const result = (session && session.context && session.context.result) || 'Nobody else is waiting.';
    return { labels: { result } };
  }

  /**
   * Aggregates only: whether reviews run, how many reviewers, how many wait.
   * @returns {Promise<Object>}
   */
  async report () {
    return {
      available: this.available,
      reviewers: this.reviewers.length,
      pending: this.members && this.members.reviewsEnabled ? (await this.members.pendingReviews()).length : 0
    };
  }
}

Reviews.SCRIPT = SCRIPT;
Reviews.REQUIREMENT = REQUIREMENT;

module.exports = Reviews;
