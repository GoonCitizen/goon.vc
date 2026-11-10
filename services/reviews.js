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

function ids (value) {
  return [].concat(value == null ? [] : value).map(String);
}

/**
 * The waiting area's reviewers. Nothing is sent on its own: a reviewer runs
 * `/goon review` and gets the `member-review` DM script listing everyone
 * waiting (a sign-in only logs that someone is waiting). The script's
 * `members.review` action approves or denies the members picked; a member
 * someone else already reviewed is left as they are. Reviewers are Discord
 * user ids; the script `requires` "goon.vc reviewer", checked at start and
 * again before anything changes.
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
      now: () => Date.now()
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
      context: { waiting: people(pending.length), waitingUrl: `${siteUrl}${this.settings.waitingPath}` }
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

  _describe (member) {
    const rsi = (member.accounts || []).filter((account) => account.platform === 'rsi').map((account) => `RSI ${account.id}`);
    return [
      `Waiting ${ago(member.review.requestedAt, this.settings.now())}`,
      member.inGuild ? 'in G00N SQUAD' : 'not in the G00N SQUAD Discord',
      ...rsi
    ].join(' · ');
  }

  /**
   * `goon.members.pending` choices: everyone waiting, minus those the
   * reviewer already approved when asking whom to turn away.
   * @param {Object} scope Script scope.
   * @param {Object} step Normalized step.
   * @returns {Promise<Array<Object>>}
   */
  async choices (scope, step) {
    const approved = step && step.saveAs === 'deny' ? ids(scope && scope.answers && scope.answers.approve) : [];
    const pending = await this.members.pendingReviews();
    return pending
      .filter((member) => !approved.includes(member.id))
      .map((member) => ({ id: member.id, label: this.name(member), description: this._describe(member) }));
  }

  /**
   * `members.review`: approve and deny the members picked.
   * @param {Object} session Script session view.
   * @returns {Promise<{ labels: { result: string } }>}
   */
  async apply (session) {
    const reviewer = userOf(session);
    if (!this.isReviewer(reviewer)) throw exposed('Only goon.vc’s sign-in reviewers can review sign-ins.');
    const answers = session.answers || {};
    const approve = ids(answers.approve);
    const deny = ids(answers.deny).filter((id) => !approve.includes(id));
    const done = { approved: [], denied: [], already: [] };
    for (const [list, status] of [[approve, 'approved'], [deny, 'denied']]) {
      for (const id of list) {
        const result = await this.members.decideReview(id, status, { by: `discord:${reviewer}` }).catch(() => null);
        if (!result) continue;
        done[result.changed ? status : 'already'].push(this.name(result.member));
      }
    }
    const left = (await this.members.pendingReviews()).length;
    this.emit('log', 'GOON.VC', `reviews: ${done.approved.length} approved, ${done.denied.length} turned away, ${left} still waiting`);
    const lines = [];
    if (done.approved.length) lines.push(`Approved: ${done.approved.join(', ')}.`);
    if (done.denied.length) lines.push(`Turned away: ${done.denied.join(', ')}.`);
    if (done.already.length) lines.push(`Already reviewed by someone else: ${done.already.join(', ')}.`);
    if (!lines.length) lines.push('Nothing changed.');
    lines.push(left ? `${people(left)} still waiting; run \`/goon review\` to see them.` : 'Nobody else is waiting.');
    return { labels: { result: lines.join('\n') } };
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
