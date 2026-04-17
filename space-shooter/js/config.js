/**
 * config.js - Game configuration and tuning constants
 * All gameplay parameters, colors, speeds, and sizes defined here for easy tweaking
 */

const Config = {
    // --- Color Palette (Neon Cyberpunk) ---
    colors: {
        background: '#0D1117',
        shipBody: '#2C3E50',
        shipGlowTier1: '#4ECDC4',
        shipGlowTier2: '#95E1D3',
        shipGlowTier3: '#FFE66D',
        shipGlowTier4: '#FFFFFF',
        bulletTier1: '#4ECDC4',
        bulletTier2: '#95E1D3',
        bulletTier3: '#FFE66D',
        bulletTier4: '#FFFFFF',
        smallOctopus: '#FF00FF',
        mediumOctopus: '#00BFFF',
        babyOctopus: '#00FFFF',
        bossOctopus: '#9B59B6',
        healthBarBg: '#333333',
        healthBarFill: '#27AE60',
        healthBarBorder: '#555555',
        text: '#FFFFFF',
        damageNumber: '#FFE66D',
        unleashGlow: '#FFFFFF',
        unleashRing: '#27AE60'
    },

    // --- Ship Configuration ---
    ship: {
        width: 50,
        height: 40,
        baseSpeed: 0.35, // Lerp factor for smooth mouse tracking
        maxHealth: 100,
        radius: 25, // For collision detection
        engineTrailColor: '#FF8C42',
        engineTrailLength: 8,
        bankAngle: 0.15 // Max tilt when moving
    },

    // --- Bullet Configuration (Speeds must be slow enough to not phase through enemies) ---
    bullets: {
        tier1: { speed: 8, damage: 10, spread: 0, count: 1 },
        tier2: { speed: 10, damage: 15, spread: 0.1, count: 2 },
        tier3: { speed: 12, damage: 20, spread: 0.15, count: 3 },
        tier4: { speed: 14, damage: 25, spread: 0.2, count: 4 }
    },

    // --- Enemy Configuration (Sizes must be large enough for collision) ---
    enemies: {
        small: { size: 36, health: 20, score: 100, speed: 2, color: '#FF00FF', tentacles: 2 },
        medium: { size: 48, health: 60, score: 300, speed: 1.5, color: '#00BFFF', tentacles: 4 },
        baby: { size: 20, health: 10, score: 50, speed: 3, color: '#00FFFF', tentacles: 2 },
        boss: { size: 150, health: 5000, score: 10000, speed: 0.8, color: '#9B59B6', tentacles: 8 }
    },

    // --- Wave Configuration ---
    waves: {
        baseEnemiesPerWave: 5,
        enemiesPerWaveIncrement: 3,
        bossEveryNLevels: 5,
        miniSwarmBeforeBoss: true
    },

    // --- Power-up Configuration ---
    powerup: {
        dropChance: 0.15, // 15% chance for big/boss enemies to drop
        unleashDuration: 5000, // 5 seconds
        scoreMultiplier: 3,
        radius: 20
    },

    // --- Particle Configuration ---
    particles: {
        maxParticles: 500,
        explosionCount: 15,
        inkSplatterCount: 10,
        sparkCount: 5,
        trailLength: 6,
        damageNumberLifetime: 1000, // ms
        damageNumberRiseSpeed: 60 // px per second
    },

    // --- Screen Shake Configuration ---
    screenShake: {
        maxIntensity: 20,
        decay: 0.9,
        contactDamage: 15,
        contactShake: 10
    },

    // --- Combo System ---
    combo: {
        maxTimeBetweenKills: 3000, // ms to maintain combo
        baseMultiplier: 1,
        multiplierPerKill: 0.1,
        maxMultiplier: 5
    },

    // --- Upgrade Tiers (every 3 levels) ---
    tierLevels: [1, 4, 7, 10], // Level at which each tier is unlocked

    // --- Audio Configuration ---
    audio: {
        masterVolume: 0.6,
        laserVolume: 0.3,
        explosionVolume: 0.5,
        powerupVolume: 0.4,
        hitVolume: 0.2,
        unleashDroneVolume: 0.15
    }
};

// Make config globally accessible
if (typeof window !== 'undefined') {
    window.Config = Config;
}