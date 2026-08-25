const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');

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

// --- Migrated from index.js legacy command chain ---

async function nukeServer({ interaction }) {
    // Admin permission check
    const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);
    if (!isAdmin) {
        console.log(`DEBUG: Role check failed for /${interaction.commandName}`);
        return interaction.editReply({ content: "❌ Permission Denied. Only the Chairman can initiate a wipe.", ephemeral: true });
    }
    console.log(`DEBUG: Role check passed for /${interaction.commandName}`);

    await interaction.editReply("🧨 **Initializing Server Wipe...** `[0%]`");

    const steps = [18, 42, 71, 89, 99];

    for (const percent of steps) {
        await new Promise(r => setTimeout(r, 1200));
        await interaction.editReply(`🧨 **Deleting Channels... [${percent}%]**\n\`Current Target: #${interaction.channel.name}\``);
    }

    await new Promise(r => setTimeout(r, 2000));
    return interaction.editReply("🤡 **APRIL FOOLS!** No channels were harmed. Your server is safe...for now..");
}

async function keyboardFix({ interaction }) {
    await interaction.editReply("🛠️ **Scanning keyboard drivers...** `[24%]`");

    setTimeout(async () => {
        try {
            await interaction.editReply({
                content: "⚠️ **CRITICAL ERROR:** Your device has detected a keyboard malfunction. PLeasE rEStArt yOUr sYStEm tO FIx tHE tYpInG iSSuE. 🤡 **APRIL FOOLS!** Your keyboard is fine.",
                ephemeral: true
            });
        } catch (err) {
            console.error("Keyboard fix prank failed:", err);
        }
    }, 2500);
}

async function banPrank({ interaction }) {
    const target = interaction.options.getMember('target');
    if (!target) return interaction.editReply("❌ User not found in the Universe.");

    const fakeBanEmbed = new EmbedBuilder()
        .setTitle('🔨 User Permanently Banned')
        .setDescription(`User **${target.user.tag}** (ID: ${target.id}) has been removed from OsQarek’s Universe.`)
        .addFields(
            { name: 'Reason', value: '`Breaking Rule #1: Excessive awesomeness.`' },
            { name: 'Moderator', value: `${interaction.user.tag}` }
        )
        .setColor(0xFF0000)
        .setThumbnail(target.user.displayAvatarURL())
        .setTimestamp();

    await interaction.editReply({ embeds: [fakeBanEmbed] });

    setTimeout(async () => {
        try {
            await interaction.followUp({
                content: `🤡 **APRIL FOOLS!** Gotcha, ${target}! You aren't actually banned.`,
                ephemeral: false
            });
        } catch (err) {
            console.error("Failed to send prank reveal:", err);
        }
    }, 5000);
}

async function resetLevels({ interaction }) {
    const target = interaction.options.getMember('target') || interaction.member;

    await interaction.editReply(`🗄️ **Database Syncing...** \`Connecting to <@437808476106784770>\\OsQarek's Universe...\``);

    await new Promise(r => setTimeout(r, 2000));

    const errorEmbed = new EmbedBuilder()
        .setTitle('⚠️ Critical Database Error')
        .setDescription(`Data corruption detected for user **${target.user.tag}**.`)
        .addFields({ name: 'Action', value: '`Resetting XP and Level to 0...`' })
        .setColor(0xFF0000)
        .setFooter({ text: 'Error Code: 0x5950X_FOOL' });

    await interaction.editReply({ embeds: [errorEmbed] });

    setTimeout(() => {
        interaction.followUp({ content: `🤡 **APRIL FOOLS!** Your levels are safe, ${target}. I wouldn't touch your XP!`, ephemeral: false });
    }, 6000);
}

async function nerdMode({ interaction, db }) {
    const target = interaction.options.getMember('target');

    if (!target) return interaction.editReply({ content: "❌ Target user not found in the Universe.", ephemeral: true });

    if (!db.nerds) db.nerds = [];

    if (db.nerds.includes(target.id)) {
        db.nerds = db.nerds.filter(id => id !== target.id);
        await interaction.editReply({ content: `✅ **Actually...** Nerd Mode is now DISABLED for ${target.user.tag}.`, ephemeral: true });
    } else {
        db.nerds.push(target.id);
        await interaction.editReply({ content: `🤓 **Actually...** Nerd Mode is now ENABLED for ${target.user.tag}.`, ephemeral: true });
    }

    await db.save();
}

module.exports = {
    fun: handleFunCommand,
    diceroll: handleDiceRoll,
    randomletter: handleRandomLetter,
    'nuke-server': nukeServer,
    'keyboard-fix': keyboardFix,
    'ban-prank': banPrank,
    'reset-levels': resetLevels,
    'nerd-mode': nerdMode,
};
