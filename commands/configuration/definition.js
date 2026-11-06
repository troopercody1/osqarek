module.exports = [
    { name: 'addmod', description: 'Add a role to the moderator list', options: [{ name: 'role', description: 'The role to add', type: 8, required: true }] },
    { name: 'deletemod', description: 'Remove a role from the moderator list', options: [{ name: 'role', description: 'The role to remove', type: 8, required: true }] },
    { name: 'modlog', description: 'Set the moderation log channel', options: [{ name: 'channel', description: 'The channel', type: 7, required: true }] },
    { name: 'setchatlog', description: 'Set the chat log channel', options: [{ name: 'channel', description: 'The channel', type: 7, required: true }] },
    { name: 'ignorechannel', description: 'Toggle ignoring a channel for logs', options: [{ name: 'channel', description: 'The channel', type: 7, required: true }] },
    { name: 'setloachannel', description: 'Set the LOA request channel', options: [{ name: 'channel', description: 'The channel', type: 7, required: true }] },
    { name: 'aitoggle', description: 'Toggle AI chat', options: [{ name: 'status', description: 'ON/OFF', type: 5, required: true }] },
];
