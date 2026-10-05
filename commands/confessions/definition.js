module.exports = [
    {
        name: 'confess',
        description: 'Post an anonymous confession to the confessions channel',
        options: [
            {
                name: 'message',
                description: 'Your confession (posted anonymously)',
                type: 3, // STRING
                required: true,
                max_length: 1800,
            },
        ],
    },
    {
        name: 'confession',
        description: 'Staff: manage who can use /confess',
        options: [
            {
                name: 'disallow',
                description: 'Stop a user from using /confess',
                type: 1,
                options: [
                    { name: 'user', description: 'The user to disallow', type: 6, required: true },
                    { name: 'reason', description: 'Why (staff-only)', type: 3, required: false, max_length: 300 },
                ],
            },
            {
                name: 'allow',
                description: 'Let a disallowed user use /confess again',
                type: 1,
                options: [{ name: 'user', description: 'The user to allow', type: 6, required: true }],
            },
            { name: 'list', description: 'List users who are disallowed from /confess', type: 1 },
        ],
    },
];
