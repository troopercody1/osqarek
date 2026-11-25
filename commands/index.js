const system = require('./system');
const configuration = require('./configuration');
const music = require('./music');
const fun = require('./fun');
const moderation = require('./moderation');
const staff = require('./staff');
const quiz = require('./quiz');
const utilities = require('./utilities');
const channels = require('./channels');
const confessions = require('./confessions');
const features = require('./features');

const commandGroups = {
    system,
    configuration,
    music,
    fun,
    moderation,
    staff,
    quiz,
    utilities,
    channels,
    confessions,
    features,
};

const commands = Object.values(commandGroups).flat();
const commandNames = new Set(commands.map((command) => command.name));

module.exports = {
    commandGroups,
    commands,
    commandNames,
};
