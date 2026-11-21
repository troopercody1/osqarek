// Seasonal / event messages.
//   ecodrops  - 1-6 random "eco drop" announcements per day (ET). Message only, no currency is given.
//               Each one picks a random amount between 50M and 500M and pings a role.
//   christmas - one Christmas fact per day at 11:00 AM ET until Christmas Day.
// Both are driven by the shared 10s scheduler in features/index.js (tick), survive restarts
// (plan/last-sent live in db.features.seasonal) and are configurable via /feature or the dashboard.
const context = require('./context');
const { getConfig } = require('./config');
const { store } = require('./util');

const TZ = 'America/New_York';

const FACTS = [
    'Santa Claus Village in Rovaniemi, Finland sits right on the Arctic Circle, and you can cross the line painted on the ground.',
    'The first commercial Christmas card was commissioned in London in 1843 by Sir Henry Cole.',
    '"Jingle Bells" was published in 1857 under the title "One Horse Open Sleigh".',
    'Rudolph the Red-Nosed Reindeer was created in 1939 by Robert L. May for the Montgomery Ward department store.',
    'Early tinsel in Germany was made from real silver, until cheaper materials replaced it.',
    'The "X" in "Xmas" is the Greek letter chi, the first letter of "Christos" (Christ).',
    'Poinsettias are native to Mexico. They were brought to the US in 1825 by Joel Roberts Poinsett, the first US ambassador to Mexico.',
    'Christmas did not become a US federal holiday until 1870.',
    'In Japan, eating KFC at Christmas became a tradition after a 1974 marketing campaign.',
    'Iceland has 13 Yule Lads who visit children on the 13 nights before Christmas.',
    'Every year since 1947, Norway has gifted London a giant Christmas tree for Trafalgar Square as thanks for British support in WWII.',
    '"Silent Night" was first performed on Christmas Eve in 1818 in Oberndorf, Austria.',
    'NORAD\'s Santa tracking began in 1955 after a misprinted phone number in a Sears ad sent kids\' calls to a military hotline.',
    'The Christmas tree at Rockefeller Center started in 1931, put up by construction workers on the site.',
    'Venezuelans in Caracas traditionally roller skate to early morning Christmas mass, and some roads are closed to cars for it.',
    'In Ukraine, decorating the tree with artificial spiderwebs is a tradition said to bring good luck.',
    'In Catalonia, children "feed" and beat a log called Caga Tió so it will "poop" out presents.',
    'Every year since 1966, Gävle, Sweden has built a giant straw Yule Goat, which has often been burned down.',
    '"White Christmas" by Bing Crosby is often cited as the best-selling single of all time.',
    'Traditionally everyone in the family stirs the Christmas pudding from east to west, in honour of the journey of the three wise men.',
    'Oliver Cromwell\'s English Parliament banned Christmas celebrations in 1647.',
    'Santa\'s eight reindeer first appeared in the 1823 poem "A Visit from St. Nicholas". Rudolph became the ninth in 1939.',
    'Coca-Cola ads in the 1930s, painted by Haddon Sundblom, helped popularise Santa\'s modern look, but they did not invent it.',
    'Queen Elizabeth I is said to have served gingerbread figures made to look like her guests.',
    'Eggnog is descended from "posset", a hot milky, spiced and boozy drink from medieval Britain.',
    'In Australia Christmas falls in summer, so many people have a BBQ or seafood lunch and head to the beach.',
    'On Christmas Eve 1914, soldiers on the Western Front in WWI paused fighting in the unofficial Christmas Truce.',
    'Charles Dickens\' "A Christmas Carol" was published on December 19, 1843, and the first print run sold out by Christmas Eve.',
    'The earliest known celebration of Christmas on December 25 was in Rome in 336 AD.',
    'Candy canes were originally plain white sticks; the red stripes came later, around the early 20th century.',
    'The Philippines has one of the world\'s longest Christmas seasons, with decorations and carols starting in September (the "ber" months).',
    'The Elf on the Shelf started as a 2005 picture book.',
    'Mistletoe is a semi-parasitic plant that grows on host trees, and kissing under it dates back centuries in England.',
    'The modern Christmas tree tradition comes from Germany, where decorated fir trees were used in the 1500s.',
    'The Christmas pickle is often called a German tradition, but most Germans have never heard of it.',
];

function data() {
    const { db } = context.get();
    return store(db, 'seasonal', { drop: { day: '', times: [], done: [] }, fact: { day: '' } });
}
const touch = () => context.get().saveLater?.();

// Current wall-clock time in New York.
function et(now = Date.now()) {
    const parts = {};
    for (const p of new Intl.DateTimeFormat('en-US', {
        timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(now))) parts[p.type] = p.value;
    const y = +parts.year, mo = +parts.month, d = +parts.day, h = +parts.hour, mi = +parts.minute;
    return { y, mo, d, h, mi, minutes: h * 60 + mi, key: `${y}-${parts.month}-${parts.day}` };
}

function daysUntilChristmas(t) {
    const a = Date.UTC(t.y, t.mo - 1, t.d);
    const b = Date.UTC(t.y, 11, 25);
    return Math.round((b - a) / 86400000);
}

async function getChannel(id) {
    if (!id) return null;
    const { client } = context.get();
    return client.channels.cache.get(id) || (await client.channels.fetch(id).catch(() => null));
}

const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// Random times (minutes since midnight ET), at least `gap` minutes apart.
function planTimes(count, from, to, gap = 20) {
    const times = [];
    for (let tries = 0; times.length < count && tries < 500; tries++) {
        const m = randInt(from, to - 1);
        if (times.every((x) => Math.abs(x - m) >= gap)) times.push(m);
    }
    return times.sort((a, b) => a - b);
}

async function tickDrops(t) {
    const cfg = getConfig(context.get().db, 'ecodrops');
    if (!cfg.enabled || !cfg.channels.length) return;
    const d = data();

    if (d.drop.day !== t.key) {
        const from = Math.min(cfg.startHour, cfg.endHour - 1) * 60;
        const to = Math.max(cfg.endHour, cfg.startHour + 1) * 60;
        const count = randInt(1, cfg.maxPerDay);
        const times = planTimes(count, from, to);
        d.drop = { day: t.key, times, done: times.map(() => false) };
        touch();
    }

    for (let i = 0; i < d.drop.times.length; i++) {
        if (d.drop.done[i] || t.minutes < d.drop.times[i]) continue;
        d.drop.done[i] = true; // mark first so a failure can never spam
        touch();
        // Missed by more than 15 minutes (bot was down) -> skip rather than send late.
        if (t.minutes - d.drop.times[i] > 15) continue;
        await sendDrop(cfg);
        break; // at most one per tick
    }
}

async function sendDrop(cfg) {
    const pool = cfg.channels.filter((x) => /^\d{15,25}$/.test(x));
    const ch = await getChannel(pool[randInt(0, pool.length - 1)]);
    if (!ch?.send) return;
    const min = Math.min(cfg.minAmount, cfg.maxAmount);
    const max = Math.max(cfg.minAmount, cfg.maxAmount);
    const amount = randInt(min, max);
    const ping = cfg.pingRole ? `<@&${cfg.pingRole}> ` : '';
    await ch.send({
        content: `${ping}💸 **ECO DROP!** **${amount}M** has dropped!`,
        allowedMentions: cfg.pingRole ? { roles: [cfg.pingRole] } : { parse: [] },
    }).catch((err) => console.error('❌ [seasonal] eco drop failed:', err.message));
}

async function tickChristmas(t) {
    const cfg = getConfig(context.get().db, 'christmas');
    if (!cfg.enabled || !cfg.channel) return;
    if (t.mo !== 11 && t.mo !== 12) return;
    const left = daysUntilChristmas(t);
    if (left < 0 || left > 45) return; // only up to and including Christmas Day
    if (t.h < cfg.hour) return;

    const d = data();
    if (d.fact.day === t.key) return;
    d.fact.day = t.key; // mark first so a failure can never spam
    touch();

    const ch = await getChannel(cfg.channel);
    if (!ch?.send) return;
    // Format: (FACT)\n**FOTD <n> | <@&role> **  (n = 263 on Nov 21, +1 per day)
    const n = cfg.startNumber + Math.round((Date.UTC(t.y, t.mo - 1, t.d) - Date.UTC(2026, 10, 21)) / 86400000);
    const fact = left === 0 ? 'Merry Christmas! 🎄 Today is Christmas Day, have an amazing one!' : FACTS[left % FACTS.length];
    const role = cfg.pingRole ? ` | <@&${cfg.pingRole}> ` : '';
    await ch.send({
        content: `${fact}\n**FOTD ${n}${role}**`,
        allowedMentions: cfg.pingRole ? { roles: [cfg.pingRole] } : { parse: [] },
    }).catch((err) => console.error('❌ [seasonal] christmas fact failed:', err.message));
}

async function tick() {
    if (!context.ready()) return;
    const t = et();
    await tickDrops(t).catch((err) => console.error('❌ [seasonal] drops:', err.message));
    await tickChristmas(t).catch((err) => console.error('❌ [seasonal] christmas:', err.message));
}

module.exports = { tick, FACTS, et, daysUntilChristmas };
