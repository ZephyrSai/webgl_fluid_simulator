/*
MIT License

Copyright (c) 2017 Pavel Dobryakov

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

import { MusicEngine } from './audio.js';
import { createInput } from './input.js';

// Simulation section

const canvas = document.getElementById('sim-canvas');

let config = {
    SIM_RESOLUTION: 128,
    DYE_RESOLUTION: 1024,
    CAPTURE_RESOLUTION: 512,
    DENSITY_DISSIPATION: 1,
    VELOCITY_DISSIPATION: 0.2,
    PRESSURE: 0.8,
    PRESSURE_ITERATIONS: 20,
    CURL: 30,
    SPLAT_RADIUS: 0.25,
    SPLAT_FORCE: 6000,
    SHADING: true,
    COLORFUL: true,
    COLOR_UPDATE_SPEED: 10,
    PAUSED: false,
    BACK_COLOR: { r: 0, g: 0, b: 0 },
    TRANSPARENT: false,
    BLOOM: true,
    BLOOM_ITERATIONS: 8,
    BLOOM_RESOLUTION: 256,
    BLOOM_INTENSITY: 0.55,
    BLOOM_THRESHOLD: 0.75,
    BLOOM_SOFT_KNEE: 0.7,
    SUNRAYS: true,
    SUNRAYS_RESOLUTION: 196,
    SUNRAYS_WEIGHT: 1.0,
    INK: 0.1,
    MAX_PIXEL_RATIO: 2,
    BEAT_PULSES: true,
}

// Splat contributions below these levels are invisible, so each splat only touches the
// pixels where it is above them (scissor rect) instead of the whole texture.
const VELOCITY_EPSILON = 0.5;
const DYE_EPSILON = 0.0015;
const MAX_SPLATS_PER_FRAME = 72;
const MIN_QUALITY = 0.55;
const PINCH_FORCE = 150;
const TWIST_FORCE = 90;
const FALLBACK_BEAT = 60 / 100;

let splatStack = [];
let pendingForces = [];
let pendingDroplets = [];
let pendingPulses = [];
let needsRender = true;
let needsResize = true;
let qualityFactor = 1;
let cssWidth = 1;
let cssHeight = 1;
let contextLost = false;

resizeCanvas();

const { gl, ext } = getWebGLContext(canvas);

if (isMobile()) {
    config.DYE_RESOLUTION = 512;
}
if (!ext.supportLinearFiltering) {
    config.DYE_RESOLUTION = 512;
    config.SHADING = false;
    config.BLOOM = false;
    config.SUNRAYS = false;
}

const music = new MusicEngine();
loadMusicPrefs();

const input = createInput(canvas, {
    onActivate: () => music.unlock(),
    onDown: handlePointerDown,
    onUp: handlePointerUp,
    onTap: handleTap,
    onMultiTap: () => triggerBurst(),
    onPinch: handlePinch,
    onTwist: handleTwist,
});

bindUI();

function getWebGLContext (canvas) {
    const params = { alpha: true, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' };

    let gl = canvas.getContext('webgl2', params);
    const isWebGL2 = !!gl;
    if (!isWebGL2)
        gl = canvas.getContext('webgl', params) || canvas.getContext('experimental-webgl', params);

    let halfFloat;
    let supportLinearFiltering;
    if (isWebGL2) {
        gl.getExtension('EXT_color_buffer_float');
        supportLinearFiltering = gl.getExtension('OES_texture_float_linear');
    } else {
        halfFloat = gl.getExtension('OES_texture_half_float');
        supportLinearFiltering = gl.getExtension('OES_texture_half_float_linear');
    }

    gl.clearColor(0.0, 0.0, 0.0, 1.0);

    const halfFloatTexType = isWebGL2 ? gl.HALF_FLOAT : halfFloat.HALF_FLOAT_OES;
    let formatRGBA;
    let formatRG;
    let formatR;

    if (isWebGL2)
    {
        formatRGBA = getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, halfFloatTexType);
        formatRG = getSupportedFormat(gl, gl.RG16F, gl.RG, halfFloatTexType);
        formatR = getSupportedFormat(gl, gl.R16F, gl.RED, halfFloatTexType);
    }
    else
    {
        formatRGBA = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
        formatRG = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
        formatR = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
    }

    return {
        gl,
        ext: {
            formatRGBA,
            formatRG,
            formatR,
            halfFloatTexType,
            supportLinearFiltering
        }
    };
}

function getSupportedFormat (gl, internalFormat, format, type)
{
    if (!supportRenderTextureFormat(gl, internalFormat, format, type))
    {
        switch (internalFormat)
        {
            case gl.R16F:
                return getSupportedFormat(gl, gl.RG16F, gl.RG, type);
            case gl.RG16F:
                return getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, type);
            default:
                return null;
        }
    }

    return {
        internalFormat,
        format
    }
}

function supportRenderTextureFormat (gl, internalFormat, format, type) {
    let texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);

    let fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

    let status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    return status == gl.FRAMEBUFFER_COMPLETE;
}

function bindUI () {
    const setValueLabel = (id, value) => {
        const label = document.querySelector(`[data-for="${id}"]`);
        if (label) label.textContent = value;
    };

    const bindRange = (id, key, options = {}) => {
        const el = document.getElementById(id);
        if (!el) return;
        const formatter = options.format || (v => v);
        el.value = config[key];
        setValueLabel(id, formatter(config[key]));
        el.addEventListener('input', () => {
            const value = parseFloat(el.value);
            config[key] = value;
            setValueLabel(id, formatter(value));
            if (options.onChange) options.onChange();
            needsRender = true;
        });
    };

    const bindSelect = (id, key, onChange) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.value = config[key];
        el.addEventListener('change', () => {
            config[key] = parseInt(el.value);
            if (onChange) onChange();
            needsRender = true;
        });
    };

    const bindToggle = (id, key, onChange) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.checked = !!config[key];
        el.addEventListener('change', () => {
            config[key] = el.checked;
            if (onChange) onChange();
            needsRender = true;
        });
    };

    bindSelect('quality', 'DYE_RESOLUTION', initFramebuffers);
    bindSelect('sim-resolution', 'SIM_RESOLUTION', initFramebuffers);
    bindRange('ink', 'INK', { format: v => v.toFixed(2) });
    bindRange('density', 'DENSITY_DISSIPATION', { format: v => v.toFixed(2) });
    bindRange('velocity-diffusion', 'VELOCITY_DISSIPATION', { format: v => v.toFixed(2) });
    bindRange('pressure', 'PRESSURE', { format: v => v.toFixed(2) });
    bindRange('curl', 'CURL', { format: v => v.toFixed(0) });
    bindRange('splat-radius', 'SPLAT_RADIUS', { format: v => v.toFixed(2) });
    bindRange('bloom-threshold', 'BLOOM_THRESHOLD', { format: v => v.toFixed(2), onChange: updateKeywords });
    bindRange('bloom-intensity', 'BLOOM_INTENSITY', { format: v => v.toFixed(2), onChange: updateKeywords });

    bindToggle('shading', 'SHADING', updateKeywords);
    bindToggle('colorful', 'COLORFUL');
    bindToggle('bloom', 'BLOOM', updateKeywords);
    bindToggle('sunrays', 'SUNRAYS', updateKeywords);
    bindToggle('transparent', 'TRANSPARENT');
    bindToggle('paused', 'PAUSED');
    bindToggle('beat-pulses', 'BEAT_PULSES');

    const background = document.getElementById('background');
    if (background) {
        background.value = rgbToHex(config.BACK_COLOR);
        background.addEventListener('input', () => {
            config.BACK_COLOR = hexToRgb(background.value);
            needsRender = true;
        });
    }

    const burst = document.getElementById('burst');
    if (burst) burst.addEventListener('click', () => {
        music.unlock();
        triggerBurst();
    });

    const togglePanel = document.getElementById('toggle-panel');
    if (togglePanel) togglePanel.addEventListener('click', () => {
        setPanelHidden(!document.body.classList.contains('panel-hidden'));
    });

    const screenshot = document.getElementById('screenshot');
    if (screenshot) screenshot.addEventListener('click', captureScreenshot);

    const reset = document.getElementById('reset');
    if (reset) reset.addEventListener('click', () => {
        resetSimulation();
        multipleSplats(3);
        needsRender = true;
    });

    bindMusicUI();
    bindFullscreen();

    // On touch-first devices (tablets, phones) the panel would cover the canvas; start with it tucked away.
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches)
        setPanelHidden(true);

    window.addEventListener('keydown', e => {
        if (e.target && e.target.closest && e.target.closest('input, select, textarea')) return;
        // Leave browser shortcuts (Cmd/Ctrl+F, +P, +H, +M) alone, and don't retrigger while a key is held.
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.code === 'Space') e.preventDefault();
        if (e.repeat) return;
        music.unlock();
        switch (e.code) {
            case 'KeyP':
                config.PAUSED = !config.PAUSED;
                syncToggle('paused', config.PAUSED);
                break;
            case 'KeyF':
                toggleFullscreen();
                break;
            case 'KeyM':
                setSoundEnabled(!music.enabled);
                break;
            case 'KeyH':
                setPanelHidden(!document.body.classList.contains('panel-hidden'));
                break;
            case 'Space':
                triggerBurst();
                break;
        }
    });

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) music.suspend();
        else music.resume();
    });

    canvas.addEventListener('webglcontextlost', e => {
        e.preventDefault();
        contextLost = true;
    });
    // Rebuilding every program and texture in place isn't worth it; the fluid state is ephemeral.
    canvas.addEventListener('webglcontextrestored', () => location.reload());
}

function setPanelHidden (hidden) {
    document.body.classList.toggle('panel-hidden', hidden);
    const label = document.querySelector('#toggle-panel .btn-label');
    if (label) label.textContent = hidden ? 'Show controls' : 'Hide controls';
}

function bindMusicUI () {
    const sound = document.getElementById('sound');
    if (sound) sound.addEventListener('click', () => setSoundEnabled(!music.enabled));

    const mood = document.getElementById('mood');
    if (mood) {
        mood.value = music.mood;
        mood.addEventListener('change', () => {
            music.setMood(mood.value);
            saveMusicPrefs();
        });
    }

    const scale = document.getElementById('scale');
    if (scale) {
        scale.value = music.scaleName;
        scale.addEventListener('change', () => {
            music.setScale(scale.value);
            saveMusicPrefs();
        });
    }

    const volume = document.getElementById('volume');
    if (volume) {
        const label = document.querySelector('[data-for="volume"]');
        const show = () => { if (label) label.textContent = Math.round(music.volume * 100) + '%'; };
        volume.value = music.volume;
        show();
        volume.addEventListener('input', () => {
            music.setVolume(parseFloat(volume.value));
            show();
        });
        volume.addEventListener('change', saveMusicPrefs);
    }

    music.onStateChange = refreshSoundUI;
    music.onChord = name => {
        const el = document.getElementById('chord-name');
        if (el) el.textContent = name;
    };
    music.onBeat = strength => {
        if (config.BEAT_PULSES) queueBeatPulses(strength);
    };
    refreshSoundUI();
}

function setSoundEnabled (enabled) {
    music.setEnabled(enabled);
    if (enabled) music.unlock();
    saveMusicPrefs();
    refreshSoundUI();
}

function refreshSoundUI () {
    const sound = document.getElementById('sound');
    if (sound) {
        sound.setAttribute('aria-pressed', String(music.enabled));
        sound.classList.toggle('is-off', !music.enabled);
        const label = sound.querySelector('.btn-label');
        if (label) label.textContent = music.enabled ? 'Sound on' : 'Sound off';
    }
    const state = document.getElementById('music-state');
    if (state) {
        if (!music.enabled) state.textContent = 'Muted';
        else if (music.running) state.textContent = 'Playing';
        else state.textContent = 'Touch the canvas to start';
    }
}

function loadMusicPrefs () {
    try {
        const saved = JSON.parse(localStorage.getItem('fluid-studio:music') || 'null');
        if (!saved) return;
        if (typeof saved.enabled === 'boolean') music.enabled = saved.enabled;
        if (typeof saved.volume === 'number') music.setVolume(saved.volume);
        if (saved.mood) music.setMood(saved.mood);
        if (saved.scale) music.setScale(saved.scale);
    } catch (e) { /* storage unavailable */ }
}

function saveMusicPrefs () {
    try {
        localStorage.setItem('fluid-studio:music', JSON.stringify({
            enabled: music.enabled, volume: music.volume, mood: music.mood, scale: music.scaleName,
        }));
    } catch (e) { /* storage unavailable */ }
}

let panelHiddenBeforeFullscreen = false;

function bindFullscreen () {
    const button = document.getElementById('fullscreen');
    if (!button) return;
    const root = document.documentElement;
    const supported = !!(root.requestFullscreen || root.webkitRequestFullscreen) &&
        !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
    // iPhone Safari has no element fullscreen; "Add to Home Screen" runs the app full-screen instead.
    if (!supported) {
        button.hidden = true;
        return;
    }
    button.addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
}

function isFullscreen () {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

function toggleFullscreen () {
    const root = document.documentElement;
    try {
        let result;
        if (isFullscreen()) {
            result = document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen();
        } else if (root.requestFullscreen) {
            result = root.requestFullscreen({ navigationUI: 'hide' });
        } else if (root.webkitRequestFullscreen) {
            result = root.webkitRequestFullscreen();
        }
        if (result && result.catch) result.catch(() => {});
    } catch (e) { /* denied */ }
}

function onFullscreenChange () {
    const active = isFullscreen();
    // Safari can fire both the prefixed and unprefixed event; only react to real transitions.
    if (active == document.body.classList.contains('is-fullscreen')) return;
    document.body.classList.toggle('is-fullscreen', active);
    const button = document.getElementById('fullscreen');
    if (button) {
        button.setAttribute('aria-pressed', String(active));
        const label = button.querySelector('.btn-label');
        if (label) label.textContent = active ? 'Exit fullscreen' : 'Fullscreen';
    }
    // Give the canvas the whole screen while immersed; restore the panel afterwards.
    if (active) {
        panelHiddenBeforeFullscreen = document.body.classList.contains('panel-hidden');
        setPanelHidden(true);
    } else {
        setPanelHidden(panelHiddenBeforeFullscreen);
    }
    needsResize = true;
}

function syncToggle (id, value) {
    const el = document.getElementById(id);
    if (el) el.checked = value;
}

function isMobile () {
    return /Mobi|Android/i.test(navigator.userAgent);
}

function captureScreenshot () {
    let res = getResolution(config.CAPTURE_RESOLUTION);
    let target = createFBO(res.width, res.height, ext.formatRGBA.internalFormat, ext.formatRGBA.format, ext.halfFloatTexType, gl.NEAREST);
    render(target);

    let texture = framebufferToTexture(target);
    texture = normalizeTexture(texture, target.width, target.height);
    destroyFBO(target);
    needsRender = true;

    let captureCanvas = textureToCanvas(texture, target.width, target.height);
    captureCanvas.toBlob(blob => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        downloadURI('fluid.png', url);
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    });
}

function framebufferToTexture (target) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    let length = target.width * target.height * 4;
    let texture = new Float32Array(length);
    gl.readPixels(0, 0, target.width, target.height, gl.RGBA, gl.FLOAT, texture);
    return texture;
}

function normalizeTexture (texture, width, height) {
    let result = new Uint8Array(texture.length);
    let id = 0;
    for (let i = height - 1; i >= 0; i--) {
        for (let j = 0; j < width; j++) {
            let nid = i * width * 4 + j * 4;
            result[nid + 0] = clamp01(texture[id + 0]) * 255;
            result[nid + 1] = clamp01(texture[id + 1]) * 255;
            result[nid + 2] = clamp01(texture[id + 2]) * 255;
            result[nid + 3] = clamp01(texture[id + 3]) * 255;
            id += 4;
        }
    }
    return result;
}

function clamp01 (input) {
    return Math.min(Math.max(input, 0), 1);
}

function textureToCanvas (texture, width, height) {
    let captureCanvas = document.createElement('canvas');
    let ctx = captureCanvas.getContext('2d');
    captureCanvas.width = width;
    captureCanvas.height = height;

    let imageData = ctx.createImageData(width, height);
    imageData.data.set(texture);
    ctx.putImageData(imageData, 0, 0);

    return captureCanvas;
}

function downloadURI (filename, uri) {
    let link = document.createElement('a');
    link.download = filename;
    link.href = uri;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

class Material {
    constructor (vertexShader, fragmentShaderSource) {
        this.vertexShader = vertexShader;
        this.fragmentShaderSource = fragmentShaderSource;
        this.programs = [];
        this.activeProgram = null;
        this.uniforms = [];
    }

    setKeywords (keywords) {
        let hash = 0;
        for (let i = 0; i < keywords.length; i++)
            hash += hashCode(keywords[i]);

        let program = this.programs[hash];
        if (program == null)
        {
            let fragmentShader = compileShader(gl.FRAGMENT_SHADER, this.fragmentShaderSource, keywords);
            program = createProgram(this.vertexShader, fragmentShader);
            this.programs[hash] = program;
        }

        if (program == this.activeProgram) return;

        this.uniforms = getUniforms(program);
        this.activeProgram = program;
    }

    bind () {
        gl.useProgram(this.activeProgram);
    }
}

class Program {
    constructor (vertexShader, fragmentShader) {
        this.uniforms = {};
        this.program = createProgram(vertexShader, fragmentShader);
        this.uniforms = getUniforms(this.program);
    }

    bind () {
        gl.useProgram(this.program);
    }
}

function createProgram (vertexShader, fragmentShader) {
    let program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        console.trace(gl.getProgramInfoLog(program));

    return program;
}

function getUniforms (program) {
    let uniforms = [];
    let uniformCount = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < uniformCount; i++) {
        let uniformName = gl.getActiveUniform(program, i).name;
        uniforms[uniformName] = gl.getUniformLocation(program, uniformName);
    }
    return uniforms;
}

function compileShader (type, source, keywords) {
    source = addKeywords(source, keywords);

    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        console.trace(gl.getShaderInfoLog(shader));

    return shader;
};

function addKeywords (source, keywords) {
    if (keywords == null) return source;
    let keywordsString = '';
    keywords.forEach(keyword => {
        keywordsString += '#define ' + keyword + '\n';
    });
    return keywordsString + source;
}

const baseVertexShader = compileShader(gl.VERTEX_SHADER, `
    precision highp float;

    attribute vec2 aPosition;
    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform vec2 texelSize;

    void main () {
        vUv = aPosition * 0.5 + 0.5;
        vL = vUv - vec2(texelSize.x, 0.0);
        vR = vUv + vec2(texelSize.x, 0.0);
        vT = vUv + vec2(0.0, texelSize.y);
        vB = vUv - vec2(0.0, texelSize.y);
        gl_Position = vec4(aPosition, 0.0, 1.0);
    }
`);

const blurVertexShader = compileShader(gl.VERTEX_SHADER, `
    precision highp float;

    attribute vec2 aPosition;
    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    uniform vec2 texelSize;

    void main () {
        vUv = aPosition * 0.5 + 0.5;
        float offset = 1.33333333;
        vL = vUv - texelSize * offset;
        vR = vUv + texelSize * offset;
        gl_Position = vec4(aPosition, 0.0, 1.0);
    }
`);

const blurShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    uniform sampler2D uTexture;

    void main () {
        vec4 sum = texture2D(uTexture, vUv) * 0.29411764;
        sum += texture2D(uTexture, vL) * 0.35294117;
        sum += texture2D(uTexture, vR) * 0.35294117;
        gl_FragColor = sum;
    }
`);

const copyShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    uniform sampler2D uTexture;

    void main () {
        gl_FragColor = texture2D(uTexture, vUv);
    }
`);

const clearShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    uniform sampler2D uTexture;
    uniform float value;

    void main () {
        gl_FragColor = value * texture2D(uTexture, vUv);
    }
`);

const checkerboardShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    uniform sampler2D uTexture;
    uniform float aspectRatio;

    #define SCALE 25.0

    void main () {
        vec2 uv = floor(vUv * SCALE * vec2(aspectRatio, 1.0));
        float v = mod(uv.x + uv.y, 2.0);
        v = v * 0.1 + 0.8;
        gl_FragColor = vec4(vec3(v), 1.0);
    }
`);

const displayShaderSource = `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform sampler2D uTexture;
    uniform sampler2D uBloom;
    uniform sampler2D uSunrays;
    uniform sampler2D uDithering;
    uniform vec2 ditherScale;
    uniform vec2 texelSize;

    vec3 linearToGamma (vec3 color) {
        color = max(color, vec3(0));
        return max(1.055 * pow(color, vec3(0.416666667)) - 0.055, vec3(0));
    }

    void main () {
        vec3 c = texture2D(uTexture, vUv).rgb;

    #ifdef SHADING
        vec3 lc = texture2D(uTexture, vL).rgb;
        vec3 rc = texture2D(uTexture, vR).rgb;
        vec3 tc = texture2D(uTexture, vT).rgb;
        vec3 bc = texture2D(uTexture, vB).rgb;

        float dx = length(rc) - length(lc);
        float dy = length(tc) - length(bc);

        vec3 n = normalize(vec3(dx, dy, length(texelSize)));
        vec3 l = vec3(0.0, 0.0, 1.0);

        float diffuse = clamp(dot(n, l) + 0.7, 0.7, 1.0);
        c *= diffuse;
    #endif

    #ifdef BLOOM
        vec3 bloom = texture2D(uBloom, vUv).rgb;
    #endif

    #ifdef SUNRAYS
        float sunrays = texture2D(uSunrays, vUv).r;
        c *= sunrays;
    #ifdef BLOOM
        bloom *= sunrays;
    #endif
    #endif

    #ifdef BLOOM
        float noise = texture2D(uDithering, vUv * ditherScale).r;
        noise = noise * 2.0 - 1.0;
        bloom += noise / 255.0;
        bloom = linearToGamma(bloom);
        c += bloom;
    #endif

        float a = max(c.r, max(c.g, c.b));
        gl_FragColor = vec4(c, a);
    }
`;

const bloomPrefilterShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying vec2 vUv;
    uniform sampler2D uTexture;
    uniform vec3 curve;
    uniform float threshold;

    void main () {
        vec3 c = texture2D(uTexture, vUv).rgb;
        float br = max(c.r, max(c.g, c.b));
        float rq = clamp(br - curve.x, 0.0, curve.y);
        rq = curve.z * rq * rq;
        c *= max(rq, br - threshold) / max(br, 0.0001);
        gl_FragColor = vec4(c, 0.0);
    }
`);

const bloomBlurShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform sampler2D uTexture;

    void main () {
        vec4 sum = vec4(0.0);
        sum += texture2D(uTexture, vL);
        sum += texture2D(uTexture, vR);
        sum += texture2D(uTexture, vT);
        sum += texture2D(uTexture, vB);
        sum *= 0.25;
        gl_FragColor = sum;
    }
`);

const bloomFinalShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform sampler2D uTexture;
    uniform float intensity;

    void main () {
        vec4 sum = vec4(0.0);
        sum += texture2D(uTexture, vL);
        sum += texture2D(uTexture, vR);
        sum += texture2D(uTexture, vT);
        sum += texture2D(uTexture, vB);
        sum *= 0.25;
        gl_FragColor = sum * intensity;
    }
`);

const sunraysMaskShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    uniform sampler2D uTexture;

    void main () {
        vec3 c = texture2D(uTexture, vUv).rgb;
        float br = max(c.r, max(c.g, c.b));
        gl_FragColor = vec4(1.0 - min(max(br * 20.0, 0.0), 0.8));
    }
`);

const sunraysShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    uniform sampler2D uTexture;
    uniform float weight;

    #define ITERATIONS 16

    void main () {
        float Density = 0.3;
        float Decay = 0.95;
        float Exposure = 0.7;

        vec2 coord = vUv;
        vec2 dir = vUv - 0.5;

        dir *= 1.0 / float(ITERATIONS) * Density;
        float illuminationDecay = 1.0;

        float color = texture2D(uTexture, vUv).r;

        for (int i = 0; i < ITERATIONS; i++)
        {
            coord -= dir;
            float col = texture2D(uTexture, coord).r;
            color += col * illuminationDecay * weight;
            illuminationDecay *= Decay;
        }

        gl_FragColor = vec4(color * Exposure, 0.0, 0.0, 1.0);
    }
`);

// Splats are drawn with additive blending straight into the current buffer, clipped to the
// splat's footprint, so they don't need a full-screen read + ping-pong pass each.
const splatShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;

    varying vec2 vUv;
    uniform float aspectRatio;
    uniform vec3 color;
    uniform vec2 point;
    uniform float radius;

    void main () {
        vec2 p = vUv - point.xy;
        p.x *= aspectRatio;
        vec3 splat = exp(-dot(p, p) / radius) * color;
        gl_FragColor = vec4(splat, 0.0);
    }
`);

// Radial (explode / implode) and tangential (vortex) velocity around a point, for gestures and beat pulses.
const forceShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;

    varying vec2 vUv;
    uniform float aspectRatio;
    uniform vec2 point;
    uniform float radius;
    uniform vec2 strength;

    void main () {
        vec2 p = vUv - point.xy;
        p.x *= aspectRatio;
        vec2 q = p / sqrt(radius);
        float falloff = exp(-dot(q, q)) * 2.3316;
        vec2 force = (strength.x * q + strength.y * vec2(-q.y, q.x)) * falloff;
        gl_FragColor = vec4(force, 0.0, 0.0);
    }
`);

const advectionShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    uniform sampler2D uVelocity;
    uniform sampler2D uSource;
    uniform vec2 texelSize;
    uniform vec2 dyeTexelSize;
    uniform float dt;
    uniform float dissipation;

    vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
        vec2 st = uv / tsize - 0.5;

        vec2 iuv = floor(st);
        vec2 fuv = fract(st);

        vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
        vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
        vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
        vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);

        return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
    }

    void main () {
    #ifdef MANUAL_FILTERING
        vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;
        vec4 result = bilerp(uSource, coord, dyeTexelSize);
    #else
        vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
        vec4 result = texture2D(uSource, coord);
    #endif
        float decay = 1.0 + dissipation * dt;
        gl_FragColor = result / decay;
    }`,
    ext.supportLinearFiltering ? null : ['MANUAL_FILTERING']
);

const divergenceShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    varying highp vec2 vL;
    varying highp vec2 vR;
    varying highp vec2 vT;
    varying highp vec2 vB;
    uniform sampler2D uVelocity;

    void main () {
        float L = texture2D(uVelocity, vL).x;
        float R = texture2D(uVelocity, vR).x;
        float T = texture2D(uVelocity, vT).y;
        float B = texture2D(uVelocity, vB).y;

        vec2 C = texture2D(uVelocity, vUv).xy;
        if (vL.x < 0.0) { L = -C.x; }
        if (vR.x > 1.0) { R = -C.x; }
        if (vT.y > 1.0) { T = -C.y; }
        if (vB.y < 0.0) { B = -C.y; }

        float div = 0.5 * (R - L + T - B);
        gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
    }
`);

const curlShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    varying highp vec2 vL;
    varying highp vec2 vR;
    varying highp vec2 vT;
    varying highp vec2 vB;
    uniform sampler2D uVelocity;

    void main () {
        float L = texture2D(uVelocity, vL).y;
        float R = texture2D(uVelocity, vR).y;
        float T = texture2D(uVelocity, vT).x;
        float B = texture2D(uVelocity, vB).x;
        float vorticity = R - L - T + B;
        gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
    }
`);

const vorticityShader = compileShader(gl.FRAGMENT_SHADER, `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform sampler2D uVelocity;
    uniform sampler2D uCurl;
    uniform float curl;
    uniform float dt;

    void main () {
        float L = texture2D(uCurl, vL).x;
        float R = texture2D(uCurl, vR).x;
        float T = texture2D(uCurl, vT).x;
        float B = texture2D(uCurl, vB).x;
        float C = texture2D(uCurl, vUv).x;

        vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
        force /= length(force) + 0.0001;
        force *= curl * C;
        force.y *= -1.0;

        vec2 velocity = texture2D(uVelocity, vUv).xy;
        velocity += force * dt;
        velocity = min(max(velocity, -1000.0), 1000.0);
        gl_FragColor = vec4(velocity, 0.0, 1.0);
    }
`);

const pressureShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    varying highp vec2 vL;
    varying highp vec2 vR;
    varying highp vec2 vT;
    varying highp vec2 vB;
    uniform sampler2D uPressure;
    uniform sampler2D uDivergence;

    void main () {
        float L = texture2D(uPressure, vL).x;
        float R = texture2D(uPressure, vR).x;
        float T = texture2D(uPressure, vT).x;
        float B = texture2D(uPressure, vB).x;
        float C = texture2D(uPressure, vUv).x;
        float divergence = texture2D(uDivergence, vUv).x;
        float pressure = (L + R + B + T - divergence) * 0.25;
        gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
    }
`);

const gradientSubtractShader = compileShader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    varying highp vec2 vL;
    varying highp vec2 vR;
    varying highp vec2 vT;
    varying highp vec2 vB;
    uniform sampler2D uPressure;
    uniform sampler2D uVelocity;

    void main () {
        float L = texture2D(uPressure, vL).x;
        float R = texture2D(uPressure, vR).x;
        float T = texture2D(uPressure, vT).x;
        float B = texture2D(uPressure, vB).x;
        vec2 velocity = texture2D(uVelocity, vUv).xy;
        velocity.xy -= vec2(R - L, T - B);
        gl_FragColor = vec4(velocity, 0.0, 1.0);
    }
`);

const blit = (() => {
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);

    return (target, clear = false) => {
        if (target == null)
        {
            gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        }
        else
        {
            gl.viewport(0, 0, target.width, target.height);
            gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
        }
        if (clear)
        {
            gl.clearColor(0.0, 0.0, 0.0, 1.0);
            gl.clear(gl.COLOR_BUFFER_BIT);
        }
        // CHECK_FRAMEBUFFER_STATUS();
        gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    }
})();

function CHECK_FRAMEBUFFER_STATUS () {
    let status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status != gl.FRAMEBUFFER_COMPLETE)
        console.trace("Framebuffer error: " + status);
}

let dye;
let velocity;
let divergence;
let curl;
let pressure;
let bloom;
let bloomFramebuffers = [];
let sunrays;
let sunraysTemp;
let sunraysMask;

let ditheringTexture = createTextureAsync('./assets/LDR_LLL1_0.png');

const blurProgram            = new Program(blurVertexShader, blurShader);
const copyProgram            = new Program(baseVertexShader, copyShader);
const clearProgram           = new Program(baseVertexShader, clearShader);
const checkerboardProgram    = new Program(baseVertexShader, checkerboardShader);
const bloomPrefilterProgram  = new Program(baseVertexShader, bloomPrefilterShader);
const bloomBlurProgram       = new Program(baseVertexShader, bloomBlurShader);
const bloomFinalProgram      = new Program(baseVertexShader, bloomFinalShader);
const sunraysMaskProgram     = new Program(baseVertexShader, sunraysMaskShader);
const sunraysProgram         = new Program(baseVertexShader, sunraysShader);
const splatProgram           = new Program(baseVertexShader, splatShader);
const forceProgram           = new Program(baseVertexShader, forceShader);
const advectionProgram       = new Program(baseVertexShader, advectionShader);
const divergenceProgram      = new Program(baseVertexShader, divergenceShader);
const curlProgram            = new Program(baseVertexShader, curlShader);
const vorticityProgram       = new Program(baseVertexShader, vorticityShader);
const pressureProgram        = new Program(baseVertexShader, pressureShader);
const gradienSubtractProgram = new Program(baseVertexShader, gradientSubtractShader);

const displayMaterial = new Material(baseVertexShader, displayShaderSource);

function initFramebuffers () {
    let simRes = getResolution(config.SIM_RESOLUTION);
    let dyeRes = getResolution(config.DYE_RESOLUTION);

    const texType = ext.halfFloatTexType;
    const rgba    = ext.formatRGBA;
    const rg      = ext.formatRG;
    const r       = ext.formatR;
    const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

    gl.disable(gl.BLEND);

    if (dye == null)
        dye = createDoubleFBO(dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, texType, filtering);
    else
        dye = resizeDoubleFBO(dye, dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, texType, filtering);

    if (velocity == null)
        velocity = createDoubleFBO(simRes.width, simRes.height, rg.internalFormat, rg.format, texType, filtering);
    else
        velocity = resizeDoubleFBO(velocity, simRes.width, simRes.height, rg.internalFormat, rg.format, texType, filtering);

    // Only reallocate what actually changed size, and free the old textures (they used to leak on every resize).
    divergence = ensureFBO      (divergence, simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
    curl       = ensureFBO      (curl,       simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
    pressure   = ensureDoubleFBO(pressure,   simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);

    initBloomFramebuffers();
    initSunraysFramebuffers();
}

function initBloomFramebuffers () {
    let res = getResolution(config.BLOOM_RESOLUTION);
    if (bloom && bloom.width == res.width && bloom.height == res.height) return;

    const texType = ext.halfFloatTexType;
    const rgba = ext.formatRGBA;
    const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

    destroyFBO(bloom);
    bloom = createFBO(res.width, res.height, rgba.internalFormat, rgba.format, texType, filtering);

    bloomFramebuffers.forEach(destroyFBO);
    bloomFramebuffers.length = 0;
    for (let i = 0; i < config.BLOOM_ITERATIONS; i++)
    {
        let width = res.width >> (i + 1);
        let height = res.height >> (i + 1);

        if (width < 2 || height < 2) break;

        let fbo = createFBO(width, height, rgba.internalFormat, rgba.format, texType, filtering);
        bloomFramebuffers.push(fbo);
    }
}

function initSunraysFramebuffers () {
    let res = getResolution(config.SUNRAYS_RESOLUTION);
    // The mask used to be rendered at full dye resolution; 2x the rays resolution looks the same once blurred.
    let maskRes = getResolution(config.SUNRAYS_RESOLUTION * 2);

    const texType = ext.halfFloatTexType;
    const r = ext.formatR;
    const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

    sunrays     = ensureFBO(sunrays,     res.width,     res.height,     r.internalFormat, r.format, texType, filtering);
    sunraysTemp = ensureFBO(sunraysTemp, res.width,     res.height,     r.internalFormat, r.format, texType, filtering);
    sunraysMask = ensureFBO(sunraysMask, maskRes.width, maskRes.height, r.internalFormat, r.format, texType, filtering);
}

function ensureFBO (target, w, h, internalFormat, format, type, param) {
    if (target && target.width == w && target.height == h) return target;
    destroyFBO(target);
    return createFBO(w, h, internalFormat, format, type, param);
}

function ensureDoubleFBO (target, w, h, internalFormat, format, type, param) {
    if (target && target.width == w && target.height == h) return target;
    if (target) {
        destroyFBO(target.read);
        destroyFBO(target.write);
    }
    return createDoubleFBO(w, h, internalFormat, format, type, param);
}

function destroyFBO (target) {
    if (!target) return;
    gl.deleteFramebuffer(target.fbo);
    gl.deleteTexture(target.texture);
}

function createFBO (w, h, internalFormat, format, type, param) {
    gl.activeTexture(gl.TEXTURE0);
    let texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);

    let fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0.0, 0.0, 0.0, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    let texelSizeX = 1.0 / w;
    let texelSizeY = 1.0 / h;

    return {
        texture,
        fbo,
        width: w,
        height: h,
        texelSizeX,
        texelSizeY,
        attach (id) {
            gl.activeTexture(gl.TEXTURE0 + id);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            return id;
        }
    };
}

function createDoubleFBO (w, h, internalFormat, format, type, param) {
    let fbo1 = createFBO(w, h, internalFormat, format, type, param);
    let fbo2 = createFBO(w, h, internalFormat, format, type, param);

    return {
        width: w,
        height: h,
        texelSizeX: fbo1.texelSizeX,
        texelSizeY: fbo1.texelSizeY,
        get read () {
            return fbo1;
        },
        set read (value) {
            fbo1 = value;
        },
        get write () {
            return fbo2;
        },
        set write (value) {
            fbo2 = value;
        },
        swap () {
            let temp = fbo1;
            fbo1 = fbo2;
            fbo2 = temp;
        }
    }
}

function resizeFBO (target, w, h, internalFormat, format, type, param) {
    let newFBO = createFBO(w, h, internalFormat, format, type, param);
    copyProgram.bind();
    gl.uniform1i(copyProgram.uniforms.uTexture, target.attach(0));
    blit(newFBO);
    return newFBO;
}

function resizeDoubleFBO (target, w, h, internalFormat, format, type, param) {
    if (target.width == w && target.height == h)
        return target;
    const oldRead = target.read;
    const oldWrite = target.write;
    target.read = resizeFBO(oldRead, w, h, internalFormat, format, type, param);
    target.write = createFBO(w, h, internalFormat, format, type, param);
    destroyFBO(oldRead);
    destroyFBO(oldWrite);
    target.width = w;
    target.height = h;
    target.texelSizeX = 1.0 / w;
    target.texelSizeY = 1.0 / h;
    return target;
}

function createTextureAsync (url) {
    let texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255]));

    let obj = {
        texture,
        width: 1,
        height: 1,
        attach (id) {
            gl.activeTexture(gl.TEXTURE0 + id);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            return id;
        }
    };

    let image = new Image();
    image.onload = () => {
        obj.width = image.width;
        obj.height = image.height;
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image);
    };
    image.src = url;

    return obj;
}

function updateKeywords () {
    let displayKeywords = [];
    if (config.SHADING) displayKeywords.push("SHADING");
    if (config.BLOOM) displayKeywords.push("BLOOM");
    if (config.SUNRAYS) displayKeywords.push("SUNRAYS");
    displayMaterial.setKeywords(displayKeywords);
}

updateKeywords();
initFramebuffers();
multipleSplats(parseInt(Math.random() * 20) + 5);

let lastFrameTime = performance.now();
let colorUpdateTimer = 0.0;
let fallbackBeatTimer = 0.0;
let beatSwirl = 1;
let hudUpdateTime = 0;

// Resize on events instead of reading layout (clientWidth) every frame.
if (window.ResizeObserver) new ResizeObserver(() => { needsResize = true; }).observe(canvas);
window.addEventListener('resize', () => { needsResize = true; });
window.addEventListener('orientationchange', () => { needsResize = true; });
watchPixelRatio();

function watchPixelRatio () {
    if (!window.matchMedia) return;
    const query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    const onChange = () => {
        needsResize = true;
        watchPixelRatio();
    };
    if (query.addEventListener) query.addEventListener('change', onChange, { once: true });
    else if (query.addListener) query.addListener(onChange);
}

requestAnimationFrame(update);

function update (now) {
    if (contextLost) return;
    const interval = now - lastFrameTime;
    const dt = Math.min(Math.max(interval, 0) / 1000, 0.016666);
    lastFrameTime = now;
    trackFrameTime(interval, now);

    if (needsResize) {
        needsResize = false;
        if (resizeCanvas()) {
            initFramebuffers();
            needsRender = true;
        }
    }
    updateColors(dt);
    updateFallbackBeat(Math.min(Math.max(interval, 0), 250) / 1000);
    if (applyInputs(now))
        needsRender = true;
    if (!config.PAUSED) {
        step(dt);
        needsRender = true;
    }
    // While paused and untouched nothing changes, so skip the bloom/sunrays/display passes entirely.
    if (needsRender) {
        render(null);
        needsRender = false;
    }
    updateHud(now);
    requestAnimationFrame(update);
}

// Adaptive resolution: if frames stay slow, render the canvas at fewer pixels per CSS pixel.
// The full-screen display pass dominates on high-DPI tablets, so this is where the budget goes.
// If a downscale doesn't speed things up (e.g. iOS Low Power Mode caps rAF at 30fps), it is undone.
const frameStats = { count: 0, sum: 0, settleUntil: 2500, state: 'measuring', previousAvg: 0, previousQuality: 1 };

function trackFrameTime (interval, now) {
    if (interval <= 0 || interval > 200 || now < frameStats.settleUntil || document.hidden) return;
    frameStats.count++;
    frameStats.sum += interval;
    if (frameStats.count < 90) return;

    const avg = frameStats.sum / frameStats.count;
    frameStats.count = 0;
    frameStats.sum = 0;

    if (frameStats.state == 'verifying') {
        if (avg > frameStats.previousAvg * 0.9) {
            qualityFactor = frameStats.previousQuality;
            frameStats.state = 'locked';
            needsResize = true;
            return;
        }
        frameStats.state = 'measuring';
    }
    if (frameStats.state == 'measuring' && avg > 1000 / 50 && qualityFactor > MIN_QUALITY) {
        frameStats.previousAvg = avg;
        frameStats.previousQuality = qualityFactor;
        qualityFactor = Math.max(MIN_QUALITY, qualityFactor * 0.8);
        frameStats.state = 'verifying';
        frameStats.settleUntil = now + 1000;
        needsResize = true;
    }
}

function resizeCanvas () {
    cssWidth = Math.max(1, canvas.clientWidth);
    cssHeight = Math.max(1, canvas.clientHeight);
    let width = scaleByPixelRatio(cssWidth);
    let height = scaleByPixelRatio(cssHeight);
    if (canvas.width != width || canvas.height != height) {
        canvas.width = width;
        canvas.height = height;
        return true;
    }
    return false;
}

function updateColors (dt) {
    if (!config.COLORFUL) return;

    colorUpdateTimer += dt * config.COLOR_UPDATE_SPEED;
    if (colorUpdateTimer >= 1) {
        colorUpdateTimer = wrap(colorUpdateTimer, 0, 1);
        for (const p of input.pointers.values())
            p.color = generateColor();
    }
}

// Held pointers pulse on the beat; without sound, keep a steady pulse so the gesture still works.
// `elapsed` is real time, not the capped simulation step, so the tempo holds at 30fps too.
function updateFallbackBeat (elapsed) {
    if (music.running) {
        fallbackBeatTimer = 0;
        return;
    }
    fallbackBeatTimer += elapsed;
    if (fallbackBeatTimer >= FALLBACK_BEAT) {
        fallbackBeatTimer -= FALLBACK_BEAT;
        if (config.BEAT_PULSES) queueBeatPulses(0.45);
    }
}

function queueBeatPulses (strength) {
    for (const p of input.pointers.values())
        if (p.down && p.holding) pendingPulses.push({ id: p.id, strength });
}

function updateHud (now) {
    if (now - hudUpdateTime < 100) return;
    hudUpdateTime = now;
    const level = music.running ? music.level : 0;
    const bar = document.getElementById('energy-bar');
    if (bar) bar.style.transform = `scaleX(${level.toFixed(3)})`;
    const meter = document.getElementById('energy-meter');
    if (meter) meter.style.transform = `scaleX(${level.toFixed(3)})`;
    const value = document.getElementById('energy-value');
    if (value) value.textContent = Math.round(level * 100) + '%';
}

function applyInputs (now) {
    let changed = false;
    if (splatStack.length > 0) {
        multipleSplats(splatStack.pop());
        changed = true;
    }

    // Runs gesture detection, which may queue forces below.
    input.update(now);

    let moving = 0;
    for (const p of input.pointers.values()) {
        if (!p.down) continue;
        music.updatePointer(p);
        if (p.pathLength > 0) moving++;
    }
    if (moving > 0) {
        // Share a fixed splat budget between fingers so ten fast fingers can't stall a frame.
        const budget = Math.max(2, Math.floor(MAX_SPLATS_PER_FRAME / moving));
        beginSplats();
        for (const p of input.pointers.values())
            if (p.down && p.pathLength > 0) strokePointer(p, budget);
        endSplats();
        changed = true;
    }

    if (pendingDroplets.length > 0 || pendingPulses.length > 0) {
        beginSplats();
        for (const d of pendingDroplets)
            splatAt(d.x, d.y, 0, 0, d.color, d.radius);
        for (const pulse of pendingPulses) {
            const p = input.pointers.get(pulse.id);
            if (!p || !p.down) continue;
            const s = strokeScales(p);
            const color = scaleColor(p.color || generateColor(), 2.0 * pulse.strength * s.dye);
            splatAt(p.x, p.y, 0, 0, color, baseRadius() * s.size * 0.8);
            // A radial push alone is mostly cancelled by the pressure solve; the swirl keeps each beat visibly stirring.
            beatSwirl = -beatSwirl;
            pendingForces.push({ x: p.x, y: p.y, radius: baseRadius() * s.size * 3, radial: (160 + 420 * pulse.strength) * s.force, swirl: beatSwirl * (60 + 160 * pulse.strength) * s.force });
        }
        endSplats();
        pendingDroplets.length = 0;
        pendingPulses.length = 0;
        changed = true;
    }

    if (pendingForces.length > 0) {
        beginForces();
        for (const f of pendingForces) forceAt(f.x, f.y, f.radius, f.radial, f.swirl);
        endSplats();
        pendingForces.length = 0;
        changed = true;
    }
    return changed;
}

// ---------------------------------------------------------------- input handlers

function handlePointerDown (pointer) {
    pointer.color = generateColor();
    music.pointerDown(pointer);
    needsRender = true;
}

function handlePointerUp (pointer) {
    // Draw whatever moved since the last frame so quick flicks keep their final motion.
    if (pointer.pathLength > 0) {
        beginSplats();
        strokePointer(pointer, MAX_SPLATS_PER_FRAME);
        endSplats();
        needsRender = true;
    }
    music.pointerUp(pointer);
}

function handleTap (pointer) {
    music.tap(pointer);
    const s = strokeScales(pointer);
    pendingDroplets.push({ x: pointer.x, y: pointer.y, color: scaleColor(pointer.color || generateColor(), 2.2 * s.dye, {}), radius: baseRadius() * s.size * 1.2 });
    pendingForces.push({ x: pointer.x, y: pointer.y, radius: baseRadius() * s.size * 4, radial: 380 * s.force, swirl: (Math.random() < 0.5 ? -1 : 1) * 140 * s.force });
}

function handlePinch (amount, x, y, radius) {
    pendingForces.push({ x, y, radius: Math.max(0.002, radius * radius * 1.4), radial: amount * PINCH_FORCE, swirl: 0 });
    music.pinch(amount);
}

function handleTwist (angle, x, y, radius) {
    pendingForces.push({ x, y, radius: Math.max(0.002, radius * radius * 1.4), radial: 0, swirl: angle * TWIST_FORCE });
    music.twist(angle, x);
}

function triggerBurst () {
    splatStack.push(parseInt(Math.random() * 20) + 5);
    music.burst();
}

function step (dt) {
    gl.disable(gl.BLEND);

    curlProgram.bind();
    gl.uniform2f(curlProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(curlProgram.uniforms.uVelocity, velocity.read.attach(0));
    blit(curl);

    vorticityProgram.bind();
    gl.uniform2f(vorticityProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(vorticityProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(vorticityProgram.uniforms.uCurl, curl.attach(1));
    gl.uniform1f(vorticityProgram.uniforms.curl, config.CURL);
    gl.uniform1f(vorticityProgram.uniforms.dt, dt);
    blit(velocity.write);
    velocity.swap();

    divergenceProgram.bind();
    gl.uniform2f(divergenceProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(divergenceProgram.uniforms.uVelocity, velocity.read.attach(0));
    blit(divergence);

    clearProgram.bind();
    gl.uniform1i(clearProgram.uniforms.uTexture, pressure.read.attach(0));
    gl.uniform1f(clearProgram.uniforms.value, config.PRESSURE);
    blit(pressure.write);
    pressure.swap();

    pressureProgram.bind();
    gl.uniform2f(pressureProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(pressureProgram.uniforms.uDivergence, divergence.attach(0));
    for (let i = 0; i < config.PRESSURE_ITERATIONS; i++) {
        gl.uniform1i(pressureProgram.uniforms.uPressure, pressure.read.attach(1));
        blit(pressure.write);
        pressure.swap();
    }

    gradienSubtractProgram.bind();
    gl.uniform2f(gradienSubtractProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(gradienSubtractProgram.uniforms.uPressure, pressure.read.attach(0));
    gl.uniform1i(gradienSubtractProgram.uniforms.uVelocity, velocity.read.attach(1));
    blit(velocity.write);
    velocity.swap();

    advectionProgram.bind();
    gl.uniform2f(advectionProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    if (!ext.supportLinearFiltering)
        gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, velocity.texelSizeX, velocity.texelSizeY);
    let velocityId = velocity.read.attach(0);
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velocityId);
    gl.uniform1i(advectionProgram.uniforms.uSource, velocityId);
    gl.uniform1f(advectionProgram.uniforms.dt, dt);
    gl.uniform1f(advectionProgram.uniforms.dissipation, config.VELOCITY_DISSIPATION);
    blit(velocity.write);
    velocity.swap();

    if (!ext.supportLinearFiltering)
        gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, dye.texelSizeX, dye.texelSizeY);
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(advectionProgram.uniforms.uSource, dye.read.attach(1));
    gl.uniform1f(advectionProgram.uniforms.dissipation, config.DENSITY_DISSIPATION);
    blit(dye.write);
    dye.swap();
}

function render (target) {
    if (config.BLOOM)
        applyBloom(dye.read, bloom);
    if (config.SUNRAYS) {
        applySunrays(dye.read, sunraysMask, sunrays);
        blur(sunrays, sunraysTemp, 1);
    }

    if (target == null || !config.TRANSPARENT) {
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.enable(gl.BLEND);
    }
    else {
        gl.disable(gl.BLEND);
    }

    // A clear is much cheaper than drawing a full-screen quad for the background.
    if (!config.TRANSPARENT)
        clearTarget(target, normalizeColor(config.BACK_COLOR));
    if (target == null && config.TRANSPARENT)
        drawCheckerboard(target);
    drawDisplay(target);
}

function resetSimulation () {
    if (!dye || !velocity) return;
    const black = { r: 0, g: 0, b: 0 };
    clearTarget(dye.read, black);
    clearTarget(dye.write, black);
    clearTarget(velocity.read, black);
    clearTarget(velocity.write, black);
    if (pressure) {
        clearTarget(pressure.read, black);
        clearTarget(pressure.write, black);
    }
}

function clearTarget (target, color) {
    if (target == null) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
        gl.viewport(0, 0, target.width, target.height);
    }
    gl.clearColor(color.r, color.g, color.b, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
}

function drawCheckerboard (target) {
    checkerboardProgram.bind();
    gl.uniform1f(checkerboardProgram.uniforms.aspectRatio, canvas.width / canvas.height);
    blit(target);
}

function drawDisplay (target) {
    let width = target == null ? gl.drawingBufferWidth : target.width;
    let height = target == null ? gl.drawingBufferHeight : target.height;

    displayMaterial.bind();
    if (config.SHADING)
        gl.uniform2f(displayMaterial.uniforms.texelSize, 1.0 / width, 1.0 / height);
    gl.uniform1i(displayMaterial.uniforms.uTexture, dye.read.attach(0));
    if (config.BLOOM) {
        gl.uniform1i(displayMaterial.uniforms.uBloom, bloom.attach(1));
        gl.uniform1i(displayMaterial.uniforms.uDithering, ditheringTexture.attach(2));
        let scale = getTextureScale(ditheringTexture, width, height);
        gl.uniform2f(displayMaterial.uniforms.ditherScale, scale.x, scale.y);
    }
    if (config.SUNRAYS)
        gl.uniform1i(displayMaterial.uniforms.uSunrays, sunrays.attach(3));
    blit(target);
}

function applyBloom (source, destination) {
    if (bloomFramebuffers.length < 2)
        return;

    let last = destination;

    gl.disable(gl.BLEND);
    bloomPrefilterProgram.bind();
    let knee = config.BLOOM_THRESHOLD * config.BLOOM_SOFT_KNEE + 0.0001;
    let curve0 = config.BLOOM_THRESHOLD - knee;
    let curve1 = knee * 2;
    let curve2 = 0.25 / knee;
    gl.uniform3f(bloomPrefilterProgram.uniforms.curve, curve0, curve1, curve2);
    gl.uniform1f(bloomPrefilterProgram.uniforms.threshold, config.BLOOM_THRESHOLD);
    gl.uniform1i(bloomPrefilterProgram.uniforms.uTexture, source.attach(0));
    blit(last);

    bloomBlurProgram.bind();
    for (let i = 0; i < bloomFramebuffers.length; i++) {
        let dest = bloomFramebuffers[i];
        gl.uniform2f(bloomBlurProgram.uniforms.texelSize, last.texelSizeX, last.texelSizeY);
        gl.uniform1i(bloomBlurProgram.uniforms.uTexture, last.attach(0));
        blit(dest);
        last = dest;
    }

    gl.blendFunc(gl.ONE, gl.ONE);
    gl.enable(gl.BLEND);

    for (let i = bloomFramebuffers.length - 2; i >= 0; i--) {
        let baseTex = bloomFramebuffers[i];
        gl.uniform2f(bloomBlurProgram.uniforms.texelSize, last.texelSizeX, last.texelSizeY);
        gl.uniform1i(bloomBlurProgram.uniforms.uTexture, last.attach(0));
        blit(baseTex);
        last = baseTex;
    }

    gl.disable(gl.BLEND);
    bloomFinalProgram.bind();
    gl.uniform2f(bloomFinalProgram.uniforms.texelSize, last.texelSizeX, last.texelSizeY);
    gl.uniform1i(bloomFinalProgram.uniforms.uTexture, last.attach(0));
    gl.uniform1f(bloomFinalProgram.uniforms.intensity, config.BLOOM_INTENSITY);
    blit(destination);
}

function applySunrays (source, mask, destination) {
    gl.disable(gl.BLEND);
    sunraysMaskProgram.bind();
    gl.uniform1i(sunraysMaskProgram.uniforms.uTexture, source.attach(0));
    blit(mask);

    sunraysProgram.bind();
    gl.uniform1f(sunraysProgram.uniforms.weight, config.SUNRAYS_WEIGHT);
    gl.uniform1i(sunraysProgram.uniforms.uTexture, mask.attach(0));
    blit(destination);
}

function blur (target, temp, iterations) {
    blurProgram.bind();
    for (let i = 0; i < iterations; i++) {
        gl.uniform2f(blurProgram.uniforms.texelSize, target.texelSizeX, 0.0);
        gl.uniform1i(blurProgram.uniforms.uTexture, target.attach(0));
        blit(temp);

        gl.uniform2f(blurProgram.uniforms.texelSize, 0.0, target.texelSizeY);
        gl.uniform1i(blurProgram.uniforms.uTexture, temp.attach(0));
        blit(target);
    }
}

function multipleSplats (amount) {
    const radius = baseRadius();
    beginSplats();
    for (let i = 0; i < amount; i++) {
        const color = generateColor();
        color.r *= 10.0;
        color.g *= 10.0;
        color.b *= 10.0;
        const x = Math.random();
        const y = Math.random();
        const dx = 1000 * (Math.random() - 0.5);
        const dy = 1000 * (Math.random() - 0.5);
        splatAt(x, y, dx, dy, color, radius);
    }
    endSplats();
}

function beginSplats () {
    splatProgram.bind();
    gl.uniform1f(splatProgram.uniforms.aspectRatio, canvas.width / canvas.height);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.enable(gl.BLEND);
    gl.enable(gl.SCISSOR_TEST);
}

function beginForces () {
    forceProgram.bind();
    gl.uniform1f(forceProgram.uniforms.aspectRatio, canvas.width / canvas.height);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.enable(gl.BLEND);
    gl.enable(gl.SCISSOR_TEST);
}

function endSplats () {
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
}

// Adds a gaussian of velocity (dx, dy) and dye `color` at (x, y). Call between beginSplats/endSplats.
function splatAt (x, y, dx, dy, color, radius) {
    gl.uniform2f(splatProgram.uniforms.point, x, y);
    gl.uniform1f(splatProgram.uniforms.radius, radius);
    if (scissorSplat(velocity.read, x, y, radius, Math.max(Math.abs(dx), Math.abs(dy)), VELOCITY_EPSILON, 0)) {
        gl.uniform3f(splatProgram.uniforms.color, dx, dy, 0.0);
        blit(velocity.read);
    }
    if (scissorSplat(dye.read, x, y, radius, Math.max(color.r, color.g, color.b), DYE_EPSILON, 0)) {
        gl.uniform3f(splatProgram.uniforms.color, color.r, color.g, color.b);
        blit(dye.read);
    }
}

// Radial (outward > 0) and swirl (counter-clockwise > 0) velocity. Call between beginForces/endSplats.
function forceAt (x, y, radius, radial, swirl) {
    if (!scissorSplat(velocity.read, x, y, radius, Math.hypot(radial, swirl), VELOCITY_EPSILON, 1.5)) return;
    gl.uniform2f(forceProgram.uniforms.point, x, y);
    gl.uniform1f(forceProgram.uniforms.radius, radius);
    gl.uniform2f(forceProgram.uniforms.strength, radial, swirl);
    blit(velocity.read);
}

// Limits drawing to where exp(-d²/radius) * magnitude is still above epsilon.
function scissorSplat (target, x, y, radius, magnitude, epsilon, margin) {
    if (!(magnitude > epsilon)) return false;
    const extentY = Math.sqrt(radius * (Math.log(magnitude / epsilon) + margin));
    const extentX = extentY * canvas.height / canvas.width;
    const x0 = Math.max(0, Math.floor((x - extentX) * target.width));
    const x1 = Math.min(target.width, Math.ceil((x + extentX) * target.width));
    const y0 = Math.max(0, Math.floor((y - extentY) * target.height));
    const y1 = Math.min(target.height, Math.ceil((y + extentY) * target.height));
    if (x1 <= x0 || y1 <= y0) return false;
    gl.scissor(x0, y0, x1 - x0, y1 - y0);
    return true;
}

// Draws everything a pointer moved through since the last frame as evenly spaced splats, so fast
// strokes stay continuous instead of turning into dotted beads.
function strokePointer (pointer, budget) {
    const aspect = canvas.width / canvas.height;
    // Distances are measured in screen heights; this converts them to the units the
    // original per-frame delta used, so a slow stroke produces exactly the old splat.
    const toDelta = aspect > 1 ? 1 / aspect : 1;
    const s = strokeScales(pointer);
    const radius = baseRadius() * s.size;
    const spacing = Math.max(Math.sqrt(radius * 0.5) * 0.9, 0.002);
    const path = pointer.path;
    const samples = pointer.pathLength;

    let length = 0;
    let px = pointer.lastX;
    let py = pointer.lastY;
    for (let i = 0; i < samples; i++) {
        const x = path[i * 2];
        const y = path[i * 2 + 1];
        length += Math.hypot((x - px) * aspect, y - py);
        px = x;
        py = y;
    }
    pointer.pathLength = 0;
    if (length < 1e-6) {
        pointer.lastX = px;
        pointer.lastY = py;
        return;
    }

    const count = Math.min(budget, Math.max(1, Math.ceil(length / spacing)));
    const stepLength = length / count;
    const norm = 1 / Math.sqrt(count);
    const strength = length * toDelta * config.SPLAT_FORCE * s.force * norm;
    const color = scaleColor(pointer.color, s.dye * norm);

    let emitted = 0;
    let next = stepLength;
    let travelled = 0;
    px = pointer.lastX;
    py = pointer.lastY;
    for (let i = 0; i < samples && emitted < count; i++) {
        const x = path[i * 2];
        const y = path[i * 2 + 1];
        const segX = (x - px) * aspect;
        const segY = y - py;
        const segLength = Math.hypot(segX, segY);
        if (segLength > 0) {
            const dirX = segX / segLength;
            const dirY = segY / segLength;
            while (emitted < count && next <= travelled + segLength + 1e-9) {
                const t = (next - travelled) / segLength;
                splatAt(px + (x - px) * t, py + (y - py) * t, dirX * strength, dirY * strength, color, radius);
                emitted++;
                next += stepLength;
            }
            travelled += segLength;
        }
        px = x;
        py = y;
    }
    pointer.lastX = px;
    pointer.lastY = py;
}

// Pen pressure and tilt shape the stroke; mouse and plain touch stay at the neutral 0.5.
const strokeScaleCache = { size: 1, dye: 1, force: 1 };

function strokeScales (pointer) {
    const pressure = pointer.pressure;
    const tilt = pointer.type == 'pen' ? pointer.tilt : 0;
    strokeScaleCache.size = (0.35 + 1.3 * pressure) * (1 + 1.5 * tilt);
    strokeScaleCache.dye = (0.45 + 1.1 * pressure) * (1 - 0.3 * tilt);
    strokeScaleCache.force = 0.7 + 0.6 * pressure;
    return strokeScaleCache;
}

function baseRadius () {
    return correctRadius(config.SPLAT_RADIUS / 100.0);
}

const tempColor = { r: 0, g: 0, b: 0 };

function scaleColor (color, amount, out = tempColor) {
    out.r = color.r * amount;
    out.g = color.g * amount;
    out.b = color.b * amount;
    return out;
}

function correctRadius (radius) {
    let aspectRatio = canvas.width / canvas.height;
    if (aspectRatio > 1)
        radius *= aspectRatio;
    return radius;
}

// INK is how much dye each splat adds. Overlapping random hues add up to white, so this sets how
// quickly heavy painting washes out (the original 0.15 turned the screen white within a second).
function generateColor () {
    let c = HSVtoRGB(Math.random(), 1.0, 1.0);
    c.r *= config.INK;
    c.g *= config.INK;
    c.b *= config.INK;
    return c;
}

function HSVtoRGB (h, s, v) {
    let r, g, b, i, f, p, q, t;
    i = Math.floor(h * 6);
    f = h * 6 - i;
    p = v * (1 - s);
    q = v * (1 - f * s);
    t = v * (1 - (1 - f) * s);

    switch (i % 6) {
        case 0: r = v, g = t, b = p; break;
        case 1: r = q, g = v, b = p; break;
        case 2: r = p, g = v, b = t; break;
        case 3: r = p, g = q, b = v; break;
        case 4: r = t, g = p, b = v; break;
        case 5: r = v, g = p, b = q; break;
    }

    return {
        r,
        g,
        b
    };
}

function normalizeColor (input) {
    let output = {
        r: input.r / 255,
        g: input.g / 255,
        b: input.b / 255
    };
    return output;
}

function rgbToHex (color) {
    const toHex = value => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
    return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
}

function hexToRgb (hex) {
    const parsed = hex.replace('#', '');
    if (parsed.length !== 6) return { r: 0, g: 0, b: 0 };
    const intVal = parseInt(parsed, 16);
    return {
        r: (intVal >> 16) & 255,
        g: (intVal >> 8) & 255,
        b: intVal & 255
    };
}

function wrap (value, min, max) {
    let range = max - min;
    if (range == 0) return min;
    return (value - min) % range + min;
}

// Uses the CSS size so changing the render scale (which only rounds differently) never
// reallocates the simulation buffers.
function getResolution (resolution) {
    let aspectRatio = cssWidth / cssHeight;
    if (aspectRatio < 1)
        aspectRatio = 1.0 / aspectRatio;

    let min = Math.round(resolution);
    let max = Math.round(resolution * aspectRatio);

    if (cssWidth > cssHeight)
        return { width: max, height: min };
    else
        return { width: min, height: max };
}

function getTextureScale (texture, width, height) {
    return {
        x: width / texture.width,
        y: height / texture.height
    };
}

// Capped at MAX_PIXEL_RATIO (phones report 3x) and scaled down further by the frame-time governor.
function scaleByPixelRatio (value) {
    let pixelRatio = Math.min(window.devicePixelRatio || 1, config.MAX_PIXEL_RATIO) * qualityFactor;
    return Math.max(1, Math.floor(value * pixelRatio));
}

function hashCode (s) {
    if (s.length == 0) return 0;
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
        hash = (hash << 5) - hash + s.charCodeAt(i);
        hash |= 0; // Convert to 32bit integer
    }
    return hash;
};
