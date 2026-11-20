'use strict';

const assert = require('assert');
const { membersInVoiceFromWidgets } = require('../functions/permafleetVoiceListing');

describe('PERMAFLEET public voice listing', function () {
  it('keeps each guild widget’s voice list, and drops a repeated id inside one widget', function () {
    const members = membersInVoiceFromWidgets([
      {
        members: [
          { id: '1', username: 'Ace', avatar_url: 'a', channel_id: 'voice-a' },
          { id: '1', username: 'Ace again', avatar_url: 'a2', channel_id: 'voice-a' },
          { id: '2', username: 'Idle', avatar_url: 'b' }
        ]
      },
      {
        members: [
          { id: '1', username: 'Ace', avatar_url: 'a-other', channel_id: 'voice-b' },
          { id: '3', username: 'Bomber', avatar_url: 'c', channel_id: 'hangar' }
        ]
      },
      null
    ]);
    assert.deepStrictEqual(members, [
      { username: 'Ace', avatar_url: 'a' },
      { username: 'Ace', avatar_url: 'a-other' },
      { username: 'Bomber', avatar_url: 'c' }
    ]);
    assert.ok(!JSON.stringify(members).includes('"id"'));
  });

  it('ignores widgets with nobody in voice', function () {
    assert.deepStrictEqual(membersInVoiceFromWidgets([{ members: [{ username: 'Idle' }] }]), []);
  });
});
