'use strict';

/**
 * Public PERMAFLEET voice roster from Discord guild widgets. Anyone with
 * `channel_id` is in a voice channel the widget can see. A widget id is
 * anonymous and only unique inside that widget, so the same id in two
 * guilds is kept twice. Ids are never returned.
 */

function membersInVoiceFromWidgets (widgets) {
  var members = [];
  var list = Array.isArray(widgets) ? widgets : [];
  for (var i = 0; i < list.length; i++) {
    var data = list[i];
    if (!data || !Array.isArray(data.members)) continue;
    var seen = {};
    for (var j = 0; j < data.members.length; j++) {
      var member = data.members[j];
      if (!member || member.channel_id == null) continue;
      var key = member.id != null && String(member.id) !== ''
        ? 'id:' + String(member.id)
        : 'name:' + String(member.username || '') + ':' + j;
      if (seen[key]) continue;
      seen[key] = 1;
      members.push({
        username: member.username || 'Member',
        avatar_url: member.avatar_url || ''
      });
    }
  }
  return members;
}

module.exports = { membersInVoiceFromWidgets };
