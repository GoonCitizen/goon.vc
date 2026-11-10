'use strict';

/**
 * Public PERMAFLEET voice roster from Discord guild widgets. Anyone with
 * `channel_id` is in a voice channel the widget can see. Discord ids are
 * used only to de-dupe a person in more than one member Discord and are
 * never returned.
 */

function membersInVoiceFromWidgets (widgets) {
  var seen = {};
  var members = [];
  var list = Array.isArray(widgets) ? widgets : [];
  for (var i = 0; i < list.length; i++) {
    var data = list[i];
    if (!data || !Array.isArray(data.members)) continue;
    for (var j = 0; j < data.members.length; j++) {
      var member = data.members[j];
      if (!member || member.channel_id == null) continue;
      var key = member.id != null && String(member.id) !== ''
        ? 'id:' + String(member.id)
        : 'name:' + String(member.username || '');
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
