const system = require('./system');
const configuration = require('./configuration');
const music = require('./music');
const fun = require('./fun');
const moderation = require('./moderation');
const staff = require('./staff');
const quiz = require('./quiz');
const utilities = require('./utilities');

module.exports = {
    ...system.handlers,
    ...configuration.handlers,
    ...music.handlers,
    ...fun.handlers,
    ...moderation.handlers,
    ...staff.handlers,
    ...quiz.handlers,
    ...utilities.handlers,
};
