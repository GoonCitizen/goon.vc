'use strict';

const fs = require('fs');
const path = require('path');
const FabricSPA = require('@fabric/http/types/spa');
const escapeHtml = require('../functions/escapeHtml');
const HomePage = require('../components/HomePage');
const SiteHeader = require('../components/SiteHeader');
const PermafleetOperation = require('../components/PermafleetOperation');
const PermafleetSchedule = require('../components/PermafleetSchedule');
const Login = require('../components/Login');
const EventsPage = require('../components/EventsPage');
const OperationsIndex = require('../components/OperationsIndex');
const Organizations = require('../components/Organizations');
const Resources = require('../components/Resources');

const ORGANIZATIONS_FILE = path.join(__dirname, '../contracts/organizations.json');

const DEFAULTS = {
  title: 'GOON SQUAD',
  heading: 'GOON SQUAD<sup>&trade;</sup>',
  joinLabel: 'Join the Squad &raquo;',
  joinUrl: 'https://discord.com/servers/g00n-squad-1190527980120850493',
  loginLabel: '&gt; LOGIN &lt;',
  loginPath: '/sessions',
  loginDocumentTitle: 'Login — GOON SQUAD',
  monitorUrl: 'https://relay.goon.vc',
  monitorLabel: 'Monitor',
  eventsPath: '/events',
  eventsLabel: 'EVENTS',
  eventsHeading: 'EVENTS',
  eventsIntro: 'Upcoming scheduled events from every Discord server we fly with.',
  eventsDocumentTitle: 'EVENTS — GOON SQUAD',
  operationsPath: '/operations',
  operationsLabel: 'OPERATIONS',
  operationsHeading: 'OPERATIONS',
  operationsIntro: 'Standing operations the Squad flies, runs, or supports.',
  operationsDocumentTitle: 'OPERATIONS — GOON SQUAD',
  // Extra index entries beyond PERMAFLEET: [{ name, path, tagline, summary, links: [{ label, href }] }].
  operations: [],
  organizationsPath: '/organizations',
  organizationsLabel: 'ORGANIZATIONS',
  organizationsHeading: 'ORGANIZATIONS',
  organizationsIntro: 'Member organizations of the PERMAFLEET Protectorate. Each links to its RSI page, where you can apply.',
  organizationsDocumentTitle: 'ORGANIZATIONS — GOON SQUAD',
  // Output of `npm run build:organizations`.
  organizationsFile: ORGANIZATIONS_FILE,
  resourcesPath: '/resources',
  resourcesLabel: 'RESOURCES',
  resourcesHeading: 'RESOURCES',
  resourcesIntro: 'Tools and guides for flying with the Squad.',
  resourcesDocumentTitle: 'RESOURCES — GOON SQUAD',
  // Extra index entries beyond GoonCitizen: [{ name, path, tagline, summary, links: [{ label, href }] }].
  resources: [],
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
  permafleetInviteUrl: 'https://discord.com/invite/M4h9bBWq',
  permafleetHeroImage: '/hero-quantum.jpg',
  permafleetSchedulePath: '/operations/PERMAFLEET/schedule',
  permafleetScheduleImage: '/permafleet-schedule.svg',
  permafleetScheduleHtml: '/permafleet-schedule.html',
  permafleetScheduleDocumentTitle: 'PERMAFLEET Weekly Ops — GOON SQUAD',
  discordWidgetId: '1190527980120850493',
  discordWidgetTheme: 'dark',
  discordWidgetWidth: 350,
  discordWidgetHeight: 800,
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
    const monitorUrl = this._site('monitorUrl');
    const monitorLabel = escapeHtml(this._site('monitorLabel'));
    const loginTitleJson = JSON.stringify(this._site('loginDocumentTitle'));
    const eventsPath = this._site('eventsPath');
    const eventsTitleJson = JSON.stringify(this._site('eventsDocumentTitle'));
    const operationsPath = this._site('operationsPath');
    const organizationsPath = this._site('organizationsPath');
    const organizationsTitleJson = JSON.stringify(this._site('organizationsDocumentTitle'));
    const orgData = loadOrganizations(this._site('organizationsFile'));
    const orgPathPattern = '^' + organizationsPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/([^/]+)$';
    const resourcesPath = this._site('resourcesPath');
    const resourcesTitleJson = JSON.stringify(this._site('resourcesDocumentTitle'));
    const gooncitizenPath = this._site('gooncitizenPath');
    const gooncitizenTitleJson = JSON.stringify(this._site('gooncitizenDocumentTitle'));
    const permafleetPath = this._site('permafleetPath');
    const permafleetTitleJson = JSON.stringify(this._site('permafleetDocumentTitle'));
    const permafleetInviteUrl = this._site('permafleetInviteUrl');
    const schedulePath = this._site('permafleetSchedulePath');
    const scheduleTitleJson = JSON.stringify(this._site('permafleetScheduleDocumentTitle'));
    const titleJson = JSON.stringify(title);
    const widgetId = this._site('discordWidgetId');
    const widgetTheme = this._site('discordWidgetTheme');
    const widgetWidth = this._site('discordWidgetWidth');
    const widgetHeight = this._site('discordWidgetHeight');
    const bitcoinAddress = this._site('bitcoinAddress');
    const copyright = this._site('copyright');
    const viewport = this._site('viewport');
    const widgetSrc = `https://discord.com/widget?id=${widgetId}&theme=${widgetTheme}`;
    const alliance = SiteHeader.renderAlliance(permafleetPath);
    const headerHtml = SiteHeader.render({
      heading,
      nav: [
        { href: eventsPath, label: escapeHtml(this._site('eventsLabel')) },
        { href: organizationsPath, label: escapeHtml(this._site('organizationsLabel')) },
        { href: operationsPath, label: escapeHtml(this._site('operationsLabel')) },
        { href: resourcesPath, label: escapeHtml(this._site('resourcesLabel')) },
        { href: monitorUrl, label: monitorLabel },
        { href: loginPath, label: 'Login' }
      ]
    });
    const homeMainHtml = HomePage.render({
      joinUrl,
      joinLabel,
      widgetSrc,
      widgetWidth,
      widgetHeight,
      loginPath,
      loginLabel,
      bitcoinAddress,
      alliance,
      copyright
    });
    const loginMainHtml = Login.render({ title: loginLabel, joinUrl });
    const loginScript = Login.script({ path: loginPath });
    const eventsMainHtml = EventsPage.render({
      heading: escapeHtml(this._site('eventsHeading')),
      intro: escapeHtml(this._site('eventsIntro')),
      loginPath,
      loginLabel,
      alliance,
      copyright
    });
    const eventsScript = EventsPage.script({ path: eventsPath });
    const operationsTitleJson = JSON.stringify(this._site('operationsDocumentTitle'));
    const operationsMainHtml = OperationsIndex.render({
      heading: escapeHtml(this._site('operationsHeading')),
      intro: escapeHtml(this._site('operationsIntro')),
      operations: [{
        name: this._site('permafleetHeading'),
        path: permafleetPath,
        tagline: this._site('permafleetTagline'),
        summary: this._site('permafleetIntro'),
        links: [
          { label: 'Weekly schedule', href: schedulePath },
          { label: 'Join on Discord', href: permafleetInviteUrl }
        ]
      }].concat(this._site('operations') || []),
      loginPath,
      loginLabel,
      alliance,
      copyright
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
      monitorUrl,
      loginPath,
      loginLabel,
      alliance,
      copyright
    });
    const orgProps = {
      heading: escapeHtml(this._site('organizationsHeading')),
      intro: escapeHtml(this._site('organizationsIntro')),
      basePath: organizationsPath,
      organizations: orgData.organizations,
      fetchedAt: orgData.fetchedAt,
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
    const permafleetMainHtml = PermafleetOperation.render({
      memberOrgs: orgData.organizations.length
        ? orgData.organizations.map((org) => ({
          name: org.displayName || org.name,
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
    const scheduleMainHtml = PermafleetSchedule.render({
      title: 'PERMAFLEET',
      imageSrc: this._site('permafleetScheduleImage'),
      htmlSrc: this._site('permafleetScheduleHtml'),
      operationPath: permafleetPath,
      joinUrl: permafleetInviteUrl
    });
    const permafleetScript = PermafleetOperation.script({
      guildId: widgetId,
      channelId: this._site('permafleetChannelId'),
      channelName: this._site('permafleetChannelName'),
      inviteUrl: permafleetInviteUrl
    });

    return `<html>
  <head>
    <title>${title}</title>
    <link rel="icon" href="/favicon.ico" sizes="48x48">
    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
    <link rel="apple-touch-icon" href="/apple-touch-icon.png">
    <meta name="theme-color" content="#4C1D95">
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
${HomePage.styles()}
${PermafleetOperation.styles({ heroImage: this._site('permafleetHeroImage') })}
${PermafleetSchedule.styles()}
${Login.styles()}
${EventsPage.styles()}
${OperationsIndex.styles()}
${Organizations.styles()}
${Resources.styles()}
    </style>
  </head>
  <body>
    ${headerHtml}
    ${homeMainHtml}
    ${loginMainHtml}
    ${eventsMainHtml}
    ${operationsMainHtml}
    ${organizationsMainHtml}
${organizationMainsHtml}
    ${resourcesMainHtml}
    ${gooncitizenMainHtml}
    ${permafleetMainHtml}
    ${scheduleMainHtml}
    <script type="text/javascript">
      (function () {
        var loginPath = ${JSON.stringify(loginPath)};
        var permafleetPath = ${JSON.stringify(permafleetPath)};
        var schedulePath = ${JSON.stringify(schedulePath)};
        var path = (window.location.pathname || '/').replace(/\\/+$/, '') || '/';
        var isLogin = path === loginPath;
        var isEvents = path.toLowerCase() === ${JSON.stringify(eventsPath.toLowerCase())};
        var isOperations = path.toLowerCase() === ${JSON.stringify(operationsPath.toLowerCase())};
        var isOrganizations = path.toLowerCase() === ${JSON.stringify(organizationsPath.toLowerCase())};
        var orgMatch = new RegExp(${JSON.stringify(orgPathPattern)}, 'i').exec(path);
        var orgEl = orgMatch ? document.getElementById('org-' + decodeURIComponent(orgMatch[1]).toUpperCase()) : null;
        var isResources = path.toLowerCase() === ${JSON.stringify(resourcesPath.toLowerCase())};
        var isGoonCitizen = path.toLowerCase() === ${JSON.stringify(gooncitizenPath.toLowerCase())};
        var isPermafleet = path.toLowerCase() === permafleetPath.toLowerCase();
        var isSchedule = path.toLowerCase() === schedulePath.toLowerCase();
        var home = document.getElementById('home-page');
        var login = document.getElementById('login-page');
        var eventsEl = document.getElementById('events-page');
        var operationsEl = document.getElementById('operations-page');
        var permafleetEl = document.getElementById('operation-permafleet');
        var scheduleEl = document.getElementById('permafleet-schedule');

        if (home) {
          home.style.display = (!isLogin && !isEvents && !isOperations && !isOrganizations && !orgEl && !isResources && !isGoonCitizen && !isPermafleet && !isSchedule) ? 'block' : 'none';
        }
        if (login) login.style.display = isLogin ? 'block' : 'none';
        if (eventsEl) eventsEl.style.display = isEvents ? 'block' : 'none';
        if (operationsEl) operationsEl.style.display = isOperations ? 'block' : 'none';
        var organizationsEl = document.getElementById('organizations-page');
        if (organizationsEl) organizationsEl.style.display = isOrganizations ? 'block' : 'none';
        document.querySelectorAll('.organization-page').forEach(function (el) {
          el.style.display = el === orgEl ? 'block' : 'none';
        });
        var resourcesEl = document.getElementById('resources-page');
        var gooncitizenEl = document.getElementById('gooncitizen-page');
        if (resourcesEl) resourcesEl.style.display = isResources ? 'block' : 'none';
        if (gooncitizenEl) gooncitizenEl.style.display = isGoonCitizen ? 'block' : 'none';
        if (permafleetEl) permafleetEl.style.display = isPermafleet ? 'block' : 'none';
        document.body.classList.toggle('op-active', isPermafleet);
        if (scheduleEl) scheduleEl.style.display = isSchedule ? 'block' : 'none';
        document.body.classList.toggle('schedule-active', isSchedule);

        if (isLogin) document.title = ${loginTitleJson};
        else if (isEvents) document.title = ${eventsTitleJson};
        else if (isOperations) document.title = ${operationsTitleJson};
        else if (isOrganizations) document.title = ${organizationsTitleJson};
        else if (isResources) document.title = ${resourcesTitleJson};
        else if (isGoonCitizen) document.title = ${gooncitizenTitleJson};
        else if (orgEl) document.title = (orgEl.querySelector('h1') || {}).textContent + ' — GOON SQUAD';
        else if (isPermafleet) document.title = ${permafleetTitleJson};
        else if (isSchedule) document.title = ${scheduleTitleJson};
        else document.title = ${titleJson};
      })();
    </script>
    ${SiteHeader.script()}
    ${loginScript}
    ${eventsScript}
    ${permafleetScript}
  </body>
</html>
`;
  }
}

module.exports = GoonSPA;
