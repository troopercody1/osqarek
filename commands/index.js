// Single wiring point for every slash command.
//   commands/<group>/definition.js -> array of slash-command definitions
//   commands/<group>/handler.js    -> { commandName: async (ctx) => ... }
//
// deploy-commands.js uses `commands`; index.js uses `commandNames` and `handlers`.
// (The old per-folder index.js files and commands/handlers.js were merged in here to keep the repo small.)
const GROUPS = ['system', 'configuration', 'music', 'fun', 'moderation', 'staff', 'quiz', 'utilities', 'channels', 'confessions', 'features'];

const commandGroups = {};
const handlers = {};

for (const name of GROUPS) {
    commandGroups[name] = require(`./${name}/definition`);
    // The music folder exposes a single `music` handler; every other handler file already is a { command: fn } map.
    const h = require(`./${name}/handler`);
    Object.assign(handlers, name === 'music' ? { music: h.music } : h);
}

const commands = Object.values(commandGroups).flat();
const commandNames = new Set(commands.map((command) => command.name));

module.exports = { commandGroups, commands, commandNames, handlers };
