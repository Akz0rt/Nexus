// Fake guild with voice channels for the voice tests (not a test itself).

const { ChannelType, Collection, PermissionFlagsBits } = require('discord.js');

const ALL = () => true;

function makeChannel(guild, { id, name, parentId = null, position = 0, type = ChannelType.GuildVoice, connect = ALL }) {
    const channel = {
        id,
        name,
        type,
        guild,
        parentId,
        parent: parentId ? guild.channels.cache.get(parentId) : null,
        rawPosition: position,
        userLimit: 0,
        members: new Collection(),
        edits: [],
        overwriteEdits: [],
        permissionOverwrites: {
            cache: new Collection(),
            edit: async (role, options) => {
                channel.overwriteEdits.push(options);
                const deny = options.Connect === false;
                channel.permissionOverwrites.cache.set(role.id, { deny: { has: flag => deny && flag === PermissionFlagsBits.Connect } });
            }
        },
        // connect(memberId) decides Connect for that member; everything else is allowed
        permissionsFor: member => ({ has: flag => flag !== PermissionFlagsBits.Connect || connect(member.id) }),
        edit: async patch => {
            channel.edits.push(patch);
            if (patch.name) channel.name = patch.name;
            if (patch.userLimit !== undefined) channel.userLimit = patch.userLimit;
        }
    };
    guild.channels.cache.set(id, channel);
    return channel;
}

/**
 * @param {{ position?: number, perms?: (flag: bigint) => boolean, channelId?: string|null,
 *           bot?: boolean, dmClosed?: boolean, roleIds?: string[] }} options
 */
function makeMember(guild, id, { position = 1, perms = () => false, channelId = null, bot = false, dmClosed = false, roleIds = [] } = {}) {
    const member = {
        id,
        displayName: `name-${id}`,
        joinedAt: new Date(),
        user: {
            id,
            bot,
            username: `user-${id}`,
            createdTimestamp: Date.now() - 1e10,
            displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png'
        },
        roles: {
            highest: { position },
            cache: new Collection(roleIds.map(roleId => [roleId, { id: roleId, name: roleId, position: 1, hexColor: '#000000' }])),
            add: async role => { member.roles.cache.set(role.id, role); },
            remove: async role => { member.roles.cache.delete(role.id); }
        },
        permissions: { has: perms },
        communicationDisabledUntilTimestamp: null,
        dms: [],
        send: async text => {
            if (dmClosed) throw Object.assign(new Error('Cannot send messages to this user'), { code: 50007 });
            member.dms.push(text);
        },
        voice: {
            channelId: null,
            serverMute: false,
            serverDeaf: false,
            setChannel: async targetId => {
                if (member.voice.failWith) throw Object.assign(new Error('fail'), { code: member.voice.failWith });
                if (!member.voice.channelId) throw Object.assign(new Error('Not connected'), { code: 40032 });
                guild.channels.cache.get(member.voice.channelId).members.delete(id);
                member.voice.channelId = targetId;
                guild.channels.cache.get(targetId).members.set(id, member);
            },
            setMute: async on => {
                if (member.voice.failWith) throw Object.assign(new Error('fail'), { code: member.voice.failWith });
                member.voice.serverMute = on;
            },
            setDeaf: async on => { member.voice.serverDeaf = on; },
            disconnect: async () => {
                guild.channels.cache.get(member.voice.channelId).members.delete(id);
                member.voice.channelId = null;
            }
        }
    };
    guild.members.cache.set(id, member);
    if (channelId) {
        member.voice.channelId = channelId;
        guild.channels.cache.get(channelId).members.set(id, member);
    }
    return member;
}

function makeGuild({ ownerId = 'owner' } = {}) {
    const guild = {
        id: '900000000000000009',
        name: 'Тестовый',
        ownerId,
        memberCount: 0,
        channels: { cache: new Collection() },
        roles: { cache: new Collection(), everyone: { id: '900000000000000009' } },
        members: {
            cache: new Collection(),
            me: null,
            fetch: async arg => {
                const id = typeof arg === 'string' ? arg : arg?.user;
                const member = guild.members.cache.get(id);
                if (!member) throw Object.assign(new Error('Unknown Member'), { code: 10007 });
                return member;
            }
        }
    };
    guild.members.me = { id: 'bot', permissions: { has: ALL } };
    return guild;
}

module.exports = { makeGuild, makeChannel, makeMember, ALL };
