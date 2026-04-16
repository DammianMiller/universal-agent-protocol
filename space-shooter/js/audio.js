/**
 * audio.js - Web Audio API procedural sound generation
 * No external files - all sounds generated in real-time
 */

const AudioSys = {
    ctx: null,
    masterGain: null,
    ambientNode: null,
    unleashDroneNode: null,
    isInitialized: false,

    init() {
        if (this.isInitialized) return;
        try {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
            this.masterGain = this.ctx.createGain();
            this.masterGain.gain.value = Config.audio.masterVolume;
            this.masterGain.connect(this.ctx.destination);
            this.isInitialized = true;
        } catch (e) {
            console.warn('Web Audio API not supported');
        }
    },

    playLaser() {
        if (!this.isInitialized) return;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.connect(gain);
        gain.connect(this.masterGain);
        osc.frequency.setValueAtTime(880, this.ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(110, this.ctx.currentTime + 0.15);
        gain.gain.setValueAtTime(Config.audio.laserVolume, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.15);
        osc.start(this.ctx.currentTime);
        osc.stop(this.ctx.currentTime + 0.15);
    },

    playHit() {
        if (!this.isInitialized) return;
        const bufferSize = this.ctx.sampleRate * 0.1;
        const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = (Math.random() * 2 - 1) * 0.5;
        }
        const noise = this.ctx.createBufferSource();
        const gain = this.ctx.createGain();
        noise.connect(gain);
        gain.connect(this.masterGain);
        gain.gain.setValueAtTime(Config.audio.hitVolume, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.1);
        noise.start(this.ctx.currentTime);
    },

    playExplosion(size) {
        if (!this.isInitialized) return;
        const duration = size === 'boss' ? 1.5 : size === 'medium' ? 0.8 : 0.4;
        const bufferSize = this.ctx.sampleRate * duration;
        const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = (Math.random() * 2 - 1) * 0.7;
        }
        const noise = this.ctx.createBufferSource();
        const gain = this.ctx.createGain();
        noise.connect(gain);
        gain.connect(this.masterGain);
        gain.gain.setValueAtTime(Config.audio.explosionVolume, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + duration);
        noise.start(this.ctx.currentTime);
    },

    playPowerup() {
        if (!this.isInitialized) return;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sine';
        osc.connect(gain);
        gain.connect(this.masterGain);
        osc.frequency.setValueAtTime(440, this.ctx.currentTime);
        osc.frequency.linearRampToValueAtTime(880, this.ctx.currentTime + 0.2);
        osc.frequency.linearRampToValueAtTime(1320, this.ctx.currentTime + 0.4);
        gain.gain.setValueAtTime(Config.audio.powerupVolume, this.ctx.currentTime);
        gain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.5);
        osc.start(this.ctx.currentTime);
        osc.stop(this.ctx.currentTime + 0.5);
    },

    playUnleashStart() {
        if (!this.isInitialized) return;
        this.unleashDroneNode = this.ctx.createOscillator();
        const droneGain = this.ctx.createGain();
        this.unleashDroneNode.type = 'sawtooth';
        this.unleashDroneNode.frequency.setValueAtTime(55, this.ctx.currentTime);
        this.unleashDroneNode.connect(droneGain);
        droneGain.connect(this.masterGain);
        droneGain.gain.setValueAtTime(Config.audio.unleashDroneVolume, this.ctx.currentTime);
        this.unleashDroneNode.start(this.ctx.currentTime);
        this.unleashDroneGain = droneGain;
    },

    playUnleashEnd() {
        if (!this.unleashDroneNode) return;
        if (this.unleashDroneGain) {
            this.unleashDroneGain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.3);
        }
        this.unleashDroneNode.disconnect();
        this.unleashDroneNode.stop(this.ctx.currentTime + 0.3);
        this.unleashDroneNode = null;
        this.unleashDroneGain = null;
    },

    playBossWarning() {
        if (!this.isInitialized) return;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.connect(gain);
        gain.connect(this.masterGain);
        osc.frequency.setValueAtTime(660, this.ctx.currentTime);
        osc.frequency.linearRampToValueAtTime(880, this.ctx.currentTime + 0.1);
        gain.gain.setValueAtTime(0.3, this.ctx.currentTime);
        gain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.15);
        osc.start(this.ctx.currentTime);
        osc.stop(this.ctx.currentTime + 0.15);
    },

    startAmbient() {
        if (!this.isInitialized || this.ambientNode) return;
        const bufferSize = this.ctx.sampleRate * 2;
        const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = (Math.random() * 2 - 1) * 0.02;
        }
        this.ambientNode = this.ctx.createBufferSource();
        const gain = this.ctx.createGain();
        this.ambientNode.loop = true;
        this.ambientNode.buffer = buffer;
        this.ambientNode.connect(gain);
        gain.connect(this.masterGain);
        gain.gain.value = 0.1;
        this.ambientNode.start(0);
    },

    stopAmbient() {
        if (this.ambientNode) {
            this.ambientNode.stop();
            this.ambientNode = null;
        }
    },

    resume() {
        if (this.ctx && this.ctx.state === 'suspended') {
            this.ctx.resume();
        }
    }
};

if (typeof window !== 'undefined') {
    window.AudioSys = AudioSys;
}