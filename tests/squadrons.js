'use strict';

const assert = require('assert');
const SquadronApplication = require('../components/SquadronApplication');

describe('SquadronApplication', function () {
  const form = {
    action: 'https://docs.google.com/forms/d/e/abc_DEF-123/formResponse',
    viewUrl: 'https://forms.gle/example',
    fields: [
      { name: 'entry.1', label: 'IGN <b>', type: 'short', required: true },
      { name: 'entry.2', label: 'Why?', type: 'paragraph' }
    ]
  };

  it('renders a native form that posts to the Google Form', function () {
    const html = SquadronApplication.render({ id: 'test', form });
    assert.ok(html.includes(`action="${form.action}"`));
    assert.ok(html.includes('method="POST"'));
    assert.ok(html.includes('IGN &lt;b&gt;'), 'labels are escaped');
    assert.ok(/<input[^>]+name="entry\.1"[^>]+required/.test(html));
    assert.ok(/<textarea[^>]+name="entry\.2"(?![^>]*required)/.test(html));
    assert.ok(html.includes('<iframe name="test-sink"'));
  });

  it('refuses to post anywhere but Google Forms', function () {
    assert.strictEqual(SquadronApplication.render({ id: 'x', form: Object.assign({}, form, { action: 'https://evil.example/formResponse' }) }), '');
    assert.strictEqual(SquadronApplication.render({ id: 'x', form: {} }), '');
  });
});
