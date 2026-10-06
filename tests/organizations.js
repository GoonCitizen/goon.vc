'use strict';

const assert = require('assert');
const parseRsiOrganization = require('../functions/rsiOrganization');
const Organizations = require('../components/Organizations');

const PAGE = `
<div class="heading "> <div class="banner"><img src="/media/b/banner/X-Banner.png" /></div> <div class="inner">
<div class="logo noshadow"> <img src="/media/l/logo/X-Logo.png" /> <span class="count">1,146 members</span> </div>
<h1>A.I.M.O.S / <span class="symbol">AIMOS</span></h1>
<ul class="tags clearfix"> <li class="model">Syndicate</li> <li class="commitment">Hardcore</li> <li class="roleplay">Role play</li> </ul>
<ul class="focus clearfix"> <li class="primary tooltip-wrap"> <img src="/media/r.png" alt="Resources" /> </li>
<li class="secondary tooltip-wrap"> <img src="/media/s.png" alt="Security" /> </li> </ul> </div> </div>
<div class="content join-us clearfix"> <ul class="subnav clearfix"><li><a href="/orgs/AIMOS">Description</a></li></ul>
<a class="holobtn bt-join js-modal-orgs js-orgs-apply"><span>Join us now!</span></a> </div>
<div class="body markitup-text"><p>Armored &amp; Mercenary <script>alert(1)</script></p> <p><a href="http://discord.gg/aimos" title="Comms">Comms&#8230;</a></p></div>
<div class="nav clearfix"> <a href="#history" data-content_id="tab-history">History</a> <a href="#charter" data-content_id="tab-charter">Charter</a> </div>
<div class="content-tab active" id="tab-history"> <h2 class="tab-title">History</h2> <div class="markitup-text"><p>Our Board of Directors will unveil our official corporate statements soon. Please come back for updated information.</p></div> </div>
<div class="content-tab" id="tab-manifesto"> <h2 class="tab-title">Manifesto</h2> <div class="markitup-text"><p>Fuck it we ball!</p></div> </div>
<div class="content-tab" id="tab-charter"> <h2 class="tab-title">Charter</h2> <div class="markitup-text"><p>Rise up.<br />Stay up.</p></div> </div>`;

describe('organizations', function () {
  it('parses a public RSI org page into plain text', function () {
    const org = parseRsiOrganization(PAGE, 'aimos');
    assert.strictEqual(org.symbol, 'AIMOS');
    assert.strictEqual(org.name, 'A.I.M.O.S');
    assert.strictEqual(org.url, 'https://robertsspaceindustries.com/orgs/AIMOS');
    assert.strictEqual(org.logoUrl, 'https://robertsspaceindustries.com/media/l/logo/X-Logo.png');
    assert.strictEqual(org.bannerUrl, 'https://robertsspaceindustries.com/media/b/banner/X-Banner.png');
    assert.strictEqual(org.members, 1146);
    assert.deepStrictEqual([org.model, org.commitment, org.roleplay], ['Syndicate', 'Hardcore', 'Role play']);
    assert.deepStrictEqual(org.focus, { primary: 'Resources', secondary: 'Security' });
    assert.strictEqual(org.recruiting, true);
    assert.deepStrictEqual(org.intro, ['Armored & Mercenary alert(1)', 'Comms…']);
    assert.deepStrictEqual(org.links, [{ label: 'Comms', href: 'http://discord.gg/aimos' }]);
    assert.deepStrictEqual(org.history, [], 'RSI placeholder dropped');
    assert.deepStrictEqual(org.manifesto, ['Fuck it we ball!']);
    assert.deepStrictEqual(org.charter, ['Rise up.', 'Stay up.']);
  });

  it('renders escaped org pages with RSI and apply links', function () {
    const org = Object.assign(parseRsiOrganization(PAGE, 'AIMOS'), { displayName: 'A.I.M.O.S. <b>' });
    const props = { basePath: '/organizations', alliancePath: '/operations/PERMAFLEET', allianceName: 'PERMAFLEET', loginPath: '/sessions', loginLabel: 'Login', copyright: '' };
    const page = Organizations.renderOrganization(org, props);
    assert.ok(page.includes('id="org-AIMOS"'));
    assert.ok(page.includes('A.I.M.O.S. &lt;b&gt;'));
    assert.ok(!page.includes('<script>'));
    assert.ok(page.includes('href="https://robertsspaceindustries.com/orgs/AIMOS" target="_blank" rel="noopener" title="Opens the RSI org page; choose “Join us now!” there">Apply on RSI</a>'));
    assert.ok(page.includes('href="https://robertsspaceindustries.com/orgs/AIMOS/members"'));
    assert.ok(page.includes('<summary>Manifesto</summary>'));
    assert.ok(!page.includes('<summary>History</summary>'));
    const index = Organizations.render(Object.assign({ heading: 'ORGS', intro: '', organizations: [org] }, props));
    assert.ok(index.includes('<a class="goon-button" href="/organizations/AIMOS">Profile</a>'));
    assert.ok(index.includes('>Apply</a>'));
  });
});
