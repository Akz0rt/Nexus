const cron = require('node-cron');
const { ChannelType, EmbedBuilder, Events, MessageFlags } = require('discord.js');
const GuildSettingsService = require('../../services/GuildSettingsService');
const VoiceActivityService = require('../../services/VoiceActivityService');
const { mapLimit } = require('../../services/RoleService');
const EconomyService = require('./EconomyService');
const PersonalRoleService = require('./PersonalRoleService');
const games = require('./games');
const { buildOffer } = require('./shop');
const { describe, number } = require('./messages');
const curve = require('./curve');

// An active minute (in voice, or chatting) is worth the same
const EXP_PER_MINUTE = 60;
const COINS_PER_MINUTE = 1;
const MESSAGE_COOLDOWN_MS = 60 * 1000;
const MIN_MESSAGE_LENGTH = 5;
const VOICE_TYPES = new Set([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);

const lastMessageCredit = new Map(); // guildId:userId -> ms

/** Who earns for this minute in voice: not in the AFK channel and not deafened. */
function earningVoiceMembers(guild) {
    const earning = [];
    for (const channel of guild.channels.cache.values()) {
        if (!VOICE_TYPES.has(channel.type) || channel.id === guild.afkChannelId) continue;
        earning.push(...[...channel.members.values()].filter(member =>
            !member.user.bot && !member.voice?.selfDeaf && !member.voice?.serverDeaf));
    }
    return earning;
}

/** Level roles the member has reached but doesn't have yet (that the bot can give). */
function missingLevelRoles(guild, member, level, levelRoles) {
    return levelRoles
        .filter(entry => entry.level <= level && !member.roles.cache.has(entry.roleId))
        .map(entry => guild.roles.cache.get(entry.roleId))
        .filter(role => role && role.editable && !role.managed);
}

/** "50 ★3" — level with the prestige, if any. */
function levelLabel(account) {
    return account.prestige ? `${account.level} ★${account.prestige}` : String(account.level);
}

/** After a credit that reached a new level or prestige: level roles and the announcement. */
async function celebrate(guild, member, result, settings) {
    if (result.reached.length === 0 && !result.prestiges) return;
    const level = result.account.level;
    const roles = result.reached.length ? missingLevelRoles(guild, member, level, settings.levelRoles) : [];
    for (const role of roles) {
        await member.roles.add(role, `Уровень ${level}`).catch(error =>
            console.error(`Economy: level role ${role.id} for ${member.id} failed:`, error.message || error));
    }
    const channel = settings.channelId ? guild.channels.cache.get(settings.channelId) : null;
    if (!channel?.isTextBased?.()) return;
    const lines = [result.prestiges
        ? `<@${member.id}> получает **престиж ★${result.account.prestige}**!`
        : `<@${member.id}> теперь **${level} уровня**!`];
    if (result.rewards > 0) lines.push(`Награда: **${result.rewards.toLocaleString('ru-RU')}** монет.`);
    if (roles.length) lines.push(`Новая роль: ${roles.map(role => `<@&${role.id}>`).join(', ')}`);
    const embed = new EmbedBuilder()
        .setColor(0xffb020)
        .setAuthor({ name: member.displayName, iconURL: member.user.displayAvatarURL({ size: 64 }) })
        .setDescription(lines.join('\n'));
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(error =>
        console.error('Economy: level-up announcement failed:', error.message || error));
}

/** A chat message: one active minute, at most once a minute. */
async function onMessage(message, now = Date.now()) {
    if (!message.guild || message.author.bot || !message.member) return null;
    if (String(message.content || '').trim().length < MIN_MESSAGE_LENGTH) return null;
    const key = `${message.guild.id}:${message.author.id}`;
    if (now - (lastMessageCredit.get(key) || 0) < MESSAGE_COOLDOWN_MS) return null;
    const settings = (await GuildSettingsService.get(message.guild.id)).economy;
    if (!settings.enabled) return null;
    lastMessageCredit.set(key, now);
    const result = await EconomyService.credit(message.guild.id, message.member, { exp: EXP_PER_MINUTE, money: COINS_PER_MINUTE, messages: 1 });
    await celebrate(message.guild, message.member, result, settings);
    return result;
}

/**
 * Every minute: the voice time that counts goes to the activity stats (always), and
 * earns exp and coins where the economy is on.
 */
async function voiceTick(client) {
    for (const guild of client.guilds.cache.values()) {
        const earning = earningVoiceMembers(guild);
        await VoiceActivityService.addCountedTime(guild.id, earning)
            .catch(error => console.error(`Voice stats for ${guild.id} failed:`, error.message || error));
        const settings = (await GuildSettingsService.get(guild.id)).economy;
        if (!settings.enabled) continue;
        await mapLimit(earning, async member => {
            try {
                const result = await EconomyService.credit(guild.id, member, { exp: EXP_PER_MINUTE, money: COINS_PER_MINUTE, voiceSeconds: 60 });
                await celebrate(guild, member, result, settings);
            } catch (error) {
                console.error(`Economy: voice credit for ${member.id} failed:`, error.message || error);
            }
        });
    }
}

/**
 * Give every member the level roles they have reached (after setting the roles up,
 * or after the import). @returns {{ given: number, failed: number }}
 */
async function syncLevelRoles(guild, levelRoles) {
    if (levelRoles.length === 0) return { given: 0, failed: 0 };
    const lowest = Math.min(...levelRoles.map(entry => entry.level));
    await guild.members.fetch();
    let given = 0;
    let failed = 0;
    const members = [...guild.members.cache.values()].filter(member => !member.user.bot);
    await mapLimit(members, async member => {
        const account = await EconomyService.get(guild.id, member.id);
        if (!account || account.level < lowest) return;
        for (const role of missingLevelRoles(guild, member, account.level, levelRoles)) {
            try {
                await member.roles.add(role, `Уровень ${account.level}`);
                given++;
            } catch {
                failed++;
            }
        }
    });
    return { given, failed };
}

/** Mark as left the accounts of people who left while the bot was offline. */
async function reconcileLeft(guild) {
    const ids = await EconomyService.presentIds(guild.id);
    if (ids.length === 0) return 0;
    await guild.members.fetch();
    const gone = ids.filter(id => !guild.members.cache.has(id));
    for (const id of gone) await EconomyService.markLeft(guild.id, id);
    return gone.length;
}

/** Daily housekeeping: catch up on who left, unlink those past the grace period, delete those away too long. */
async function housekeeping(client) {
    for (const guild of client.guilds.cache.values()) {
        try {
            const gone = await reconcileLeft(guild);
            if (gone) console.log(`Economy: ${gone} account(s) in ${guild.id} marked as left`);
        } catch (error) {
            console.error(`Economy: reconcile in ${guild.id} failed:`, error.message || error);
        }
    }
    const unlinked = await EconomyService.unlinkExpired();
    if (unlinked) console.log(`Economy: ${unlinked} account(s) of members who left are no longer linkable`);
    const deleted = await EconomyService.purgeLeft();
    if (deleted) console.log(`Economy: deleted ${deleted} account(s) of members who left`);
}

/**
 * Buttons and menus: eco:duel:yes|no:<id>, eco:shop:pick (role menu), eco:shop:buy:<roleId>.
 */
async function handleInteraction(interaction) {
    const [, area, action, id] = String(interaction.customId).split(':');
    const guild = interaction.guild;
    if (!guild) return;

    if (area === 'duel' && interaction.isButton()) {
        const result = await games.answer(guild, id, interaction.member, action === 'yes');
        if (!result.ok && (result.code === 'not_opponent' || result.code === 'duel_gone')) {
            await interaction.reply({ content: describe(result), flags: MessageFlags.Ephemeral });
            if (result.code === 'duel_gone') await interaction.message.edit({ components: [] }).catch(() => {});
            return;
        }
        const duel = result.duel;
        let text;
        if (!result.ok) text = result.code === 'challenger_broke'
            ? `⚔️ Дуэль отменена: у <@${duel.challengerId}> не хватает монет.`
            : `⚔️ Дуэль отменена: у <@${duel.opponentId}> не хватает монет.`;
        else if (result.declined) text = `⚔️ <@${duel.opponentId}> отказался от дуэли с <@${duel.challengerId}>.`;
        else text = `⚔️ Дуэль <@${duel.challengerId}> и <@${duel.opponentId}> на ${number(duel.bet)}: побеждает <@${result.winnerId}> и забирает **${number(result.prize)}**!`;
        await interaction.update({ content: text, components: [], allowedMentions: { users: result.ok && !result.declined ? [result.winnerId, result.loserId] : [] } });
        return;
    }

    if (area === 'shop' && action === 'pick' && interaction.isStringSelectMenu()) {
        await interaction.update(await buildOffer(guild, interaction.values[0]));
        return;
    }

    if (area === 'shop' && action === 'buy' && interaction.isButton()) {
        await interaction.deferUpdate();
        const result = await PersonalRoleService.buy(guild, interaction.member, id);
        const content = result.ok
            ? `Куплено: <@&${result.role.id}> ваша до <t:${Math.floor(Date.parse(result.expiresAt) / 1000)}:D>. Баланс: ${number(result.balance)}.`
            : describe(result);
        await interaction.editReply({ content, embeds: [], components: [], allowedMentions: { parse: [] } });
    }
}

module.exports = {
    name: 'economy',
    interactionPrefix: 'eco',
    handleInteraction,
    EXP_PER_MINUTE,
    earningVoiceMembers,
    missingLevelRoles,
    levelLabel,
    celebrate,
    onMessage,
    voiceTick,
    syncLevelRoles,
    reconcileLeft,
    housekeeping,
    curve,

    register(client) {
        client.on(Events.MessageCreate, message => {
            onMessage(message).catch(error => console.error('Economy: message credit failed:', error.message || error));
        });
        client.on(Events.GuildMemberRemove, member => {
            if (member.user?.bot) return;
            EconomyService.markLeft(member.guild.id, member.id)
                .catch(error => console.error(`Economy: marking ${member.id} as left failed:`, error.message || error));
            PersonalRoleService.memberLeft(member.guild.id, member.id)
                .catch(error => console.error(`PersonalRoles: ${member.id} left, update failed:`, error.message || error));
        });
        client.on(Events.GuildMemberAdd, member => {
            if (member.user?.bot) return;
            EconomyService.markReturned(member.guild.id, member)
                .catch(error => console.error(`Economy: restoring ${member.id} failed:`, error.message || error));
            PersonalRoleService.memberReturned(member.guild, member)
                .catch(error => console.error(`PersonalRoles: restoring ${member.id} failed:`, error.message || error));
        });
    },

    async onReady(client) {
        cron.schedule('* * * * *', () => {
            voiceTick(client).catch(error => console.error('Economy: voice tick failed:', error.message || error));
            PersonalRoleService.processDue(client).catch(error => console.error('PersonalRoles: due check failed:', error.message || error));
        });
        const tidy = () => housekeeping(client).catch(error => console.error('Economy: housekeeping failed:', error.message || error));
        cron.schedule('30 3 * * *', tidy);
        await tidy();
    }
};
