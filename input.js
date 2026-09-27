// Multi-pointer input for the fluid canvas: mouse, any number of touches and pens
// (Apple Pencil pressure and tilt), plus tap, multi-finger tap, hold, pinch and twist gestures.
//
// Pointers are tracked by pointerId, so fingers can land and lift in any order. Positions are
// reported in texture space (0..1, y up) so the simulation can use them directly. Every sample
// between frames is buffered (including coalesced high-rate pen samples) so fast strokes can be
// drawn as continuous lines instead of dotted splats.

const TAP_MAX_MS = 280;
const TAP_MAX_TRAVEL = 14;      // CSS px
const HOLD_DELAY_MS = 420;
const HOLD_MAX_DRIFT = 9;       // CSS px
const MULTI_TAP_MIN = 3;
const MULTI_TAP_WINDOW = 400;   // ms
const PATH_CAPACITY = 64;       // samples buffered per pointer between frames
const SPEED_SMOOTHING = 0.05;   // s
const SPEED_DECAY = 0.08;       // s, once a pointer stops sending events
const MIN_GESTURE_SPREAD = 24;  // CSS px
const PINCH_THRESHOLD = 0.0025; // relative spread change per frame
const TWIST_THRESHOLD = 0.003;  // radians per frame

class TrackedPointer {
    constructor () {
        this.path = new Float32Array(PATH_CAPACITY * 2);
        this.reset(-1, 'mouse');
    }

    reset (id, type) {
        this.id = id;
        this.type = type;
        this.down = false;
        this.x = 0;                // texture space, y up
        this.y = 0;
        this.lastX = 0;            // last position consumed by the simulation
        this.lastY = 0;
        this.pathLength = 0;       // samples buffered in `path` since the last frame
        this.pressure = 0.5;
        this.tilt = 0;             // 0 = pen upright, 1 = lying flat
        this.speed = 0;            // smoothed, screen short-sides per second
        this.holding = false;
        this.clientX = 0;
        this.clientY = 0;
        this.startClientX = 0;
        this.startClientY = 0;
        this.anchorX = 0;
        this.anchorY = 0;
        this.anchorTime = 0;
        this.startTime = 0;
        this.lastSeen = 0;
        this.lastEventTs = 0;
        this.travel = 0;
        this.gestureAngle = 0;
        this.color = null;
        this.colorLockUntil = 0;
    }
}

export function createInput (element, handlers = {}) {
    const pointers = new Map();
    const pool = [];
    const recentTaps = [];
    const gesture = { key: '', spread: 0 };
    let bounds = element.getBoundingClientRect();
    let touchPressure = false;
    let lastUpdate = performance.now();

    const refreshBounds = () => { bounds = element.getBoundingClientRect(); };
    if (window.ResizeObserver) new ResizeObserver(refreshBounds).observe(element);
    window.addEventListener('resize', refreshBounds);

    const activate = () => { if (handlers.onActivate) handlers.onActivate(); };

    element.addEventListener('pointerdown', onPointerDown, { passive: false });
    element.addEventListener('pointermove', onPointerMove, { passive: false });
    element.addEventListener('pointerup', onPointerUp);
    element.addEventListener('pointercancel', onPointerCancel);
    element.addEventListener('lostpointercapture', onPointerCancel);
    window.addEventListener('blur', releaseAll);

    // Keep the browser from turning touches into scrolling, zooming, text selection, the
    // magnifier loupe or context menus. Pointer events still arrive; these only block defaults.
    const block = e => e.preventDefault();
    element.addEventListener('touchstart', block, { passive: false });
    element.addEventListener('touchmove', block, { passive: false });
    element.addEventListener('touchend', e => { e.preventDefault(); activate(); }, { passive: false });
    element.addEventListener('contextmenu', block);
    element.addEventListener('dblclick', block);
    for (const type of ['gesturestart', 'gesturechange', 'gestureend'])
        document.addEventListener(type, block, { passive: false });

    function onPointerDown (e) {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        if (e.pointerType === 'mouse') activate();
        try { element.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }

        const stale = pointers.get(e.pointerId);
        if (stale) finish(stale, true);

        const p = pool.pop() || new TrackedPointer();
        p.reset(e.pointerId, e.pointerType || 'mouse');
        readSample(p, e);
        const now = performance.now();
        p.down = true;
        p.lastX = p.x;
        p.lastY = p.y;
        p.startClientX = p.anchorX = p.clientX;
        p.startClientY = p.anchorY = p.clientY;
        p.startTime = p.anchorTime = p.lastSeen = now;
        p.lastEventTs = e.timeStamp;
        pointers.set(e.pointerId, p);
        if (handlers.onDown) handlers.onDown(p);
    }

    function onPointerMove (e) {
        const p = pointers.get(e.pointerId);
        if (!p || !p.down) return;
        e.preventDefault();
        const samples = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
        if (samples && samples.length > 0) {
            for (let i = 0; i < samples.length; i++) addSample(p, samples[i]);
        } else {
            addSample(p, e);
        }
        p.lastSeen = performance.now();
    }

    function onPointerUp (e) {
        const p = pointers.get(e.pointerId);
        if (!p) return;
        activate();
        finish(p, false);
    }

    function onPointerCancel (e) {
        // Fires when the OS takes over (e.g. iPadOS four/five-finger gestures): release cleanly.
        const p = pointers.get(e.pointerId);
        if (p) finish(p, true);
    }

    function releaseAll () {
        for (const p of Array.from(pointers.values())) finish(p, true);
    }

    function finish (p, cancelled) {
        const now = performance.now();
        const tap = !cancelled && now - p.startTime < TAP_MAX_MS && p.travel < TAP_MAX_TRAVEL;
        p.down = false;
        pointers.delete(p.id);
        if (handlers.onUp) handlers.onUp(p, tap);
        if (tap) {
            if (handlers.onTap) handlers.onTap(p);
            registerTap(p, now);
        }
        pool.push(p);
    }

    function readSample (p, e) {
        const x = e.clientX - bounds.left;
        const y = e.clientY - bounds.top;
        p.clientX = x;
        p.clientY = y;
        p.x = x / bounds.width;
        p.y = 1.0 - y / bounds.height;

        if (p.type === 'pen') {
            if (e.pressure > 0) p.pressure = e.pressure;
            p.tilt = readTilt(e);
        } else if (p.type === 'touch') {
            // Most touch screens report a fixed 0.5 (or 0/1); trust it only once it varies.
            if (e.pressure > 0 && e.pressure !== 0.5 && e.pressure !== 1) touchPressure = true;
            p.pressure = touchPressure && e.pressure > 0 ? e.pressure : 0.5;
        } else {
            p.pressure = 0.5;
        }
    }

    function readTilt (e) {
        if (typeof e.altitudeAngle === 'number')
            return clamp01(1 - e.altitudeAngle / (Math.PI / 2));
        const tilt = Math.max(Math.abs(e.tiltX || 0), Math.abs(e.tiltY || 0));
        return clamp01(tilt / 90);
    }

    function addSample (p, e) {
        const prevX = p.clientX;
        const prevY = p.clientY;
        readSample(p, e);

        const dist = Math.hypot(p.clientX - prevX, p.clientY - prevY);
        const dt = (e.timeStamp - p.lastEventTs) / 1000;
        if (dt > 0.0005 && dt < 0.25) {
            const shortSide = Math.max(1, Math.min(bounds.width, bounds.height));
            const instant = dist / shortSide / dt;
            p.speed += (instant - p.speed) * (1 - Math.exp(-dt / SPEED_SMOOTHING));
            p.lastEventTs = e.timeStamp;
        } else if (!(dt > 0)) {
            // Duplicate timestamps: wait for the next sample to measure speed.
        } else {
            p.lastEventTs = e.timeStamp;
        }

        p.travel = Math.max(p.travel, Math.hypot(p.clientX - p.startClientX, p.clientY - p.startClientY));
        if (Math.hypot(p.clientX - p.anchorX, p.clientY - p.anchorY) > HOLD_MAX_DRIFT) {
            p.anchorX = p.clientX;
            p.anchorY = p.clientY;
            p.anchorTime = performance.now();
            p.holding = false;
        }

        // When the buffer is full, keep overwriting the newest slot so the stroke still ends at the pointer.
        if (p.pathLength < PATH_CAPACITY) p.pathLength++;
        const i = (p.pathLength - 1) * 2;
        p.path[i] = p.x;
        p.path[i + 1] = p.y;
    }

    function registerTap (p, now) {
        recentTaps.push({ start: p.startTime, end: now, x: p.x, y: p.y });
        while (recentTaps.length > 0 && now - recentTaps[0].end > MULTI_TAP_WINDOW) recentTaps.shift();
        if (recentTaps.length < MULTI_TAP_MIN) return;
        // Wait until every finger of the chord has lifted.
        for (const other of pointers.values())
            if (other.type === 'touch' && now - other.startTime < TAP_MAX_MS) return;

        // Only a real multi-finger tap: all fingers were on the glass at the same moment.
        let latestStart = 0;
        let earliestEnd = Infinity;
        let x = 0;
        let y = 0;
        for (const t of recentTaps) {
            latestStart = Math.max(latestStart, t.start);
            earliestEnd = Math.min(earliestEnd, t.end);
            x += t.x;
            y += t.y;
        }
        if (latestStart > earliestEnd) return;
        const count = recentTaps.length;
        recentTaps.length = 0;
        if (handlers.onMultiTap) handlers.onMultiTap(count, x / count, y / count);
    }

    // Called once per animation frame, before the pointers are consumed.
    function update (now) {
        const dt = Math.min(0.1, Math.max(0, (now - lastUpdate) / 1000));
        lastUpdate = now;
        const decay = Math.exp(-dt / SPEED_DECAY);
        for (const p of pointers.values()) {
            if (now - p.lastSeen > 34) p.speed *= decay;
            p.holding = now - p.anchorTime > HOLD_DELAY_MS;
        }
        detectTransform();
    }

    // Pinch/spread and twist from two or more touches, measured around their centroid.
    function detectTransform () {
        let count = 0;
        let cx = 0;
        let cy = 0;
        let key = '';
        for (const p of pointers.values()) {
            if (p.type !== 'touch') continue;
            count++;
            cx += p.clientX;
            cy += p.clientY;
            key += p.id + ',';
        }
        if (count < 2) {
            gesture.key = '';
            return;
        }
        cx /= count;
        cy /= count;

        let spread = 0;
        for (const p of pointers.values())
            if (p.type === 'touch') spread += Math.hypot(p.clientX - cx, p.clientY - cy);
        spread /= count;

        if (key !== gesture.key) {
            // A finger joined or left: restart from the new configuration instead of jumping.
            gesture.key = key;
            gesture.spread = spread;
            for (const p of pointers.values())
                if (p.type === 'touch') p.gestureAngle = Math.atan2(cy - p.clientY, p.clientX - cx);
            return;
        }

        let turn = 0;
        for (const p of pointers.values()) {
            if (p.type !== 'touch') continue;
            const angle = Math.atan2(cy - p.clientY, p.clientX - cx);
            let delta = angle - p.gestureAngle;
            if (delta > Math.PI) delta -= 2 * Math.PI;
            else if (delta < -Math.PI) delta += 2 * Math.PI;
            turn += delta;
            p.gestureAngle = angle;
        }
        turn /= count;
        const scale = gesture.spread > 1 ? spread / gesture.spread - 1 : 0;
        gesture.spread = spread;
        if (spread < MIN_GESTURE_SPREAD) return;

        const x = cx / bounds.width;
        const y = 1.0 - cy / bounds.height;
        const radius = spread / bounds.height;
        if (Math.abs(scale) > PINCH_THRESHOLD && handlers.onPinch) handlers.onPinch(scale, x, y, radius);
        if (Math.abs(turn) > TWIST_THRESHOLD && handlers.onTwist) handlers.onTwist(turn, x, y, radius);
    }

    return { pointers, update };
}

function clamp01 (v) {
    return Math.min(1, Math.max(0, v));
}
