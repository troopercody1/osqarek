require('dotenv').config();
const { REST, Routes } = require('discord.js');
const { commands } = require('./commands');

const appId = process.env.CLIENT_ID || '1268166506949120094';
const guildId = process.env.GUILD_ID || '771423231114084353';

async function deployCommands() {
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

    console.log(`📡 DEPLOYING ${commands.length} COMMANDS TO GUILD: ${guildId}...`);

    const data = await rest.put(
        Routes.applicationGuildCommands(appId, guildId),
        { body: commands }
    );

    console.log(`✨ SUCCESS: Registered ${data.length} commands!`);
    return data;
}

if (require.main === module) {
    deployCommands().catch((err) => {
        console.error('❌ DEPLOYMENT ERROR:');
        if (err.rawError?.errors) {
            console.dir(err.rawError.errors, { depth: null });
        } else {
            console.error(err);
        }
        process.exit(1);
    });
}

module.exports = { commands, deployCommands };
