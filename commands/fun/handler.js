function buildRandomLetterEmbed(createEmbed) {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let result = '';

    for (let i = 0; i < 3; i++) {
        result += letters[Math.floor(Math.random() * letters.length)];
    }

    return createEmbed({
        title: '🛰️ Incoming Transmission',
        description: `The universe sent a 3-letter signal: **${result}**`,
        footer: "OsQarek's Universe • Signal Received",
        timestamp: false,
    });
}

async function handleFunCommand({ interaction, createEmbed }) {
    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
        case 'joke':
        case 'dadjoke': {
            const response = await fetch('https://icanhazdadjoke.com/', {
                headers: { Accept: 'application/json' },
            });
            const data = await response.json();
            return interaction.editReply(data.joke);
        }

        case 'fact': {
            const response = await fetch('https://uselessfacts.jsph.pl/random.json?language=en');
            const data = await response.json();
            return interaction.editReply(data.text);
        }

        case 'cat': {
            const response = await fetch('https://api.thecatapi.com/v1/images/search');
            const data = await response.json();
            return interaction.editReply(data[0].url);
        }

        case 'dog': {
            const response = await fetch('https://dog.ceo/api/breeds/image/random');
            const data = await response.json();
            return interaction.editReply(data.message);
        }

        case 'coinflip': {
            const result = Math.random() < 0.5 ? 'Heads' : 'Tails';
            return interaction.editReply(`🪙 The coin landed on: **${result}**!`);
        }

        case 'diceroll':
            return handleDiceRoll({ interaction });

        case 'randomletter':
            return handleRandomLetter({ interaction, createEmbed });

        case 'random-user': {
            const members = interaction.guild.members.cache.filter((member) => !member.user.bot);
            const randomMember = members.random();

            if (!randomMember) {
                return interaction.editReply("❌ I couldn't find a random member.");
            }

            return interaction.editReply(`🎯 The universe picked ${randomMember}.`);
        }

        default:
            return interaction.editReply('❌ Unknown fun command.');
    }
}

async function handleDiceRoll({ interaction }) {
    const roll = Math.floor(Math.random() * 6) + 1;
    return interaction.editReply(`🎲 The universe rolled a **${roll}**!`);
}

async function handleRandomLetter({ interaction, createEmbed }) {
    const signalEmbed = buildRandomLetterEmbed(createEmbed);
    return interaction.editReply({ embeds: [signalEmbed] });
}

module.exports = {
    fun: handleFunCommand,
    diceroll: handleDiceRoll,
    randomletter: handleRandomLetter,
};
