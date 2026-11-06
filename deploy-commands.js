require('dotenv').config();
const { REST, Routes } = require('discord.js');
const { commands } = require('./commands');

const appId = process.env.CLIENT_ID || '1268166506949120094';
const guildId = process.env.GUILD_ID || '771423231114084353';

async function deployCommands({ timeoutMs = 20_000 } = {}) {
    // A short REST timeout so a blackholed/slow connection to Discord can
    // never hang this step forever (that used to block the whole process,
    // including the web server, if command deployment never resolved).
    const rest = new REST({ version: '10', timeout: timeoutMs }).setToken(process.env.TOKEN);

    console.log(`📡 DEPLOYING ${commands.length} COMMANDS TO GUILD: ${guildId}...`);

    // Belt-and-suspenders: race against a manual timeout too, in case the
    // REST client's own timeout option doesn't cover some edge case (e.g.
    // DNS resolution hanging before the request timer even starts).
    const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`deployCommands timed out after ${timeoutMs}ms`)), timeoutMs + 5_000)
    );

    const data = await Promise.race([
        rest.put(Routes.applicationGuildCommands(appId, guildId), { body: commands }),
        timeout
    ]);

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
