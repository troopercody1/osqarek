// /feature — per-feature settings from Discord (the dashboard "Features" page edits the same data).
const context = require('./context');
const { FEATURES, FEATURE_NAMES, getConfig, setValue, resetFeature } = require('./config');
const { brandEmbed, truncate } = require('./util');

function show(v) {
    if (Array.isArray(v)) return v.length ? v.join(', ') : '*none*';
    if (v === '' || v === null || v === undefined) return '*not set*';
    if (typeof v === 'boolean') return v ? 'on' : 'off';
    return String(v);
}

const commands = {
    async feature({ interaction, options, isAtLeastAdmin }) {
        const { db } = context.get();
        if (!isAtLeastAdmin) return interaction.editReply('❌ You need **Admin+** to use this.');
        const sub = options.getSubcommand();

        if (sub === 'list') {
            const lines = FEATURE_NAMES.map((n) => {
                const c = getConfig(db, n);
                return `${c.enabled ? '✅' : '⛔'} ${FEATURES[n].icon} **${FEATURES[n].label}** (\`${n}\`)`;
            });
            return interaction.editReply({ embeds: [brandEmbed({ title: '🧩 Features', description: lines.join('\n'), footer: '/feature show <name> • /feature set <name> <key> <value>' })] });
        }

        const name = options.getString('name');
        const def = FEATURES[name];
        if (!def) return interaction.editReply('❌ Unknown feature.');

        if (sub === 'show') {
            const c = getConfig(db, name);
            const rows = def.settings.map((s) => `**${s.label}** (\`${s.key}\`): ${show(c[s.key])}`);
            return interaction.editReply({ embeds: [brandEmbed({ title: `${def.icon} ${def.label} — ${c.enabled ? 'enabled' : 'disabled'}`, description: `${def.description}\n\n${truncate(rows.join('\n'), 3500)}` })] });
        }
        if (sub === 'enable' || sub === 'disable') {
            setValue(db, name, 'enabled', sub === 'enable');
            await context.get().safeSave();
            return interaction.editReply(`${sub === 'enable' ? '✅ Enabled' : '⛔ Disabled'} **${def.label}**.`);
        }
        if (sub === 'set') {
            const key = options.getString('key');
            const r = setValue(db, name, key, options.getString('value'));
            if (!r.ok) return interaction.editReply(`❌ ${r.error}`);
            await context.get().safeSave();
            return interaction.editReply(`✅ **${def.label}** → \`${key}\` = ${show(r.value)}`);
        }
        if (sub === 'reset') {
            resetFeature(db, name);
            await context.get().safeSave();
            return interaction.editReply(`♻️ **${def.label}** reset to defaults.`);
        }
        return interaction.editReply('❌ Unknown subcommand.');
    },
};

const nameOpt = { name: 'name', description: 'Feature', type: 3, required: true, choices: FEATURE_NAMES.map((n) => ({ name: FEATURES[n].label, value: n })) };

const definitions = [
    {
        name: 'feature',
        description: 'Enable, disable and configure features (Admin+)',
        options: [
            { name: 'list', description: 'List features and whether they are on', type: 1 },
            { name: 'show', description: 'Show a feature\'s settings', type: 1, options: [nameOpt] },
            { name: 'enable', description: 'Turn a feature on', type: 1, options: [nameOpt] },
            { name: 'disable', description: 'Turn a feature off', type: 1, options: [nameOpt] },
            { name: 'set', description: 'Change one setting', type: 1, options: [nameOpt, { name: 'key', description: 'Setting key (see /feature show)', type: 3, required: true, max_length: 40 }, { name: 'value', description: 'New value (channels/roles: ID or mention, "none" to clear)', type: 3, required: true, max_length: 500 }] },
            { name: 'reset', description: 'Reset a feature to defaults', type: 1, options: [nameOpt] },
        ],
    },
];

module.exports = { commands, definitions };
