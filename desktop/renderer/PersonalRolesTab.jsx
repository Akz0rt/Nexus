import React, { useEffect, useState } from 'react';
import { apiDelete, apiGet, apiPost, describeError } from './api.js';
import { ErrorState } from './States.jsx';
import { formatDateTime, timeLeft } from './format.js';
import Avatar, { MemberLink } from './Avatar.jsx';
import Dialog from './Dialog.jsx';

const number = n => Number(n || 0).toLocaleString('ru-RU');

function Person({ person, onOpenMember }) {
    return (
        <span className="who">
            <Avatar src={person.avatarURL} name={person.displayName} size={20} />
            {person.member
                ? <MemberLink id={person.id} name={person.displayName} onOpen={onOpenMember} />
                : <span className="muted">нет на сервере</span>}
        </span>
    );
}

function GrantDialog({ guildId, role, onClose, onDone, toast }) {
    const [days, setDays] = useState('30');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const submit = async () => {
        const n = Number(days);
        if (!Number.isInteger(n) || n < 1 || n > 365) { setError('От 1 до 365 дней.'); return; }
        setBusy(true);
        const result = await apiPost(`/guilds/${guildId}/economy/personal-roles/${role.roleId}/grant`, { days: n });
        setBusy(false);
        if (!result.ok) { setError(describeError(result)); return; }
        toast(`«${role.name}» продлена на ${n} дн. бесплатно`);
        onDone();
        onClose();
    };
    return (
        <Dialog title={`Продлить «${role.name}» бесплатно`} onClose={onClose} onSubmit={submit} busy={busy} submitLabel="Продлить">
            <label className="field">
                На сколько дней
                <input type="number" min="1" max="365" autoFocus value={days} onChange={e => setDays(e.target.value)} />
            </label>
            <p className="muted small">Например, в качестве компенсации. Владелец ничего не платит; запись появится в журнале.</p>
            {error && <p className="error">{error}</p>}
        </Dialog>
    );
}

/** Economy → «Личные роли»: every rented role, its owner, term, price and buyers. */
export default function PersonalRolesTab({ guildId, revision, onOpenMember, toast }) {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [reload, setReload] = useState(0);
    const [granting, setGranting] = useState(null);
    const [deleting, setDeleting] = useState(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        let cancelled = false;
        apiGet(`/guilds/${guildId}/economy/personal-roles`)
            .then(result => { if (!cancelled) { setData(result); setError(null); } })
            .catch(err => { if (!cancelled) setError(err); });
        return () => { cancelled = true; };
    }, [guildId, revision, reload]);

    const remove = async () => {
        setBusy(true);
        const result = await apiDelete(`/guilds/${guildId}/economy/personal-roles/${deleting.roleId}`);
        setBusy(false);
        if (!result.ok) { toast(describeError(result), { tone: 'error' }); return; }
        toast(`Роль «${deleting.name}» удалена`);
        setDeleting(null);
        setReload(n => n + 1);
    };

    if (error) return <ErrorState what="личные роли" error={error} onRetry={() => setReload(n => n + 1)} />;
    if (!data) return <p className="muted">Загружаем…</p>;
    if (data.items.length === 0) return <div className="empty"><h2>Личных ролей пока нет</h2><p>Участники создают их командой /myrole create.</p></div>;
    return (
        <>
            <ul className="personal-roles">
                {data.items.map(item => (
                    <li key={item.roleId} className="personal-role">
                        <div className="personal-role-head">
                            <span className="role" style={{ '--role': item.color && item.color !== '#000000' ? item.color : 'var(--muted)' }}>
                                {item.iconURL && <img src={item.iconURL} alt="" width="16" height="16" />}
                                {item.emoji && <span aria-hidden="true">{item.emoji}</span>}
                                {item.name || 'роль удалена в Discord'}
                            </span>
                            <span className="muted small" title={formatDateTime(item.expiresAt)}>до {formatDateTime(item.expiresAt)} · {timeLeft(item.expiresAt)}</span>
                        </div>
                        <dl className="facts compact">
                            <div><dt>Владелец</dt><dd><Person person={item.owner} onOpenMember={onOpenMember} />{!item.ownerWears && <span className="muted small"> · не носит</span>}</dd></div>
                            <div><dt>Продажа</dt><dd>{item.price ? `${number(item.price)} монет` : 'не продаётся'}</dd></div>
                            <div>
                                <dt>Купили</dt>
                                <dd>
                                    {item.buyers.length === 0 && <span className="muted">никто</span>}
                                    {item.buyers.map(buyer => (
                                        <span key={buyer.id} className="buyer"><Person person={buyer} onOpenMember={onOpenMember} /><span className="muted small">{buyer.expiresAt ? `до ${formatDateTime(buyer.expiresAt)}` : 'пока роль существует'}</span></span>
                                    ))}
                                </dd>
                            </div>
                        </dl>
                        {data.canManage && (
                            <div className="punish-row">
                                <button className="btn" onClick={() => setGranting(item)}>Продлить бесплатно</button>
                                <button className="btn btn-danger" onClick={() => setDeleting(item)}>Удалить</button>
                            </div>
                        )}
                    </li>
                ))}
            </ul>
            {granting && <GrantDialog guildId={guildId} role={granting} onClose={() => setGranting(null)} onDone={() => setReload(n => n + 1)} toast={toast} />}
            {deleting && (
                <Dialog title={`Удалить «${deleting.name}»?`} onClose={() => setDeleting(null)} onSubmit={remove} busy={busy} submitLabel="Удалить" submitTone="danger">
                    <p>Роль удалится из Discord у владельца и у всех, кто её купил. Монеты не возвращаются.</p>
                </Dialog>
            )}
        </>
    );
}
