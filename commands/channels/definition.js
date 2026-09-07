module.exports = [
    {
        name: 'channel',
        description: 'Manage temporary voice/text channels',
        options: [
            {
                name: 'add-voice',
                description: 'Create a temp voice channel + matching text channel',
                type: 1,
                options: [
                    { name: 'name', description: 'Name for the channel(s)', type: 3, required: true },
                    { name: 'members', description: "Who's allowed in (@mentions or IDs, space separated)", type: 3, required: false },
                ],
            },
            {
                name: 'delete',
                description: 'Delete a temp channel you own (and its paired channel, if any)',
                type: 1,
                options: [
                    { name: 'channel', description: 'Channel to delete (defaults to the current channel)', type: 7, required: false },
                ],
            },
            {
                name: 'member-add',
                description: 'Add a member to your temp channel',
                type: 1,
                options: [
                    { name: 'target', description: 'User to add', type: 6, required: true },
                    { name: 'channel', description: 'Channel to modify (defaults to the current channel)', type: 7, required: false },
                ],
            },
            {
                name: 'member-delete',
                description: 'Remove a member from your temp channel',
                type: 1,
                options: [
                    { name: 'target', description: 'User to remove', type: 6, required: true },
                    { name: 'channel', description: 'Channel to modify (defaults to the current channel)', type: 7, required: false },
                ],
            },
        ],
    },
];
