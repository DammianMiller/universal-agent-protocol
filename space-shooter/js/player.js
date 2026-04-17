/**
 * player.js - Player ship control, rendering, weapons, and upgrades
 * Handles mouse tracking with lerp, weapon tiers, health management, engine trails
 */

class Player {
  constructor(game) {
    this.game = game;
    this.bullets = [];
    this.reset();
    this.setupEventListeners();
  }

  reset() {
    this.x = window.innerWidth / 2;
    this.y = window.innerHeight - 100;
    this.targetX = this.x;
    this.targetY = this.y;
    this.tier = 1;
    this.level = 0;
    this.health = Config.ship.maxHealth;
    this.maxHealth = Config.ship.maxHealth;
    this.weaponsUnlocked = false;
    this.lastShotTime = 0;
    this.fireRate = 150; // ms between shots
    this.engineTrails = [];
    this.trailTimer = 0;
  }

  setupEventListeners() {
    window.addEventListener('mousemove', (e) => {
      this.targetX = e.clientX;
      this.targetY = e.clientY - 50; // Offset so ship follows cursor tip
    });

    window.addEventListener('mousedown', () => {
      if (!this.weaponsUnlocked) {
        this.weaponsUnlocked = true;
      }
    });
  }

  update(dt, deltaTime) {
    // Smooth mouse tracking with lerp (factor 0.35)
    const lerpFactor = Config.ship.baseSpeed;
    this.x += (this.targetX - this.x) * lerpFactor;
    this.y += (this.targetY - this.y) * lerpFactor;

    // Clamp to screen bounds
    this.x = Math.max(Config.ship.radius, Math.min(window.innerWidth - Config.ship.radius, this.x));
    this.y = Math.max(
      Config.ship.radius,
      Math.min(window.innerHeight - Config.ship.radius, this.y)
    );

    // Engine trail spawning
    this.trailTimer += deltaTime * 1000;
    if (this.trailTimer > 50) {
      // Every 50ms
      this.engineTrails.push({
        x: this.x - Config.ship.width / 2,
        y: this.y + Config.ship.height / 2,
        age: 0,
        lifetime: 300,
      });
      this.trailTimer = 0;
    }

    // Update engine trails
    this.engineTrails = this.engineTrails.filter((trail) => {
      trail.age += deltaTime * 1000;
      return trail.age < trail.lifetime;
    });
  }

  draw(ctx) {
    // Calculate bank angle based on horizontal movement
    const dx = this.targetX - this.x;
    const bankAngle = Math.max(-Config.ship.bankAngle, Math.min(Config.ship.bankAngle, dx * 0.001));

    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(bankAngle);

    // Draw ship body with glow based on tier
    const glowColor = this.getTierGlowColor();
    const glowSize = 20 + this.tier * 5;

    // Glow effect
    const gradient = ctx.createRadialGradient(0, 0, 10, 0, 0, glowSize);
    gradient.addColorStop(0, glowColor + '60');
    gradient.addColorStop(1, glowColor + '00');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(0, 0, glowSize, 0, Math.PI * 2);
    ctx.fill();

    // Main ship body (triangular fighter)
    ctx.fillStyle = Config.ship.shipBody;
    ctx.beginPath();
    ctx.moveTo(0, -Config.ship.height / 2); // Nose
    ctx.lineTo(Config.ship.width / 2, Config.ship.height / 2); // Right wing
    ctx.lineTo(0, Config.ship.height / 3); // Center indent
    ctx.lineTo(-Config.ship.width / 2, Config.ship.height / 2); // Left wing
    ctx.closePath();
    ctx.fill();

    // Cockpit
    ctx.fillStyle = '#1a2634';
    ctx.beginPath();
    ctx.ellipse(0, -5, 6, 12, 0, 0, Math.PI * 2);
    ctx.fill();

    // Engine glow at rear
    ctx.fillStyle = glowColor;
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.moveTo(-Config.ship.width / 3, Config.ship.height / 3);
    ctx.lineTo(Config.ship.width / 3, Config.ship.height / 3);
    ctx.lineTo(0, Config.ship.height / 2 + Math.random() * 10 + 5);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;

    // Wing details based on tier
    if (this.tier >= 2) {
      ctx.strokeStyle = glowColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-Config.ship.width / 2, 0);
      ctx.lineTo(0, Config.ship.height / 4);
      ctx.lineTo(Config.ship.width / 2, 0);
      ctx.stroke();
    }

    if (this.tier >= 3) {
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.arc(0, -Config.ship.height / 4, 4 + this.tier, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();

    // Draw engine trails
    this.engineTrails.forEach((trail) => {
      const progress = trail.age / trail.lifetime;
      const size = (3 + Math.random() * 2) * (1 - progress);
      ctx.fillStyle =
        Config.ship.engineTrailColor +
        Math.floor((1 - progress) * 255)
          .toString(16)
          .padStart(2, '0');
      ctx.beginPath();
      ctx.arc(trail.x, trail.y, size, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  getTierGlowColor() {
    switch (this.tier) {
      case 1:
        return Config.colors.shipGlowTier1;
      case 2:
        return Config.colors.shipGlowTier2;
      case 3:
        return Config.colors.shipGlowTier3;
      case 4:
        return Config.colors.shipGlowTier4;
      default:
        return Config.colors.shipGlowTier1;
    }
  }

  shoot() {
    const now = Date.now();
    if (now - this.lastShotTime < this.fireRate) return;

    const bulletConfig = Config.bullets[`tier${this.tier}`];
    const bulletSpeed = bulletConfig.speed;
    const spread = bulletConfig.spread;
    const count = bulletConfig.count;

    for (let i = 0; i < count; i++) {
      const offsetX = (i - (count - 1) / 2) * 15;
      const angle = (i - (count - 1) / 2) * spread;

      this.game.bullets.push({
        x: this.x + offsetX,
        y: this.y - Config.ship.height / 2,
        vx: Math.sin(angle) * bulletSpeed * 0.3,
        vy: -bulletSpeed,
        damage: bulletConfig.damage,
        color: Config.colors[`bulletTier${this.tier}`],
        radius: 4 + this.tier,
        tier: this.tier,
      });
    }

    this.lastShotTime = now;
    AudioSys.playLaser();
  }

  takeDamage(amount) {
    this.health = Math.max(0, this.health - amount);
    return this.health;
  }

  heal(amount) {
    this.health = Math.min(this.maxHealth, this.health + amount);
  }

  getHealthPercent() {
    return this.health / this.maxHealth;
  }

  addLevel() {
    this.level++;
    const newTier = this.getTierForLevel();
    if (newTier > this.tier) {
      this.tier = newTier;
      this.fireRate = Math.max(80, this.fireRate - 20);
    }
  }

  getTierForLevel() {
    for (let i = Config.tierLevels.length - 1; i >= 0; i--) {
      if (this.level >= Config.tierLevels[i]) {
        return i + 1;
      }
    }
    return 1;
  }

  hasWeapons() {
    return this.weaponsUnlocked;
  }
}

if (typeof window !== 'undefined') {
  window.Player = Player;
}
