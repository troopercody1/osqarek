// Holds the objects index.js hands to features.init() so every feature module
// can reach the client, the live db and the bot's helpers without circular
// requires.
const { EventEmitter } = require('events');

let _ctx = null;
// Lightweight internal event bus (e.g. 'raid:start', 'evasion:flag') so features
// such as analytics can listen without importing each other.
const bus = new EventEmitter();

module.exports = {
    set(ctx) { _ctx = ctx; },
    get() {
        if (!_ctx) throw new Error('features: init() has not been called yet');
        return _ctx;
    },
    ready() { return !!_ctx; },
    bus,
};
