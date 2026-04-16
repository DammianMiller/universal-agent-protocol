/**
 * particles.js - Particle system for explosions, trails, and effects
 * Handles all visual particle effects including explosions, ink splatter, engine trails, and bullet trails
 */

class Particle {
    constructor(x, y, color, vx, vy, size, lifetime) {
        this.x = x;
        this.y = y;
        this.color = color;
        this.vx = vx;
        this.vy = vy;
        this.size = size;
        this.lifetime = lifetime;
        this.age = 0;
        this.alpha = 1;
    }

    update(dt) {
        this.age += dt * 1000;
        const progress = this.age / this.lifetime;
        this.x += this.vx * dt * 60;
        this.y += this.vy * dt * 60;
        this.alpha = 1 - progress;
    }

    isDead() {
        return this.age >= this.lifetime;
    }
}

class DamageNumber {
    constructor(x, y, damage) {
        this.x = x;
        this.y = y;
        this.damage = damage;
        this.vy = -Config.particles.damageNumberRiseSpeed / 60;
        this.age = 0;
        this.lifetime = Config.particles.damageNumberLifetime;
        this.alpha = 1;
    }

    update(dt) {
        this.age += dt * 1000;
        const progress = this.age / this.lifetime;
        this.y += this.vy * dt;
        this.alpha = 1 - progress;
    }

    isDead() {
        return this.age >= this.lifetime;
    }
}

class SparkParticle extends Particle {
    constructor(x, y, color) {
        const angle = Math.random() * Math.PI * 2;
        const speed = Math.random() * 3 + 1;
        super(
            x,
            y,
            color,
            Math.cos(angle) * speed,
            Math.sin(angle) * speed,
            Math.random() * 3 + 2,
            300
        );
    }
}

class ExplosionParticle extends Particle {
    constructor(x, y, color) {
        const angle = Math.random() * Math.PI * 2;
        const speed = Math.random() * 5 + 2;
        super(
            x,
            y,
            color,
            Math.cos(angle) * speed,
            Math.sin(angle) * speed,
            Math.random() * 4 + 3,
            600
        );
    }
}

class InkSplatter extends Particle {
    constructor(x, y, color) {
        const angle = Math.random() * Math.PI * 2;
        const speed = Math.random() * 4 + 1;
        super(
            x,
            y,
            color,
            Math.cos(angle) * speed,
            Math.sin(angle) * speed,
            Math.random() * 5 + 3,
            800
        );
    }
}

class EngineTrail extends Particle {
    constructor(x, y, color) {
        super(
            x,
            y,
            color,
            0,
            Math.random() * 2 + 1,
            Math.random() * 3 + 2,
            200
        );
    }
}

class BulletTrail extends Particle {
    constructor(x, y, color) {
        super(
            x,
            y,
            color,
            0,
            Math.random() * 1 + 0.5,
            Math.random() * 2 + 1,
            150
        );
    }
}

class PowerupSparkle extends Particle {
    constructor(x, y) {
        const angle = Math.random() * Math.PI * 2;
        const speed = Math.random() * 2 + 0.5;
        super(
            x,
            y,
            '#FFFFFF',
            Math.cos(angle) * speed,
            Math.sin(angle) * speed,
            Math.random() * 2 + 1,
            400
        );
    }
}

class Comet extends Particle {
    constructor(x, y) {
        super(
            x,
            y,
            '#FFFFFF',
            Math.random() * 2 + 3,
            Math.random() * 2 + 3,
            Math.random() * 3 + 2,
            2000
        );
    }
}

class Star {
    constructor(x, y) {
        this.x = x;
        this.y = y;
        this.size = Math.random() * 1.5 + 0.5;
        this.speed = Math.random() * 0.5 + 0.2;
        this.brightness = Math.random();
    }

    update(dt, scrollSpeed) {
        this.y += (this.speed + scrollSpeed) * dt * 60;
        if (this.y > window.innerHeight) {
            this.y = 0;
            this.x = Math.random() * window.innerWidth;
        }
    }

    draw(ctx) {
        ctx.fillStyle = `rgba(255, 255, 255, ${this.brightness})`;
        ctx.fillRect(this.x, this.y, this.size, this.size);
    }
}

class NebulaCloud {
    constructor() {
        this.reset();
    }

    reset() {
        this.x = Math.random() * window.innerWidth;
        this.y = -100 - Math.random() * 200;
        this.radius = Math.random() * 80 + 60;
        this.color = this.getRandomColor();
        this.speed = Math.random() * 0.3 + 0.1;
    }

    getRandomColor() {
        const colors = [
            'rgba(78, 205, 196, ',
            'rgba(149, 225, 211, ',
            'rgba(255, 230, 109, ',
            'rgba(255, 100, 150, '
        ];
        return colors[Math.floor(Math.random() * colors.length)];
    }

    update(dt, scrollSpeed) {
        this.y += (this.speed + scrollSpeed * 0.3) * dt * 60;
        if (this.y > window.innerHeight + 200) {
            this.reset();
        }
    }

    draw(ctx) {
        const gradient = ctx.createRadialGradient(
            this.x, this.y, 0,
            this.x, this.y, this.radius
        );
        gradient.addColorStop(0, this.color + '0.15)');
        gradient.addColorStop(1, this.color + '0)');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
        ctx.fill();
    }
}

class Planet {
    constructor() {
        this.reset();
    }

    reset() {
        this.x = Math.random() * window.innerWidth;
        this.y = -150 - Math.random() * 300;
        this.radius = Math.random() < 0.5 ? Math.random() * 20 + 20 : Math.random() * 40 + 60;
        this.isNear = this.radius > 50;
        this.color = this.isNear ? `rgba(78, 205, 196, ${this.radius / 100})` : 'rgba(78, 205, 196, 0.4)';
        this.speed = this.isNear ? Math.random() * 0.5 + 0.3 : Math.random() * 0.1 + 0.05;
    }

    update(dt, scrollSpeed) {
        this.y += (this.speed + scrollSpeed * (this.isNear ? 0.5 : 0.2)) * dt * 60;
        if (this.y > window.innerHeight + 100) {
            this.reset();
        }
    }

    draw(ctx) {
        ctx.fillStyle = this.color;
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
        ctx.fill();
    }
}

class ParticleSystem {
    constructor() {
        this.particles = [];
        this.damageNumbers = [];
        this.stars = [];
        this.nebulaClouds = [];
        this.planets = [];
        this.comets = [];

        // Initialize stars
        for (let i = 0; i < 150; i++) {
            this.stars.push(new Star(
                Math.random() * window.innerWidth,
                Math.random() * window.innerHeight
            ));
        }

        // Initialize nebula clouds
        for (let i = 0; i < 8; i++) {
            this.nebulaClouds.push(new NebulaCloud());
        }

        // Initialize planets
        for (let i = 0; i < 12; i++) {
            this.planets.push(new Planet());
        }
    }

    spawnExplosion(x, y, color) {
        const count = Config.particles.explosionCount;
        for (let i = 0; i < count; i++) {
            this.particles.push(new ExplosionParticle(x, y, color));
        }
    }

    spawnInkSplatter(x, y, color) {
        const count = Config.particles.inkSplatterCount;
        for (let i = 0; i < count; i++) {
            this.particles.push(new InkSplatter(x, y, color));
        }
    }

    spawnSparks(x, y, color) {
        const count = Config.particles.sparkCount;
        for (let i = 0; i < count; i++) {
            this.particles.push(new SparkParticle(x, y, color));
        }
    }

    spawnEngineTrail(x, y, color) {
        this.particles.push(new EngineTrail(x, y, color));
    }

    spawnBulletTrail(x, y, color) {
        this.particles.push(new BulletTrail(x, y, color));
    }

    spawnPowerupSparkle(x, y) {
        for (let i = 0; i < 8; i++) {
            this.particles.push(new PowerupSparkle(x, y));
        }
    }

    spawnDamageNumber(x, y, damage) {
        this.damageNumbers.push(new DamageNumber(x, y, damage));
    }

    spawnComet() {
        const x = Math.random() * window.innerWidth * 0.6;
        this.comets.push(new Comet(x, -50));
    }

    update(dt) {
        // Update stars
        this.stars.forEach(star => star.update(dt, 0.2));

        // Update nebula clouds
        this.nebulaClouds.forEach(cloud => cloud.update(dt, 0.15));

        // Update planets
        this.planets.forEach(planet => planet.update(dt, 0.25));

        // Update comets
        this.comets = this.comets.filter(comet => {
            comet.update(dt);
            return !comet.isDead();
        });

        // Update regular particles
        this.particles = this.particles.filter(particle => {
            particle.update(dt);
            return !particle.isDead();
        });

        // Update damage numbers
        this.damageNumbers = this.damageNumbers.filter(num => {
            num.update(dt);
            return !num.isDead();
        });
    }

    draw(ctx) {
        // Draw stars
        this.stars.forEach(star => star.draw(ctx));

        // Draw nebula clouds
        this.nebulaClouds.forEach(cloud => cloud.draw(ctx));

        // Draw planets
        this.planets.forEach(planet => planet.draw(ctx));

        // Draw comets
        this.comets.forEach(comet => {
            comet.draw(ctx);
        });

        // Draw particles
        this.particles.forEach(particle => {
            ctx.globalAlpha = particle.alpha;
            ctx.fillStyle = particle.color;
            ctx.beginPath();
            ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
            ctx.fill();
        });

        // Draw damage numbers
        this.damageNumbers.forEach(num => {
            ctx.globalAlpha = num.alpha;
            ctx.fillStyle = Config.colors.damageNumber;
            ctx.font = `bold ${16 + Math.random() * 4}px monospace`;
            ctx.fillText(`-${num.damage}`, num.x, num.y);
        });

        ctx.globalAlpha = 1;
    }
}

if (typeof window !== 'undefined') {
    window.ParticleSystem = ParticleSystem;
}