module.exports = [
    {
        name: 'quiz',
        description: "OsQarek's Universe Quiz Suite",
        options: [
            { name: 'trivia', description: 'Start a built-in trivia round', type: 1, options: [{ name: 'type', description: 'Trivia category', type: 3, required: true, choices: [{ name: 'States', value: 'states' }, { name: 'Countries', value: 'countries' }, { name: 'Canada', value: 'canada' }] }] },
            { name: 'create', description: 'Create a custom quiz question', type: 1, options: [{ name: 'name', description: 'Quiz name', type: 3, required: true }, { name: 'question', description: 'The question', type: 3, required: true }, { name: 'answer', description: 'The answer', type: 3, required: true }] },
            { name: 'list', description: 'View all custom quizzes', type: 1 },
            { name: 'start', description: 'Start a custom quiz', type: 1, options: [{ name: 'name', description: 'The quiz name', type: 3, required: true }, { name: 'shuffle', description: 'Shuffle questions?', type: 5, required: false }] },
            { name: 'ban', description: 'Ban or unban a user from quizzes', type: 1, options: [{ name: 'target', description: 'User to ban', type: 6, required: true }, { name: 'status', description: 'True to ban', type: 5, required: true }] },
            { name: 'delete', description: 'Delete a custom quiz', type: 1, options: [{ name: 'name', description: 'Quiz name to delete', type: 3, required: true }] },
        ],
    },
    { name: 'stateleaderboard', description: 'View the State/Country trivia leaderboard' },
];
