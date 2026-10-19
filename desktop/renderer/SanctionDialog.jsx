import React, { useState } from 'react';
import { apiPost, describeError } from './api.js';
import Dialog from './Dialog.jsx';
import { useModerationOptions } from './PunishDialog.jsx';
import { StepsEditor, stepsText, useTemplates } from './PunishTemplates.jsx';

/**
 * «Наказать…»: the server's templates first (one click picks one), then «Своё наказание»
 * — any of варн / мут / кик или бан with a reason. From a report (`reportId`) the bot
 * closes the report as resolved with what was done.
 */
export default function SanctionDialog({ guildId, target, reportId, onClose, onDone, toast }) {
    const templates = useTemplates(guildId);
    const options = useModerationOptions(guildId);
    const [picked, setPicked] = useState(null); // template id, or 'own'
    const [steps, setSteps] = useState([{ kind: 'warn' }]);
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const name = target?.displayName || target?.id;

    const template = templates?.items.find(t => t.id === picked) || null;
    const own = picked === 'own';
    const drastic = (template?.steps || (own ? steps : [])).some(step => step.kind === 'kick' || step.kind === 'ban');

    const submit = async () => {
        if (!picked) { setError('Выберите шаблон или «Своё наказание».'); return; }
        if (own && steps.length === 0) { setError('Отметьте хотя бы одно наказание.'); return; }
        if (own && !reason.trim()) { setError('Укажите причину.'); return; }
        setBusy(true);
        setError(null);
        const body = own ? { steps, reason: reason.trim() } : { templateId: template.id, reason: reason.trim() || undefined };
        if (reportId) body.reportId = reportId;
        const result = await apiPost(`/guilds/${guildId}/moderation/${target.id}/punish`, body);
        setBusy(false);
        if (!result.ok) { setError(describeError(result)); return; }
        const data = result.data;
        let text = `${name}: ${data.summary}`;
        if (data.failed) text += ` · дальше не вышло: ${describeError({ error: data.failed })}`;
        if (data.reportClosed) text += ' · жалоба закрыта';
        toast(text, data.failed ? { tone: 'error', ttl: 8000 } : {});
        onDone?.(data);
        onClose();
    };

    return (
        <Dialog title={`Наказать: ${name}`} onClose={onClose} onSubmit={submit} busy={busy}
            submitLabel={template ? `Применить: ${template.name}` : 'Наказать'} submitTone={drastic ? 'danger' : 'primary'}>
            {!templates && <p className="muted small">Загружаем шаблоны…</p>}
            <div className="sanction-list" role="radiogroup" aria-label="Шаблон наказания">
                {(templates?.items || []).map(t => (
                    <button key={t.id} type="button" role="radio" aria-checked={picked === t.id}
                        className={`sanction-option ${picked === t.id ? 'is-picked' : ''}`} onClick={() => setPicked(t.id)}>
                        <strong>{t.name}</strong>
                        <span className="muted small">{t.summary || stepsText(t.steps)}</span>
                    </button>
                ))}
                <button type="button" role="radio" aria-checked={own} className={`sanction-option ${own ? 'is-picked' : ''}`} onClick={() => setPicked('own')}>
                    <strong>Своё наказание…</strong>
                    <span className="muted small">варн, мут, кик или бан — на выбор</span>
                </button>
            </div>
            {own && <StepsEditor guildId={guildId} value={steps} onChange={setSteps} />}
            {picked && (
                <div className="field">
                    {own ? 'Причина' : 'Причина (можно оставить из шаблона)'}
                    {own && (
                        <div className="reason-chips">
                            {(options?.reasons || []).map(r => (
                                <button type="button" key={r} className={`chip ${reason === r ? 'is-active' : ''}`} onClick={() => setReason(r)}>{r}</button>
                            ))}
                        </div>
                    )}
                    <input value={reason} maxLength={400} onChange={e => setReason(e.target.value)}
                        placeholder={template ? template.reason : 'Шаблон выше или своя причина'} aria-label="Причина" />
                </div>
            )}
            {reportId && <p className="muted small">После наказания жалоба закроется как решённая — с заметкой, что сделано.</p>}
            {error && <p className="error">{error}</p>}
        </Dialog>
    );
}
