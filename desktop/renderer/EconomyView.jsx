import React, { useEffect, useState } from 'react';
import { apiGet, apiPost, apiPut, describeError } from './api.js';
import { formatDateTime } from './format.js';
import Avatar, { MemberLink } from './Avatar.jsx';
import Dialog from './Dialog.jsx';

const BY = [{ id: 'level', label: 'По уровню' }, { id: 'money', label: 'По балансу' }];

const ADJUST_ERRORS = {
    invalid_amount: 'Укажите сумму — целое число.',
    invalid_reason: 'Укажите причину.',
    insufficient_funds: 'На балансе меньше, чем вы хотите забрать.',
    member_not_found: 'Этого человека нет на сервере.'
};

const SETTINGS_ERRORS = {
    channel_not_found: 'Выберите существующий текстовый канал.',
    bot_cannot_channel: 'Бот не может писать в этот канал: нужны «Просматривать», «Отправлять сообщения» и «Встраивать ссылки».',
    invalid_level: 'Уровень роли — от 2 до 50.',
    role_higher: 'Роль выше вашей: её нельзя выдавать за уровень.',
    bot_cannot_role: 'Роль выше роли бота: он не сможет её выдать.',
    role_managed: 'Эту роль выдаёт интеграция, её нельзя выдавать за уровень.',
    role_dangerous: 'Роль с модераторскими правами нельзя выдавать за уровень.',
    duplicate_role: 'Одна роль указана дважды.',
    role_not_found: 'Роль не найдена.'
};

export const number = n => Number(n || 0).toLocaleString('ru-RU');

export function LevelBadge({ level, prestige }) {
    return (
        <span className="level-badge numeric">
            {level}
            {prestige > 0 && <span className="prestige" title={`Престиж ${prestige}`}>★{prestige}</span>}
        </span>
    );
}

export function XpBar({ exp, cost }) {
    const share = Math.min(1, exp / cost);
    return (
        <span className="xp-bar" role="img" aria-label={`${number(exp)} из ${number(cost)} опыта`} title={`${number(exp)} / ${number(cost)}`}>
            <span style={{ width: `${share * 100}%` }} />
        </span>
    );
}

const hours = seconds => `${number(Math.floor((seconds || 0) / 3600))} ч`;

/** Give (+) or take (−) coins by hand. */
export function AdjustDialog({ guildId, userId, name, onClose, onDone, toast }) {
    const [mode, setMode] = useState('give');
    const [amount, setAmount] = useState('');
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const submit = async () => {
        const size = Number(amount);
        if (!Number.isInteger(size) || size <= 0) { setError(ADJUST_ERRORS.invalid_amount); return; }
        if (!reason.trim()) { setError(ADJUST_ERRORS.invalid_reason); return; }
        setBusy(true);
        const result = await apiPost(`/guilds/${guildId}/economy/members/${userId}/adjust`, { amount: mode === 'give' ? size : -size, reason });
        setBusy(false);
        if (!result.ok) { setError(ADJUST_ERRORS[result.error] || describeError(result)); return; }
        toast(`${mode === 'give' ? 'Выдано' : 'Забрано'} ${number(size)} · баланс ${number(result.data.account.money)}`);
        onDone?.();
        onClose();
    };
    return (
        <Dialog title={`Монеты: ${name}`} onClose={onClose} onSubmit={submit} busy={busy} submitLabel={mode === 'give' ? 'Выдать' : 'Забрать'}>
            <div className="segmented" role="group" aria-label="Действие">
                <button type="button" className={`tab ${mode === 'give' ? 'is-active' : ''}`} aria-pressed={mode === 'give'} onClick={() => setMode('give')}>Выдать</button>
                <button type="button" className={`tab ${mode === 'take' ? 'is-active' : ''}`} aria-pressed={mode === 'take'} onClick={() => setMode('take')}>Забрать</button>
            </div>
            <label className="field">
                Сумма
                <input type="number" min="1" step="1" autoFocus value={amount} onChange={e => setAmount(e.target.value)} />
            </label>
            <label className="field">
                Причина (видна в журнале)
                <input value={reason} maxLength={200} placeholder="Победа в ивенте" onChange={e => setReason(e.target.value)} />
            </label>
            {error && <p className="error">{error}</p>}
        </Dialog>
    );
}

/** Level, balance and recent operations in the member card. */
export function EconomyBlock({ guildId, userId, name, revision, toast }) {
    const [data, setData] = useState(null);
    const [adjusting, setAdjusting] = useState(false);
    const [reload, setReload] = useState(0);
    useEffect(() => {
        let cancelled = false;
        apiGet(`/guilds/${guildId}/economy/members/${userId}`)
            .then(result => { if (!cancelled) setData(result); })
            .catch(() => { if (!cancelled) setData(null); });
        return () => { cancelled = true; };
    }, [guildId, userId, revision, reload]);
    if (!data) return null;
    const account = data.account;
    return (
        <>
            <h3>Экономика</h3>
            {!account && <p className="muted small">Опыта и монет пока нет.</p>}
            {account && (
                <>
                    <dl className="facts">
                        <div><dt>Уровень</dt><dd><LevelBadge level={account.level} prestige={account.prestige} /> · {account.levelRank}-е место</dd></div>
                        <div><dt>{account.level >= 50 ? 'До престижа' : 'До следующего'}</dt><dd className="xp-line"><XpBar exp={account.exp} cost={account.cost} /> <span className="numeric small">{number(account.exp)} / {number(account.cost)}</span></dd></div>
                        <div><dt>Баланс</dt><dd className="numeric">{number(account.money)} монет · {account.moneyRank}-е место</dd></div>
                        <div><dt>В голосе</dt><dd className="numeric">{hours(account.voiceSeconds)} · {number(account.messages)} сообщ.</dd></div>
                    </dl>
                    {data.transactions.length > 0 && (
                        <ol className="history">
                            {data.transactions.slice(0, 8).map(tx => (
                                <li key={tx.id}>
                                    <span className="numeric muted small">{formatDateTime(tx.createdAt)}</span>
                                    <span>
                                        <span className={`numeric ${tx.amount > 0 ? 'tx-plus' : 'tx-minus'}`}>{tx.amount > 0 ? '+' : '−'}{number(Math.abs(tx.amount))}</span>
                                        {' '}{tx.cause.replace(/<@&\d+>/g, '@роль')}
                                    </span>
                                    <span className="muted small">{tx.balance !== null ? `баланс ${number(tx.balance)}` : ''}{tx.source === 'import' ? ' · старый бот' : ''}</span>
                                </li>
                            ))}
                        </ol>
                    )}
                </>
            )}
            {data.canManage && (
                <div className="punish-row">
                    <button className="btn" onClick={() => setAdjusting(true)}>Выдать / забрать монеты</button>
                </div>
            )}
            {adjusting && (
                <AdjustDialog guildId={guildId} userId={userId} name={name} onClose={() => setAdjusting(false)} onDone={() => setReload(n => n + 1)} toast={toast} />
            )}
        </>
    );
}

function SettingsTab({ guildId, data, onSaved, toast }) {
    const [enabled, setEnabled] = useState(data.settings.enabled);
    const [channelId, setChannelId] = useState(data.settings.channelId || '');
    const [levelRoles, setLevelRoles] = useState(data.settings.levelRoles.map(r => ({ level: String(r.level), roleId: r.roleId })));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [syncing, setSyncing] = useState(false);

    const save = async () => {
        setBusy(true);
        const result = await apiPut(`/guilds/${guildId}/economy/settings`, {
            enabled, channelId: channelId || null,
            levelRoles: levelRoles.filter(r => r.roleId).map(r => ({ level: Number(r.level), roleId: r.roleId }))
        });
        setBusy(false);
        if (!result.ok) {
            const text = SETTINGS_ERRORS[result.error] || describeError(result);
            setError(result.body?.roleName ? `${result.body.roleName}: ${text}` : text);
            return;
        }
        setError(null);
        toast('Настройки экономики сохранены');
        onSaved();
    };
    const sync = async () => {
        setSyncing(true);
        const result = await apiPost(`/guilds/${guildId}/economy/sync-roles`);
        setSyncing(false);
        if (!result.ok) { toast(describeError(result), { tone: 'error' }); return; }
        toast(`Ролей выдано: ${result.data.given}${result.data.failed ? ` · не удалось: ${result.data.failed}` : ''}`, result.data.failed ? { tone: 'error' } : {});
    };
    const setRole = (index, patch) => setLevelRoles(rows => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

    return (
        <div className="economy-settings">
            <label className="check">
                <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
                Начислять опыт и монеты за активность
            </label>
            <p className="muted small">
                Минута в голосе (не в AFK, не заглушённым и не одному) или сообщение раз в минуту — 60 опыта и 1 монета.
                Включайте после переноса данных из старого бота и после того, как старый бот выключен, иначе монеты начислятся дважды.
            </p>
            <label className="field">
                Канал для объявлений о новых уровнях
                <select value={channelId} onChange={e => setChannelId(e.target.value)}>
                    <option value="">— не объявлять —</option>
                    {data.channels.map(c => <option key={c.id} value={c.id}>{c.category ? `${c.category} · ` : ''}#{c.name}</option>)}
                </select>
            </label>
            <h2 className="section-title">Роли за уровни</h2>
            <p className="muted small">Роль выдаётся, когда участник достигает уровня, и остаётся с ним. Роли за предыдущие уровни не снимаются.</p>
            <ul className="level-roles">
                {levelRoles.map((row, index) => (
                    <li key={index}>
                        <label className="field">
                            Уровень
                            <input type="number" min="2" max="50" value={row.level} onChange={e => setRole(index, { level: e.target.value })} />
                        </label>
                        <label className="field">
                            Роль
                            <select value={row.roleId} onChange={e => setRole(index, { roleId: e.target.value })}>
                                <option value="">— выберите —</option>
                                {data.roles.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}
                                {row.roleId && !data.roles.some(role => role.id === row.roleId) && <option value={row.roleId}>(недоступная роль)</option>}
                            </select>
                        </label>
                        <button type="button" className="btn btn-quiet" onClick={() => setLevelRoles(rows => rows.filter((_, i) => i !== index))} aria-label="Убрать">✕</button>
                    </li>
                ))}
            </ul>
            <div className="save-bar">
                <button type="button" className="btn" disabled={levelRoles.length >= 20} onClick={() => setLevelRoles(rows => [...rows, { level: '5', roleId: '' }])}>+ роль за уровень</button>
                <button type="button" className="btn" disabled={syncing || data.settings.levelRoles.length === 0} onClick={sync}
                    title="Выдать всем участникам роли за уже достигнутые уровни (например, после переноса)">
                    {syncing ? 'Выдаём…' : 'Выдать роли по уровням всем'}
                </button>
            </div>
            {error && <p className="error">{error}</p>}
            <div className="save-bar">
                <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Сохраняем…' : 'Сохранить'}</button>
            </div>
        </div>
    );
}

export default function EconomyView({ guildId, revision, onOpenMember, toast }) {
    const [tab, setTab] = useState('top');
    const [by, setBy] = useState('level');
    const [query, setQuery] = useState('');
    const [search, setSearch] = useState('');
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [reload, setReload] = useState(0);

    useEffect(() => {
        const timer = setTimeout(() => setSearch(query.trim()), 300);
        return () => clearTimeout(timer);
    }, [query]);

    useEffect(() => {
        let cancelled = false;
        apiGet(`/guilds/${guildId}/economy?by=${by}${search ? `&q=${encodeURIComponent(search)}` : ''}`)
            .then(result => { if (!cancelled) { setData(result); setError(null); } })
            .catch(err => { if (!cancelled) setError(describeError(err)); });
        return () => { cancelled = true; };
    }, [guildId, by, search, revision, reload]);

    return (
        <section className="view view-wide">
            <div className="view-head">
                <h1>Экономика</h1>
                {data?.canManage && (
                    <div className="segmented" role="tablist">
                        <button role="tab" aria-selected={tab === 'top'} className={`tab ${tab === 'top' ? 'is-active' : ''}`} onClick={() => setTab('top')}>Топ</button>
                        <button role="tab" aria-selected={tab === 'settings'} className={`tab ${tab === 'settings' ? 'is-active' : ''}`} onClick={() => setTab('settings')}>Настройки</button>
                    </div>
                )}
            </div>
            {error && <p className="error">{error}</p>}
            {!data && !error && <p className="muted">Загружаем…</p>}
            {data && !data.settings.enabled && tab === 'top' && (
                <p className="notice">Начисление за активность выключено{data.canManage ? ' — включается во вкладке «Настройки».' : '.'}</p>
            )}
            {data && tab === 'settings' && data.canManage && (
                <SettingsTab key={JSON.stringify(data.settings)} guildId={guildId} data={data} onSaved={() => setReload(n => n + 1)} toast={toast} />
            )}
            {data && tab === 'top' && (
                <>
                    <div className="toolbar">
                        <div className="segmented" role="group" aria-label="Сортировка">
                            {BY.map(b => <button key={b.id} className={`tab ${by === b.id ? 'is-active' : ''}`} aria-pressed={by === b.id} onClick={() => setBy(b.id)}>{b.label}</button>)}
                        </div>
                        <input type="search" className="economy-search" placeholder="Ник или ID" value={query} onChange={e => setQuery(e.target.value)} />
                        <span className="muted small">
                            Участников с опытом: {number(data.totals.accounts)} · монет на руках: {number(data.totals.money)}
                        </span>
                    </div>
                    {data.items.length === 0 && <div className="empty"><h2>{search ? 'Никого не нашли' : 'Пока никто не набрал опыта'}</h2></div>}
                    {data.items.length > 0 && (
                        <div className="table-wrap">
                            <table className="journal stats">
                                <thead>
                                    <tr>
                                        <th className="num">#</th>
                                        <th>Участник</th>
                                        <th>Уровень</th>
                                        <th>Прогресс</th>
                                        <th className="num">Баланс</th>
                                        <th className="num">В голосе</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {data.items.map((row, index) => (
                                        <tr key={row.user.id}>
                                            <td className="num numeric muted">{search ? '' : index + 1}</td>
                                            <td>
                                                <span className="who">
                                                    <Avatar src={row.user.avatarURL} name={row.user.displayName} size={22} />
                                                    {row.user.member
                                                        ? <MemberLink id={row.user.id} name={row.user.displayName} onOpen={onOpenMember} />
                                                        : <span className="muted">{row.user.displayName || row.user.id}</span>}
                                                </span>
                                            </td>
                                            <td><LevelBadge level={row.level} prestige={row.prestige} /></td>
                                            <td><XpBar exp={row.exp} cost={row.cost} /></td>
                                            <td className="num numeric">{number(row.money)}</td>
                                            <td className="num numeric">{hours(row.voiceSeconds)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                    <p className="muted small">
                        Уровни 1–{data.curve.maxLevel}: переход с уровня N стоит 5000·N опыта, награда — 100·(N−1) монет.
                        После {data.curve.maxLevel}-го каждые {number(data.curve.prestigeExp)} опыта — престиж ★ и {number(data.curve.prestigeReward)} монет.
                        Кто покинул сервер, в топе не показывается; через 90 дней его счёт удаляется.
                    </p>
                </>
            )}
        </section>
    );
}
