module.exports = [
    { name: 'announce', description: 'Send an announcement to a channel', options: [{ name: 'message', description: 'The announcement text', type: 3, required: true }, { name: 'channel', description: 'Target channel (defaults to current)', type: 7, required: false }] },
    { name: 'afk', description: 'Set AFK', options: [{ name: 'reason', description: 'Reason for AFK', type: 3, required: false }] },
    { name: 'ask-rules', description: 'Ask the AI about rules', options: [{ name: 'question', description: 'Question', type: 3, required: true }] },
    { name: 'summarize', description: 'AI summarizes last 50 messages' },
    { name: 'poll', description: 'Create a poll', options: [{ name: 'question', description: 'The question to ask', type: 3, required: true }] },
    { name: 'pfp', description: 'View PFP', options: [{ name: 'target', description: 'User', type: 6 }] },
    { name: 'osqareksocials', description: 'Official links' },
    { name: 'userinfo', description: 'User details', options: [{ name: 'target', description: 'User', type: 6 }] },
    { name: 'emoji-names', description: 'Glitch nicknames or leave blank to restore. Optional: Moderate unpingable names.', options: [{ name: 'prefix', description: 'Emoji for the front', type: 3, required: false }, { name: 'suffix', description: 'Emoji for the back', type: 3, required: false }] },
    { name: 'serverinfo', description: 'Server details' },
    { name: 'reminder', description: 'Set reminder', options: [{ name: 'time', description: 'When', type: 3, required: true }, { name: 'task', description: 'What', type: 3, required: true }] },
    { name: 'random', description: 'Pick a random server member' },
];
