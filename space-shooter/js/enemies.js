/**
 * enemies.js - Enemy spawning, rendering, and AI
 * Pixelated octopus enemy types with grid-based fillRect rendering (NOT smooth arcs)
 * Includes small, medium, baby, and boss variants with wave spawning logic
 */

class Enemy {
  constructor(x, y, type) {
    this.x = x;
    this.y = y;
    this.type = type;
    this.baseX = x;
    this.baseY = y;
    this.time = 0;
    this.hitFlashTimer = 0;
    this.markedForDeletion = false;

    const stats = Config.enemies[type];
    this.size = stats.size;
    this.health = stats.health;
    this.maxHealth = stats.health;
    this.score = stats.score;
    this.speed = stats.speed;
    this.color = stats.color;
    this.tentacles = stats.tentacles;
    this.radius = this.size / 2;
  }

  update(dt, gameTime) {
    this.time += dt;

    // Hit flash countdown
    if (this.hitFlashTimer > 0) {
      this.hitFlashTimer -= dt * 1000;
    }

    // Movement patterns based on type
    switch (this.type) {
      case 'small':
        this.updateSmall(dt);
        break;
      case 'medium':
        this.updateMedium(dt);
        break;
      case 'baby':
        this.updateBaby(dt);
        break;
      case 'boss':
        this.updateBoss(dt, gameTime);
        break;
    }

    // Clamp to screen
    this.y = Math.max(-this.size, Math.min(window.innerHeight + this.size, this.y));
  }

  updateSmall(dt) {
    // Sine wave movement
    this.x = this.baseX + Math.sin(this.time * 3) * 50;
    this.y += this.speed * dt * 60;
  }

  updateMedium(dt) {
    // Slightly slower with more pronounced sine wave
    this.x = this.baseX + Math.sin(this.time * 2) * 70;
    this.y += this.speed * dt * 60;
  }

  updateBaby(dt) {
    // Fast, erratic movement
    this.x = this.baseX + Math.sin(this.time * 8) * 30;
    this.y += this.speed * dt * 60;
  }

  updateBoss(dt, gameTime) {
    // Multi-phase boss logic
    const phase = Math.floor(gameTime / 10000) % 3; // Change phase every 10 seconds

    switch (phase) {
      case 0: // Spiral pattern
        this.x = this.baseX + Math.sin(this.time * 2) * 150;
        this.y += this.speed * dt * 60;
        break;
      case 1: // Side to side
        this.x = this.baseX + Math.sin(this.time * 1.5) * 200;
        this.y += this.speed * 0.5 * dt * 60;
        break;
      case 2: // Stationary with attacks
        this.x = this.baseX;
        this.y = this.baseY;
        break;
    }
  }

  draw(ctx) {
    ctx.save();
    ctx.translate(this.x, this.y);

    // Hit flash effect (white overlay for 3 frames)
    if (this.hitFlashTimer > 0) {
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = '#FFFFFF';
    } else {
      ctx.globalAlpha = 1;
      ctx.fillStyle = this.color;
    }

    // Draw pixelated octopus using grid-based fillRect (NOT arcs)
    this.drawOctopusPixelArt(ctx);

    // Boss health bar
    if (this.type === 'boss') {
      this.drawBossHealthBar(ctx);
    }

    ctx.restore();
  }

  drawOctopusPixelArt(ctx) {
    const s = this.size / 12; // Scale factor for pixel grid
    const cx = 0;
    const cy = -s * 2;

    // Tentacles (rectangular grid pattern)
    for (let t = 0; t < this.tentacles; t++) {
      const angle = (Math.PI * 2 * t) / this.tentacles + this.time * 0.5;
      const tentacleLen = this.size / 2;

      // Draw tentacle as series of rectangles
      for (let i = 0; i < 4; i++) {
        const progress = i / 4;
        const tx =
          cx + Math.sin(angle + Math.sin(this.time * 2 + t) * 0.5) * tentacleLen * progress;
        const ty =
          cy + Math.cos(angle + Math.sin(this.time * 2 + t) * 0.5) * tentacleLen * progress;

        ctx.fillStyle = this.color;
        ctx.fillRect(tx - s / 2, ty - s / 2, s, s * 1.5);
      }
    }

    // Head (grid of squares)
    const headSize = this.size / 2;
    const gridCount = 6;
    const step = headSize / gridCount;

    for (let row = 0; row < gridCount; row++) {
      for (let col = 0; col < gridCount; col++) {
        const px = cx - headSize / 2 + col * step + step / 2;
        const py = cy - headSize / 2 + row * step + step / 2;

        // Create pixel art pattern with varying opacity
        const alpha = 0.7 + Math.sin(this.time * 3 + row * col) * 0.3;
        ctx.fillStyle = this.color;
        ctx.globalAlpha = alpha;
        ctx.fillRect(px, py, step - 1, step - 1);
      }
    }

    // Eyes (white squares)
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(cx - s * 1.5, cy - s * 0.5, s * 1.2, s * 1.2);
    ctx.fillRect(cx + s * 0.3, cy - s * 0.5, s * 1.2, s * 1.2);

    // Pupils (black squares)
    ctx.fillStyle = '#000000';
    ctx.fillRect(cx - s * 1.2, cy - s * 0.2, s * 0.6, s * 0.6);
    ctx.fillRect(cx + s * 0.6, cy - s * 0.2, s * 0.6, s * 0.6);

    // Mouth (small rectangle)
    ctx.fillStyle = '#000000';
    ctx.fillRect(cx - s, cy + s * 1.5, s * 2, s * 0.5);

    ctx.globalAlpha = 1;
  }

  drawBossHealthBar(ctx) {
    const barWidth = this.size * 2;
    const barHeight = 8;
    const x = -barWidth / 2;
    const y = -this.size / 2 - 20;

    // Background
    ctx.fillStyle = '#333333';
    ctx.fillRect(x, y, barWidth, barHeight);

    // Health fill
    const healthPercent = this.health / this.maxHealth;
    const healthColor =
      healthPercent > 0.5 ? '#27AE60' : healthPercent > 0.25 ? '#FFE66D' : '#E74C3C';
    ctx.fillStyle = healthColor;
    ctx.fillRect(x, y, barWidth * healthPercent, barHeight);

    // Border
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, barWidth, barHeight);
  }

  takeDamage(amount) {
    this.health -= amount;
    this.hitFlashTimer = 100; // 100ms flash

    if (this.health <= 0) {
      this.markedForDeletion = true;
      return true; // Dead
    }
    return false; // Still alive
  }

  getCenter() {
    return {
      x: this.x,
      y: this.y,
    };
  }
}

class EnemyManager {
  constructor(game) {
    this.game = game;
    this.enemies = [];
    this.bullets = [];
    this.wave = 1;
    this.enemiesToSpawn = 0;
    this.spawnTimer = 0;
    this.spawnInterval = 1500;
    this.lastBossWave = 0;
    this.gameTime = 0;
  }

  startWave() {
    const waveConfig = Config.waves;
    const enemyCount =
      waveConfig.baseEnemiesPerWave + (this.wave - 1) * waveConfig.enemiesPerWaveIncrement;

    // Boss wave every N levels
    if (this.wave % Config.waves.bossEveryNLevels === 0) {
      this.spawnBoss();
    } else {
      this.enemiesToSpawn = enemyCount;
      this.spawnTimer = 0;
    }
  }

  spawnBoss() {
    const boss = new Enemy(window.innerWidth / 2, -150, 'boss');
    boss.baseX = window.innerWidth / 2;
    boss.baseY = -150;
    this.enemies.push(boss);
    AudioSys.playBossWarning();
  }

  update(dt) {
    this.gameTime += dt * 1000;

    // Spawn enemies
    if (this.enemiesToSpawn > 0) {
      this.spawnTimer += dt * 1000;
      if (this.spawnTimer >= this.spawnInterval) {
        this.spawnEnemy();
        this.spawnTimer = 0;
      }
    }

    // Update enemies
    this.enemies = this.enemies.filter((enemy) => {
      enemy.update(dt, this.gameTime);

      // Remove if off screen (except boss)
      if (enemy.y > window.innerHeight + enemy.size && enemy.type !== 'boss') {
        return false;
      }
      return !enemy.markedForDeletion;
    });

    // Update enemy bullets
    this.bullets = this.bullets.filter((bullet) => {
      bullet.y += bullet.vy * dt * 60;
      bullet.x += bullet.vx * dt * 60;
      return bullet.y < window.innerHeight + 50 && bullet.y > -50;
    });
  }

  spawnEnemy() {
    if (this.enemiesToSpawn <= 0) return;

    const types = ['small', 'medium'];
    const type = this.wave % 3 === 0 && Math.random() > 0.7 ? 'medium' : 'small';

    const enemy = new Enemy(Math.random() * (window.innerWidth - 100) + 50, -50, type);

    this.enemies.push(enemy);
    this.enemiesToSpawn--;
  }

  spawnBabyEnemies(x, y, color) {
    // Spawn 2 baby octopuses from medium enemy death
    for (let i = 0; i < 2; i++) {
      const baby = new Enemy(x + (i - 0.5) * 40, y, 'baby');
      baby.speed = Config.enemies.baby.speed;
      this.enemies.push(baby);
    }
  }

  draw(ctx) {
    this.enemies.forEach((enemy) => enemy.draw(ctx));

    // Draw enemy bullets (ink blobs)
    this.bullets.forEach((bullet) => {
      ctx.fillStyle = bullet.color;
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      ctx.arc(bullet.x, bullet.y, bullet.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    });
  }

  getEnemies() {
    return this.enemies;
  }

  getBullets() {
    return this.bullets;
  }

  addBullet(bullet) {
    this.bullets.push(bullet);
  }

  getWave() {
    return this.wave;
  }

  incrementWave() {
    this.wave++;
  }

  isBossActive() {
    return this.enemies.some((e) => e.type === 'boss');
  }
}

if (typeof window !== 'undefined') {
  window.Enemy = Enemy;
  window.EnemyManager = EnemyManager;
}
