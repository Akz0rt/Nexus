function formatDate(date) {
    return date.toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric'
    });
}

function isValidDate(month, day) {
    const date = new Date(2000, month - 1, day);
    return date.getMonth() === month - 1 && date.getDate() === day;
}

function getDaysUntilBirthday(birthMonth, birthDay) {
    const today = new Date();
    const birthday = new Date(today.getFullYear(), birthMonth - 1, birthDay);
    
    // Reset time parts to compare dates only
    today.setHours(0, 0, 0, 0);
    birthday.setHours(0, 0, 0, 0);
    
    // If birthday has already passed this year, look at next year's birthday
    if (birthday < today) {
        birthday.setFullYear(today.getFullYear() + 1);
    }
    
    const diffTime = birthday.getTime() - today.getTime();
    return Math.floor(diffTime / (1000 * 60 * 60 * 24));
}

// Midnight of the current day in the given IANA timezone, as a UTC Date.
function startOfToday(timeZone, now = new Date()) {
    const local = new Date(now.toLocaleString('en-US', { timeZone }));
    const offsetMs = now.getTime() - local.getTime();
    local.setHours(0, 0, 0, 0);
    return new Date(local.getTime() + offsetMs);
}

module.exports = {
    formatDate,
    isValidDate,
    getDaysUntilBirthday,
    startOfToday
};