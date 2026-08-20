const handler = require('./handler');

module.exports = require('./definition');
module.exports.handlers = { music: handler.music };
// Needed directly by index.js: setupPlayDL() runs once at startup, and the
// queue Map is inspected elsewhere (e.g. voice state bookkeeping).
module.exports.setupPlayDL = handler.setupPlayDL;
module.exports.queue = handler.queue;
