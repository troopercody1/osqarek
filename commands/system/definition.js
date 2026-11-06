module.exports = [
    { name: 'help', description: 'List all available moderator commands' },
    { name: 'ping', description: "Check the bot's latency" },
    { name: 'restart', description: 'Refreshes the bot session (Admin Only)' },
    {
        name: 'reloaddb',
        description: 'Reload the database without restarting the bot (Head Admin+)',
        options: [{
            name: 'source',
            description: 'Where to load from (default: Redis if configured, else local file)',
            type: 3,
            required: false,
            choices: [
                { name: 'Auto', value: 'auto' },
                { name: 'Redis (Upstash)', value: 'redis' },
                { name: 'Local database.json', value: 'file' },
            ],
        }],
    },
    {
        name: 'status',
        description: 'Set bot status',
        options: [{
            name: 'preset',
            description: 'The status to set',
            type: 3,
            required: true,
            choices: [
                { name: 'Universe', value: 'universe' },
                { name: 'Update', value: 'update' },
                { name: 'Help', value: 'help' },
                { name: 'Expand', value: 'expand' },
            ],
        }],
    },
    { name: 'latest-update', description: 'Patch notes' },
];
