// Staff IDs: a private recovery secret for every dashboard staff login (the username is public, it only logs you in).
//   Format: 5 numbers - 6 letters - 4 numbers, e.g. 48213-QKXMTB-7305
//
// Each account stores (never the plain ID):
//   staffIdEnc    the ID encrypted with AES-256-GCM ("v1:iv:tag:ciphertext", bound to the account id). Dashboard OWNERS can
//                 read it back (Settings -> Staff Access, SEC- tickets); nobody else is ever shown the full ID.
//   staffIdHash   salted SHA-256, used to check IDs typed on the website and to find the account for an ID
//                 (so a lookup never has to decrypt every account)
//   staffIdLast4  last 4 digits, for the masked form shown to the ticket's own user (•••••-••••••-1234)
//   staffIdDmAt   when the ID was DM'd to its owner (null = still to be sent)
//
// Encryption key (first one that is set wins):
//   STAFF_ID_KEY     recommended: set it in Render's Environment tab (any long random string)
//   SESSION_SECRET   used if STAFF_ID_KEY isn't set
//   otherwise a random key is generated and saved in the database next to the data (works, but then the key is
//   NOT separate from the data, so set STAFF_ID_KEY or SESSION_SECRET).
// If the key is ever changed, existing IDs can't be decrypted any more: they keep working for logins (the hash still
// matches) but owners see them as masked until they press "New Staff ID". Keep the key stable.
//
//   const tools = require('./features/staffid')(() => db);   // db may be reassigned on reload, so it is read lazily
const crypto = require('crypto');

const RE = /^\d{5}-[A-Z]{6}-\d{4}$/;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

module.exports = function makeStaffIdTools(getDb) {
    const normalize = (v) => String(v || '').trim().toUpperCase().replace(/\s+/g, '');
    let warned = false;

    function salt() {
        const db = getDb();
        if (!db.staffIdSalt) db.staffIdSalt = crypto.randomBytes(16).toString('hex');
        return db.staffIdSalt;
    }
    function key() {
        const env = String(process.env.STAFF_ID_KEY || process.env.SESSION_SECRET || '');
        let material = env;
        if (!material) {
            const db = getDb();
            if (!db.staffIdKey) db.staffIdKey = crypto.randomBytes(32).toString('hex');
            material = db.staffIdKey;
            if (!warned) { warned = true; console.warn('⚠️ [staff id] Set STAFF_ID_KEY (or SESSION_SECRET) so the Staff ID encryption key is kept apart from the database.'); }
        }
        return crypto.createHash('sha256').update(`staff-id-key:${material}`).digest(); // 32 bytes
    }
    const hash = (id) => crypto.createHash('sha256').update(`${salt()}:${id}`).digest('hex');
    const last4 = (id) => id.slice(-4);
    const same = (a, b) => { const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || '')); return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y); };

    function encrypt(id, accountId) {
        const iv = crypto.randomBytes(12);
        const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
        c.setAAD(Buffer.from(String(accountId)));
        const ct = Buffer.concat([c.update(id, 'utf8'), c.final()]);
        return ['v1', iv.toString('hex'), c.getAuthTag().toString('hex'), ct.toString('hex')].join(':');
    }
    // Plain ID for an account, or null (no ID, wrong key, tampered).
    function reveal(account) {
        try {
            const [v, iv, tag, ct] = String(account?.staffIdEnc || '').split(':');
            if (v !== 'v1' || !iv || !tag || !ct) return null;
            const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'hex'));
            d.setAAD(Buffer.from(String(account.id)));
            d.setAuthTag(Buffer.from(tag, 'hex'));
            const id = Buffer.concat([d.update(Buffer.from(ct, 'hex')), d.final()]).toString('utf8');
            return RE.test(id) ? id : null;
        } catch { return null; }
    }
    function store(account, id) {
        account.staffIdHash = hash(id);
        account.staffIdLast4 = last4(id);
        account.staffIdEnc = encrypt(id, account.id);
        delete account.staffId; // never keep a plain-text copy
    }

    const matches = (account, input) => {
        const id = normalize(input);
        return !!account && RE.test(id) && !!account.staffIdHash && same(account.staffIdHash, hash(id));
    };
    const findAccount = (accounts, input) => {
        const id = normalize(input);
        if (!RE.test(id)) return null;
        const h = hash(id);
        return (accounts || []).find((a) => a.staffIdHash && same(a.staffIdHash, h)) || null;
    };
    const mask = (account) => (account && account.staffIdLast4 ? `•••••-••••••-${account.staffIdLast4}` : 'not issued');

    function generate(accounts) {
        const taken = new Set((accounts || []).map((a) => a.staffIdHash).filter(Boolean));
        for (;;) {
            const a = String(crypto.randomInt(0, 100000)).padStart(5, '0');
            let l = '';
            for (let i = 0; i < 6; i++) l += LETTERS[crypto.randomInt(0, 26)];
            const b = String(crypto.randomInt(0, 10000)).padStart(4, '0');
            const id = `${a}-${l}-${b}`;
            if (!taken.has(hash(id))) return id;
        }
    }
    // Gives `account` a brand-new ID (replacing any old one, which stops working) and returns the plain text.
    function issue(account, accounts) {
        const id = generate(accounts);
        store(account, id);
        account.staffIdDmAt = null;
        return id;
    }
    // Brings an account up to date. Returns true when it changed (the caller should save):
    //  - no ID yet                           -> issue one (every current staff member gets one)
    //  - plain-text ID from an old build      -> encrypt it (same ID keeps working)
    //  - hash only (the hash-only build)      -> stays valid; owners can't read it until it is reissued
    //  - ID that was encrypted with another key -> same as above
    function migrate(account, accounts) {
        const legacy = normalize(account.staffId);
        if (RE.test(legacy)) { store(account, legacy); return true; }
        if (account.staffId !== undefined) { delete account.staffId; }
        if (!account.staffIdHash) { issue(account, accounts); return true; }
        return false;
    }

    return { RE, normalize, matches, findAccount, mask, issue, migrate, reveal };
};
