/** Replies for the economy commands: refusal codes → text. */

const number = n => Number(n || 0).toLocaleString('ru-RU');

const TEXT = {
    invalid_amount: 'Сумма — целое число больше нуля.',
    invalid_bet: 'Ставка — от 10 до 50 000 монет.',
    cooldown: 'Не так быстро: подбросить монетку можно раз в 5 секунд.',
    self: 'С самим собой нельзя.',
    bot: 'С ботами нельзя.',
    duel_gone: 'Этот вызов уже недействителен.',
    not_opponent: 'Этот вызов не вам.',
    challenger_broke: 'У вызвавшего уже не хватает монет на ставку. Дуэль отменена.',
    roles_disabled: 'Личные роли на этом сервере выключены.',
    anchor_invalid: 'Личные роли ещё не настроены: администратору нужно выбрать их место в приложении.',
    invalid_name: 'Название — до 50 символов, без @everyone, @here и ссылок-приглашений.',
    invalid_color: 'Цвет — в формате #ff7a1a.',
    icons_unavailable: 'Иконки ролей доступны только на сервере со 2-м уровнем буста.',
    invalid_icon: 'Иконка — картинка PNG, JPG или WEBP до 256 КБ.',
    invalid_emoji: 'Укажите один эмодзи.',
    not_personal: 'Это не личная роль.',
    not_owner: 'Это не ваша личная роль.',
    role_gone: 'Этой роли уже нет.',
    invalid_periods: 'Продлить можно на 1–12 сроков за раз.',
    too_far: 'Оплатить можно не больше чем на год вперёд.',
    nothing_to_change: 'Укажите, что изменить: название, цвет или иконку.',
    invalid_price: 'Цена — от 1 до 1 000 000 монет (0 — снять с продажи).',
    not_for_sale: 'Эта роль не продаётся.',
    own_role: 'Это ваша роль.',
    already_yours: 'Эта роль у вас и так есть — пока она существует.',
    owner_gone: 'Владельца роли нет на сервере, роль не продаётся.',
    discord_error: 'Discord не дал это сделать. Возможно, у бота не хватает прав — напишите администратору.'
};

/** Text for a refused result; `insufficient_funds` and the role limit carry numbers. */
function describe(result) {
    if (result.code === 'insufficient_funds') {
        const need = result.price ? ` Нужно ${number(result.price)}.` : '';
        return `Не хватает монет.${need}${result.balance !== undefined ? ` На балансе ${number(result.balance)}.` : ''}`;
    }
    if (result.code === 'too_many_roles') return `У вас уже ${result.limit} активных личных роли — это максимум.`;
    return TEXT[result.code] || `Не получилось (${result.code}).`;
}

module.exports = { describe, number };
