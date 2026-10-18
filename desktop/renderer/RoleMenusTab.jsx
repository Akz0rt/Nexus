import React, { useEffect, useState } from 'react';
import { apiDelete, apiGet, apiPost, apiPut, describeError } from './api.js';
import { ROLE_PROBLEMS } from './format.js';
import Dialog from './Dialog.jsx';
import { RoleChip } from './RoleDialogs.jsx';

const SAVE_ERRORS = {
    invalid_title: 'Введите заголовок.',
    invalid_roles: 'Отметьте от 1 до 25 ролей.',
    channel_not_found: 'Выберите текстовый канал.',
    bot_cannot_channel: 'Бот не может писать в этот канал.',
    role_dangerous: 'Роль даёт модераторские права — её нельзя выдавать кнопкой.'
};

const roleColor = color => (!color || color === '#000000' ? 'var(--muted)' : color);

function MenuDialog({ guildId, menu, channels, roles, onClose, toast }) {
    const [title, setTitle] = useState(menu?.title || '');
    const [description, setDescription] = useState(menu?.description || '');
    const [channelId, setChannelId] = useState(menu?.channel.id || channels[0]?.id || '');
    const [mode, setMode] = useState(menu?.mode || 'multi');
    const [chosen, setChosen] = useState(() => new Set(menu ? menu.roles.filter(r => !r.problem).map(r => r.id) : []));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const toggle = id => setChosen(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else if (next.size < 25) next.add(id);
        return next;
    });

    const submit = async () => {
        setBusy(true);
        const body = { title, description, channelId, mode, roleIds: roles.filter(r => chosen.has(r.id)).map(r => r.id) };
        const result = menu
            ? await apiPut(`/guilds/${guildId}/roles/menus/${menu.id}`, body)
            : await apiPost(`/guilds/${guildId}/roles/menus`, body);
        setBusy(false);
        if (!result.ok) {
            const text = SAVE_ERRORS[result.error] || ROLE_PROBLEMS[result.error] || describeError(result);
            setError(result.body?.roleName ? `«${result.body.roleName}»: ${text}` : text);
            return;
        }
        toast(menu ? 'Меню обновлено в Discord' : 'Меню опубликовано');
        onClose();
    };

    return (
        <Dialog title={menu ? 'Изменить меню ролей' : 'Новое меню ролей'} onClose={onClose} onSubmit={submit} busy={busy}
            submitLabel={menu ? 'Сохранить' : 'Опубликовать'} wide>
            <div className="settings-grid">
                <label className="field">
                    Заголовок
                    <input autoFocus value={title} maxLength={100} placeholder="Выбери интересы" onChange={e => setTitle(e.target.value)} />
                </label>
                <label className="field">
                    Канал
                    <select value={channelId} onChange={e => setChannelId(e.target.value)}>
                        {channels.map(c => <option key={c.id} value={c.id}>{c.category ? `${c.category} · ` : ''}#{c.name}</option>)}
                    </select>
                </label>
            </div>
            <label className="field">
                Текст над кнопками (необязательно)
                <textarea rows={3} value={description} maxLength={1500} onChange={e => setDescription(e.target.value)} />
            </label>
            <div className="segmented" role="group" aria-label="Сколько ролей">
                <button type="button" className={`tab ${mode === 'multi' ? 'is-active' : ''}`} aria-pressed={mode === 'multi'} onClick={() => setMode('multi')}>Можно несколько</button>
                <button type="button" className={`tab ${mode === 'single' ? 'is-active' : ''}`} aria-pressed={mode === 'single'} onClick={() => setMode('single')}>Только одна</button>
            </div>
            <h3>Роли · {chosen.size} из 25</h3>
            {roles.length === 0 && <p className="muted">Нет ролей, которые можно выдавать кнопкой: они должны быть ниже вашей роли и роли бота и без модераторских прав.</p>}
            <ul className="check-list role-checks">
                {roles.map(role => (
                    <li key={role.id}>
                        <label className="check">
                            <input type="checkbox" checked={chosen.has(role.id)} onChange={() => toggle(role.id)} />
                            <span className="role-dot" style={{ '--role': roleColor(role.color) }} />
                            {role.name}
                        </label>
                    </li>
                ))}
            </ul>
            <p className="muted small">Под сообщением будет кнопка на каждую роль; участник нажимает — роль выдаётся, нажимает ещё раз — снимается.</p>
            {error && <p className="error">{error}</p>}
        </Dialog>
    );
}

/** «Меню ролей» on the Roles screen: self-service role buttons («роли по интересам»). */
export default function RoleMenusTab({ guildId, revision, toast }) {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [dialog, setDialog] = useState(null); // { menu|null }
    const [removing, setRemoving] = useState(null);

    useEffect(() => {
        let cancelled = false;
        apiGet(`/guilds/${guildId}/roles/menus`)
            .then(result => { if (!cancelled) { setData(result); setError(null); } })
            .catch(err => { if (!cancelled) setError(describeError(err)); });
        return () => { cancelled = true; };
    }, [guildId, revision]);

    const remove = async () => {
        const result = await apiDelete(`/guilds/${guildId}/roles/menus/${removing.id}`);
        toast(result.ok ? 'Меню удалено вместе с сообщением' : describeError(result), result.ok ? {} : { tone: 'error' });
        setRemoving(null);
    };

    return (
        <>
            <div className="toolbar">
                <button className="btn btn-primary" disabled={!data} onClick={() => setDialog({ menu: null })}>Новое меню</button>
                <span className="muted small hint">Сообщение бота с кнопками — участники сами берут роли по интересам.</span>
            </div>
            {error && <p className="error">{error}</p>}
            {data && data.items.length === 0 && (
                <div className="empty"><h2>Меню ролей пока нет</h2><p>Например: «Игры», «Аниме», «Музыка» — каждый выбирает себе сам, модераторам выдавать не нужно.</p></div>
            )}
            <ul className="presets">
                {(data?.items || []).map(menu => (
                    <li key={menu.id} className="preset">
                        <div className="preset-head">
                            <strong>{menu.title}</strong>
                            <button className="btn btn-quiet" onClick={() => setDialog({ menu })}>Изменить</button>
                            <button className="btn btn-quiet" onClick={() => setRemoving(menu)}>Удалить</button>
                        </div>
                        <p className="muted small">
                            #{menu.channel.name || 'удалённый канал'} · {menu.mode === 'single' ? 'только одна роль' : 'можно несколько'}
                            {menu.messageUrl && <> · <a href={menu.messageUrl} target="_blank" rel="noreferrer">открыть в Discord</a></>}
                        </p>
                        <ul className="roles">{menu.roles.map(role => <RoleChip key={role.id} role={role} />)}</ul>
                    </li>
                ))}
            </ul>
            {dialog && data && (
                <MenuDialog guildId={guildId} menu={dialog.menu} channels={data.channels} roles={data.roles}
                    onClose={() => setDialog(null)} toast={toast} />
            )}
            {removing && (
                <Dialog title={`Удалить меню «${removing.title}»?`} onClose={() => setRemoving(null)} onSubmit={remove} submitLabel="Удалить" submitTone="danger">
                    <p className="muted">Сообщение с кнопками удалится из Discord. Роли, которые участники уже взяли, останутся у них.</p>
                </Dialog>
            )}
        </>
    );
}
