module.exports = [
    {
        name: 'fun',
        description: 'Fun and utility commands for the community',
        options: [
            { name: 'joke', description: 'Get a random joke', type: 1 },
            { name: 'dadjoke', description: 'Get a random dad joke', type: 1 },
            { name: 'coinflip', description: 'Flip a coin (Heads or Tails)', type: 1 },
            { name: 'cat', description: 'Get a random cat image', type: 1 },
            { name: 'dog', description: 'Get a random dog image', type: 1 },
            { name: 'fact', description: 'Get a random interesting fact', type: 1 },
            { name: 'random-user', description: 'Ping a random person in the server', type: 1 },
            { name: 'randomletter', description: 'Get 3 random letters out of the alphabet', type: 1 },
        ],
    },
    { name: 'ship', description: 'Matchmake users', options: [{ name: 'user1', description: 'User 1', type: 6 }, { name: 'user2', description: 'User 2', type: 6 }] },
    { name: 'diceroll', description: 'Roll a die' },
    { name: 'randomletter', description: 'Get a letter' },
];
