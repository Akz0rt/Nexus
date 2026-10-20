import React, { useEffect, useMemo, useRef, useState } from 'react';
import { apiGet, apiPost, describeError } from './api.js';
import { GENDER_LABELS } from './format.js';
import Avatar from './Avatar.jsx';
import Icon from './icons.jsx';
import Dialog from './Dialog.jsx';
import PunishDialog, { useModerationOptions } from './PunishDialog.jsx';
import { BoosterDialog } from './BoostersTab.jsx';
import { EXAMPLES, durationLabel, matchDuration, parseCommand } from './commands.js';

const UNDO_TOAST_MS = 10000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MEMBERS_SHOWN = 5;

// «Экраны»: where Enter goes; `tab` opens a tab of that screen
const SCREENS = [
    { view: 'overview', label: 'Обзор' },
    { view: 'queue', label: 'Пропуск', words: 'очередь новички' },
    { view: 'queue', tab: 'boosters', label: 'Пропуск → Бустеры', words: 'бустеры буст' },
    { view: 'voice', label: 'Голосовые', words: 'доска голос' },
    { view: 'moderation', label: 'Модерация', words: 'наказания муты баны варны' },
    { view: 'moderation', tab: 'reports', label: 'Модерация → Жалобы', words: 'жалобы репорты' },
    { view: 'roles', label: 'Роли' },
    { view: 'events', label: 'Ивенты', words: 'события' },
    { view: 'birthdays', label: 'Дни рождения', words: 'др' },
    { view: 'economy', label: 'Экономика', words: 'уровни монеты' },
    { view: 'activity', label: 'Активность' },
    { view: 'stats', label: 'Статистика' },
    { view: 'journal', label: 'Журнал', words: 'лог' },
    { view: 'settings', label: 'Настройки', senior: true }
];

const KIND_LABELS = { mute: 'Мут', warn: 'Варн', kick: 'Кик', ban: 'Бан', unmute: 'Снять мут', pass: 'Пропустить', booster: 'Буст-аккаунт', journal: 'Журнал' };
const GROUP_TITLES = { commands: 'Команды', members: 'Участники', channels: 'Голосовые каналы', screens: 'Экраны', examples: 'Например' };

const norm = text => String(text || '').toLowerCase().replace(/ё/g, 'е');

/** Voice channels by name: the exact one first, then those that contain it */
function findChannels(channels, query) {
    const q = norm(query).trim();
    if (!q) return [];
    return channels
        .filter(channel => norm(channel.name).includes(q))
        .sort((a, b) => Number(norm(b.name) === q) - Number(norm(a.name) === q) || a.name.length - b.name.length);
}

/**
 * The topbar's search and command field (Ctrl+K). Groups: Команды / Участники /
 * Голосовые каналы / Экраны. Safe commands run at once («пропустить» with «Отменить»,
 * «снять мут»); punishments and the booster term open their usual dialogs prefilled;
 * a move and Lockdown are confirmed first.
 */
export default function CommandBar({ guildId, canLockdown, senior, actions, toast }) {
    const [query, setQuery] = useState('');
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(0);
    const [members, setMembers] = useState({ q: '', items: [] });
    const [channels, setChannels] = useState(null);
    const [dialog, setDialog] = useState(null);
    const inputRef = useRef(null);
    const options = useModerationOptions(guildId);
    const command = useMemo(() => parseCommand(query), [query]);
    // What to look people up by: the command's member, or the whole text
    const memberQuery = command ? (command.member || '') : query.trim();

    // Ctrl+K focuses the bar from anywhere
    useEffect(() => {
        const onKey = event => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
                event.preventDefault();
                inputRef.current?.focus();
                inputRef.current?.select();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    useEffect(() => { setChannels(null); setMembers({ q: '', items: [] }); }, [guildId]);

    // Voice channels once the bar is used (the board, without the people)
    useEffect(() => {
        if (!open || channels || !guildId) return;
        apiGet(`/guilds/${guildId}/voice`)
            .then(board => setChannels(board.categories.flatMap(c => c.channels.map(ch => ({ id: ch.id, name: ch.name, people: ch.members.length, category: c.name })))))
            .catch(() => setChannels([]));
    }, [open, channels, guildId]);

    useEffect(() => {
        const q = memberQuery.trim();
        if (!guildId || q.length < 2 || (command && ['move', 'lockdown'].includes(command.kind))) { setMembers({ q, items: [] }); return undefined; }
        let cancelled = false;
        const timer = setTimeout(() => {
            apiGet(`/guilds/${guildId}/members/search?q=${encodeURIComponent(q)}`)
                .then(data => { if (!cancelled) setMembers({ q, items: data.items.filter(m => !m.bot).slice(0, MEMBERS_SHOWN) }); })
                .catch(() => { if (!cancelled) setMembers({ q, items: [] }); });
        }, 180);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [memberQuery, guildId, command]);

    const close = () => { setOpen(false); setQuery(''); setActive(0); inputRef.current?.blur(); };

    const approve = async (member, gender) => {
        const result = await apiPost(`/guilds/${guildId}/queue/${member.id}/approve`, { gender });
        actions.onQueueChanged();
        if (!result.ok) { toast(describeError(result), { tone: 'error' }); return; }
        toast(`Пропущен ${member.displayName} · ${GENDER_LABELS[gender]}`, {
            ttl: UNDO_TOAST_MS,
            action: {
                label: 'Отменить',
                onClick: async () => {
                    const undo = await apiPost(`/guilds/${guildId}/queue/${member.id}/undo`);
                    toast(undo.ok ? `${member.displayName} снова в очереди` : describeError(undo), { tone: undo.ok ? null : 'error' });
                    actions.onQueueChanged();
                }
            }
        });
    };
    const unmute = async member => {
        const result = await apiPost(`/guilds/${guildId}/moderation/${member.id}/unmute`);
        toast(result.ok ? `Мут снят: ${member.displayName}` : describeError(result), result.ok ? {} : { tone: 'error' });
    };

    // --- what the list offers -----------------------------------------------------
    const items = [];
    const add = (group, item) => items.push({ group, ...item });
    const typed = query.trim();
    const searching = memberQuery.trim().length >= 2 && members.q !== memberQuery.trim();

    if (command) {
        const { kind } = command;
        if (kind === 'lockdown') {
            add('commands', {
                key: 'lockdown', icon: 'lock', label: 'Lockdown: закрыть сервер для новичков', sub: 'покажем, что именно будет сделано, и спросим',
                disabled: !canLockdown, hint: 'только администраторам', run: () => actions.onLockdown()
            });
        } else if (kind === 'move') {
            const from = findChannels(channels || [], command.from).slice(0, 2);
            const to = command.to ? findChannels(channels || [], command.to).slice(0, 2) : [];
            if (command.missing || from.length === 0 || to.length === 0) {
                add('commands', {
                    key: 'move-hint', icon: 'voice', label: 'Перенести всех из канала в канал', disabled: true,
                    sub: command.missing ? `допишите, ${command.missing}: «перенести Болталка в Мафия»`
                        : from.length === 0 ? `нет канала «${command.from}»` : `нет канала «${command.to}»`
                });
            }
            for (const source of from) {
                for (const target of to.filter(channel => channel.id !== source.id)) {
                    add('commands', {
                        key: `move-${source.id}-${target.id}`, icon: 'voice',
                        label: `Перенести всех из «${source.name}» в «${target.name}»`,
                        sub: source.people ? `${source.people} чел.` : 'сейчас там никого', disabled: !source.people,
                        run: () => setDialog({ type: 'move', source, target })
                    });
                }
            }
        } else if (command.missing === 'ник') {
            add('commands', { key: 'need-member', icon: 'search', label: `${KIND_LABELS[kind]}: кому?`, sub: 'допишите ник, ID или @упоминание', disabled: true });
        } else {
            for (const member of members.items) {
                const base = { key: `${kind}-${member.id}`, member };
                if (kind === 'mute') {
                    const option = command.durationMs && matchDuration(command.durationMs, options?.muteDurations);
                    add('commands', {
                        ...base, label: `Мут${option ? ` на ${option.label}` : ''}: ${member.displayName}`, sub: command.reason || 'причину спросим в диалоге',
                        disabled: !option, hint: command.durationMs ? 'такого срока нет: 10м, 1ч, 6ч, 1д, 7д' : 'допишите срок: 10м, 1ч, 6ч, 1д, 7д',
                        run: () => setDialog({ type: 'punish', kind, member, initial: { duration: option.id, reason: command.reason } })
                    });
                } else if (kind === 'ban') {
                    const option = command.durationMs ? matchDuration(command.durationMs, options?.banDurations) : { id: 'forever', label: 'навсегда' };
                    add('commands', {
                        ...base, label: `Бан ${option ? option.label : durationLabel(command.durationMs)}: ${member.displayName}`, sub: command.reason || 'причину спросим в диалоге',
                        disabled: !option, hint: 'такого срока нет: 7д, 30д или без срока — навсегда',
                        run: () => setDialog({ type: 'punish', kind, member, initial: { duration: option.id, reason: command.reason } })
                    });
                } else if (kind === 'warn' || kind === 'kick') {
                    add('commands', {
                        ...base, label: `${KIND_LABELS[kind]}: ${member.displayName}`, sub: command.reason || 'причину спросим в диалоге',
                        run: () => setDialog({ type: 'punish', kind, member, initial: { reason: command.reason } })
                    });
                } else if (kind === 'unmute') {
                    add('commands', { ...base, label: `Снять мут: ${member.displayName}`, sub: 'сразу', run: () => unmute(member) });
                } else if (kind === 'pass') {
                    add('commands', {
                        ...base, label: `Пропустить ${member.displayName}${command.gender ? ` · ${GENDER_LABELS[command.gender]}` : ''}`,
                        sub: 'сразу, в уведомлении будет «Отменить»', disabled: !command.gender, hint: 'допишите: парень или девушка',
                        run: () => approve(member, command.gender)
                    });
                } else if (kind === 'booster') {
                    const days = command.durationMs ? Math.round(command.durationMs / DAY_MS) : null;
                    add('commands', {
                        ...base, label: `Буст-аккаунт${days ? ` на ${days} дн.` : ''}: ${member.displayName}`, sub: 'срок проверим в диалоге',
                        disabled: !days, hint: 'допишите срок в днях: 30д',
                        run: () => setDialog({ type: 'booster', member, days })
                    });
                } else if (kind === 'journal') {
                    add('commands', { ...base, label: `Журнал: ${member.displayName}`, sub: 'все записи о человеке', run: () => actions.onOpenJournal({ targetId: member.id }) });
                }
            }
        }
    } else if (typed) {
        for (const member of members.items) {
            add('members', { key: `m-${member.id}`, member, label: member.displayName, sub: `@${member.username}`, run: () => actions.onOpenMember(member.id) });
        }
        for (const channel of findChannels(channels || [], typed).slice(0, 4)) {
            add('channels', {
                key: `c-${channel.id}`, icon: 'voice', label: channel.name, sub: `${channel.category || 'без категории'} · ${channel.people ? `${channel.people} чел.` : 'пусто'}`,
                run: () => actions.onFocusVoice(channel.id)
            });
        }
        const q = norm(typed);
        for (const screen of SCREENS.filter(s => !s.senior || senior).filter(s => norm(`${s.label} ${s.words || ''}`).includes(q)).slice(0, 4)) {
            add('screens', { key: `s-${screen.view}-${screen.tab || ''}`, icon: 'chevron', label: screen.label, run: () => actions.onOpenTab(screen.view, screen.tab) });
        }
    } else {
        for (const example of EXAMPLES) add('examples', { key: example.text, label: example.text, sub: example.note, keepOpen: true, run: () => setQuery(example.text.replace('@ник', '@')) });
    }

    const enabled = items.map((item, index) => (item.disabled ? -1 : index)).filter(index => index >= 0);
    const current = enabled.includes(active) ? active : enabled[0] ?? -1;

    const choose = item => {
        if (!item || item.disabled) return;
        if (item.keepOpen) { item.run(); inputRef.current?.focus(); return; }
        close();
        item.run();
    };

    const onKeyDown = event => {
        const position = enabled.indexOf(current);
        if (event.key === 'ArrowDown') { event.preventDefault(); setActive(enabled[(position + 1) % enabled.length] ?? 0); }
        if (event.key === 'ArrowUp') { event.preventDefault(); setActive(enabled[(position - 1 + enabled.length) % enabled.length] ?? 0); }
        if (event.key === 'Enter') { event.preventDefault(); choose(items[current]); }
        if (event.key === 'Escape') { event.preventDefault(); close(); }
    };

    let lastGroup = null;
    return (
        <div className="search command-bar">
            <Icon name="search" size={16} strokeWidth={2} className="search-icon" />
            <input
                ref={inputRef}
                type="search"
                placeholder="Участник, канал или команда: «мут @ник 1ч»"
                aria-label="Поиск и команды"
                aria-expanded={open}
                aria-controls="command-list"
                role="combobox"
                value={query}
                onChange={e => { setQuery(e.target.value); setOpen(true); setActive(0); }}
                onFocus={() => setOpen(true)}
                onBlur={() => setTimeout(() => setOpen(false), 150)}
                onKeyDown={onKeyDown}
            />
            <kbd className="search-hint">Ctrl K</kbd>
            {open && (
                <ul id="command-list" className="search-results command-list" role="listbox" aria-label="Результаты">
                    {items.map((item, index) => {
                        const header = item.group !== lastGroup ? <li key={`h-${item.group}`} className="command-group" role="presentation">{GROUP_TITLES[item.group]}</li> : null;
                        lastGroup = item.group;
                        return (
                            <React.Fragment key={item.key}>
                                {header}
                                <li role="option" aria-selected={index === current} aria-disabled={item.disabled || undefined}
                                    className={`${index === current ? 'is-active' : ''} ${item.disabled ? 'is-disabled' : ''}`}
                                    onMouseDown={event => { event.preventDefault(); choose(item); }}
                                    onMouseEnter={() => !item.disabled && setActive(index)}>
                                    {item.member
                                        ? <Avatar id={item.member.id} src={item.member.avatarURL} name={item.member.displayName} size={24} />
                                        : <span className="command-icon"><Icon name={item.icon || 'search'} size={15} /></span>}
                                    <span className="command-text">
                                        <span>{item.label}</span>
                                        {(item.disabled && item.hint) || item.sub ? <span className="muted small">{item.disabled && item.hint ? item.hint : item.sub}</span> : null}
                                    </span>
                                    {index === current && <kbd className="command-enter">Enter</kbd>}
                                </li>
                            </React.Fragment>
                        );
                    })}
                    {items.length === 0 && (
                        <li className="muted small search-empty">{searching || (open && typed && !channels) ? 'Ищем…' : 'Ничего не нашлось.'}</li>
                    )}
                </ul>
            )}

            {dialog?.type === 'punish' && (
                <PunishDialog guildId={guildId} kind={dialog.kind} target={{ id: dialog.member.id, displayName: dialog.member.displayName }}
                    initial={dialog.initial} onClose={() => setDialog(null)} toast={toast} />
            )}
            {dialog?.type === 'booster' && (
                <BoosterDialog title={`${dialog.member.displayName} — буст-аккаунт`} initialDays={dialog.days} submitLabel="Отметить бустером"
                    onClose={() => setDialog(null)}
                    onSubmit={async ({ until, note }) => {
                        const result = await apiPost(`/guilds/${guildId}/queue/boosters`, { userIds: [dialog.member.id], until, note });
                        const ok = result.ok && result.data.done.length > 0;
                        toast(ok ? `${dialog.member.displayName} — буст-аккаунт` : describeError(result.ok ? { error: result.data.failed[0]?.code } : result), ok ? {} : { tone: 'error' });
                        if (ok) { setDialog(null); actions.onQueueChanged(); }
                    }} />
            )}
            {dialog?.type === 'move' && (
                <Dialog title={`Перенести всех из «${dialog.source.name}» в «${dialog.target.name}»?`} submitLabel={`Перенести ${dialog.source.people}`}
                    onClose={() => setDialog(null)}
                    onSubmit={async () => {
                        const result = await apiPost(`/guilds/${guildId}/voice/gather`, { channelId: dialog.target.id, fromChannelIds: [dialog.source.id], background: true });
                        setDialog(null);
                        if (!result.ok) toast(describeError(result), { tone: 'error' });
                    }}>
                    <p className="muted small">Ход переноса покажется внизу справа, там же «Отменить всё».</p>
                </Dialog>
            )}
        </div>
    );
}
