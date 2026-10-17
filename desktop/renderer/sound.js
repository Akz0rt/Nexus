// Short two-note chime for "a newcomer joined the queue", made with Web Audio
// so the app ships no sound files.

let context = null;

export function playChime() {
    try {
        context = context || new AudioContext();
        if (context.state === 'suspended') context.resume();
        const start = context.currentTime + 0.02;
        [[880, 0], [1318.5, 0.14]].forEach(([frequency, offset]) => {
            const osc = context.createOscillator();
            const gain = context.createGain();
            osc.type = 'sine';
            osc.frequency.value = frequency;
            gain.gain.setValueAtTime(0, start + offset);
            gain.gain.linearRampToValueAtTime(0.18, start + offset + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.001, start + offset + 0.45);
            osc.connect(gain).connect(context.destination);
            osc.start(start + offset);
            osc.stop(start + offset + 0.5);
        });
    } catch {
        // No audio device: the badge and the notification still tell
    }
}
