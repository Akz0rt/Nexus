import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPost, apiPut, describeError } from './api.js';
import { ErrorState } from './States.jsx';
import { StatusPill } from './Chips.jsx';
import Avatar from './Avatar.jsx';
import Dialog from './Dialog.jsx';

// What the banner shows; «Не менять баннер» is enabled: false (the mode is kept)
const MODES = [
    { id: 'leader', label: 'Самый активный', hint: 'один лидер' },
    { id: 'podium', label: 'Топ недели', hint: 'лидер + 2 и 3 место' },
    { id: 'event', label: 'Ближайший ивент', hint: 'название и время' },
    { id: 'background', label: 'Только фон', hint: 'без надписей' },
    { id: 'off', label: 'Не менять баннер', hint: 'бот не трогает' }
];
const LAYOUT_MODES = [
    { id: 'leader', label: 'Самый активный' },
    { id: 'podium', label: 'Топ недели' },
    { id: 'birthday', label: 'Именинник' },
    { id: 'event', label: 'Ивент' }
];
const LAYOUTS = [{ id: 'left', label: 'Слева' }, { id: 'center', label: 'По центру' }, { id: 'right', label: 'Справа' }];
const PERIODS = [{ id: '1h', label: '1 ч' }, { id: '2h', label: '2 ч' }, { id: '24h', label: '24 ч' }, { id: '7d', label: '7 дн.' }, { id: '30d', label: '30 дн.' }];
const CALCS = [{ id: 'messages', label: 'Сообщения' }, { id: 'voice', label: 'Голос' }, { id: 'combined', label: 'Вместе' }];
const BACKINGS = [{ id: 'glass', label: 'Стекло' }, { id: 'solid', label: 'Плашка' }, { id: 'none', label: 'Нет' }];
const PERIOD_TEXT = { '1h': 'последний час', '2h': 'последние 2 ч', '24h': 'последние 24 ч', '7d': 'последние 7 дней', '30d': 'последние 30 дней' };
const CALC_TEXT = { messages: 'сообщения', voice: 'голос', combined: 'сообщения + голос' };
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const PREVIEW_DELAY_MS = 300;
const POLL_MS = 3000;
const POLL_LIMIT_MS = 2 * 60 * 1000;

const ERRORS = {
    no_background: 'Сначала загрузите фон — без него бот баннер не трогает.',
    too_soon: '«Обновить сейчас» — не чаще раза в минуту.',
    file_too_large: 'Файл больше 15 МБ.',
    bad_background: 'Нужна картинка GIF, PNG, JPG или WebP.',
    empty_file: 'Файл пустой.',
    renderer_unavailable: 'Предпросмотр недоступен: на сервере бота не загрузилась отрисовка.',
    ffmpeg_unavailable: 'На сервере бота не запускается ffmpeg — фон и баннер собрать нельзя.',
    invalid_value: 'Проверьте значения.',
    invalid_user: 'Это не похоже на ID участника.',
    too_many_users: 'Не больше 25 участников в исключениях.',
    nothing_to_save: 'Нечего сохранять.'
};
const errorText = result => ERRORS[result?.error] || describeError(result || {});

const pad = n => String(n).padStart(2, '0');
const hhmm = iso => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const dayLabel = iso => { const d = new Date(iso); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };
const formatNumber = n => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const formatBytes = bytes => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`);
const clone = value => JSON.parse(JSON.stringify(value));

function Segmented({ items, value, onChange, label, small }) {
    return (
        <div className={`segmented banner-segmented${small ? ' segmented-small' : ''}`} role="radiogroup" aria-label={label}>
            {items.map(item => (
                <button key={item.id} type="button" role="radio" aria-checked={value === item.id}
                    className={`tab${value === item.id ? ' is-active' : ''}`} onClick={() => onChange(item.id)}>{item.label}</button>
            ))}
        </div>
    );
}

/** A small schematic of where the card stands */
function LayoutIcon({ layout }) {
    return (
        <span className={`banner-layout-icon is-${layout}`} aria-hidden="true">
            <span className="banner-layout-safe" />
            <span className="banner-layout-card" />
        </span>
    );
}

/** The header's status: on the server since…, next at…, or why not */
function statusPill(status) {
    if (!status) return null;
    if (!status.enabled) return <StatusPill tone="neutral">Бот не меняет баннер</StatusPill>;
    if (status.lastError) return <StatusPill tone="accent" title={status.lastError.message}>Не обновлён: {status.lastError.message}</StatusPill>;
    const parts = ['На сервере'];
    if (status.lastPublishedAt) parts.push(`обновлён в ${hhmm(status.lastPublishedAt)}`);
    if (status.nextAt) parts.push(`следующий в ${hhmm(status.nextAt)}`);
    return <StatusPill tone="ok">{parts.join(' · ')}</StatusPill>;
}

function ExcludeDialog({ guildId, onPick, onClose }) {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState([]);
    useEffect(() => {
        const q = query.trim();
        if (q.length < 2) { setResults([]); return undefined; }
        let cancelled = false;
        const timer = setTimeout(() => {
            apiGet(`/guilds/${guildId}/members/search?q=${encodeURIComponent(q)}`)
                .then(data => { if (!cancelled) setResults(data.items.slice(0, 8)); })
                .catch(() => {});
        }, 200);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [query, guildId]);
    return (
        <Dialog title="Не учитывать участника" onClose={onClose}>
            <input type="search" autoFocus placeholder="Ник, ID или @упоминание" value={query} onChange={e => setQuery(e.target.value)} />
            <ul className="preset-pick">
                {results.map(m => (
                    <li key={m.id}>
                        <button type="button" className="picker-item" onClick={() => onPick(m)}>
                            <span>{m.displayName}</span><span className="muted small">@{m.username}</span>
                        </button>
                    </li>
                ))}
            </ul>
            <p className="muted small">Он не попадёт ни на баннер, ни в «Гонку за баннер».</p>
        </Dialog>
    );
}

export default function BannerView({ guildId, guildName, toast }) {
    const base = `/guilds/${guildId}/banner`;
    const [saved, setSaved] = useState(null);
    const [draft, setDraft] = useState(null);
    const [users, setUsers] = useState({});
    const [status, setStatus] = useState(null);
    const [race, setRace] = useState(null);
    const [history, setHistory] = useState({ items: [], currentId: null });
    const [thumbs, setThumbs] = useState({});
    const [bgThumb, setBgThumb] = useState(null);
    const [preview, setPreview] = useState({ url: null, sample: false, loading: true, error: null });
    const [tab, setTab] = useState('full');
    const [safe, setSafe] = useState(true);
    const [layoutMode, setLayoutMode] = useState('leader');
    const [loadError, setLoadError] = useState(null);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState(null);
    const [publishing, setPublishing] = useState(false);
    const [restoring, setRestoring] = useState(null);
    const [crop, setCrop] = useState(null); // a picked non-16:9 picture waiting for «обрезать»
    const [uploading, setUploading] = useState(false);
    const [excluding, setExcluding] = useState(false);
    const previewRequest = useRef(0);

    const loadStatus = useCallback(() => apiGet(`${base}/status`).then(setStatus).catch(() => {}), [base]);
    const loadRace = useCallback(() => apiGet(`${base}/race`).then(setRace).catch(() => setRace(null)), [base]);
    const loadHistory = useCallback(async () => {
        try {
            const data = await apiGet(`${base}/history`);
            setHistory(data);
            const pictures = {};
            await Promise.all(data.items.slice(0, 4).map(async item => {
                const result = await window.panel.image(`${base}/history/${item.id}/image?thumb=1`);
                if (result.ok) pictures[item.id] = result.dataUrl;
            }));
            setThumbs(pictures);
        } catch {
            // the screen works without the history
        }
    }, [base]);
    const loadBackground = useCallback(async () => {
        const result = await window.panel.image(`${base}/background/image`);
        setBgThumb(result.ok ? result.dataUrl : null);
    }, [base]);

    const load = useCallback(async () => {
        setLoadError(null);
        try {
            const data = await apiGet(`${base}/settings`);
            setSaved(data.values);
            setDraft(clone(data.values));
            setUsers(Object.fromEntries((data.users || []).map(user => [user.id, user])));
            setLayoutMode(data.values.mode === 'background' ? 'leader' : data.values.mode);
        } catch (error) {
            setLoadError(error);
        }
        loadStatus();
        loadRace();
        loadHistory();
        loadBackground();
    }, [base, loadStatus, loadRace, loadHistory, loadBackground]);

    useEffect(() => { load(); }, [load]);

    // The preview follows the unsaved values, ~300 ms after the last change
    const previewMode = draft?.mode === 'background' && draft?.enabled ? 'background' : layoutMode;
    const previewKey = draft ? JSON.stringify([previewMode, draft.layouts[layoutMode], draft.backing, draft.blur, draft.dim, draft.period, draft.calc, bgThumb]) : null;
    useEffect(() => {
        if (!draft) return undefined;
        const id = ++previewRequest.current;
        setPreview(p => ({ ...p, loading: true }));
        const timer = setTimeout(async () => {
            const query = new URLSearchParams({
                mode: previewMode, layout: draft.layouts[layoutMode] || 'left', backing: draft.backing,
                blur: String(draft.blur), dim: String(draft.dim), period: draft.period, calc: draft.calc
            });
            const result = await window.panel.image(`${base}/preview?${query}`);
            if (id !== previewRequest.current) return;
            setPreview(result.ok
                ? { url: result.dataUrl, sample: result.sample, loading: false, error: null }
                : p => ({ ...p, loading: false, error: errorText(result) }));
        }, PREVIEW_DELAY_MS);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [previewKey, base]);

    if (loadError) return <ErrorState what="настройки баннера" error={loadError} onRetry={load} />;
    if (!draft) return <div className="view view-wide"><h1>Баннер сервера</h1><p className="muted">Загружаем…</p></div>;

    const set = patch => { setDraft(d => ({ ...d, ...patch })); setSaveError(null); };
    const setExclude = patch => set({ exclude: { ...draft.exclude, ...patch } });
    const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
    const modeValue = draft.enabled ? draft.mode : 'off';
    const pickMode = id => {
        if (id === 'off') { set({ enabled: false }); return; }
        set({ enabled: true, mode: id });
        if (id !== 'background') setLayoutMode(id);
    };

    const save = async () => {
        setSaving(true);
        const changed = Object.fromEntries(Object.keys(draft)
            .filter(key => key !== 'backgroundBlobId' && JSON.stringify(draft[key]) !== JSON.stringify(saved[key]))
            .map(key => [key, draft[key]]));
        const result = await apiPut(`${base}/settings`, changed);
        setSaving(false);
        if (!result.ok) { setSaveError(errorText(result)); return; }
        setSaved(result.data.values);
        setDraft(clone(result.data.values));
        toast('Настройки баннера сохранены');
        loadStatus();
        loadRace();
    };

    const publish = async () => {
        setPublishing(true);
        const before = JSON.stringify([status?.lastPublishedAt, status?.lastError?.at]);
        const result = await apiPost(`${base}/publish`, {});
        if (!result.ok) { setPublishing(false); toast(errorText(result), { tone: 'error' }); return; }
        toast('Собираем баннер…');
        // The task tray shows the progress; here the header, history and race catch up when it's done
        const started = Date.now();
        const poll = async () => {
            const next = await apiGet(`${base}/status`).catch(() => null);
            if (next) setStatus(next);
            const changed = next && JSON.stringify([next.lastPublishedAt, next.lastError?.at]) !== before;
            if (changed || Date.now() - started > POLL_LIMIT_MS) {
                setPublishing(false);
                loadHistory();
                loadRace();
                return;
            }
            setTimeout(poll, POLL_MS);
        };
        setTimeout(poll, POLL_MS);
    };

    const restore = async () => {
        const item = restoring;
        const result = await apiPost(`${base}/history/${item.id}/restore`, {});
        setRestoring(null);
        if (!result.ok) { toast(result.message || errorText(result), { tone: 'error' }); return; }
        toast('Баннер возвращён');
        loadStatus();
        loadHistory();
    };

    const pickBackground = async () => {
        const picked = await window.panel.pickImage();
        if (picked.canceled) return;
        if (picked.error) { toast(errorText({ error: picked.error }), { tone: 'error' }); return; }
        const image = new Image();
        image.onload = () => {
            const ratio = image.naturalWidth / image.naturalHeight;
            const info = { ...picked, width: image.naturalWidth, height: image.naturalHeight };
            if (Math.abs(ratio - 16 / 9) > 0.02) setCrop(info);
            else upload(info);
        };
        image.onerror = () => toast(errorText({ error: 'bad_background' }), { tone: 'error' });
        image.src = picked.dataUrl;
    };

    const upload = async info => {
        setCrop(null);
        setUploading(true);
        const result = await window.panel.uploadPicked(`${base}/background`);
        setUploading(false);
        if (!result.ok) { toast(errorText(result), { tone: 'error' }); return; }
        toast(`Фон «${info.name}» загружен`);
        loadStatus();
        loadBackground();
    };

    const raceTop = race?.top || [];
    const maxScore = raceTop[0]?.score || 1;
    const current = status?.current;
    const boost = status?.boost;
    const bg = status?.background;

    return (
        <div className="view view-wide banner-view">
            <div className="view-head banner-head">
                <h1>Баннер сервера</h1>
                {statusPill(status)}
                <span className="toolbar-spacer" />
                <button className="btn" disabled={publishing} onClick={publish}>{publishing ? 'Собираем…' : 'Обновить сейчас'}</button>
                <button className="btn btn-primary" disabled={!dirty || saving} onClick={save}>{saving ? 'Сохраняем…' : 'Сохранить'}</button>
            </div>
            {saveError && <p className="error">{saveError}</p>}

            <div className="banner-layout">
                <div className="banner-main">
                    <section className="block banner-preview-block" aria-label="Предпросмотр">
                        <div className="block-head">
                            <Segmented label="Предпросмотр" value={tab} onChange={setTab}
                                items={[{ id: 'full', label: 'Полный размер' }, { id: 'discord', label: 'Как в Discord' }]} />
                            <span className="toolbar-spacer" />
                            {preview.sample && <span className="muted small" title="На сервере пока нет данных для этого режима">пример данных</span>}
                            {tab === 'full' && (
                                <button type="button" className={`banner-safe-toggle${safe ? ' is-on' : ''}`} aria-pressed={safe} onClick={() => setSafe(v => !v)}>Безопасная зона</button>
                            )}
                            <span className="muted small">960 × 540</span>
                        </div>
                        {tab === 'full' ? (
                            <div className={`banner-preview${preview.loading ? ' is-loading' : ''}`}>
                                {preview.url && <img src={preview.url} alt="Предпросмотр баннера" />}
                                {safe && <div className="banner-safe" aria-hidden="true">Здесь Discord пишет название сервера — сюда ничего не ставим</div>}
                                {preview.error && <p className="banner-preview-error">{preview.error}</p>}
                            </div>
                        ) : (
                            <div className="banner-discord">
                                <div className="banner-discord-side">
                                    <div className="banner-discord-top">
                                        {preview.url && <img src={preview.url} alt="Баннер в боковой панели Discord" />}
                                        <span className="banner-discord-name">{guildName || 'Сервер'} <span aria-hidden="true">⌄</span></span>
                                    </div>
                                    <div className="banner-discord-channels" aria-hidden="true">
                                        <span className="banner-discord-cat">Текстовые</span>
                                        <span className="is-active"># общий</span>
                                        <span># правила</span>
                                        <span># ивенты</span>
                                        <span className="banner-discord-cat">Голосовые</span>
                                        <span>🔊 Болталка</span>
                                    </div>
                                </div>
                                <p className="muted small">Так баннер выглядит в боковой панели Discord: в 4 раза мельче. Читаются аватар, ник и одна крупная цифра.</p>
                            </div>
                        )}
                    </section>

                    <section className="block" aria-labelledby="banner-race">
                        <h2 id="banner-race" className="banner-subhead">Гонка за баннер · {PERIOD_TEXT[saved.period]}, {CALC_TEXT[saved.calc]}</h2>
                        {raceTop.length === 0 && <p className="muted small">За этот период активности пока нет.</p>}
                        <ol className="banner-race">
                            {raceTop.map((row, index) => (
                                <li key={row.id}>
                                    <span className="muted numeric">{index + 1}</span>
                                    <Avatar src={row.avatarURL} name={row.displayName} id={row.id} size={24} />
                                    <strong className="banner-race-name">{row.displayName || row.id}</strong>
                                    <span className="banner-race-bar"><span className={index === 0 ? 'is-first' : ''} style={{ width: `${Math.max(4, (row.score / maxScore) * 100)}%` }} /></span>
                                    <span className="numeric banner-race-score">{formatNumber(row.score)}</span>
                                    <span className="muted small banner-race-note">
                                        {index === 0
                                            ? (current?.leaderId === row.id && current.leaderSince ? `на баннере с ${hhmm(current.leaderSince)}` : '')
                                            : `отстаёт на ${formatNumber(row.behind)}`}
                                    </span>
                                </li>
                            ))}
                        </ol>
                    </section>

                    <section aria-labelledby="banner-history" className="banner-history-block">
                        <h2 id="banner-history" className="banner-subhead">История · клик — вернуть этот баннер</h2>
                        {history.items.length === 0 && <p className="muted small">Бот ещё не ставил баннер.</p>}
                        <div className="banner-history">
                            {history.items.slice(0, 4).map(item => {
                                const isCurrent = item.id === history.currentId;
                                return (
                                    <button key={item.id} type="button" className={`banner-history-item${isCurrent ? ' is-current' : ''}`}
                                        disabled={isCurrent} onClick={() => setRestoring(item)}
                                        title={item.downgraded ? 'Поставлен первый кадр: анимация не поместилась в лимит Discord' : undefined}>
                                        <span className="banner-history-thumb">{thumbs[item.id] && <img src={thumbs[item.id]} alt="" />}</span>
                                        <span className="small">{isCurrent ? 'сейчас' : dayLabel(item.createdAt)}{item.caption ? ` · ${item.caption}` : ''}</span>
                                    </button>
                                );
                            })}
                        </div>
                    </section>
                </div>

                <aside className="block banner-settings" aria-label="Настройки баннера">
                    <h3>Что показывать</h3>
                    <div className="banner-modes" role="radiogroup" aria-label="Что показывать">
                        {MODES.map(mode => (
                            <label key={mode.id} className={`banner-mode${modeValue === mode.id ? ' is-active' : ''}`}>
                                <input type="radio" name="banner-mode" checked={modeValue === mode.id} onChange={() => pickMode(mode.id)} />
                                <span>{mode.label}</span>
                                <span className="muted small">{mode.hint}</span>
                            </label>
                        ))}
                    </div>
                    {draft.enabled && !bg && <p className="notice notice-warn small">Фон не загружен — пока его нет, бот баннер не трогает.</p>}
                    <label className="check small">
                        <input type="checkbox" checked={draft.autoBirthday} onChange={e => set({ autoBirthday: e.target.checked })} />
                        В день рождения — показывать именинника
                    </label>
                    <label className="check small">
                        <input type="checkbox" checked={draft.autoEventHours > 0} onChange={e => set({ autoEventHours: e.target.checked ? (saved.autoEventHours || 3) : 0 })} />
                        За
                        <input type="number" className="banner-hours" min="1" max="24" value={draft.autoEventHours || 3} disabled={!draft.autoEventHours}
                            onChange={e => set({ autoEventHours: Math.max(1, Math.min(24, Number(e.target.value) || 1)) })} aria-label="Часов до ивента" />
                        ч до ивента — показывать ивент
                    </label>

                    {draft.mode !== 'background' || !draft.enabled ? (
                        <>
                            <h3 className="banner-layout-title">
                                Расположение · для
                                <select value={layoutMode} onChange={e => setLayoutMode(e.target.value)} aria-label="Для какого режима">
                                    {LAYOUT_MODES.map(mode => <option key={mode.id} value={mode.id}>«{mode.label}»</option>)}
                                </select>
                            </h3>
                            <div className="banner-layouts" role="radiogroup" aria-label="Расположение">
                                {LAYOUTS.map(layout => (
                                    <button key={layout.id} type="button" role="radio" aria-checked={draft.layouts[layoutMode] === layout.id}
                                        className={`banner-layout-option${draft.layouts[layoutMode] === layout.id ? ' is-active' : ''}`}
                                        onClick={() => set({ layouts: { ...draft.layouts, [layoutMode]: layout.id } })}>
                                        <LayoutIcon layout={layout.id} />
                                        <span className="small">{layout.label}</span>
                                    </button>
                                ))}
                            </div>
                        </>
                    ) : null}

                    <h3>Период и подсчёт</h3>
                    <Segmented label="Период" items={PERIODS} value={draft.period} onChange={period => set({ period })} />
                    <Segmented label="Подсчёт" items={CALCS} value={draft.calc} onChange={calc => set({ calc })} />

                    <h3>Фон</h3>
                    <div className="banner-background">
                        <span className="banner-background-thumb">{bgThumb && <img src={bgThumb} alt="" />}</span>
                        <span className="banner-background-info">
                            {bg ? <><strong title={bg.name}>{bg.name}</strong><span className="muted small">{bg.animated ? 'анимированный' : 'картинка'} · {formatBytes(bg.bytes)}</span></>
                                : <span className="muted small">не загружен</span>}
                        </span>
                        <button className="btn" disabled={uploading} onClick={pickBackground}>{uploading ? 'Загружаем…' : bg ? 'Заменить' : 'Загрузить'}</button>
                    </div>
                    <p className="muted small">GIF, PNG, JPG или WebP до 15 МБ. Бот приводит фон к 960 × 540.</p>
                    <div className="banner-row">
                        <span className="banner-row-label">Подложка</span>
                        <Segmented label="Подложка" items={BACKINGS} value={draft.backing} onChange={backing => set({ backing })} />
                    </div>
                    <label className="banner-row">
                        <span className="banner-row-label">Размытие</span>
                        <input type="range" min="0" max="40" step="2" value={draft.blur} disabled={draft.backing !== 'glass'}
                            onChange={e => set({ blur: Number(e.target.value) })} />
                        <span className="numeric banner-row-value">{draft.blur} px</span>
                    </label>
                    <label className="banner-row">
                        <span className="banner-row-label">Затемнение</span>
                        <input type="range" min="0" max="100" step="5" value={Math.round(draft.dim * 100)}
                            onChange={e => set({ dim: Number(e.target.value) / 100 })} />
                        <span className="numeric banner-row-value">{Math.round(draft.dim * 100)}%</span>
                    </label>

                    <h3>Не учитывать</h3>
                    <div className="banner-chips">
                        {[['bots', 'Боты'], ['admins', 'Администрацию'], ['yesterdayLeader', 'Кто был на баннере вчера']].map(([key, label]) => (
                            <button key={key} type="button" className={`banner-chip${draft.exclude[key] ? ' is-active' : ''}`} aria-pressed={draft.exclude[key]}
                                onClick={() => setExclude({ [key]: !draft.exclude[key] })}>{label}</button>
                        ))}
                        {draft.exclude.users.map(id => (
                            <button key={id} type="button" className="banner-chip is-active" title="Убрать из исключений"
                                onClick={() => setExclude({ users: draft.exclude.users.filter(x => x !== id) })}>
                                {users[id]?.displayName || id} ✕
                            </button>
                        ))}
                        <button type="button" className="banner-chip" disabled={draft.exclude.users.length >= 25} onClick={() => setExcluding(true)}>+ участник</button>
                    </div>

                    <div className="banner-row">
                        <span className="banner-row-label">Обновлять</span>
                        <select value={draft.intervalMin} onChange={e => set({ intervalMin: Number(e.target.value) })}>
                            {[15, 30, 60].map(min => <option key={min} value={min}>каждые {min} мин</option>)}
                        </select>
                        <label className="check small">
                            <input type="checkbox" checked={draft.onlyOnChange} onChange={e => set({ onlyOnChange: e.target.checked })} />
                            если лидер сменился
                        </label>
                    </div>

                    {boost && (
                        <p className={`banner-boost small${boost.animated ? ' is-ok' : ''}`}>
                            {!boost.banner
                                ? `Баннер сервера — со 2-го уровня буста. У сервера: ${boost.tier}.`
                                : `Анимированный баннер — 3-й уровень буста. У сервера: ${boost.tier}.${boost.animated ? '' : ' Пока ставится первый кадр.'}`}
                        </p>
                    )}
                </aside>
            </div>

            {restoring && (
                <Dialog title="Вернуть этот баннер?" onClose={() => setRestoring(null)} onSubmit={restore} submitLabel="Вернуть">
                    {thumbs[restoring.id] && <img className="banner-restore-thumb" src={thumbs[restoring.id]} alt="" />}
                    <p>Баннер от {dayLabel(restoring.createdAt)} {hhmm(restoring.createdAt)}{restoring.caption ? ` (${restoring.caption})` : ''} снова встанет на сервер.</p>
                    {draft.enabled && <p className="muted small">Бот сменит его при следующем обновлении, если изменится лидер.</p>}
                </Dialog>
            )}
            {crop && (
                <Dialog title="Обрезать по центру?" onClose={() => setCrop(null)} onSubmit={() => upload(crop)} submitLabel="Обрезать и загрузить">
                    <p>У «{crop.name}» пропорции {crop.width} × {crop.height}, а баннеру нужно 16:9. Бот обрежет края по центру до 960 × 540.</p>
                    <div className="banner-crop">
                        <img src={crop.dataUrl} alt="" />
                        <span className="banner-crop-frame" style={crop.width / crop.height > 16 / 9
                            ? { width: `${(16 / 9) / (crop.width / crop.height) * 100}%`, height: '100%' }
                            : { width: '100%', height: `${(crop.width / crop.height) / (16 / 9) * 100}%` }} />
                    </div>
                </Dialog>
            )}
            {excluding && (
                <ExcludeDialog guildId={guildId} onClose={() => setExcluding(false)} onPick={member => {
                    if (!draft.exclude.users.includes(member.id)) setExclude({ users: [...draft.exclude.users, member.id] });
                    setUsers(u => ({ ...u, [member.id]: member }));
                    setExcluding(false);
                }} />
            )}
        </div>
    );
}
