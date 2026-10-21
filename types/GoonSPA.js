'use strict';

const fs = require('fs');
const path = require('path');
const FabricSPA = require('@fabric/http/types/spa');
const escapeHtml = require('../functions/escapeHtml');
const pageMeta = require('../functions/pageMeta');
const { FEATURES } = require('../constants');
const HomePage = require('../components/HomePage');
const SiteHeader = require('../components/SiteHeader');
const PermafleetOperation = require('../components/PermafleetOperation');
const PermafleetSchedule = require('../components/PermafleetSchedule');
const PermafleetHeader = require('../components/PermafleetHeader');
const PermafleetSquadrons = require('../components/PermafleetSquadrons');
const Login = require('../components/Login');
const EventsPage = require('../components/EventsPage');
const OperationsIndex = require('../components/OperationsIndex');
const IdleRPGPage = require('../components/IdleRPGPage');
const IdleRPGPlayerPage = require('../components/IdleRPGPlayerPage');
const Organizations = require('../components/Organizations');
const Resources = require('../components/Resources');
const SquadronApplication = require('../components/SquadronApplication');
const DrillsPage = require('../components/DrillsPage');
const TournamentsPage = require('../components/TournamentsPage');
const LeaguesPage = require('../components/LeaguesPage');
const DuelLeaderboard = require('../components/DuelLeaderboard');
const ClipsPage = require('../components/ClipsPage');

const ORGANIZATIONS_FILE = path.join(__dirname, '../contracts/organizations.json');
const OPERATIONS_FILE = path.join(__dirname, '../contracts/operations.json');

const DEFAULTS = {
  title: 'GOON SQUAD',
  // Absolute origin for og:url / og:image (link previews need absolute URLs).
  siteUrl: 'https://goon.vc',
  homeDescription: 'G00N SQUAD: Star Citizen security and infiltration, with friends in most corners of the ’verse. A core member of the PERMAFLEET Protectorate. Membership is by invitation only.',
  loginDescription: 'Sign in to GOON SQUAD with Discord, Fabric Passport, or the GoonCitizen desktop app.',
  heading: 'GOON SQUAD<sup>&trade;</sup>',
  joinLabel: 'Join the Squad &raquo;',
  joinUrl: 'https://discord.com/servers/g00n-squad-1190527980120850493',
  loginLabel: '&gt; LOGIN &lt;',
  loginPath: '/sessions',
  loginDocumentTitle: 'Login — GOON SQUAD',
  eventsPath: '/events',
  eventsLabel: 'EVENTS',
  eventsIntro: 'Upcoming scheduled events from every Discord server we fly with.',
  eventsDocumentTitle: 'EVENTS — GOON SQUAD',
  operationsPath: '/operations',
  // Header link to the PERMAFLEET page.
  allianceLabel: 'PERMAFLEET',
  operationsHeading: 'OPERATIONS',
  operationsIntro: 'Standing operations the Squad flies, runs, or supports.',
  operationsDocumentTitle: 'OPERATIONS — GOON SQUAD',
  // Extra index entries beyond PERMAFLEET: [{ name, path, tagline, summary, links: [{ label, href }] }].
  operations: [],
  // Operations with Discord metrics (PERMAFLEET's card merges its entry); same file services/operations reads.
  operationsFile: OPERATIONS_FILE,
  // IdleRPG: card on /operations + dedicated players & statistics page (data from /services/idlerpg).
  idlerpgPath: '/services/idlerpg',
  idlerpgHeading: 'IDLERPG',
  idlerpgTagline: 'Presence is progress.',
  idlerpgIntro: 'The alliance idle game. Every pilot in a voice channel the bot can see levels up, fights, and loots just by being there — across every PERMAFLEET server at once.',
  idlerpgDocumentTitle: 'IDLERPG — GOON SQUAD',
  organizationsPath: '/organizations',
  organizationsHeading: 'ORGANIZATIONS',
  organizationsIntro: 'Member organizations of the PERMAFLEET Protectorate. Each links to its RSI page, where you can apply.',
  organizationsDocumentTitle: 'PERMAFLEET Organizations — GOON SQUAD',
  // Output of `npm run build:organizations`.
  organizationsFile: ORGANIZATIONS_FILE,
  resourcesPath: '/resources',
  resourcesLabel: 'RESOURCES',
  resourcesHeading: 'RESOURCES',
  resourcesIntro: 'Tools and guides for flying with the Squad.',
  resourcesDocumentTitle: 'RESOURCES — GOON SQUAD',
  // Extra index entries beyond GoonCitizen: [{ name, path, tagline, summary, links: [{ label, href }] }].
  resources: [],
  // Flight-training drills: /drills index + one page per drill hosting its Web Component.
  drillsPath: '/drills',
  drillsHeading: 'DRILLS',
  drillsIntro: 'Interactive flight-training drills. Run them on a second screen while you fly.',
  drillsDocumentTitle: 'DRILLS — GOON SQUAD',
  // [{ id, name, tagline?, summary?, element, script, attributes?: { name: value } }]
  drills: [{
    id: 'melee-rotation',
    name: 'Melee Rotation Drill',
    tagline: 'Evader, attacker, shadow. Splash and rotate.',
    summary: 'Three ships fly a chase chain: the evader runs, the attacker hunts, the shadow tails the attacker with guns cold. Splash the evader and everyone moves up one role while the next pilot on deck joins the tail.',
    element: 'melee-rotation-drill',
    script: '/scripts/melee-rotation-drill.js'
  }],
  // Tournaments: /tournaments index, /tournaments/<series>, /tournaments/<series>/<date>
  // (records in the tournaments Store, services/tournaments.js).
  tournamentsPath: '/tournaments',
  tournamentsHeading: 'TOURNAMENTS',
  tournamentsIntro: 'Squad tournaments, on record. Create one, score each game, and the winners are kept for posterity.',
  tournamentsDocumentTitle: 'TOURNAMENTS — GOON SQUAD',
  // Leagues: /leagues index and /leagues/<id> (Elo-rated duels, services/leagues.js).
  leaguesPath: '/leagues',
  leaguesHeading: 'LEAGUES',
  leaguesIntro: 'Standing duel leagues with Elo ratings. Start a perpetual ladder or a seasonal one, log each duel, and the ratings update.',
  leaguesDocumentTitle: 'LEAGUES — GOON SQUAD',
  // Clips: /clips library, /clips/timeline session timeline, /clips/projects/<id> editor (services/clips.js).
  clipsPath: '/clips',
  clipsHeading: 'CLIPS',
  clipsTagline: 'Every clip from our Discord clip channels, in one library.',
  clipsIntro: 'Every clip posted in our Discord clip channels, grouped into the sessions they were recorded in. Watch every angle of a fight, then cut the best ones together and render the film.',
  clipsDocumentTitle: 'CLIPS — GOON SQUAD',
  clipsTimelineDocumentTitle: 'CLIP TIMELINE — GOON SQUAD',
  clipsTimelineDescription: 'One recording session from our Discord clips, every pilot on their own track, lined up by when it happened.',
  // 1v1 ladder from the pinned message in G00N SQUAD #1v1-challenges (services/leaderboard.js).
  leaderboardPath: '/resources/1v1-leaderboard',
  leaderboardEndpoint: '/services/leaderboards/1v1',
  leaderboardDocumentTitle: '1v1 Leaderboard — GOON SQUAD',
  leaderboardDescription: 'The G00N SQUAD 1v1 dogfight ladder. Anyone can challenge anyone in #1v1-challenges on Discord, including pilots from other orgs.',
  leaderboardChannelUrl: 'https://discord.com/channels/1190527980120850493/1229937640116064276',
  // Squadron pages that show the top of the ladder.
  leaderboardSquadrons: ['bravo-squadron'],
  gooncitizenPath: '/resources/gooncitizen',
  gooncitizenTagline: 'The companion app for Star Citizen.',
  gooncitizenSummary: 'A desktop app that tracks your in-game statistics and lets you coordinate with your friends through groups: shared chat, missions, and fleets.',
  gooncitizenDocumentTitle: 'GoonCitizen — GOON SQUAD',
  gooncitizenRepoUrl: 'https://github.com/GoonCitizen/star-citizen-live',
  // Overrides the manifest: [{ label, href, version?, size?, sha256?, builtAt? }].
  gooncitizenDownloads: [],
  // Written by `npm run build:downloads`.
  gooncitizenManifest: path.join(__dirname, '../assets/downloads/gooncitizen/index.json'),
  permafleetPath: '/operations/PERMAFLEET',
  permafleetHeading: 'PERMAFLEET',
  permafleetTagline: 'We’re always online.',
  permafleetIntro: 'Dedicated to giving everyone a group to fly with, PERMAFLEET runs 24/7 public assistance. Security is always on standby, giving us rapid response times to hostile encounters.',
  permafleetDocumentTitle: 'PERMAFLEET — GOON SQUAD',
  permafleetChannelId: '1236721094153732276',
  permafleetChannelName: 'permafleet',
  permafleetInviteUrl: 'https://discord.gg/permafleet',
  permafleetHeroImage: '/hero-quantum.jpg',
  permafleetSquadronsPath: '/operations/PERMAFLEET/squadrons',
  permafleetSquadronsDocumentTitle: 'PERMAFLEET Squadrons — GOON SQUAD',
  permafleetSquadronsDescription: 'Your path to PERMAFLEET membership: join, fly with the fleet, and get selected for a cross-org squadron.',
  permafleetSchedulePath: '/operations/PERMAFLEET/schedule',
  permafleetScheduleDocumentTitle: 'PERMAFLEET Weekly Ops — GOON SQUAD',
  discordWidgetId: '1190527980120850493',
  discordRosterTitle: 'Discord',
  // Front-page overview; facts, logo, and motto come from the G00N record in organizationsFile.
  overviewSymbol: 'G00N',
  overviewParagraphs: [
    'Friends in most corners of the ’verse, and ears in the rest. We work across the Star Citizen community, mostly out of sight. A core member of the <a href="/operations/PERMAFLEET">PERMAFLEET Protectorate</a>.',
    'Wear the <code>[PERMAFLEET]</code> tag and you fly under our watch — anywhere, at any hour. Most of the time, you won’t even see us.',
    'Membership is by invitation only, and we notice who performs. Start with a <a href="/operations/PERMAFLEET/squadrons#squadron-apply">squadron application</a>, even if you already fly PERMAFLEET, or join PERMAFLEET directly by <a href="https://robertsspaceindustries.com/orgs/PERMAFLEET" target="_blank" rel="noopener noreferrer">applying on RSI</a>.'
  ],
  overviewCreed: 'Esse quam videri.',
  // Google Form behind the one application for every PERMAFLEET squadron (fields: entry ids from the live form).
  squadronApplicationForm: {
    action: 'https://docs.google.com/forms/d/e/1FAIpQLSdNqMmrcUJSSjzzTNzDQBIJ_foCL5m-EBp5nEQNIrlLNXMXVw/formResponse',
    viewUrl: 'https://forms.gle/GvUx3o1MuWtxJifT9',
    fields: [
      { name: 'entry.1263490172', label: 'What is your in-game name (IGN)?', type: 'short', required: true },
      { name: 'entry.1476806575', label: 'Why would you like to apply?', type: 'paragraph', required: true }
    ]
  },
  bitcoinAddress: 'bc1qx5ktkj6utjw3vl43htvn434c9kg89m73lympr0',
  copyright: '&copy; big lol',
  viewport: 'width=500, initial-scale=1'
};

function loadOrganizations (file) {
  try {
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    const organizations = (payload.organizations || [])
      .filter((org) => org && /^[A-Z0-9_]+$/.test(String(org.symbol || '')));
    return { fetchedAt: payload.fetchedAt || null, organizations };
  } catch {
    return { fetchedAt: null, organizations: [] };
  }
}

function loadOperations (file) {
  try {
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (payload.operations || []).filter((op) => op && op.id && op.name);
  } catch {
    return [];
  }
}

function loadDownloads (file) {
  try {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (manifest.files || []).filter((f) => f && f.label && /^\/downloads\//.test(String(f.href || '')));
  } catch {
    return [];
  }
}

/**
 * Goon.VC SPA: static site template driven by settings (see settings/local.js site.*).
 * Edit settings to change title, Discord, Bitcoin, footer without touching this file.
 */
class GoonSPA extends FabricSPA {
  _site (key) {
    return this.settings[key] !== undefined ? this.settings[key] : DEFAULTS[key];
  }

  /**
   * Origin and site name for {@link pageMeta.renderMetaTags}.
   * @returns {{ origin: string, name: string }}
   */
  metaSite () {
    return { origin: this._site('siteUrl'), name: this._site('title') };
  }

  /**
   * Link-preview metadata for every route the SPA renders.
   * @returns {Array<{ path: string, title: string, description: string, image: string|null, imageAlt: string, largeImage: boolean }>}
   */
  pages () {
    const title = this._site('title');
    const orgData = loadOrganizations(this._site('organizationsFile'));
    const overviewOrg = orgData.organizations.find((org) => org.symbol === this._site('overviewSymbol')) || {};
    const hero = this._site('permafleetHeroImage');
    const logo = { image: overviewOrg.logoUrl || '/apple-touch-icon.png', imageAlt: `${title} logo`, largeImage: false };
    const permafleet = { image: hero, imageAlt: 'PERMAFLEET', largeImage: true };
    const page = (path, documentTitle, description, image = logo) => Object.assign({ path, title: documentTitle, description }, image);
    return [
      page('/', title, this._site('homeDescription')),
      page(this._site('loginPath'), this._site('loginDocumentTitle'), this._site('loginDescription')),
      page(this._site('eventsPath'), this._site('eventsDocumentTitle'), this._site('eventsIntro')),
      page(this._site('operationsPath'), this._site('operationsDocumentTitle'), this._site('operationsIntro')),
      page(this._site('idlerpgPath'), this._site('idlerpgDocumentTitle'), this._site('idlerpgIntro')),
      page(this._site('organizationsPath'), this._site('organizationsDocumentTitle'), this._site('organizationsIntro'), permafleet),
      page(this._site('resourcesPath'), this._site('resourcesDocumentTitle'), this._site('resourcesIntro')),
      page(this._site('gooncitizenPath'), this._site('gooncitizenDocumentTitle'), `${this._site('gooncitizenTagline')} ${this._site('gooncitizenSummary')}`),
      page(this._site('leaderboardPath'), this._site('leaderboardDocumentTitle'), this._site('leaderboardDescription')),
      page(this._site('drillsPath'), this._site('drillsDocumentTitle'), this._site('drillsIntro')),
      ...DrillsPage.validDrills(this._site('drills')).map((drill) => page(
        DrillsPage.drillPath(drill, this._site('drillsPath')),
        `${drill.name} — ${title}`,
        drill.summary || drill.tagline || drill.name
      )),
      page(this._site('tournamentsPath'), this._site('tournamentsDocumentTitle'), this._site('tournamentsIntro')),
      page(this._site('leaguesPath'), this._site('leaguesDocumentTitle'), this._site('leaguesIntro')),
      page(this._site('clipsPath'), this._site('clipsDocumentTitle'), this._site('clipsIntro')),
      page(ClipsPage.timelinePath(this._site('clipsPath')), this._site('clipsTimelineDocumentTitle'), this._site('clipsTimelineDescription')),
      page(this._site('permafleetPath'), this._site('permafleetDocumentTitle'), `${this._site('permafleetTagline')} ${this._site('permafleetIntro')}`, permafleet),
      page(this._site('permafleetSchedulePath'), this._site('permafleetScheduleDocumentTitle'), 'The PERMAFLEET weekly schedule: day themes, training, and operations across the Protectorate.', permafleet),
      page(this._site('permafleetSquadronsPath'), this._site('permafleetSquadronsDocumentTitle'), this._site('permafleetSquadronsDescription'), permafleet),
      ...PermafleetSquadrons.pageEntries(this._site('permafleetSquadronsPath')).map((entry) => page(
        entry.path,
        `${entry.name} — ${title}`,
        entry.description,
        permafleet
      ))
    ].concat(orgData.organizations.map((org) => {
      const name = org.displayName || org.name || org.symbol;
      const image = org.bannerUrl
        ? { image: org.bannerUrl, imageAlt: `${name} banner`, largeImage: true }
        : { image: org.logoUrl || logo.image, imageAlt: `${name} logo`, largeImage: false };
      return page(
        Organizations.organizationPath(org, this._site('organizationsPath')),
        `${name} — ${title}`,
        (org.intro || []).join(' ') || `${name}, a member organization of the PERMAFLEET Protectorate.`,
        image
      );
    }));
  }

  /**
   * Build the full HTML document from config (settings/local.js site.*).
   * @param {string} [html=''] - Ignored; output is static. Kept for API compatibility.
   * @returns {string} Full document string.
   */
  _renderWith (html = '') {
    const title = this._site('title');
    const heading = this._site('heading');
    const joinLabel = this._site('joinLabel');
    const joinUrl = this._site('joinUrl');
    const loginLabel = this._site('loginLabel');
    const loginPath = this._site('loginPath');
    const loginTitleJson = JSON.stringify(this._site('loginDocumentTitle'));
    const eventsPath = this._site('eventsPath');
    const eventsTitleJson = JSON.stringify(this._site('eventsDocumentTitle'));
    const operationsPath = this._site('operationsPath');
    const idlerpgPath = this._site('idlerpgPath');
    const idlerpgTitleJson = JSON.stringify(this._site('idlerpgDocumentTitle'));
    const organizationsPath = this._site('organizationsPath');
    const organizationsTitleJson = JSON.stringify(this._site('organizationsDocumentTitle'));
    const orgData = loadOrganizations(this._site('organizationsFile'));
    const orgPathPattern = '^' + organizationsPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/([^/]+)$';
    const resourcesPath = this._site('resourcesPath');
    const resourcesTitleJson = JSON.stringify(this._site('resourcesDocumentTitle'));
    const gooncitizenPath = this._site('gooncitizenPath');
    const gooncitizenTitleJson = JSON.stringify(this._site('gooncitizenDocumentTitle'));
    const leaderboardPath = this._site('leaderboardPath');
    const leaderboardTitleJson = JSON.stringify(this._site('leaderboardDocumentTitle'));
    const leaderboardChannelUrl = this._site('leaderboardChannelUrl');
    const drillsPath = this._site('drillsPath');
    const drillsTitleJson = JSON.stringify(this._site('drillsDocumentTitle'));
    const tournamentsPath = this._site('tournamentsPath');
    const tournamentsTitleJson = JSON.stringify(this._site('tournamentsDocumentTitle'));
    const leaguesPath = this._site('leaguesPath');
    const leaguesTitleJson = JSON.stringify(this._site('leaguesDocumentTitle'));
    const clipsPath = this._site('clipsPath');
    const clipsTitleJson = JSON.stringify(this._site('clipsDocumentTitle'));
    const permafleetPath = this._site('permafleetPath');
    const permafleetTitleJson = JSON.stringify(this._site('permafleetDocumentTitle'));
    const permafleetInviteUrl = this._site('permafleetInviteUrl');
    const schedulePath = this._site('permafleetSchedulePath');
    const scheduleTitleJson = JSON.stringify(this._site('permafleetScheduleDocumentTitle'));
    const squadronsPath = this._site('permafleetSquadronsPath');
    const squadronsTitleJson = JSON.stringify(this._site('permafleetSquadronsDocumentTitle'));
    const titleJson = JSON.stringify(title);
    const widgetId = this._site('discordWidgetId');
    const bitcoinAddress = this._site('bitcoinAddress');
    const copyright = this._site('copyright');
    const viewport = this._site('viewport');
    const alliance = SiteHeader.renderAlliance(permafleetPath);
    const headerHtml = SiteHeader.render({
      heading,
      nav: [
        { href: eventsPath, label: escapeHtml(this._site('eventsLabel')) },
        { href: resourcesPath, label: escapeHtml(this._site('resourcesLabel')) },
        { href: permafleetPath, label: escapeHtml(this._site('allianceLabel')) },
        FEATURES.headerLogin ? { href: loginPath, label: 'Login' } : null
      ].filter(Boolean)
    });
    const overviewOrg = orgData.organizations.find((org) => org.symbol === this._site('overviewSymbol')) || {};
    const homeMainHtml = HomePage.render({
      overview: {
        name: overviewOrg.displayName || overviewOrg.name || title,
        logoUrl: overviewOrg.logoUrl,
        facts: [
          overviewOrg.model,
          overviewOrg.focus && [overviewOrg.focus.primary, overviewOrg.focus.secondary].filter(Boolean).join(' / '),
          overviewOrg.recruiting ? 'Recruiting' : null
        ],
        paragraphs: this._site('overviewParagraphs'),
        creed: this._site('overviewCreed'),
        motto: [].concat(overviewOrg.manifesto || [], overviewOrg.charter || []).slice(0, 2),
        actions: [
          { label: 'Apply for a squadron', href: PermafleetSquadrons.applyPath(squadronsPath) },
          overviewOrg.symbol ? { label: 'Org profile', href: Organizations.organizationPath(overviewOrg, organizationsPath) } : null,
          { label: 'Events', href: eventsPath }
        ].filter(Boolean)
      },
      discordTitle: this._site('discordRosterTitle'),
      joinUrl,
      joinLabel,
      loginPath,
      loginLabel,
      bitcoinAddress,
      alliance,
      copyright
    });
    const loginMainHtml = Login.render({ title: loginLabel, joinUrl });
    const loginScript = Login.script({ path: loginPath });
    const eventsMainHtml = EventsPage.render({
      description: this._site('eventsIntro'),
      loginPath,
      loginLabel,
      alliance,
      copyright
    });
    const eventsScript = EventsPage.script();
    const operationsScript = OperationsIndex.script();
    const operationsTitleJson = JSON.stringify(this._site('operationsDocumentTitle'));
    const hasMetrics = (op) => !!op && Array.isArray(op.metrics) && op.metrics.length > 0;
    const crossOrgOperations = loadOperations(this._site('operationsFile'));
    const permafleetOperation = crossOrgOperations.find((op) => op.id === 'permafleet');
    const operationsMainHtml = OperationsIndex.render({
      heading: escapeHtml(this._site('operationsHeading')),
      intro: escapeHtml(this._site('operationsIntro')),
      operations: [{
        id: 'permafleet',
        name: this._site('permafleetHeading'),
        path: permafleetPath,
        tagline: this._site('permafleetTagline'),
        summary: this._site('permafleetIntro'),
        links: [
          { label: 'Weekly schedule', href: schedulePath },
          { label: 'Join on Discord', href: permafleetInviteUrl }
        ],
        metrics: hasMetrics(permafleetOperation)
      }].concat(crossOrgOperations.filter((op) => op !== permafleetOperation).map((op) => ({
        id: op.id,
        name: op.name,
        path: op.path || `${permafleetPath}#${op.id}`,
        tagline: op.role,
        summary: op.summary,
        links: op.links,
        metrics: hasMetrics(op)
      })), this._site('operations') || []),
      loginPath,
      loginLabel,
      alliance,
      copyright
    });
    const idlerpgMainHtml = IdleRPGPage.render({
      heading: escapeHtml(this._site('idlerpgHeading')),
      intro: escapeHtml(this._site('idlerpgIntro')),
      resourcesPath,
      loginPath,
      loginLabel,
      alliance,
      copyright
    });
    const idlerpgScript = IdleRPGPage.script();
    const idlerpgPlayerMainHtml = IdleRPGPlayerPage.render({
      idlerpgPath,
      loginPath,
      loginLabel,
      alliance,
      copyright
    });
    const idlerpgPlayerScript = IdleRPGPlayerPage.script({
      idlerpgPath,
      titleSuffix: ` — ${this._site('idlerpgDocumentTitle')}`
    });
    const resourcesMainHtml = Resources.render({
      heading: escapeHtml(this._site('resourcesHeading')),
      intro: escapeHtml(this._site('resourcesIntro')),
      resources: [{
        name: 'GoonCitizen',
        path: gooncitizenPath,
        tagline: this._site('gooncitizenTagline'),
        summary: this._site('gooncitizenSummary'),
        links: [{ label: 'Source on GitHub', href: this._site('gooncitizenRepoUrl') }]
      }, {
        name: 'Drills',
        path: drillsPath,
        tagline: 'Flight training you can run on a second screen.',
        summary: this._site('drillsIntro')
      }, {
        name: 'Tournaments',
        path: tournamentsPath,
        tagline: 'Single and double elimination brackets, best of n, with every result on record.',
        summary: this._site('tournamentsIntro'),
        openLabel: 'Tournaments'
      }, {
        name: 'Leagues',
        path: leaguesPath,
        tagline: 'Perpetual and seasonal duel ladders, Elo-rated.',
        summary: this._site('leaguesIntro'),
        openLabel: 'Leagues'
      }, {
        name: 'Clips',
        path: clipsPath,
        tagline: this._site('clipsTagline'),
        summary: 'Every clip from our Discord, grouped by when it was recorded so every angle of a fight sits side by side. Cut them into a film; the render credits each pilot and links back to the Discord post.',
        openLabel: 'Clips'
      }, {
        name: '1v1 Leaderboard',
        path: leaderboardPath,
        tagline: 'The standing dogfight ladder, synced from #1v1-challenges.',
        summary: 'Anyone can challenge anyone, including pilots from other orgs.',
        openLabel: 'Leaderboard',
        links: [{ label: 'Challenge someone', href: leaderboardChannelUrl }]
      }, {
        id: 'idlerpg-card',
        name: this._site('idlerpgHeading'),
        path: idlerpgPath,
        tagline: this._site('idlerpgTagline'),
        summary: this._site('idlerpgIntro'),
        openLabel: 'Players & statistics',
        presence: true
      }].concat(this._site('resources') || []),
      loginPath,
      loginLabel,
      alliance,
      copyright
    });
    const gooncitizenMainHtml = Resources.renderGoonCitizen({
      resourcesPath,
      tagline: this._site('gooncitizenTagline'),
      summary: this._site('gooncitizenSummary'),
      downloads: (this._site('gooncitizenDownloads') || []).length
        ? this._site('gooncitizenDownloads')
        : loadDownloads(this._site('gooncitizenManifest')),
      repoUrl: this._site('gooncitizenRepoUrl'),
      discordUrl: joinUrl,
      loginPath,
      loginLabel,
      alliance,
      copyright
    });
    const leaderboardMainHtml = DuelLeaderboard.render({
      path: leaderboardPath,
      resourcesPath,
      channelUrl: leaderboardChannelUrl,
      joinUrl,
      tournamentsPath,
      loginPath,
      loginLabel,
      alliance,
      copyright
    });
    const drillsProps = {
      heading: escapeHtml(this._site('drillsHeading')),
      intro: escapeHtml(this._site('drillsIntro')),
      basePath: drillsPath,
      drills: this._site('drills'),
      siteTitle: title,
      loginPath,
      loginLabel,
      alliance,
      copyright
    };
    const drillsMainHtml = DrillsPage.render(drillsProps);
    const drillMainsHtml = DrillsPage.renderDrills(drillsProps);
    const drillsScript = DrillsPage.script(drillsProps);
    const tournamentsProps = {
      heading: escapeHtml(this._site('tournamentsHeading')),
      intro: escapeHtml(this._site('tournamentsIntro')),
      basePath: tournamentsPath,
      siteTitle: title,
      loginPath,
      loginLabel,
      alliance,
      copyright
    };
    const tournamentsMainHtml = TournamentsPage.render(tournamentsProps);
    const tournamentMainsHtml = TournamentsPage.renderTournaments(tournamentsProps);
    const tournamentsScript = TournamentsPage.script(tournamentsProps);
    const leaguesProps = {
      heading: escapeHtml(this._site('leaguesHeading')),
      intro: escapeHtml(this._site('leaguesIntro')),
      basePath: leaguesPath,
      siteTitle: title,
      loginPath,
      loginLabel,
      alliance,
      copyright
    };
    const leaguesMainHtml = LeaguesPage.render(leaguesProps);
    const leagueMainHtml = LeaguesPage.renderLeague(leaguesProps);
    const leaguesScript = LeaguesPage.script(leaguesProps);
    const clipsProps = {
      heading: escapeHtml(this._site('clipsHeading')),
      intro: escapeHtml(this._site('clipsIntro')),
      basePath: clipsPath,
      loginPath,
      loginLabel,
      alliance,
      copyright
    };
    const clipsMainHtml = ClipsPage.render(clipsProps);
    const clipTimelineMainHtml = ClipsPage.renderTimeline(clipsProps);
    const clipProjectMainHtml = ClipsPage.renderProject(clipsProps);
    const clipsScript = ClipsPage.script(clipsProps);
    const orgProps = {
      heading: escapeHtml(this._site('organizationsHeading')),
      intro: escapeHtml(this._site('organizationsIntro')),
      basePath: organizationsPath,
      organizations: orgData.organizations,
      fetchedAt: orgData.fetchedAt,
      embassyUrl: joinUrl,
      allianceName: this._site('permafleetHeading'),
      alliancePath: permafleetPath,
      loginPath,
      loginLabel,
      alliance,
      copyright
    };
    const organizationsMainHtml = Organizations.render(orgProps);
    const organizationMainsHtml = orgData.organizations
      .map((org) => Organizations.renderOrganization(org, orgProps))
      .join('\n');
    const applicationHtml = SquadronApplication.render({
      id: 'squadron-application',
      form: this._site('squadronApplicationForm')
    });
    const applicationScript = applicationHtml
      ? SquadronApplication.script({
        id: 'squadron-application',
        successText: 'Application sent. Leadership reviews every application; watch Discord for a reply.'
      })
      : '';
    const squadronProps = {
      basePath: squadronsPath,
      inviteUrl: permafleetInviteUrl,
      schedulePath,
      title,
      applicationHtml,
      extras: Object.fromEntries((this._site('leaderboardSquadrons') || []).map((id) => [id, DuelLeaderboard.renderEmbed({
        id,
        path: leaderboardPath,
        channelUrl: leaderboardChannelUrl
      })]))
    };
    const squadronsMainHtml = PermafleetSquadrons.render(squadronProps);
    const squadronMainsHtml = PermafleetSquadrons.SQUADRONS
      .map((squadron) => PermafleetSquadrons.renderSquadron(squadron, squadronProps))
      .join('\n');
    const permafleetMainHtml = PermafleetOperation.render({
      squadronsPath,
      memberOrgs: orgData.organizations.length
        ? orgData.organizations.map((org) => ({
          name: org.displayName || org.name,
          symbol: org.symbol,
          logoUrl: org.logoUrl,
          members: org.members,
          href: Organizations.organizationPath(org, organizationsPath)
        }))
        : null,
      organizationsPath,
      heading: escapeHtml(this._site('permafleetHeading')),
      tagline: escapeHtml(this._site('permafleetTagline')),
      intro: escapeHtml(this._site('permafleetIntro')),
      inviteUrl: permafleetInviteUrl,
      hotlineUrl: joinUrl,
      schedulePath,
      bitcoinAddress,
      copyright
    });
    const scheduleMainHtml = PermafleetSchedule.render({ server: widgetId });
    const permafleetHeaderHtml = PermafleetHeader.render({
      heading: escapeHtml(this._site('permafleetHeading')),
      homeLabel: escapeHtml(title),
      permafleetPath,
      schedulePath,
      squadronsPath,
      organizationsPath,
      inviteUrl: permafleetInviteUrl
    });
    const permafleetScript = PermafleetOperation.script({
      guildId: widgetId,
      channelId: this._site('permafleetChannelId'),
      channelName: this._site('permafleetChannelName'),
      inviteUrl: permafleetInviteUrl
    });

    return `<html>
  <head>
    <title>${escapeHtml(title)}</title>
    ${pageMeta.renderMetaTags(this.pages()[0], this.metaSite())}
    <link rel="icon" href="/favicon.ico" sizes="48x48">
    <link rel="icon" href="/favicon.png" type="image/png" sizes="175x175">
    <link rel="apple-touch-icon" href="/apple-touch-icon.png">
    <meta name="theme-color" content="#520002">
    <meta name="viewport" content="${viewport}" />
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Bungee&family=Rajdhani:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style type="text/css">
      body { background: #333; color: #ddd; font-family: "Rajdhani", sans-serif; font-size: 17px; font-weight: 500; text-align: center; }
      button, input { font-family: inherit; }
      h1, h2, h3 { font-family: "Bungee", sans-serif; font-weight: 400; font-style: normal; }
      a { color: #fff; }
      footer, footer > div { padding-top: 1em; }
      footer { text-align: center; }
      .footer-login-button, .goon-button {
        background: transparent;
        border: 2px solid #fff;
        border-radius: 8px;
        color: #fff;
        cursor: pointer;
        display: inline-block;
        font-family: "Bungee", sans-serif;
        font-size: 1em;
        letter-spacing: 0.1em;
        padding: 0.5em 0.9em;
        text-decoration: none;
      }
      .footer-login-button:hover, .goon-button:hover:not(:disabled) { background: rgba(255, 255, 255, 0.1); }
      .goon-button:disabled { cursor: default; opacity: 0.45; }
      .page-back { text-align: center; margin-bottom: 1.5em; }
${SiteHeader.styles()}
${PermafleetHeader.styles()}
${HomePage.styles()}
${PermafleetOperation.styles({ heroImage: this._site('permafleetHeroImage') })}
${PermafleetSchedule.styles()}
${PermafleetSquadrons.styles()}
${Login.styles()}
${EventsPage.styles()}
${OperationsIndex.styles()}
${IdleRPGPage.styles()}
${IdleRPGPlayerPage.styles()}
${Organizations.styles()}
${Resources.styles()}
${DrillsPage.styles()}
${TournamentsPage.styles()}
${LeaguesPage.styles()}
${DuelLeaderboard.styles()}
${ClipsPage.styles()}
    </style>
  </head>
  <body>
    ${headerHtml}
    ${permafleetHeaderHtml}
    ${homeMainHtml}
    ${loginMainHtml}
    ${eventsMainHtml}
    ${operationsMainHtml}
    ${idlerpgMainHtml}
    ${idlerpgPlayerMainHtml}
    ${organizationsMainHtml}
${organizationMainsHtml}
    ${resourcesMainHtml}
    ${gooncitizenMainHtml}
    ${leaderboardMainHtml}
    ${drillsMainHtml}
${drillMainsHtml}
    ${tournamentsMainHtml}
${tournamentMainsHtml}
    ${leaguesMainHtml}
    ${leagueMainHtml}
    ${clipsMainHtml}
    ${clipTimelineMainHtml}
    ${clipProjectMainHtml}
    ${permafleetMainHtml}
    ${scheduleMainHtml}
    ${squadronsMainHtml}
${squadronMainsHtml}
    <script type="text/javascript">
      (function () {
        var loginPath = ${JSON.stringify(loginPath)};
        var permafleetPath = ${JSON.stringify(permafleetPath)};
        var schedulePath = ${JSON.stringify(schedulePath)};
        var squadronsPath = ${JSON.stringify(squadronsPath)};
        var path = (window.location.pathname || '/').replace(/\\/+$/, '') || '/';
        if (path.toLowerCase() === permafleetPath.toLowerCase() && /^#[a-z0-9-]+$/i.test(window.location.hash)) {
          var movedSquadron = document.getElementById('squadron-' + window.location.hash.slice(1).toLowerCase());
          if (movedSquadron) {
            window.location.replace(movedSquadron.getAttribute('data-path'));
            return;
          }
        }
        var isLogin = path === loginPath;
        var isEvents = path.toLowerCase() === ${JSON.stringify(eventsPath.toLowerCase())};
        var isOperations = path.toLowerCase() === ${JSON.stringify(operationsPath.toLowerCase())};
        var isIdleRPG = path.toLowerCase() === ${JSON.stringify(idlerpgPath.toLowerCase())};
        var idlerpgPlayerEl = path.toLowerCase().indexOf(${JSON.stringify(IdleRPGPlayerPage.playersPath(idlerpgPath).toLowerCase() + '/')}) === 0
          ? document.getElementById('idlerpg-player-page')
          : null;
        var isOrganizations = path.toLowerCase() === ${JSON.stringify(organizationsPath.toLowerCase())};
        var orgMatch = new RegExp(${JSON.stringify(orgPathPattern)}, 'i').exec(path);
        var orgEl = orgMatch ? document.getElementById('org-' + decodeURIComponent(orgMatch[1]).toUpperCase()) : null;
        var isResources = path.toLowerCase() === ${JSON.stringify(resourcesPath.toLowerCase())};
        var isGoonCitizen = path.toLowerCase() === ${JSON.stringify(gooncitizenPath.toLowerCase())};
        var isLeaderboard = path.toLowerCase() === ${JSON.stringify(leaderboardPath.toLowerCase())};
        var isDrills = path.toLowerCase() === ${JSON.stringify(drillsPath.toLowerCase())};
        var drillEl = null;
        document.querySelectorAll('.drill-page').forEach(function (el) {
          if (el.getAttribute('data-path') === path.toLowerCase()) drillEl = el;
        });
        var isTournaments = path.toLowerCase() === ${JSON.stringify(tournamentsPath.toLowerCase())};
        var tournamentEl = path.toLowerCase().indexOf(${JSON.stringify(tournamentsPath.toLowerCase() + '/')}) === 0
          ? document.getElementById('tournament-page')
          : null;
        var isLeagues = path.toLowerCase() === ${JSON.stringify(leaguesPath.toLowerCase())};
        var leagueEl = path.toLowerCase().indexOf(${JSON.stringify(leaguesPath.toLowerCase() + '/')}) === 0
          ? document.getElementById('league-page')
          : null;
        var isClips = path.toLowerCase() === ${JSON.stringify(clipsPath.toLowerCase())};
        var isClipTimeline = path.toLowerCase() === ${JSON.stringify(ClipsPage.timelinePath(clipsPath).toLowerCase())};
        var clipProjectEl = path.toLowerCase().indexOf(${JSON.stringify(clipsPath.toLowerCase() + '/projects/')}) === 0
          ? document.getElementById('clip-project-page')
          : null;
        var isPermafleet = path.toLowerCase() === permafleetPath.toLowerCase();
        var isSchedule = path.toLowerCase() === schedulePath.toLowerCase();
        var isSquadrons = path.toLowerCase() === squadronsPath.toLowerCase();
        var squadronEl = null;
        document.querySelectorAll('.pf-squadron-page').forEach(function (el) {
          if (el.getAttribute('data-path').toLowerCase() === path.toLowerCase()) squadronEl = el;
        });
        var home = document.getElementById('home-page');
        var login = document.getElementById('login-page');
        var eventsEl = document.getElementById('events-page');
        var operationsEl = document.getElementById('operations-page');
        var permafleetEl = document.getElementById('operation-permafleet');
        var scheduleEl = document.getElementById('permafleet-schedule');

        if (home) {
          home.style.display = (!isLogin && !isEvents && !isOperations && !isIdleRPG && !idlerpgPlayerEl && !isOrganizations && !orgEl && !isResources && !isGoonCitizen && !isLeaderboard && !isDrills && !drillEl && !isTournaments && !tournamentEl && !isLeagues && !leagueEl && !isClips && !isClipTimeline && !clipProjectEl && !isPermafleet && !isSchedule && !isSquadrons && !squadronEl) ? 'block' : 'none';
        }
        if (login) login.style.display = isLogin ? 'block' : 'none';
        if (eventsEl) eventsEl.style.display = isEvents ? 'block' : 'none';
        if (operationsEl) operationsEl.style.display = isOperations ? 'block' : 'none';
        var idlerpgEl = document.getElementById('idlerpg-page');
        if (idlerpgEl) idlerpgEl.style.display = isIdleRPG ? 'block' : 'none';
        var idlerpgPlayerPageEl = document.getElementById('idlerpg-player-page');
        if (idlerpgPlayerPageEl) idlerpgPlayerPageEl.style.display = idlerpgPlayerEl ? 'block' : 'none';
        var organizationsEl = document.getElementById('organizations-page');
        if (organizationsEl) organizationsEl.style.display = isOrganizations ? 'block' : 'none';
        document.querySelectorAll('.organization-page').forEach(function (el) {
          el.style.display = el === orgEl ? 'block' : 'none';
        });
        var resourcesEl = document.getElementById('resources-page');
        var gooncitizenEl = document.getElementById('gooncitizen-page');
        if (resourcesEl) resourcesEl.style.display = isResources ? 'block' : 'none';
        if (gooncitizenEl) gooncitizenEl.style.display = isGoonCitizen ? 'block' : 'none';
        var leaderboardEl = document.getElementById('leaderboard-page');
        if (leaderboardEl) leaderboardEl.style.display = isLeaderboard ? 'block' : 'none';
        var drillsEl = document.getElementById('drills-page');
        if (drillsEl) drillsEl.style.display = isDrills ? 'block' : 'none';
        document.querySelectorAll('.drill-page').forEach(function (el) {
          el.style.display = el === drillEl ? 'block' : 'none';
        });
        var tournamentsEl = document.getElementById('tournaments-page');
        if (tournamentsEl) tournamentsEl.style.display = isTournaments ? 'block' : 'none';
        var tournamentPageEl = document.getElementById('tournament-page');
        if (tournamentPageEl) tournamentPageEl.style.display = tournamentEl ? 'block' : 'none';
        var leaguesEl = document.getElementById('leagues-page');
        if (leaguesEl) leaguesEl.style.display = isLeagues ? 'block' : 'none';
        var leaguePageEl = document.getElementById('league-page');
        if (leaguePageEl) leaguePageEl.style.display = leagueEl ? 'block' : 'none';
        var clipsEl = document.getElementById('clips-page');
        if (clipsEl) clipsEl.style.display = isClips ? 'block' : 'none';
        var clipTimelineEl = document.getElementById('clip-timeline-page');
        if (clipTimelineEl) clipTimelineEl.style.display = isClipTimeline ? 'block' : 'none';
        var clipProjectPageEl = document.getElementById('clip-project-page');
        if (clipProjectPageEl) clipProjectPageEl.style.display = clipProjectEl ? 'block' : 'none';
        if (permafleetEl) permafleetEl.style.display = isPermafleet ? 'block' : 'none';
        document.body.classList.toggle('op-active', isPermafleet);
        if (scheduleEl) scheduleEl.style.display = isSchedule ? 'block' : 'none';
        document.body.classList.toggle('schedule-active', isSchedule);
        var squadronsEl = document.getElementById('squadrons-page');
        if (squadronsEl) squadronsEl.style.display = isSquadrons ? 'block' : 'none';
        document.querySelectorAll('.pf-squadron-page').forEach(function (el) {
          el.style.display = el === squadronEl ? 'block' : 'none';
        });
        document.body.classList.toggle('pf-section', isPermafleet || isSchedule || isSquadrons || !!squadronEl || isOrganizations || !!orgEl);

        if (isLogin) document.title = ${loginTitleJson};
        else if (isEvents) document.title = ${eventsTitleJson};
        else if (isOperations) document.title = ${operationsTitleJson};
        else if (isIdleRPG || idlerpgPlayerEl) document.title = ${idlerpgTitleJson};
        else if (isOrganizations) document.title = ${organizationsTitleJson};
        else if (isResources) document.title = ${resourcesTitleJson};
        else if (isGoonCitizen) document.title = ${gooncitizenTitleJson};
        else if (isLeaderboard) document.title = ${leaderboardTitleJson};
        else if (isDrills) document.title = ${drillsTitleJson};
        else if (drillEl) document.title = drillEl.getAttribute('data-title');
        else if (isTournaments) document.title = ${tournamentsTitleJson};
        else if (tournamentEl) document.title = ${tournamentsTitleJson};
        else if (isLeagues || leagueEl) document.title = ${leaguesTitleJson};
        else if (isClipTimeline) document.title = ${JSON.stringify(this._site('clipsTimelineDocumentTitle'))};
        else if (isClips || clipProjectEl) document.title = ${clipsTitleJson};
        else if (orgEl) document.title = (orgEl.querySelector('h1') || {}).textContent + ' — GOON SQUAD';
        else if (isPermafleet) document.title = ${permafleetTitleJson};
        else if (isSchedule) document.title = ${scheduleTitleJson};
        else if (isSquadrons) document.title = ${squadronsTitleJson};
        else if (squadronEl) document.title = squadronEl.getAttribute('data-title');
        else document.title = ${titleJson};
      })();
    </script>
    ${SiteHeader.script()}
    ${PermafleetHeader.script()}
    ${loginScript}
    ${HomePage.script({ guildId: widgetId })}
    ${eventsScript}
    ${operationsScript}
    ${idlerpgScript}
    ${idlerpgPlayerScript}
    ${Resources.gooncitizenScript()}
    ${Resources.presenceScript()}
    ${DuelLeaderboard.script({ endpoint: this._site('leaderboardEndpoint') })}
    ${drillsScript}
    ${tournamentsScript}
    ${leaguesScript}
    ${clipsScript}
    ${permafleetScript}
    ${applicationScript}
  </body>
</html>
`;
  }
}

module.exports = GoonSPA;
