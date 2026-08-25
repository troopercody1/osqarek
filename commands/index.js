const system = require('./system');
const configuration = require('./configuration');
const music = require('./music');
const fun = require('./fun');
const moderation = require('./moderation');
const staff = require('./staff');
const quiz = require('./quiz');
const utilities = require('./utilities');

const commandGroups = {
    system,
    configuration,
    music,
    fun,
    moderation,
    staff,
    quiz,
    utilities,
};

const commands = Object.values(commandGroups).flat();
const commandNames = new Set(commands.map((command) => command.name));

module.exports = {
    commandGroups,
    commands,
    commandNames,
};
