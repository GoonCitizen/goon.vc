'use strict';

const assert = require('assert');
const post = require('../functions/marketPost');

const TAGS = [
  { id: '1', name: 'Ship' },
  { id: '2', name: 'CCU' },
  { id: '3', name: 'Paint' },
  { id: '10', name: 'Available' },
  { id: '11', name: 'Dibs' },
  { id: '12', name: 'Reserved' },
  { id: '13', name: '✅ Sold' },
  { id: '20', name: 'LTI' }
];

describe('market posts', function () {
  describe('prices', function () {
    it('reads BTC, sats, and k / m suffixes as written', function () {
      assert.strictEqual(post.parsePrice('0.005 BTC').sats, 500000);
      assert.strictEqual(post.parsePrice('₿0.005').sats, 500000);
      assert.strictEqual(post.parsePrice('btc 0.0125').sats, 1250000);
      assert.strictEqual(post.parsePrice('500k sats').sats, 500000);
      assert.strictEqual(post.parsePrice('500,000 sats').sats, 500000);
      assert.strictEqual(post.parsePrice('1.2m sats').sats, 1200000);
      assert.strictEqual(post.parsePrice('750000').sats, 750000);
      assert.strictEqual(post.parsePrice('a lot'), null);
    });

    it('converts dollars at the reference rate, and says when it cannot', function () {
      const usd = post.parsePrice('$40', { usdPerBtc: 80000 });
      assert.deepStrictEqual(usd, { sats: 50000, unit: 'usd', amount: 40, converted: true });
      assert.strictEqual(post.parsePrice('40 USD', { usdPerBtc: 80000 }).sats, 50000);
      assert.strictEqual(post.parsePrice('$40').sats, null);
    });

    it('finds the first price in a sentence, preferring BTC', function () {
      assert.strictEqual(post.parsePrice('selling for $40 or 0.0005 BTC obo', { loose: true, usdPerBtc: 80000 }).sats, 50000);
      assert.strictEqual(post.parsePrice('asking 250k sats, no lowballs', { loose: true }).sats, 250000);
      assert.strictEqual(post.parsePrice('$40 kinda firm', { loose: true, usdPerBtc: 80000 }).sats, 50000);
    });

    it('formats BTC with sats and a USD hint', function () {
      assert.strictEqual(post.formatBtc(500000), '0.005 BTC');
      assert.strictEqual(post.formatSats(500000), '500,000 sats');
      assert.strictEqual(post.formatPrice(500000, 80000), '0.005 BTC (500,000 sats, ≈ $400)');
      assert.strictEqual(post.formatPrice(null), 'Make an offer');
    });
  });

  describe('fields', function () {
    it('normalizes kind, insurance, source, and status names', function () {
      assert.strictEqual(post.normalizeKind('ships'), 'Ship');
      assert.strictEqual(post.normalizeKind('upgrade'), 'CCU');
      assert.strictEqual(post.normalizeInsurance('lifetime'), 'LTI');
      assert.strictEqual(post.normalizeInsurance('6 months'), '6 mo');
      assert.strictEqual(post.normalizeInsurance('10 years'), '120 mo');
      assert.strictEqual(post.normalizeInsurance('soon'), null);
      assert.strictEqual(post.normalizeSource('buy-back'), 'Buyback');
      assert.strictEqual(post.normalizeStatus('reserved-paid'), 'paid');
    });

    it('checks a patch and refuses bad values with a reason', function () {
      const { fields, conversion } = post.normalizeFields({ title: '  Cutlass Black  ', price: '$40', qty: '2', insurance: 'LTI', giftable: 'yes' }, { usdPerBtc: 80000, create: true });
      assert.deepStrictEqual(fields, { title: 'Cutlass Black', qty: 2, insurance: 'LTI', priceSats: 50000, giftable: true });
      assert.deepStrictEqual(conversion, { usd: 40, sats: 50000, usdPerBtc: 80000 });
      assert.throws(() => post.normalizeFields({}, { create: true }), /title/);
      assert.throws(() => post.normalizeFields({ qty: 0 }), (e) => e.status === 400);
      assert.throws(() => post.normalizeFields({ imageUrl: 'http://example.com/a.png' }), /https/);
      assert.throws(() => post.normalizeFields({ price: '$40' }), (e) => e.status === 503);
    });
  });

  describe('forum posts', function () {
    const listing = {
      id: 'abc123',
      title: 'Cutlass Black',
      kind: 'Ship',
      contents: 'Cutlass Black, 2 paints',
      qty: 1,
      insurance: 'LTI',
      msrpUsd: 110,
      priceSats: 120000,
      source: 'Buyback',
      giftable: true,
      notes: 'Melted in 2950, still giftable.',
      imageUrl: 'https://media.robertsspaceindustries.com/cutlass.jpg',
      status: 'available'
    };

    it('renders a starter message with the fields and both buttons', function () {
      const message = post.renderPost(listing, { url: 'https://goon.vc/services/market/listings/abc123', usdPerBtc: 80000 });
      assert.match(message.content, /^\*\*Cutlass Black\*\* — 0\.0012 BTC/);
      const names = message.embeds[0].fields.map((f) => f.name);
      assert.deepStrictEqual(names, ['Price', 'Kind', 'Status', 'Qty', 'Insurance', 'MSRP', 'Source', 'Giftable', 'Contents']);
      const [view, buy] = message.components[0].components;
      assert.strictEqual(view.url, 'https://goon.vc/services/market/listings/abc123');
      assert.strictEqual(buy.custom_id, 'market:buy:abc123');
      assert.strictEqual(buy.disabled, false);
      assert.deepStrictEqual(message.allowed_mentions, { parse: [] });
      assert.strictEqual(post.renderPost(Object.assign({}, listing, { status: 'sold' })).components[0].components[0].disabled, true);
      assert.match(post.renderPost(listing, { sellerName: 'Ace' }).content, /Listed by Ace via goon\.vc/);
    });

    it('reads back exactly what it rendered', function () {
      const message = post.renderPost(listing, { usdPerBtc: 80000 });
      const { fields } = post.parsePost({ title: listing.title, content: message.content, embeds: message.embeds });
      for (const name of ['title', 'kind', 'contents', 'qty', 'insurance', 'msrpUsd', 'priceSats', 'source', 'giftable', 'notes', 'imageUrl', 'status']) {
        assert.deepStrictEqual(fields[name], listing[name], name);
      }
    });

    it('reads labelled lines in a hand-written post', function () {
      const { fields, priced } = post.parsePost({
        title: 'WTS Carrack Expedition',
        content: '**Price:** 0.02 BTC\nInsurance: 120 months\nQty: 1\nSource: hangar\nGiftable: no\nComes with the Pisces.',
        attachments: [{ url: 'https://cdn.discordapp.com/a/carrack.png', content_type: 'image/png' }],
        tags: ['Ship', 'Available']
      });
      assert.strictEqual(priced, true);
      assert.strictEqual(fields.priceSats, 2000000);
      assert.strictEqual(fields.insurance, '120 mo');
      assert.strictEqual(fields.qty, 1);
      assert.strictEqual(fields.source, 'Hangar');
      assert.strictEqual(fields.giftable, false);
      assert.strictEqual(fields.kind, 'Ship');
      assert.strictEqual(fields.status, 'available');
      assert.strictEqual(fields.notes, 'Comes with the Pisces.');
      assert.strictEqual(fields.imageUrl, 'https://cdn.discordapp.com/a/carrack.png');
    });

    it('picks up loose mentions, and leaves an unpriced post as an offer', function () {
      const loose = post.parsePost({ title: 'Arrow x2', content: 'buyback, 6 months insurance on one. 150k sats each', tags: ['LTI'] });
      assert.strictEqual(loose.fields.priceSats, 150000);
      assert.strictEqual(loose.fields.insurance, '6 mo');
      assert.strictEqual(loose.fields.qty, 2);
      assert.strictEqual(loose.fields.source, 'Buyback');
      assert.deepStrictEqual(loose.tags, ['LTI']);
      const dollars = post.parsePost({ title: 'Herald paint', content: 'Asking $12' }, { usdPerBtc: 60000 });
      assert.strictEqual(dollars.fields.priceSats, 20000);
      assert.strictEqual(dollars.fields.kind, 'Paint');
      const offer = post.parsePost({ title: 'Idris-P', content: 'DM me offers' });
      assert.strictEqual(offer.priced, false);
      assert.strictEqual(offer.fields.priceSats, undefined);
    });
  });

  describe('tags', function () {
    it('maps forum tags to kind and status by name, ignoring case and emoji', function () {
      assert.deepStrictEqual(post.mapTag('ships'), { kind: 'Ship' });
      assert.deepStrictEqual(post.mapTag('✅ Sold'), { status: 'sold' });
      assert.strictEqual(post.mapTag('LTI'), null);
      const aliases = post.tagAliases({ Ship: ['WTS Ship'] });
      assert.deepStrictEqual(post.mapTag('WTS ship', aliases), { kind: 'Ship' });
    });

    it('applies the kind and status tags and keeps the others', function () {
      assert.deepStrictEqual(post.appliedTags({ kind: 'Ship', status: 'available', tags: ['LTI'] }, TAGS), ['1', '10', '20']);
      assert.deepStrictEqual(post.appliedTags({ kind: 'CCU', status: 'paid' }, TAGS), ['2', '12']);
      assert.deepStrictEqual(post.appliedTags({ kind: 'Other', status: 'sold' }, TAGS), ['13']);
      assert.deepStrictEqual(post.appliedTags({ kind: 'Ship', status: 'hidden' }, TAGS), ['1']);
    });
  });

  it('describes changes for a hand-written post it cannot edit', function () {
    assert.strictEqual(post.updateText({ priceSats: 500000, status: 'sold' }, { usdPerBtc: 80000 }), 'Updated on goon.vc: price 0.005 BTC (500,000 sats, ≈ $400), status Sold');
    assert.strictEqual(post.updateText({}), '');
  });
});
