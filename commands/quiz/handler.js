const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');

async function handleCreate({ interaction, options, guild, user, db }) {
    if (db.quizEnabled === false) return interaction.editReply('🚫 The Quiz module is currently disabled.');
    // 1. Check if user is banned from quizzes
    if (db.quizBanned && db.quizBanned.includes(user.id)) {
        return interaction.editReply("❌ You are banned from creating quizzes.");
    }

    const name = options.getString('name').toLowerCase();
    const question = options.getString('question');
    const answer = options.getString('answer');

    // 2. Ensure the quiz database object exists
    if (!db.customQuizzes) db.customQuizzes = {};
    if (!db.customQuizzes[name]) db.customQuizzes[name] = [];

    // 3. Add to DB as unapproved (approved: false)
    db.customQuizzes[name].push({
        question,
        answer,
        creator: user.id,
        approved: false
    });
    await db.save();

    // 4. Build the Review Embed for Staff
    const reviewEmbed = new EmbedBuilder()
        .setTitle("📝 New Quiz Submission")
        .setColor(0xF1C40F)
        .addFields(
            { name: "Quiz Name", value: name, inline: true },
            { name: "Creator", value: `<@${user.id}>`, inline: true },
            { name: "Question", value: question },
            { name: "Answer", value: `||${answer}||` }
        )
        .setFooter({ text: "Use buttons below to moderate this question." })
        .setTimestamp();

    const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`qapp_approve_${name}_${user.id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`qapp_deny_${name}_${user.id}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`qapp_ban_${name}_${user.id}`).setLabel('Ban Creator').setStyle(ButtonStyle.Secondary)
    );

    // 5. Send to Mod Log and Check for Channel
    const logChanId = db.loaChannel;
    const logChan = logChanId ? guild.channels.cache.get(logChanId) : null;

    if (logChan) {
        await logChan.send({ embeds: [reviewEmbed], components: [buttons] }).catch(err => {
            console.error("Failed to send to Mod Log:", err);
        });
        return interaction.editReply("✅ Question submitted! Staff will review it in the Mod Log.");
    } else {
        // Fallback: If Mod Log isn't set, we notify the user but still save it
        return interaction.editReply("⚠️ Question saved, but the Mod Log channel is not set! Staff cannot approve this yet.");
    }
}

async function handleStart({ interaction, options, user, db }) {
    const name = options.getString('name').toLowerCase();
    const shuffle = options.getBoolean('shuffle');

    // 1. Check if the quiz exists at all
    if (!db.customQuizzes || !db.customQuizzes[name]) {
        return interaction.editReply("❌ That quiz doesn't exist.");
    }

    // 2. Filter for ONLY approved questions
    let quizData = db.customQuizzes[name].filter(q => q.approved === true);

    // 3. Check if there are any approved questions to play
    if (quizData.length === 0) {
        return interaction.editReply("❌ This quiz has no approved questions yet. Please wait for staff to review them!");
    }

    // 4. Shuffle if requested
    if (shuffle) quizData = quizData.sort(() => Math.random() - 0.5);

    await interaction.editReply(`🎯 Starting quiz: **${name}**! Check the channel below.`);

    let score = 0;
    const filter = m => m.author.id === user.id;

    // Game Loop
    for (const [index, q] of quizData.entries()) {
        const embed = new EmbedBuilder()
            .setTitle(`Quiz: ${name}`)
            .setDescription(`**Question ${index + 1}:**\n${q.question}`)
            .setFooter({ text: `Score: ${score} | Type your answer in the chat!` })
            .setColor(0x3498DB);

        await interaction.channel.send({ content: `<@${user.id}>`, embeds: [embed] });

        try {
            // Wait 15 seconds for an answer
            const collected = await interaction.channel.awaitMessages({
                filter,
                max: 1,
                time: 15000,
                errors: ['time']
            });

            const userAns = collected.first().content.toLowerCase().trim();
            if (userAns === q.answer.toLowerCase().trim()) {
                score++;
                await interaction.channel.send("✅ **Correct!**");
            } else {
                await interaction.channel.send(`❌ **Wrong!** The correct answer was: \`${q.answer}\``);
            }
        } catch (e) {
            await interaction.channel.send(`⏰ **Time's up!** The answer was: \`${q.answer}\``);
        }
    }

    const finalEmbed = new EmbedBuilder()
        .setTitle("🏁 Quiz Complete!")
        .setDescription(`${user.username}, you finished **${name}** with a score of **${score}/${quizData.length}**!`)
        .setColor(0x2ECC71);

    return interaction.channel.send({ embeds: [finalEmbed] });
}

async function handleList({ interaction, db }) {
    const quizzes = Object.keys(db.customQuizzes || {});
    if (quizzes.length === 0) return interaction.editReply("📚 No custom quizzes found.");

    const list = quizzes.map(q => `• **${q}** (${db.customQuizzes[q].length} questions)`).join('\n');
    const embed = new EmbedBuilder()
        .setTitle("📚 Available Quizzes")
        .setDescription(list)
        .setColor(0x3498DB);

    return interaction.editReply({ embeds: [embed] });
            }
            // --- DELETE ENTIRE QUIZ ---}

async function handleDelete({ interaction, db }) {
    const name = interaction.options.getString('name').toLowerCase();
    if (!db.customQuizzes?.[name]) return interaction.editReply("❌ Quiz not found.");

    delete db.customQuizzes[name];
    await db.save();
    await interaction.editReply(`🗑️ Entire quiz **${name}** and all its questions have been deleted.`);
}

async function handleBan({ interaction, db }) {
    // Check for Admin permissions (or use your existing mod check logic)
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        console.log(`DEBUG: Role check failed for /${interaction.commandName}`);
        return interaction.editReply("❌ You don't have permission to use this command.");
    }
    console.log(`DEBUG: Role check passed for /${interaction.commandName}`);

    const target = interaction.options.getUser('target');
    const status = interaction.options.getBoolean('status');

    if (!db.quizBanned) db.quizBanned = [];

    if (status) {
        if (!db.quizBanned.includes(target.id)) {
            db.quizBanned.push(target.id);
            await db.save();
        }
        await interaction.editReply(`🚫 **${target.username}** has been banned from creating quizzes.`);
    } else {
        db.quizBanned = db.quizBanned.filter(id => id !== target.id);
        await db.save();
        await interaction.editReply(`✅ **${target.username}** is no longer banned from creating quizzes.`);
    }
}

async function handleTriviaStates({ interaction, db }) {
    let statePool = [
        { name: 'Alabama', code: 'al', flag: 'https://flagcdn.com/w320/us-al.png' },
        { name: 'Alaska', code: 'ak', flag: 'https://flagcdn.com/w320/us-ak.png' },
        { name: 'Arizona', code: 'az', flag: 'https://flagcdn.com/w320/us-az.png' },
        { name: 'Arkansas', code: 'ar', flag: 'https://flagcdn.com/w320/us-ar.png' },
        { name: 'California', code: 'ca', flag: 'https://flagcdn.com/w320/us-ca.png' },
        { name: 'Colorado', code: 'co', flag: 'https://flagcdn.com/w320/us-co.png' },
        { name: 'Connecticut', code: 'ct', flag: 'https://flagcdn.com/w320/us-ct.png' },
        { name: 'Delaware', code: 'de', flag: 'https://flagcdn.com/w320/us-de.png' },
        { name: 'Florida', code: 'fl', flag: 'https://flagcdn.com/w320/us-fl.png' },
        { name: 'Georgia', code: 'ga', flag: 'https://flagcdn.com/w320/us-ga.png' },
        { name: 'Hawaii', code: 'hi', flag: 'https://flagcdn.com/w320/us-hi.png' },
        { name: 'Idaho', code: 'id', flag: 'https://flagcdn.com/w320/us-id.png' },
        { name: 'Illinois', code: 'il', flag: 'https://flagcdn.com/w320/us-il.png' },
        { name: 'Indiana', code: 'in', flag: 'https://flagcdn.com/w320/us-in.png' },
        { name: 'Iowa', code: 'ia', flag: 'https://flagcdn.com/w320/us-ia.png' },
        { name: 'Kansas', code: 'ks', flag: 'https://flagcdn.com/w320/us-ks.png' },
        { name: 'Kentucky', code: 'ky', flag: 'https://flagcdn.com/w320/us-ky.png' },
        { name: 'Louisiana', code: 'la', flag: 'https://flagcdn.com/w320/us-la.png' },
        { name: 'Maine', code: 'me', flag: 'https://flagcdn.com/w320/us-me.png' },
        { name: 'Maryland', code: 'md', flag: 'https://flagcdn.com/w320/us-md.png' },
        { name: 'Massachusetts', code: 'ma', flag: 'https://flagcdn.com/w320/us-ma.png' },
        { name: 'Michigan', code: 'mi', flag: 'https://flagcdn.com/w320/us-mi.png' },
        { name: 'Minnesota', code: 'mn', flag: 'https://flagcdn.com/w320/us-mn.png' },
        { name: 'Mississippi', code: 'ms', flag: 'https://flagcdn.com/w320/us-ms.png' },
        { name: 'Missouri', code: 'mo', flag: 'https://flagcdn.com/w320/us-mo.png' },
        { name: 'Montana', code: 'mt', flag: 'https://flagcdn.com/w320/us-mt.png' },
        { name: 'Nebraska', code: 'ne', flag: 'https://flagcdn.com/w320/us-ne.png' },
        { name: 'Nevada', code: 'nv', flag: 'https://flagcdn.com/w320/us-nv.png' },
        { name: 'New Hampshire', code: 'nh', flag: 'https://flagcdn.com/w320/us-nh.png' },
        { name: 'New Jersey', code: 'nj', flag: 'https://flagcdn.com/w320/us-nj.png' },
        { name: 'New Mexico', code: 'nm', flag: 'https://flagcdn.com/w320/us-nm.png' },
        { name: 'New York', code: 'ny', flag: 'https://flagcdn.com/w320/us-ny.png' },
        { name: 'North Carolina', code: 'nc', flag: 'https://flagcdn.com/w320/us-nc.png' },
        { name: 'North Dakota', code: 'nd', flag: 'https://flagcdn.com/w320/us-nd.png' },
        { name: 'Ohio', code: 'oh', flag: 'https://flagcdn.com/w320/us-oh.png' },
        { name: 'Oklahoma', code: 'ok', flag: 'https://flagcdn.com/w320/us-ok.png' },
        { name: 'Oregon', code: 'or', flag: 'https://flagcdn.com/w320/us-or.png' },
        { name: 'Pennsylvania', code: 'pa', flag: 'https://flagcdn.com/w320/us-pa.png' },
        { name: 'Rhode Island', code: 'ri', flag: 'https://flagcdn.com/w320/us-ri.png' },
        { name: 'South Carolina', code: 'sc', flag: 'https://flagcdn.com/w320/us-sc.png' },
        { name: 'South Dakota', code: 'sd', flag: 'https://flagcdn.com/w320/us-sd.png' },
        { name: 'Tennessee', code: 'tn', flag: 'https://flagcdn.com/w320/us-tn.png' },
        { name: 'Texas', code: 'tx', flag: 'https://flagcdn.com/w320/us-tx.png' },
        { name: 'Utah', code: 'ut', flag: 'https://flagcdn.com/w320/us-ut.png' },
        { name: 'Vermont', code: 'vt', flag: 'https://flagcdn.com/w320/us-vt.png' },
        { name: 'Virginia', code: 'va', flag: 'https://flagcdn.com/w320/us-va.png' },
        { name: 'Washington', code: 'wa', flag: 'https://flagcdn.com/w320/us-wa.png' },
        { name: 'West Virginia', code: 'wv', flag: 'https://flagcdn.com/w320/us-wv.png' },
        { name: 'Wisconsin', code: 'wi', flag: 'https://flagcdn.com/w320/us-wi.png' },
        { name: 'Wyoming', code: 'wy', flag: 'https://flagcdn.com/w320/us-wy.png' }
    ];

    let statesFinished = 0;
    let isGameActive = true;
    let sessionScores = {}; // Local score tracking

    await interaction.editReply({ content: "🏁 **The 50 State Marathon is starting!** Get ready..." });

    const showFinalResults = async () => {
        const sorted = Object.entries(sessionScores)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 5); // Get top 5

        let scoreboard = sorted.length > 0
            ? sorted.map(([id, score], index) => `**${index + 1}.** <@${id}> — ${score} points`).join('\n')
            : "No one scored this time!";

        const resultsEmbed = new EmbedBuilder()
            .setTitle("🏆 Quiz Results")
            .setDescription(`**Game Over!** Here is how you did:\n\n${scoreboard}`)
            .setColor(0xF1C40F)
            .setFooter({ text: `Total States Covered: ${statesFinished}/50` });

        await interaction.channel.send({ embeds: [resultsEmbed] });
    };

    const startNewRound = async () => {
        if (!isGameActive) return await showFinalResults();

        if (statePool.length === 0) {
            isGameActive = false;
            await interaction.channel.send("🏆 **The Marathon is complete!** All 50 states found.");
            return await showFinalResults();
        }

        const randomIndex = Math.floor(Math.random() * statePool.length);
        const state = statePool[randomIndex];
        statePool.splice(randomIndex, 1);

        statesFinished++;

        const quizEmbed = new EmbedBuilder()
            .setTitle(`🏁 State Quiz (${statesFinished}/50)`)
            .setDescription('**Which state does this flag belong to?**\nYou have 60 seconds!')
            .setImage(state.flag)
            .setColor(0x3498DB);

        await interaction.channel.send({ embeds: [quizEmbed] });

        const filter = m => {
            const guess = m.content.toLowerCase();
            if (guess === 'stop quiz') return true;
            return guess === state.name.toLowerCase() || guess === state.code.toLowerCase();
        };

        const collector = interaction.channel.createMessageCollector({ filter, time: 60000 });
        let answered = false;

        collector.on('collect', async m => {
            if (m.content.toLowerCase() === 'stop quiz') {
                isGameActive = false;
                await m.reply("🛑 **Quiz stopped.** Calculating final scores...");
                collector.stop();
                return;
            }

            answered = true;

            // Session tracking
            sessionScores[m.author.id] = (sessionScores[m.author.id] || 0) + 1;

            // Database tracking
            if (!db.stats[m.author.id]) db.stats[m.author.id] = { count: 0, triviaPoints: 0 };
            db.stats[m.author.id].triviaPoints = (db.stats[m.author.id].triviaPoints || 0) + 1;
            await db.save();

            await m.reply(`🌟 **Correct!** It was **${state.name}**. Next round starting...`);
            collector.stop();
        });

        collector.on('end', async () => {
            if (!isGameActive) return;

            if (!answered) {
                await interaction.channel.send(`⏰ **Time's up!** The answer was **${state.name}**. Moving on...`);
            }
            setTimeout(startNewRound, 2000);
        });
    };

    startNewRound();
}

async function handleTriviaCountries({ interaction, db }) {
    let countryPool = [
        // --- EASY / WELL KNOWN ---
        { name: 'United States', code: 'us', flag: 'https://flagcdn.com/w320/us.png' },
        { name: 'United Kingdom', code: 'gb', flag: 'https://flagcdn.com/w320/gb.png' },
        { name: 'Canada', code: 'ca', flag: 'https://flagcdn.com/w320/ca.png' },
        { name: 'France', code: 'fr', flag: 'https://flagcdn.com/w320/fr.png' },
        { name: 'Germany', code: 'de', flag: 'https://flagcdn.com/w320/de.png' },
        { name: 'Japan', code: 'jp', flag: 'https://flagcdn.com/w320/jp.png' },
        { name: 'Brazil', code: 'br', flag: 'https://flagcdn.com/w320/br.png' },
        { name: 'Australia', code: 'au', flag: 'https://flagcdn.com/w320/au.png' },
        { name: 'Italy', code: 'it', flag: 'https://flagcdn.com/w320/it.png' },
        { name: 'Mexico', code: 'mx', flag: 'https://flagcdn.com/w320/mx.png' },
        { name: 'South Korea', code: 'kr', flag: 'https://flagcdn.com/w320/kr.png' },
        { name: 'China', code: 'cn', flag: 'https://flagcdn.com/w320/cn.png' },
        { name: 'India', code: 'in', flag: 'https://flagcdn.com/w320/in.png' },
        { name: 'Spain', code: 'es', flag: 'https://flagcdn.com/w320/es.png' },
        { name: 'Argentina', code: 'ar', flag: 'https://flagcdn.com/w320/ar.png' },
        { name: 'Greece', code: 'gr', flag: 'https://flagcdn.com/w320/gr.png' },
        { name: 'Turkey', code: 'tr', flag: 'https://flagcdn.com/w320/tr.png' },
        { name: 'Switzerland', code: 'ch', flag: 'https://flagcdn.com/w320/ch.png' },
        { name: 'Sweden', code: 'se', flag: 'https://flagcdn.com/w320/se.png' },
        { name: 'Egypt', code: 'eg', flag: 'https://flagcdn.com/w320/eg.png' },

        // --- MEDIUM ---
        { name: 'Vietnam', code: 'vn', flag: 'https://flagcdn.com/w320/vn.png' },
        { name: 'Norway', code: 'no', flag: 'https://flagcdn.com/w320/no.png' },
        { name: 'Poland', code: 'pl', flag: 'https://flagcdn.com/w320/pl.png' },
        { name: 'Ukraine', code: 'ua', flag: 'https://flagcdn.com/w320/ua.png' },
        { name: 'Iceland', code: 'is', flag: 'https://flagcdn.com/w320/is.png' },
        { name: 'New Zealand', code: 'nz', flag: 'https://flagcdn.com/w320/nz.png' },
        { name: 'Portugal', code: 'pt', flag: 'https://flagcdn.com/w320/pt.png' },
        { name: 'Thailand', code: 'th', flag: 'https://flagcdn.com/w320/th.png' },
        { name: 'South Africa', code: 'za', flag: 'https://flagcdn.com/w320/za.png' },
        { name: 'Ireland', code: 'ie', flag: 'https://flagcdn.com/w320/ie.png' },
        { name: 'Jamaica', code: 'jm', flag: 'https://flagcdn.com/w320/jm.png' },
        { name: 'Finland', code: 'fi', flag: 'https://flagcdn.com/w320/fi.png' },
        { name: 'Morocco', code: 'ma', flag: 'https://flagcdn.com/w320/ma.png' },
        { name: 'Israel', code: 'il', flag: 'https://flagcdn.com/w320/il.png' },

        // --- DIFFICULT / TERRITORIES ---
        { name: 'Bhutan', code: 'bt', flag: 'https://flagcdn.com/w320/bt.png' },
        { name: 'Kazakhstan', code: 'kz', flag: 'https://flagcdn.com/w320/kz.png' },
        { name: 'Eswatini', code: 'sz', flag: 'https://flagcdn.com/w320/sz.png' },
        { name: 'Kiribati', code: 'ki', flag: 'https://flagcdn.com/w320/ki.png' },
        { name: 'Seychelles', code: 'sc', flag: 'https://flagcdn.com/w320/sc.png' },
        { name: 'Saint Lucia', code: 'lc', flag: 'https://flagcdn.com/w320/lc.png' },
        { name: 'Grenada', code: 'gd', flag: 'https://flagcdn.com/w320/gd.png' },
        { name: 'Greenland', code: 'gl', flag: 'https://flagcdn.com/w320/gl.png' },
        { name: 'Faroe Islands', code: 'fo', flag: 'https://flagcdn.com/w320/fo.png' },
        { name: 'Guam', code: 'gu', flag: 'https://flagcdn.com/w320/gu.png' },
        { name: 'French Polynesia', code: 'pf', flag: 'https://flagcdn.com/w320/pf.png' },
        { name: 'Gibraltar', code: 'gi', flag: 'https://flagcdn.com/w320/gi.png' },
        { name: 'American Samoa', code: 'as', flag: 'https://flagcdn.com/w320/as.png' },
        { name: 'Isle of Man', code: 'im', flag: 'https://flagcdn.com/w320/im.png' },
        { name: 'Curacao', code: 'cw', flag: 'https://flagcdn.com/w320/cw.png' },
        { name: 'Aruba', code: 'aw', flag: 'https://flagcdn.com/w320/aw.png' }
    ];

    let roundsFinished = 0;
    let isGameActive = true;
    let sessionScores = {};

    await interaction.editReply({ content: "🌍 **The Global Flag Marathon is starting!** Get ready..." });

    const startNewRound = async () => {
        if (!isGameActive) return;

        if (countryPool.length === 0) {
            await interaction.channel.send("🏆 **The World Tour is over!** You finished all 50 locations.");
            return showFinalResults();
        }

        const randomIndex = Math.floor(Math.random() * countryPool.length);
        const country = countryPool[randomIndex];
        countryPool.splice(randomIndex, 1);
        roundsFinished++;

        const quizEmbed = new EmbedBuilder()
            .setTitle(`🌍 Country/Territory Quiz (${roundsFinished}/50)`)
            .setDescription('**Which country or territory does this flag belong to?**\nYou have 60 seconds!')
            .setImage(country.flag)
            .setColor(0x2ECC71);

        await interaction.channel.send({ embeds: [quizEmbed] });

        const filter = m => {
            const guess = m.content.toLowerCase();
            return guess === 'stop quiz' || guess === country.name.toLowerCase() || guess === country.code.toLowerCase();
        };

        const collector = interaction.channel.createMessageCollector({ filter, time: 60000 });
        let answered = false;

        collector.on('collect', async m => {
            if (m.content.toLowerCase() === 'stop quiz') {
                isGameActive = false;
                await m.reply("🛑 **Quiz stopped.** Showing final scores...");
                collector.stop();
                return;
            }

            answered = true;
            sessionScores[m.author.id] = (sessionScores[m.author.id] || 0) + 1;

            // Database tracking
            if (!db.stats[m.author.id]) db.stats[m.author.id] = { count: 0, triviaPoints: 0 };
            db.stats[m.author.id].triviaPoints++;
            await db.save();

            await m.reply(`🌟 **Correct!** It was **${country.name}** (${country.code.toUpperCase()}). Next round starting...`);
            collector.stop();
        });

        collector.on('end', async () => {
            if (!isGameActive) return showFinalResults();

            if (!answered) {
                await interaction.channel.send(`⏰ **Time's up!** The answer was **${country.name}**. Moving on...`);
            }
            setTimeout(startNewRound, 2000);
        });
    };

    const showFinalResults = async () => {
        const sorted = Object.entries(sessionScores)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 5);

        let scoreboard = sorted.length > 0
            ? sorted.map(([id, score], index) => `**${index + 1}.** <@${id}> — ${score} points`).join('\n')
            : "No one scored this time!";

        const resultsEmbed = new EmbedBuilder()
            .setTitle("🏆 Final Leaderboard")
            .setDescription(scoreboard)
            .setColor(0xF1C40F)
            .setFooter({ text: `Total Locations: ${roundsFinished}/50` });

        await interaction.channel.send({ embeds: [resultsEmbed] });
    };

    startNewRound();
}

async function handleTriviaCanada({ interaction, db }) {
    let canadaPool = [
        { name: 'Ontario', code: 'on', flag: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/88/Flag_of_Ontario.svg/320px-Flag_of_Ontario.svg.png' },
        { name: 'Quebec', code: 'qc', flag: 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5f/Flag_of_Quebec.svg/320px-Flag_of_Quebec.svg.png' },
        { name: 'Nova Scotia', code: 'ns', flag: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c0/Flag_of_Nova_Scotia.svg/320px-Flag_of_Nova_Scotia.svg.png' },
        { name: 'New Brunswick', code: 'nb', flag: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fb/Flag_of_New_Brunswick.svg/320px-Flag_of_New_Brunswick.svg.png' },
        { name: 'Manitoba', code: 'mb', flag: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c4/Flag_of_Manitoba.svg/320px-Flag_of_Manitoba.svg.png' },
        { name: 'British Columbia', code: 'bc', flag: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b8/Flag_of_British_Columbia.svg/320px-Flag_of_British_Columbia.svg.png' },
        { name: 'Prince Edward Island', code: 'pe', flag: 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d7/Flag_of_Prince_Edward_Island.svg/320px-Flag_of_Prince_Edward_Island.svg.png' },
        { name: 'Saskatchewan', code: 'sk', flag: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/bb/Flag_of_Saskatchewan.svg/320px-Flag_of_Saskatchewan.svg.png' },
        { name: 'Alberta', code: 'ab', flag: 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f5/Flag_of_Alberta.svg/320px-Flag_of_Alberta.svg.png' },
        { name: 'Newfoundland and Labrador', code: 'nl', flag: 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/dd/Flag_of_Newfoundland_and_Labrador.svg/320px-Flag_of_Newfoundland_and_Labrador.svg.png' },
        { name: 'Northwest Territories', code: 'nt', flag: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c1/Flag_of_the_Northwest_Territories.svg/320px-Flag_of_the_Northwest_Territories.svg.png' },
        { name: 'Yukon', code: 'yt', flag: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/69/Flag_of_Yukon.svg/320px-Flag_of_Yukon.svg.png' },
        { name: 'Nunavut', code: 'nu', flag: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/90/Flag_of_Nunavut.svg/320px-Flag_of_Nunavut.svg.png' }
    ].sort(() => Math.random() - 0.5);

    let roundsFinished = 0;
    let isGameActive = true;
    let sessionScores = {};

    await interaction.editReply({ content: "🇨🇦 **The Canadian Sprint is starting!** (13 Rounds)" });

    const startNewRound = async () => {
        if (!isGameActive) return;

        if (canadaPool.length === 0) {
            await interaction.channel.send("🏆 **Sprint complete!**");
            return showFinalResults();
        }

        const current = canadaPool.shift();
        roundsFinished++;

        const quizEmbed = new EmbedBuilder()
            .setTitle(`🇨🇦 Canada Quiz (${roundsFinished}/13)`)
            .setDescription('**Identify this Province or Territory!**')
            .setImage(current.flag)
            .setColor(0xFF0000);

        await interaction.channel.send({ embeds: [quizEmbed] });

        const filter = m => {
            const guess = m.content.toLowerCase();
            return guess === 'stop quiz' || guess === current.name.toLowerCase() || guess === current.code.toLowerCase();
        };

        const collector = interaction.channel.createMessageCollector({ filter, time: 60000 });
        let answered = false;

        collector.on('collect', async m => {
            if (m.content.toLowerCase() === 'stop quiz') {
                isGameActive = false;
                await m.reply("🛑 **Quiz stopped.**");
                collector.stop();
                return;
            }

            answered = true;
            sessionScores[m.author.id] = (sessionScores[m.author.id] || 0) + 1;

            if (!db.stats[m.author.id]) db.stats[m.author.id] = { count: 0, triviaPoints: 0 };
            db.stats[m.author.id].triviaPoints++;
            await db.save();

            await m.reply(`🌟 **Correct!** That was **${current.name}**. Next one...`);
            collector.stop();
        });

        collector.on('end', async () => {
            if (!isGameActive) return showFinalResults();
            if (!answered) {
                await interaction.channel.send(`⏰ **Time's up!** The answer was **${current.name}**.`);
            }
            setTimeout(startNewRound, 2000);
        });
    };

    const showFinalResults = async () => {
        const sorted = Object.entries(sessionScores)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 5);

        let scoreboard = sorted.length > 0
            ? sorted.map(([id, score], index) => `**${index + 1}.** <@${id}> — ${score} points`).join('\n')
            : "No points this round!";

        const resultsEmbed = new EmbedBuilder()
            .setTitle("🏆 Final Canadian Standings")
            .setDescription(scoreboard)
            .setColor(0xF1C40F);

        await interaction.channel.send({ embeds: [resultsEmbed] });
    };

    startNewRound();
}

async function stateleaderboard({ interaction, db }) {
    // Sort all users by their triviaPoints
    const sorted = Object.entries(db.stats)
        .filter(([id, stats]) => stats.triviaPoints > 0)
        .sort(([, a], [, b]) => b.triviaPoints - a.triviaPoints)
        .slice(0, 10); // Top 10

    const lbEmbed = new EmbedBuilder()
        .setTitle('🏆 State Quiz Leaderboard')
        .setColor(0xF1C40F);

    let list = sorted.map(([id, stats], index) => {
        return `**#${index + 1}** <@${id}> — \`${stats.triviaPoints}\` Points`;
    }).join('\n');

    lbEmbed.setDescription(list || "No points awarded yet. Start a quiz with `/statequiz`!");
    return interaction.editReply({ embeds: [lbEmbed] });
}


async function quiz(ctx) {
    const { interaction, options } = ctx;
    const subcommand = options.getSubcommand();

    if (subcommand === 'create') return handleCreate(ctx);
    if (subcommand === 'start') return handleStart(ctx);
    if (subcommand === 'list') return handleList(ctx);
    if (subcommand === 'delete') return handleDelete(ctx);
    if (subcommand === 'ban') return handleBan(ctx);

    if (subcommand === 'trivia') {
        const type = options.getString('type');
        if (type === 'states') return handleTriviaStates(ctx);
        if (type === 'countries') return handleTriviaCountries(ctx);
        if (type === 'canada') return handleTriviaCanada(ctx);
        return interaction.editReply('❌ Unknown trivia type.');
    }

    return interaction.editReply('❌ Unknown quiz subcommand.');
}

module.exports = {
    quiz,
    stateleaderboard,
};
