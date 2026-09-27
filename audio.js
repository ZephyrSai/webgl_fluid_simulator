// Generative music for Fluid Studio.
//
// Everything is synthesized live with the Web Audio API: no samples, no audio files.
//
// The arrangement is driven by an "energy" level that follows how vigorously the canvas
// is being played. Layers fade in as it rises:
//   pad + generative bells → sub bass + shaker → hats + pulse bass → kick + clap
//   → auto arpeggio → stabs, open hats, risers and crashes (intense)
//
// Touch input plays on top of that bed:
//   - every finger / pen owns a sustained voice whose pitch follows x (scale-quantized),
//     brightness follows y, loudness follows speed (fingers) or pressure (pen)
//   - movement triggers tempo-synced plucks; faster strokes play denser, higher runs
//   - taps ring bells, twists play scale runs, pinch/spread sweep a master filter,
//     multi-finger taps fire an impact

const ROOT = 50; // D3
const LOOKAHEAD = 0.12; // seconds of audio scheduled ahead of the clock
const TICK_MS = 25;
const MAX_LIVE_VOICES = 56;
const MAX_SUSTAINED_VOICES = 6;

const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

const MOODS = {
    ambient:  { bpm: 84 },
    adaptive: { bpm: 100 },
    intense:  { bpm: 118 },
};

// `steps` is the 7-note mode, `melody` the consonant subset touch input is quantized to,
// `graph` a weighted Markov chain over scale degrees used to generate chord progressions.
const SCALES = {
    aeolian: {
        steps: [0, 2, 3, 5, 7, 8, 10],
        melody: [0, 3, 5, 7, 10],
        graph: {
            0: [[5, 3], [3, 2], [6, 2], [2, 1]],
            5: [[2, 2], [6, 3], [3, 1], [0, 1]],
            2: [[6, 2], [5, 1], [3, 1]],
            6: [[0, 4], [2, 1], [5, 1]],
            3: [[0, 2], [6, 2], [5, 1]],
        },
    },
    dorian: {
        steps: [0, 2, 3, 5, 7, 9, 10],
        melody: [0, 2, 3, 7, 9],
        graph: {
            0: [[3, 4], [6, 2], [2, 1], [4, 1]],
            3: [[0, 3], [6, 1], [4, 1]],
            6: [[0, 3], [3, 2]],
            2: [[3, 2], [6, 1]],
            4: [[0, 2], [3, 1]],
        },
    },
    phrygian: {
        steps: [0, 1, 3, 5, 7, 8, 10],
        melody: [0, 1, 5, 7, 8],
        graph: {
            0: [[1, 4], [5, 2], [6, 2], [3, 1]],
            1: [[0, 4], [6, 1]],
            5: [[1, 2], [6, 2], [0, 1]],
            6: [[0, 2], [1, 2]],
            3: [[0, 2], [1, 1]],
        },
    },
    harmonic: {
        steps: [0, 2, 3, 5, 7, 8, 11],
        melody: [0, 3, 5, 7, 8, 11],
        graph: {
            0: [[5, 3], [3, 2], [4, 2]],
            5: [[4, 2], [3, 1], [1, 1]],
            3: [[4, 3], [0, 1]],
            4: [[0, 4], [5, 1]],
            1: [[4, 3]],
        },
    },
    lydian: {
        steps: [0, 2, 4, 6, 7, 9, 11],
        melody: [0, 2, 4, 7, 9],
        graph: {
            0: [[1, 3], [4, 1], [5, 2]],
            1: [[0, 3], [5, 1], [4, 1]],
            4: [[0, 2], [5, 2], [1, 1]],
            5: [[1, 2], [0, 2], [4, 1]],
        },
    },
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const mtof = midi => 440 * Math.pow(2, (midi - 69) / 12);
const ramp = (lo, hi, v) => {
    const t = clamp((v - lo) / (hi - lo), 0, 1);
    return t * t * (3 - 2 * t);
};

function weightedPick (options) {
    let total = 0;
    for (const option of options) total += option[1];
    let r = Math.random() * total;
    for (const option of options) {
        r -= option[1];
        if (r <= 0) return option[0];
    }
    return options[0][0];
}

function createImpulse (ctx, seconds, decay) {
    const rate = ctx.sampleRate;
    const length = Math.max(1, Math.floor(rate * seconds));
    const impulse = ctx.createBuffer(2, length, rate);
    const predelay = Math.floor(rate * 0.012);
    for (let ch = 0; ch < 2; ch++) {
        const data = impulse.getChannelData(ch);
        let lp = 0;
        for (let i = predelay; i < length; i++) {
            const t = i / length;
            // Highs die out faster than lows, like a real room: bright early reflections, dark tail.
            lp += (Math.random() * 2 - 1 - lp) * (0.72 - 0.64 * t);
            data[i] = lp * Math.pow(1 - t, decay);
        }
    }
    return impulse;
}

function createNoise (ctx, seconds) {
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
}

function createDriveCurve (amount) {
    const n = 1024;
    const curve = new Float32Array(n);
    const norm = Math.tanh(amount);
    for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        curve[i] = Math.tanh(x * amount) / norm;
    }
    return curve;
}

export class MusicEngine {
    constructor () {
        this.ctx = null;
        this.enabled = true;
        this.volume = 0.7;
        this.mood = 'adaptive';
        this.scaleName = 'aeolian';
        this.scale = SCALES.aeolian;
        this.pendingScale = null;

        this.energy = 0;       // follows interaction, 0..1
        this.level = 0;        // arrangement intensity, latched once per bar
        this.degree = -1;      // current chord (scale degree)
        this.chordName = '';

        this.step = 0;
        this.nextStepTime = 0;
        this.lastTick = 0;
        this.timer = null;
        this.live = 0;

        this.toneBias = 0;     // <0 after pinching (muffled), >0 after spreading (airy)
        this.pinchAcc = 0;
        this.pinchTime = 0;
        this.whooshTime = 0;
        this.twistAcc = 0;
        this.twistIndex = 0;
        this.twistLast = 0;
        this.twistNoteTime = 0;

        this.pointerState = new Map();
        this.voices = new Map();
        this.melody = [];

        this.onBeat = null;
        this.onNote = null;
        this.onChord = null;
        this.onStateChange = null;

        this.buildMelody();
    }

    // ---------------------------------------------------------------- lifecycle

    get running () {
        return !!this.ctx && this.enabled && this.ctx.state === 'running';
    }

    get started () {
        return !!this.ctx;
    }

    get stepDur () {
        return 60 / MOODS[this.mood].bpm / 4;
    }

    // Must be called from a user gesture (pointerup / touchend / click / keydown) the first time.
    unlock () {
        if (!this.enabled) return;
        if (!this.ctx) {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (!AudioContextClass) return;
            // Let Web Audio play even when an iPhone/iPad is in silent mode.
            try {
                if (navigator.audioSession) navigator.audioSession.type = 'playback';
            } catch (e) { /* not supported */ }
            try {
                this.ctx = new AudioContextClass({ latencyHint: 'interactive' });
            } catch (e) {
                this.ctx = new AudioContextClass();
            }
            this.ctx.onstatechange = () => this.notifyState();
            this.build();
            this.startScheduler();
            this.notifyState();
        }
        if (this.ctx.state !== 'running') {
            // Older iOS only unlocks output once a buffer has been started inside the gesture.
            const silent = this.ctx.createBufferSource();
            silent.buffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
            silent.connect(this.ctx.destination);
            silent.start(0);
            const resumed = this.ctx.resume();
            if (resumed && resumed.catch) resumed.catch(() => {});
        }
    }

    setEnabled (enabled) {
        this.enabled = enabled;
        if (!this.ctx) {
            this.notifyState();
            return;
        }
        const now = this.ctx.currentTime;
        if (enabled) {
            this.unlock();
            this.master.gain.setTargetAtTime(this.volumeGain(), now, 0.08);
        } else {
            this.releaseAllVoices();
            this.master.gain.setTargetAtTime(0, now, 0.06);
            setTimeout(() => {
                if (!this.enabled && this.ctx.state === 'running') this.ctx.suspend();
            }, 400);
        }
        this.notifyState();
    }

    suspend () {
        if (this.ctx && this.ctx.state === 'running') {
            this.releaseAllVoices();
            this.ctx.suspend();
        }
    }

    resume () {
        if (this.ctx && this.enabled && this.ctx.state !== 'running') {
            const resumed = this.ctx.resume();
            if (resumed && resumed.catch) resumed.catch(() => {});
        }
    }

    setVolume (volume) {
        this.volume = clamp(volume, 0, 1);
        if (this.ctx && this.enabled) this.master.gain.setTargetAtTime(this.volumeGain(), this.ctx.currentTime, 0.05);
    }

    setMood (mood) {
        if (!MOODS[mood]) return;
        this.mood = mood;
        if (this.ctx) this.updateDelayTime();
    }

    setScale (name) {
        if (!SCALES[name]) return;
        this.scaleName = name;
        // Switch on the next bar so the change lands musically.
        if (this.ctx) this.pendingScale = name;
        else this.applyScale(name);
    }

    volumeGain () {
        return this.volume * this.volume * 1.1;
    }

    notifyState () {
        if (this.onStateChange) this.onStateChange();
    }

    // ---------------------------------------------------------------- audio graph

    build () {
        const ctx = this.ctx;

        // bus → tone (gesture filter) → glue compressor → master volume → limiter → out
        this.bus = ctx.createGain();
        this.bus.gain.value = 0.8;
        this.toneFilter = ctx.createBiquadFilter();
        this.toneFilter.type = 'lowpass';
        this.toneFilter.frequency.value = 18000;
        this.toneFilter.Q.value = 0.9;
        this.glue = ctx.createDynamicsCompressor();
        this.glue.threshold.value = -16;
        this.glue.knee.value = 8;
        this.glue.ratio.value = 3;
        this.glue.attack.value = 0.01;
        this.glue.release.value = 0.2;
        this.master = ctx.createGain();
        this.master.gain.value = this.enabled ? this.volumeGain() : 0;
        this.limiter = ctx.createDynamicsCompressor();
        this.limiter.threshold.value = -3;
        this.limiter.knee.value = 0;
        this.limiter.ratio.value = 20;
        this.limiter.attack.value = 0.002;
        this.limiter.release.value = 0.12;
        this.bus.connect(this.toneFilter);
        this.toneFilter.connect(this.glue);
        this.glue.connect(this.master);
        this.master.connect(this.limiter);
        this.limiter.connect(ctx.destination);

        // Sidechain-style ducking for pads/bass/arp, pumped by the kick.
        this.duck = ctx.createGain();
        this.duck.connect(this.bus);
        this.drums = ctx.createGain();
        this.drums.gain.value = 0.9;
        this.drums.connect(this.bus);

        // Reverb with a procedurally generated impulse response.
        this.reverbSend = ctx.createGain();
        this.reverb = ctx.createConvolver();
        this.reverb.buffer = createImpulse(ctx, 3.6, 2.4);
        this.reverbReturn = ctx.createGain();
        this.reverbReturn.gain.value = 0.85;
        this.reverbSend.connect(this.reverb);
        this.reverb.connect(this.reverbReturn);
        this.reverbReturn.connect(this.bus);

        // Ping-pong delay, dotted eighths, darkening on every repeat.
        this.delaySend = ctx.createGain();
        this.delayL = ctx.createDelay(2);
        this.delayR = ctx.createDelay(2);
        const feedback = ctx.createGain();
        feedback.gain.value = 0.38;
        const damp = ctx.createBiquadFilter();
        damp.type = 'lowpass';
        damp.frequency.value = 2600;
        const merger = ctx.createChannelMerger(2);
        this.delayReturn = ctx.createGain();
        this.delayReturn.gain.value = 0.55;
        this.delaySend.connect(this.delayL);
        this.delayL.connect(merger, 0, 0);
        this.delayL.connect(this.delayR);
        this.delayR.connect(merger, 0, 1);
        this.delayR.connect(damp);
        damp.connect(feedback);
        feedback.connect(this.delayL);
        merger.connect(this.delayReturn);
        this.delayReturn.connect(this.bus);
        this.delayReturn.connect(this.reverbSend);
        this.updateDelayTime();

        // Pad: shared, slowly breathing filter.
        this.padFilter = ctx.createBiquadFilter();
        this.padFilter.type = 'lowpass';
        this.padFilter.frequency.value = 900;
        this.padFilter.Q.value = 0.8;
        const padLfo = ctx.createOscillator();
        padLfo.frequency.value = 0.06;
        const padLfoDepth = ctx.createGain();
        padLfoDepth.gain.value = 320;
        padLfo.connect(padLfoDepth);
        padLfoDepth.connect(this.padFilter.frequency);
        padLfo.start();
        this.padOut = ctx.createGain();
        this.padOut.gain.value = 0.9;
        this.padFilter.connect(this.padOut);
        this.padOut.connect(this.duck);
        const padVerb = ctx.createGain();
        padVerb.gain.value = 0.55;
        this.padOut.connect(padVerb);
        padVerb.connect(this.reverbSend);

        // Bass: clean + driven paths, the drive fades in at high intensity.
        this.bassBus = ctx.createGain();
        this.bassClean = ctx.createGain();
        this.bassDriven = ctx.createGain();
        this.bassDriven.gain.value = 0;
        const shaper = ctx.createWaveShaper();
        shaper.curve = createDriveCurve(3);
        shaper.oversample = '2x';
        this.bassBus.connect(this.bassClean);
        this.bassBus.connect(shaper);
        shaper.connect(this.bassDriven);
        this.bassClean.connect(this.duck);
        this.bassDriven.connect(this.duck);

        // Touch voices get their own bus so they sit above the bed.
        this.voiceBus = ctx.createGain();
        this.voiceBus.gain.value = 1.5;
        this.voiceBus.connect(this.bus);

        this.noise = createNoise(ctx, 2);
    }

    updateDelayTime () {
        const time = (60 / MOODS[this.mood].bpm) * 0.75;
        const now = this.ctx.currentTime;
        this.delayL.delayTime.setTargetAtTime(time, now, 0.2);
        this.delayR.delayTime.setTargetAtTime(time, now, 0.2);
    }

    // Connects `node` to the mix with optional panning and effect sends.
    route (node, pan, reverb, delay, destination) {
        const ctx = this.ctx;
        let out = node;
        if (pan && ctx.createStereoPanner) {
            const panner = ctx.createStereoPanner();
            panner.pan.value = clamp(pan, -1, 1);
            node.connect(panner);
            out = panner;
        }
        out.connect(destination || this.bus);
        if (reverb > 0) {
            const send = ctx.createGain();
            send.gain.value = reverb;
            out.connect(send);
            send.connect(this.reverbSend);
        }
        if (delay > 0) {
            const send = ctx.createGain();
            send.gain.value = delay;
            out.connect(send);
            send.connect(this.delaySend);
        }
    }

    // Counts a one-shot voice until `source` stops, so bursts of notes can't pile up unbounded.
    track (source) {
        this.live++;
        source.onended = () => { this.live--; };
    }

    hasRoom (priority = 0) {
        return this.live < MAX_LIVE_VOICES + priority * 16;
    }

    noiseSource (time, duration) {
        const src = this.ctx.createBufferSource();
        src.buffer = this.noise;
        const offset = Math.random() * Math.max(0, this.noise.duration - duration - 0.05);
        src.start(time, offset, duration + 0.02);
        return src;
    }

    // ---------------------------------------------------------------- clock

    startScheduler () {
        this.nextStepTime = this.ctx.currentTime + 0.08;
        this.lastTick = this.ctx.currentTime;
        this.timer = setInterval(() => this.tick(), TICK_MS);
    }

    tick () {
        const ctx = this.ctx;
        if (!ctx || ctx.state !== 'running') return;
        const now = ctx.currentTime;
        const dt = clamp(now - this.lastTick, 0, 0.1);
        this.lastTick = now;
        this.updateEnergy(dt);
        this.relaxTone(dt);
        // After a suspend the clock jumps; skip missed steps instead of firing them all at once.
        if (this.nextStepTime < now - 0.05) this.nextStepTime = now + 0.05;
        this.scheduleUntil(now + LOOKAHEAD);
    }

    scheduleUntil (horizon) {
        while (this.nextStepTime < horizon) {
            this.playStep(this.step, this.nextStepTime);
            this.nextStepTime += this.stepDur;
            this.step++;
        }
    }

    updateEnergy (dt) {
        let drive = 0;
        for (const st of this.pointerState.values()) {
            const weight = st.type === 'pen' ? 0.5 + st.pressure : 1;
            drive += (0.08 + 0.92 * st.speedN) * weight;
        }
        if (drive > 0) this.energy += dt * 0.16 * drive * (1.02 - this.energy);
        this.energy -= dt * (drive > 0.05 ? 0.03 : 0.06);
        this.energy = clamp(this.energy, 0, 1);
    }

    effectiveEnergy () {
        if (this.mood === 'ambient') return this.energy * 0.42;
        if (this.mood === 'intense') return 0.55 + this.energy * 0.45;
        return this.energy;
    }

    // ---------------------------------------------------------------- harmony

    applyScale (name) {
        this.scale = SCALES[name];
        this.degree = -1;
        this.buildMelody();
    }

    buildMelody () {
        const out = [];
        for (let octave = 0; octave < 3; octave++)
            for (const s of this.scale.melody) out.push(ROOT + 12 * octave + s);
        out.push(ROOT + 36);
        this.melody = out;
    }

    tone (degree) {
        const steps = this.scale.steps;
        return steps[((degree % 7) + 7) % 7] + 12 * Math.floor(degree / 7);
    }

    chordTones (degree = this.degree) {
        return [this.tone(degree), this.tone(degree + 2), this.tone(degree + 4)];
    }

    chordPitchClasses () {
        return this.chordTones().map(t => (ROOT + t) % 12);
    }

    melodyIndexForX (x) {
        return clamp(Math.floor(x * this.melody.length), 0, this.melody.length - 1);
    }

    noteForX (x) {
        return this.melody[this.melodyIndexForX(x)];
    }

    nearestChordTone (midi) {
        const pcs = this.chordPitchClasses();
        for (let d = 0; d <= 6; d++) {
            if (pcs.includes(((midi - d) % 12 + 12) % 12)) return midi - d;
            if (pcs.includes((midi + d) % 12)) return midi + d;
        }
        return midi;
    }

    randomChordTone (low, high) {
        const pcs = this.chordPitchClasses();
        const candidates = [];
        for (let m = low; m <= high; m++) if (pcs.includes(m % 12)) candidates.push(m);
        return candidates[Math.floor(Math.random() * candidates.length)];
    }

    bassRoot () {
        let midi = ROOT - 12 + (this.tone(this.degree) % 12);
        if (midi > ROOT - 5) midi -= 12;
        return midi;
    }

    nameChord (degree) {
        const root = this.tone(degree);
        const third = this.tone(degree + 2) - root;
        const fifth = this.tone(degree + 4) - root;
        let quality = third === 3 ? 'm' : '';
        if (fifth === 6) quality = '°';
        else if (fifth === 8) quality = '+';
        return NOTE_NAMES[(ROOT + root) % 12] + quality;
    }

    nextChord (time, bars) {
        if (this.degree < 0) this.degree = 0;
        else this.degree = weightedPick(this.scale.graph[this.degree] || [[0, 1]]);
        this.chordName = this.nameChord(this.degree);

        const L = this.level;
        const duration = this.stepDur * 16 * bars;
        this.pad(time, duration, L);
        const subGain = ramp(0.1, 0.3, L);
        if (subGain > 0.02) this.sub(time, duration, subGain);
        if (L > 0.8) this.stab(time, 0.55 + 0.45 * ramp(0.8, 1, L));

        if (this.onChord) this.at(time, () => this.onChord && this.onChord(this.chordName));
    }

    // Runs `fn` on the main thread roughly when `time` is heard.
    at (time, fn) {
        const delay = Math.max(0, (time - this.ctx.currentTime) * 1000);
        setTimeout(fn, delay);
    }

    // ---------------------------------------------------------------- sequencer

    startBar (bar, time) {
        if (this.pendingScale) {
            this.applyScale(this.pendingScale);
            this.pendingScale = null;
        }
        const previous = this.level;
        this.level = this.effectiveEnergy();
        const L = this.level;

        if (bar % 2 === 0 || this.degree < 0) this.nextChord(time, 2);

        this.padFilter.frequency.setTargetAtTime(420 + 3400 * (0.12 + L) * (0.6 + 0.4 * L), time, 1.2);
        this.bassDriven.gain.setTargetAtTime(0.55 * ramp(0.72, 0.95, L), time, 0.3);
        this.bassClean.gain.setTargetAtTime(1 - 0.4 * ramp(0.72, 0.95, L), time, 0.3);

        const phrase = bar % 8;
        if (phrase === 7 && L > 0.62) this.riser(time, this.stepDur * 16);
        const drop = previous < 0.5 && L >= 0.5;
        if ((phrase === 0 && previous > 0.62) || drop) this.crash(time, 0.55 + 0.45 * L);
    }

    playStep (step, time) {
        const s16 = step % 16;
        if (s16 === 0) this.startBar(Math.floor(step / 16), time);
        const L = this.level;
        const sd = this.stepDur;
        const rand = Math.random;

        // Drums
        let kicked = false;
        const kickGain = ramp(0.45, 0.6, L);
        if (kickGain > 0.02) {
            let hit = s16 === 0 || s16 === 8 || (L > 0.62 && (s16 === 4 || s16 === 12));
            if (L > 0.85 && (s16 === 14 || s16 === 7) && rand() < 0.35) hit = true;
            if (hit) {
                this.kick(time, kickGain * (s16 % 8 === 0 ? 1 : 0.85));
                kicked = true;
            }
        }
        const clapGain = ramp(0.55, 0.7, L);
        if (clapGain > 0.02) {
            if (s16 === 4 || s16 === 12) this.clap(time, clapGain);
            else if (L > 0.85 && s16 === 15 && rand() < 0.3) this.clap(time, clapGain * 0.35);
        }
        const hatGain = ramp(0.3, 0.46, L);
        if (hatGain > 0.02) {
            if (s16 % 2 === 0) this.hat(time, hatGain * (s16 % 4 === 2 ? 0.9 : 0.5), L > 0.8 && s16 % 4 === 2);
            else if (L > 0.7) this.hat(time, hatGain * (0.2 + 0.15 * rand()), false);
        }
        const shakerGain = ramp(0.12, 0.26, L) * (1 - hatGain);
        if (shakerGain > 0.02 && s16 % 2 === 0) this.shaker(time, shakerGain * (s16 % 4 === 2 ? 1 : 0.55));

        // Pulse bass
        const bassGain = ramp(0.36, 0.55, L);
        if (bassGain > 0.02) {
            const sixteenths = L > 0.75;
            if (sixteenths || s16 % 2 === 0) {
                const pattern = [0, 0, 12, 0, 0, 12, 0, 7, 0, 0, 12, 0, 0, 12, 7, 12];
                const offset = sixteenths ? pattern[s16] : (s16 % 4 === 2 ? 12 : 0);
                this.bass(this.bassRoot() + offset, time, sd * (sixteenths ? 0.9 : 1.7), bassGain * (s16 % 4 === 0 ? 1 : 0.8), L);
            }
        }

        // Auto arpeggio over the chord
        const arpGain = ramp(0.6, 0.8, L);
        if (arpGain > 0.02 && this.hasRoom()) {
            const tones = this.chordTones();
            const ladder = [];
            for (let octave = 1; octave <= 2; octave++) for (const t of tones) ladder.push(ROOT + t + 12 * octave);
            const up = ladder.concat(ladder.slice(1, -1).reverse());
            const note = up[step % up.length];
            this.pluck(note, time, 0.32 * arpGain, 0.5 + 0.35 * Math.sin(step * 0.37), 0.55, 'arp');
        }

        // Generative bells: the ambient sparkle, busiest when things are calm
        if (s16 % 2 === 0) {
            const chance = 0.09 * (1 - 0.6 * L) + (this.pointerState.size ? 0 : 0.03);
            if (rand() < chance && this.hasRoom()) {
                const note = this.randomChordTone(ROOT + 22, ROOT + 41);
                this.bell(note, time + rand() * 0.02, 0.3 + 0.3 * rand(), rand() * 1.4 - 0.7, 0.75);
            }
        }

        // Touch-driven plucks
        for (const [id, st] of this.pointerState) {
            const speed = st.speedN;
            if (speed < 0.07) continue;
            const every = speed < 0.3 ? 4 : speed < 0.65 ? 2 : 1;
            if (step % every !== 0) continue;
            let midi = this.noteForX(st.x);
            if (s16 % 4 === 0) midi = this.nearestChordTone(midi);
            if (every === 1 && step % 2 === 1 && speed > 0.85) midi += 12;
            if (midi === st.lastPluck && every > 1 && rand() < 0.5) continue;
            st.lastPluck = midi;
            const velocity = Math.min(1, (0.3 + 0.7 * speed) * (st.type === 'pen' ? 0.45 + 0.75 * st.pressure : 1));
            this.pluck(midi, time, velocity, (st.x * 2 - 1) * 0.75, st.y, st.type === 'pen' ? 'pen' : 'finger');
            if (this.onNote) this.onNote(id, midi);
        }

        if (s16 % 4 === 0 && this.onBeat) {
            const strength = kicked ? 0.55 + 0.45 * L : 0.3 + 0.3 * L;
            this.at(time, () => this.onBeat && this.onBeat(strength));
        }
    }

    // ---------------------------------------------------------------- instruments

    pad (time, duration, L) {
        const ctx = this.ctx;
        let base = ROOT + this.tone(this.degree);
        if (base > ROOT + 6) base -= 12;
        const t = this.tone(this.degree);
        const notes = [
            base,
            base + (this.tone(this.degree + 4) - t),
            base + (this.tone(this.degree + 2) - t) + 12,
            base + (this.tone(this.degree + 6) - t) + 12,
        ];
        const attack = 2.2;
        const release = 3;
        const end = time + duration + release;
        const env = ctx.createGain();
        env.gain.setValueAtTime(0, time);
        env.gain.linearRampToValueAtTime(1, time + attack);
        env.gain.setValueAtTime(1, time + duration);
        env.gain.linearRampToValueAtTime(0, end);
        env.connect(this.padFilter);

        const level = 0.05 + 0.015 * L;
        let last = null;
        notes.forEach((midi, i) => {
            const f = mtof(midi);
            for (const detune of [-7, 7]) {
                const osc = ctx.createOscillator();
                osc.type = 'sawtooth';
                osc.frequency.value = f;
                osc.detune.value = detune + (Math.random() - 0.5) * 4;
                const g = ctx.createGain();
                g.gain.value = level * (i === 3 ? 0.6 : 1);
                osc.connect(g);
                g.connect(env);
                osc.start(time);
                osc.stop(end + 0.05);
                last = osc;
            }
        });
        // A soft sine an octave above the root keeps the pad glassy when the filter is closed.
        const shimmer = ctx.createOscillator();
        shimmer.frequency.value = mtof(base + 24);
        const shimmerGain = ctx.createGain();
        shimmerGain.gain.value = 0.02;
        shimmer.connect(shimmerGain);
        shimmerGain.connect(env);
        shimmer.start(time);
        shimmer.stop(end + 0.05);
        if (last) this.track(last);
    }

    sub (time, duration, gain) {
        const ctx = this.ctx;
        const osc = ctx.createOscillator();
        osc.frequency.value = mtof(this.bassRoot());
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, time);
        g.gain.linearRampToValueAtTime(0.07 * gain, time + 0.35);
        g.gain.setValueAtTime(0.07 * gain, time + duration - 0.1);
        g.gain.linearRampToValueAtTime(0, time + duration + 0.4);
        osc.connect(g);
        g.connect(this.duck);
        osc.start(time);
        osc.stop(time + duration + 0.5);
        this.track(osc);
    }

    bass (midi, time, duration, gain, L) {
        const ctx = this.ctx;
        const f = mtof(midi);
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = f;
        const square = ctx.createOscillator();
        square.type = 'square';
        square.frequency.value = f / 2;
        const squareGain = ctx.createGain();
        squareGain.gain.value = 0.35;
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.Q.value = 5;
        const peak = 220 + 2200 * L * gain;
        filter.frequency.setValueAtTime(peak, time);
        filter.frequency.exponentialRampToValueAtTime(Math.max(90, f * 1.2), time + duration);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, time);
        g.gain.exponentialRampToValueAtTime(0.4 * gain, time + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, time + duration);
        osc.connect(filter);
        square.connect(squareGain);
        squareGain.connect(filter);
        filter.connect(g);
        g.connect(this.bassBus);
        osc.start(time);
        square.start(time);
        osc.stop(time + duration + 0.05);
        square.stop(time + duration + 0.05);
        this.track(osc);
    }

    pluck (midi, time, velocity, pan, y, kind) {
        if (!this.hasRoom()) return;
        const ctx = this.ctx;
        const f = mtof(midi);
        const bright = 0.25 + 0.75 * clamp(y, 0, 1);
        const out = ctx.createGain();
        let end;
        let main;

        if (kind === 'pen') {
            // Glassy FM tone: sharp attack, harmonic 3:1 modulator.
            const carrier = ctx.createOscillator();
            carrier.frequency.value = f;
            const mod = ctx.createOscillator();
            mod.frequency.value = f * 3;
            const index = ctx.createGain();
            const depth = f * (0.6 + 2.2 * bright) * velocity;
            index.gain.setValueAtTime(depth, time);
            index.gain.exponentialRampToValueAtTime(Math.max(1, depth * 0.04), time + 0.9);
            mod.connect(index);
            index.connect(carrier.frequency);
            carrier.connect(out);
            end = time + 1.8;
            out.gain.setValueAtTime(0.0001, time);
            out.gain.exponentialRampToValueAtTime(0.15 * velocity + 0.0001, time + 0.004);
            out.gain.exponentialRampToValueAtTime(0.0001, end);
            mod.start(time);
            carrier.start(time);
            mod.stop(end);
            carrier.stop(end);
            main = carrier;
        } else {
            // Plucked saw through a snapping lowpass.
            const osc = ctx.createOscillator();
            osc.type = 'sawtooth';
            osc.frequency.value = f;
            const octave = ctx.createOscillator();
            octave.type = 'triangle';
            octave.frequency.value = f * 2;
            octave.detune.value = 4;
            const octaveGain = ctx.createGain();
            octaveGain.gain.value = 0.3;
            const filter = ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.Q.value = 3.5;
            const peak = 400 + (1500 + 5000 * bright) * velocity;
            filter.frequency.setValueAtTime(peak, time);
            filter.frequency.exponentialRampToValueAtTime(Math.max(200, f), time + 0.35);
            osc.connect(filter);
            octave.connect(octaveGain);
            octaveGain.connect(filter);
            filter.connect(out);
            const length = kind === 'arp' ? 0.45 : 0.95;
            end = time + length;
            out.gain.setValueAtTime(0.0001, time);
            out.gain.exponentialRampToValueAtTime((kind === 'arp' ? 0.16 : 0.13) * velocity + 0.0001, time + 0.003);
            out.gain.exponentialRampToValueAtTime(0.0001, end);
            osc.start(time);
            octave.start(time);
            osc.stop(end + 0.02);
            octave.stop(end + 0.02);
            main = osc;
        }
        this.track(main);
        this.route(out, pan, 0.2 + 0.3 * y, kind === 'arp' ? 0.35 : 0.26, kind === 'arp' ? this.duck : this.voiceBus);
    }

    bell (midi, time, velocity, pan, wet) {
        const ctx = this.ctx;
        const f = mtof(midi);
        const carrier = ctx.createOscillator();
        carrier.frequency.value = f;
        const mod = ctx.createOscillator();
        mod.frequency.value = f * 3.5;
        const index = ctx.createGain();
        const depth = f * 1.6 * velocity;
        index.gain.setValueAtTime(depth, time);
        index.gain.exponentialRampToValueAtTime(Math.max(1, depth * 0.03), time + 1.2);
        mod.connect(index);
        index.connect(carrier.frequency);
        const partial = ctx.createOscillator();
        partial.frequency.value = f * 2.76;
        const partialGain = ctx.createGain();
        partialGain.gain.setValueAtTime(0.1 * velocity, time);
        partialGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.7);
        partial.connect(partialGain);
        const out = ctx.createGain();
        const end = time + 1.6 + 1.6 * velocity;
        out.gain.setValueAtTime(0.0001, time);
        out.gain.exponentialRampToValueAtTime(0.18 * velocity + 0.0001, time + 0.003);
        out.gain.exponentialRampToValueAtTime(0.0001, end);
        carrier.connect(out);
        partialGain.connect(out);
        mod.start(time);
        carrier.start(time);
        partial.start(time);
        mod.stop(end);
        carrier.stop(end);
        partial.stop(time + 0.75);
        this.track(carrier);
        this.route(out, pan, wet, 0.2, this.voiceBus);
    }

    stab (time, gain) {
        const ctx = this.ctx;
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.Q.value = 2;
        filter.frequency.setValueAtTime(3800, time);
        filter.frequency.exponentialRampToValueAtTime(500, time + 0.5);
        const out = ctx.createGain();
        out.gain.setValueAtTime(0.0001, time);
        out.gain.exponentialRampToValueAtTime(0.05 * gain, time + 0.01);
        out.gain.exponentialRampToValueAtTime(0.0001, time + 0.7);
        filter.connect(out);
        let last = null;
        for (const t of this.chordTones()) {
            const f = mtof(ROOT + 12 + t);
            for (const detune of [-14, 0, 14]) {
                const osc = ctx.createOscillator();
                osc.type = 'sawtooth';
                osc.frequency.value = f;
                osc.detune.value = detune;
                osc.connect(filter);
                osc.start(time);
                osc.stop(time + 0.75);
                last = osc;
            }
        }
        this.track(last);
        this.route(out, 0, 0.4, 0.3, this.bus);
    }

    kick (time, gain) {
        const ctx = this.ctx;
        const osc = ctx.createOscillator();
        osc.frequency.setValueAtTime(155, time);
        osc.frequency.exponentialRampToValueAtTime(44, time + 0.12);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, time);
        g.gain.exponentialRampToValueAtTime(0.95 * gain, time + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, time + 0.45);
        osc.connect(g);
        g.connect(this.drums);
        osc.start(time);
        osc.stop(time + 0.5);
        this.track(osc);

        const click = this.noiseSource(time, 0.012);
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 2500;
        const clickGain = ctx.createGain();
        clickGain.gain.setValueAtTime(0.22 * gain, time);
        clickGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.012);
        click.connect(hp);
        hp.connect(clickGain);
        clickGain.connect(this.drums);

        // Pump the bed.
        const duck = this.duck.gain;
        duck.setTargetAtTime(1 - 0.55 * gain, time, 0.006);
        duck.setTargetAtTime(1, time + 0.05, 0.09);
    }

    clap (time, gain) {
        const ctx = this.ctx;
        const src = this.noiseSource(time, 0.3);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 1500;
        bp.Q.value = 0.9;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, time);
        for (const offset of [0, 0.011, 0.022]) {
            g.gain.setValueAtTime(0.6 * gain, time + offset);
            g.gain.exponentialRampToValueAtTime(0.06 * gain + 0.0001, time + offset + 0.01);
        }
        g.gain.setValueAtTime(0.54 * gain, time + 0.033);
        g.gain.exponentialRampToValueAtTime(0.0001, time + 0.26);
        src.connect(bp);
        bp.connect(g);
        this.route(g, 0, 0.25, 0, this.drums);

        const body = ctx.createOscillator();
        body.type = 'triangle';
        body.frequency.setValueAtTime(200, time);
        body.frequency.exponentialRampToValueAtTime(150, time + 0.08);
        const bodyGain = ctx.createGain();
        bodyGain.gain.setValueAtTime(0.16 * gain, time);
        bodyGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.09);
        body.connect(bodyGain);
        bodyGain.connect(this.drums);
        body.start(time);
        body.stop(time + 0.1);
        this.track(src);
    }

    hat (time, gain, open) {
        const ctx = this.ctx;
        const length = open ? 0.3 : 0.05;
        const src = this.noiseSource(time, length);
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 7200;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, time);
        g.gain.exponentialRampToValueAtTime(0.28 * gain, time + 0.002);
        g.gain.exponentialRampToValueAtTime(0.0001, time + length);
        src.connect(hp);
        hp.connect(g);
        this.route(g, 0.2, open ? 0.12 : 0, 0, this.drums);
        this.track(src);
    }

    shaker (time, gain) {
        const ctx = this.ctx;
        const src = this.noiseSource(time, 0.09);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 5200;
        bp.Q.value = 1.4;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, time);
        g.gain.exponentialRampToValueAtTime(0.32 * gain, time + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, time + 0.085);
        src.connect(bp);
        bp.connect(g);
        this.route(g, -0.25, 0.12, 0, this.drums);
        this.track(src);
    }

    crash (time, gain) {
        const ctx = this.ctx;
        const src = this.noiseSource(time, 2.4);
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 4200;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, time);
        g.gain.exponentialRampToValueAtTime(0.16 * gain, time + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, time + 2.3);
        src.connect(hp);
        hp.connect(g);
        this.route(g, 0, 0.3, 0, this.drums);
        this.track(src);
    }

    riser (time, duration) {
        const ctx = this.ctx;
        const src = this.noiseSource(time, duration);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.value = 2.5;
        bp.frequency.setValueAtTime(350, time);
        bp.frequency.exponentialRampToValueAtTime(8000, time + duration);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, time);
        g.gain.exponentialRampToValueAtTime(0.09, time + duration * 0.95);
        g.gain.linearRampToValueAtTime(0, time + duration);
        src.connect(bp);
        bp.connect(g);
        this.route(g, 0, 0.35, 0.2, this.bus);
        this.track(src);
    }

    whoosh (time, up) {
        const ctx = this.ctx;
        const duration = 0.55;
        const src = this.noiseSource(time, duration);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.value = 1.8;
        bp.frequency.setValueAtTime(up ? 300 : 6500, time);
        bp.frequency.exponentialRampToValueAtTime(up ? 6500 : 250, time + duration);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, time);
        g.gain.exponentialRampToValueAtTime(0.07, time + duration * 0.4);
        g.gain.exponentialRampToValueAtTime(0.0001, time + duration);
        src.connect(bp);
        bp.connect(g);
        this.route(g, 0, 0.4, 0, this.voiceBus);
        this.track(src);
    }

    subDrop (time) {
        const ctx = this.ctx;
        const osc = ctx.createOscillator();
        osc.frequency.setValueAtTime(110, time);
        osc.frequency.exponentialRampToValueAtTime(32, time + 1.0);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, time);
        g.gain.exponentialRampToValueAtTime(0.4, time + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, time + 1.3);
        osc.connect(g);
        g.connect(this.bus);
        osc.start(time);
        osc.stop(time + 1.35);
        this.track(osc);
    }

    // ---------------------------------------------------------------- sustained touch voices

    createVoice (st) {
        const ctx = this.ctx;
        const now = ctx.currentTime;
        const pen = st.type === 'pen';
        const midi = this.noteForX(st.x);
        const f = mtof(midi);

        const out = ctx.createGain();
        out.gain.value = 0;
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.Q.value = pen ? 3 : 1;
        filter.frequency.value = 900;
        filter.connect(out);

        const vibrato = ctx.createOscillator();
        vibrato.frequency.value = pen ? 5.3 : 4.4;
        const vibratoDepth = ctx.createGain();
        vibratoDepth.gain.value = 0;
        vibrato.connect(vibratoDepth);

        const oscillators = [];
        const add = (type, ratio, detune, level) => {
            const osc = ctx.createOscillator();
            osc.type = type;
            osc.frequency.value = f * ratio;
            osc.detune.value = detune;
            vibratoDepth.connect(osc.detune);
            const g = ctx.createGain();
            g.gain.value = level;
            osc.connect(g);
            g.connect(filter);
            oscillators.push({ osc, ratio });
        };
        if (pen) {
            // Bowed lead: two detuned saws over a square sub.
            add('sawtooth', 1, -5, 0.45);
            add('sawtooth', 1, 5, 0.45);
            add('square', 0.5, 0, 0.3);
        } else {
            // Glass harmonica: triangle body, sine octave, a whisper of saw.
            add('triangle', 1, 0, 0.8);
            add('sine', 2, 3, 0.25);
            add('sawtooth', 1, -6, 0.1);
        }

        let breath = null;
        let breathFilter = null;
        if (pen) {
            // Tilting the pencil adds breath noise, like a flute.
            const src = ctx.createBufferSource();
            src.buffer = this.noise;
            src.loop = true;
            breathFilter = ctx.createBiquadFilter();
            breathFilter.type = 'bandpass';
            breathFilter.Q.value = 6;
            breathFilter.frequency.value = f * 2;
            breath = ctx.createGain();
            breath.gain.value = 0;
            src.connect(breathFilter);
            breathFilter.connect(breath);
            breath.connect(out);
            src.start(now);
            oscillators.push({ osc: src, ratio: 0 });
        }

        let panner = null;
        let tail = out;
        if (ctx.createStereoPanner) {
            panner = ctx.createStereoPanner();
            panner.pan.value = (st.x * 2 - 1) * 0.7;
            out.connect(panner);
            tail = panner;
        }
        tail.connect(this.voiceBus);
        const verb = ctx.createGain();
        verb.gain.value = 0.35;
        tail.connect(verb);
        verb.connect(this.reverbSend);
        const echo = ctx.createGain();
        echo.gain.value = 0.12;
        tail.connect(echo);
        echo.connect(this.delaySend);

        vibrato.start(now);
        for (const o of oscillators) if (o.ratio) o.osc.start(now);
        oscillators.push({ osc: vibrato, ratio: 0 });

        return { out, filter, oscillators, vibratoDepth, panner, breath, breathFilter, midi, pen, lastUpdate: -Infinity };
    }

    updateVoice (voice, st) {
        const now = this.ctx.currentTime;
        if (now - voice.lastUpdate < 0.03) return;
        voice.lastUpdate = now;

        const midi = this.noteForX(st.x);
        if (midi !== voice.midi) {
            voice.midi = midi;
            const f = mtof(midi);
            for (const o of voice.oscillators)
                if (o.ratio) o.osc.frequency.setTargetAtTime(f * o.ratio, now, 0.03);
            if (voice.breathFilter) voice.breathFilter.frequency.setTargetAtTime(f * 2, now, 0.03);
        }

        const swell = st.holdStart ? clamp((now - st.holdStart) / 2, 0, 1) : 0;
        const norm = 1 / Math.sqrt(Math.max(1, this.voices.size));
        const y = clamp(st.y, 0, 1);
        let amp;
        let cutoff;
        if (voice.pen) {
            const p = st.pressure;
            amp = 0.02 + 0.13 * Math.pow(p, 1.4);
            cutoff = 350 + 5200 * Math.pow(p, 1.2) * (1 - 0.55 * st.tilt) * (0.5 + 0.5 * y);
            voice.breath.gain.setTargetAtTime(0.25 * st.tilt * (0.3 + p), now, 0.08);
        } else {
            amp = 0.03 + 0.08 * st.speedN + 0.05 * swell;
            cutoff = 500 + 3200 * (0.3 + 0.7 * y) * (0.5 + 0.5 * st.speedN) + 900 * swell;
        }
        voice.out.gain.setTargetAtTime(amp * norm, now, 0.05);
        voice.filter.frequency.setTargetAtTime(cutoff, now, 0.05);
        voice.vibratoDepth.gain.setTargetAtTime((voice.pen ? 4 : 6) + 20 * swell, now, 0.2);
        if (voice.panner) voice.panner.pan.setTargetAtTime((st.x * 2 - 1) * 0.7, now, 0.05);
    }

    releaseVoice (voice) {
        const now = this.ctx.currentTime;
        voice.out.gain.setTargetAtTime(0, now, 0.18);
        for (const o of voice.oscillators) {
            try { o.osc.stop(now + 1.2); } catch (e) { /* already stopped */ }
        }
    }

    releaseAllVoices () {
        if (this.ctx) for (const voice of this.voices.values()) this.releaseVoice(voice);
        this.voices.clear();
        this.pointerState.clear();
    }

    // ---------------------------------------------------------------- input API

    pointerDown (p) {
        if (!this.running) return;
        const st = {
            type: p.type, x: p.x, y: p.y, pressure: p.pressure, tilt: p.tilt,
            speedN: 0, holdStart: 0, lastPluck: -1,
        };
        this.pointerState.set(p.id, st);
        if (this.voices.size < MAX_SUSTAINED_VOICES) this.voices.set(p.id, this.createVoice(st));
    }

    updatePointer (p) {
        const st = this.pointerState.get(p.id);
        if (!st) return;
        st.x = p.x;
        st.y = p.y;
        st.pressure = p.pressure;
        st.tilt = p.tilt;
        st.speedN = Math.min(1, p.speed / 2.2);
        if (p.holding) {
            if (!st.holdStart) st.holdStart = this.ctx.currentTime;
        } else {
            st.holdStart = 0;
        }
        const voice = this.voices.get(p.id);
        if (voice) this.updateVoice(voice, st);
    }

    pointerUp (p) {
        this.pointerState.delete(p.id);
        const voice = this.voices.get(p.id);
        if (voice) {
            this.releaseVoice(voice);
            this.voices.delete(p.id);
        }
    }

    // Returns the note played so the visuals can match its color.
    tap (p) {
        if (!this.running) return null;
        let midi = this.nearestChordTone(this.noteForX(p.x));
        if (p.y > 0.66) midi += 12;
        const velocity = 0.5 + 0.5 * (p.type === 'pen' ? p.pressure : 0.6);
        this.bell(midi, this.ctx.currentTime + 0.005, velocity, (p.x * 2 - 1) * 0.7, 0.6);
        this.energy = Math.min(1, this.energy + 0.03);
        return midi;
    }

    burst () {
        if (!this.running) return;
        const time = this.ctx.currentTime + 0.01;
        this.crash(time, 1);
        this.subDrop(time);
        if (this.degree >= 0) this.stab(time, 1);
        this.energy = Math.min(1, this.energy + 0.25);
    }

    // amount > 0 when fingers spread apart, < 0 when they pinch together (per frame).
    pinch (amount) {
        if (!this.running) return;
        const now = this.ctx.currentTime;
        this.toneBias = clamp(this.toneBias + amount * 5, -1, 1);
        this.applyTone();
        if (now - this.pinchTime > 0.3) this.pinchAcc = 0;
        this.pinchTime = now;
        this.pinchAcc += amount;
        if (Math.abs(this.pinchAcc) > 0.12 && now - this.whooshTime > 0.7) {
            this.whoosh(now + 0.01, this.pinchAcc > 0);
            this.whooshTime = now;
            this.pinchAcc = 0;
        }
        this.energy = Math.min(1, this.energy + Math.abs(amount) * 0.4);
    }

    // angle in radians, counter-clockwise positive. Turning plays a scale run up or down.
    twist (angle, x) {
        if (!this.running) return;
        const now = this.ctx.currentTime;
        if (now - this.twistLast > 0.6) {
            this.twistAcc = 0;
            this.twistIndex = this.melodyIndexForX(x);
        }
        this.twistLast = now;
        this.twistAcc += angle;
        const STEP = 0.26;
        while (Math.abs(this.twistAcc) >= STEP) {
            const dir = Math.sign(this.twistAcc);
            this.twistAcc -= dir * STEP;
            this.twistIndex = clamp(this.twistIndex + dir, 0, this.melody.length - 1);
            if (now - this.twistNoteTime < 0.05) continue;
            this.twistNoteTime = now;
            this.bell(this.melody[this.twistIndex] + 12, now + 0.01, 0.45, (x * 2 - 1) * 0.6, 0.5);
            this.energy = Math.min(1, this.energy + 0.012);
        }
    }

    applyTone () {
        const now = this.ctx.currentTime;
        const cutoff = this.toneBias < 0 ? 18000 * Math.pow(2, this.toneBias * 6.2) : 18000;
        this.toneFilter.frequency.setTargetAtTime(cutoff, now, 0.05);
        this.reverbReturn.gain.setTargetAtTime(0.85 + 0.7 * Math.max(0, this.toneBias), now, 0.1);
    }

    relaxTone (dt) {
        if (Math.abs(this.toneBias) < 0.002) return;
        this.toneBias *= Math.exp(-dt / 1.8);
        if (Math.abs(this.toneBias) < 0.002) this.toneBias = 0;
        this.applyTone();
    }
}
