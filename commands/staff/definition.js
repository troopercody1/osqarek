module.exports = [
    { name: 'staffdm', description: 'Send a DM to all staff members', options: [{ name: 'message', description: 'The message to send', type: 3, required: true }] },
    { name: 'apply', description: 'Link to apply for staff' },
    {
        name: 'notes',
        description: "OsQarek's Universe Staff Notes",
        options: [
            { name: 'view', description: 'View notes for a user', type: 1, options: [{ name: 'target', description: 'The user', type: 6, required: true }] },
            { name: 'add', description: 'Add a note to a user', type: 1, options: [{ name: 'target', description: 'The user', type: 6, required: true }, { name: 'note', description: 'The text', type: 3, required: true }] },
            { name: 'delete', description: 'Delete a note from a user', type: 1, options: [{ name: 'target', description: 'The user', type: 6, required: true }, { name: 'index', description: 'Note number', type: 4, required: true }] },
        ],
    },
    {
        name: 'loa',
        description: "OsQarek's Universe LOA Suite",
        options: [
            { name: 'request', description: 'Request a leave of absence', type: 1, options: [{ name: 'reason', description: 'Reason', type: 3, required: true }, { name: 'duration', description: 'Until [YYYY-MM-DD HH:mm]', type: 3, required: true }, { name: 'start', description: 'Preset a future start [YYYY-MM-DD HH:mm] - leave blank to start now', type: 3, required: false }] },
            { name: 'list', description: 'View staff currently on LOA', type: 1 },
            { name: 'end', description: 'End a leave of absence', type: 1, options: [{ name: 'staff', description: 'The user', type: 6, required: false }] },
            { name: 'adminset', description: 'Forcefully set an LOA for a staff member', type: 1, options: [{ name: 'user', description: 'The staff member', type: 6, required: true }, { name: 'duration', description: 'Until [YYYY-MM-DD HH:mm]', type: 3, required: true }, { name: 'start', description: 'Preset a future start [YYYY-MM-DD HH:mm] - leave blank to start now', type: 3, required: false }, { name: 'reason', description: 'Reason for the LOA', type: 3, required: false }] },
        ],
    },
    {
        name: 'staffstats',
        description: "OsQarek's Universe Staff Stats Suite",
        options: [
            { name: 'view', description: 'View stats for a staff member', type: 1, options: [{ name: 'staff', description: 'User', type: 6, required: false }] },
            { name: 'all', description: 'View progress for all staff', type: 1 },
            { name: 'leaderboard', description: 'View the weekly and all-time leadership stats', type: 1 },
        ],
    },
    { name: 'ping-all-staff', description: 'Ping all staff members and send them a DM', options: [{ name: 'reason', description: 'The reason for summoning staff', type: 3, required: true }] },
    { name: 'messagereset', description: 'Wipe message counts' },
    { name: 'syncstats', description: 'Fetch stats', options: [{ name: 'audit', description: 'Kick new?', type: 5 }, { name: 'dryrun', description: 'Test?', type: 5 }, { name: 'debug', description: 'Show age?', type: 5 }] },
    { name: 'strike', description: 'Manage strikes', options: [{ name: 'add', description: 'Add strike', type: 1, options: [{ name: 'target', description: 'User', type: 6, required: true }, { name: 'reason', description: 'Reason', type: 3, required: true }] }, { name: 'remove', description: 'Remove strike', type: 1, options: [{ name: 'target', description: 'User', type: 6, required: true }, { name: 'reason', description: 'Reason', type: 3, required: true }] }] },
    { name: 'strikes', description: 'Check strike count', options: [{ name: 'target', description: 'User', type: 6, required: true }] },
];
