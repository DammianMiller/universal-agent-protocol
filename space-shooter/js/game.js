/**
 * game.js - Main game loop, state machine, collision detection, and game logic
 * Manages menu/playing/paused/gameover states, screen shake, damage numbers
 */

class Game {
  constructor() {
    this.canvas = document.getElementById('gameCanvas');
    this.ctx = this.canvas.getContext('2d');

    // Set canvas dimensions
    this.resize();
    window.addEventListener('resize', () => this.resize());

    // Disable image smoothing for pixel art
    this.ctx.imageSmoothingEnabled = false;

    // Game state
    this.state = 'menu'; // menu, playing, paused, gameover
    this.lastTime = 0;
    this.deltaTime = 0;

    // Initialize systems
    this.config = window.Config;
    this.audio = window.AudioSys;
    this.particles = new ParticleSystem();
    this.background = new Background();
    this.player = new Player(this);
    this.enemies = new EnemyManager(this);
    this.ui = new UIManager(this);

    // Screen shake
    this.screenShake = 0;
    this.shakeIntensity = 0;

    // Power-up collection
    this.powerups = [];

    // Setup input
    this.setupInput();

    // Start game loop
    this.lastFrameTime = performance.now();
    requestAnimationFrame((ts) => this.loop(ts));
  }

  resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  setupInput() {
    // Keyboard controls
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.togglePause();
      }
    });

    // Mouse click to start game or shoot
    document.addEventListener('mousedown', (e) => {
      if (this.state === 'menu' || this.state === 'gameover') {
        this.start();
      } else if (this.state === 'playing') {
        this.player.shoot();
      }
    });

    // Touch support
    document.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const touch = e.touches[0];
      this.player.targetX = touch.clientX;
      this.player.targetY = touch.clientY - 50;
      if (this.state === 'playing') {
        this.player.shoot();
      }
    });

    document.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const touch = e.touches[0];
      this.player.targetX = touch.clientX;
      this.player.targetY = touch.clientY - 50;
    });
  }

  start() {
    this.audio.init();
    this.audio.resume();
    this.audio.startAmbient();

    this.reset();
    this.state = 'playing';
    document.body.classList.remove('menu-active', 'gameover-active');
    document.body.classList.add('game-active');
  }

  reset() {
    this.player.reset();
    this.enemies = new EnemyManager(this);
    this.ui.score = 0;
    this.ui.combo = 0;
    this.ui.comboMultiplier = 1;
    this.powerups = [];
    this.particles = new ParticleSystem();
    this.enemies.startWave();
  }

  togglePause() {
    if (this.state === 'playing') {
      this.state = 'paused';
    } else if (this.state === 'paused') {
      this.state = 'playing';
      this.lastTime = performance.now();
    }
  }

  gameOver() {
    this.state = 'gameover';
    this.audio.stopAmbient();
    document.body.classList.remove('menu-active', 'game-active');
    document.body.classList.add('gameover-active');
  }

  loop(timestamp) {
    const dt = (timestamp - this.lastFrameTime) / 1000;
    this.lastFrameTime = timestamp;

    // Cap delta time to prevent huge jumps
    const cappedDt = Math.min(dt, 0.05);

    if (this.state === 'playing') {
      this.update(cappedDt);
    }

    this.draw();
    requestAnimationFrame((ts) => this.loop(ts));
  }

  update(dt) {
    // Update systems
    this.background.update(dt);
    this.player.update(dt, dt);
    this.enemies.update(dt);
    this.particles.update(dt);
    this.ui.update(dt, Date.now());

    // Player shooting
    if (this.player.hasWeapons()) {
      this.player.shoot();
    }

    // Collision detection
    this.checkCollisions();

    // Screen shake decay
    if (this.screenShake > 0) {
      this.screenShake *= Config.screenShake.decay;
      if (this.screenShake < 0.5) {
        this.screenShake = 0;
      }
    }

    // Check for wave completion
    if (
      this.enemies.enemiesToSpawn === 0 &&
      this.enemies.getEnemies().length === 0 &&
      !this.enemies.isBossActive()
    ) {
      this.nextWave();
    }
  }

  checkCollisions() {
    const player = this.player;
    const enemies = this.enemies.getEnemies();
    const bullets = this.enemies.getBullets();
    const gameBullets = this.player.bullets || [];

    // Player bullets vs enemies
    for (let i = gameBullets.length - 1; i >= 0; i--) {
      const bullet = gameBullets[i];
      let bulletHit = false;

      for (let j = enemies.length - 1; j >= 0; j--) {
        const enemy = enemies[j];

        // Circle collision: dx*dx + dy*dy < (r1+r2)*(r1+r2)
        const dx = bullet.x - enemy.x;
        const dy = bullet.y - enemy.y;
        const distanceSq = dx * dx + dy * dy;
        const radiusSum = bullet.radius + enemy.radius;

        if (distanceSq < radiusSum * radiusSum) {
          // Hit!
          const dead = enemy.takeDamage(bullet.damage);

          // Visual feedback
          this.spawnHitEffects(enemy.x, enemy.y, enemy.color, bullet.damage);

          // Remove bullet
          bulletHit = true;

          if (dead) {
            this.handleEnemyDeath(enemy, j);
          }
          break;
        }
      }

      if (bulletHit) {
        gameBullets.splice(i, 1);
      }
    }

    // Enemy bullets vs player
    for (let i = bullets.length - 1; i >= 0; i--) {
      const bullet = bullets[i];
      const dx = bullet.x - player.x;
      const dy = bullet.y - player.y;
      const distanceSq = dx * dx + dy * dy;
      const radiusSum = bullet.radius + player.radius;

      if (distanceSq < radiusSum * radiusSum) {
        // Player hit!
        const damage = 10;
        player.takeDamage(damage);

        this.spawnHitEffects(player.x, player.y, '#E74C3C', damage);
        this.applyScreenShake(Config.screenShake.contactShake);

        if (player.health <= 0) {
          this.gameOver();
        }
        bullets.splice(i, 1);
      }
    }

    // Player vs enemies (contact damage)
    for (let enemy of enemies) {
      const dx = player.x - enemy.x;
      const dy = player.y - enemy.y;
      const distanceSq = dx * dx + dy * dy;
      const radiusSum = player.radius + enemy.radius;

      if (distanceSq < radiusSum * radiusSum) {
        player.takeDamage(Config.screenShake.contactDamage);
        this.applyScreenShake(Config.screenShake.contactShake);

        if (player.health <= 0) {
          this.gameOver();
        }
      }
    }
  }

  spawnHitEffects(x, y, color, damage) {
    // Flash white
    AudioSys.playHit();

    // Sparks
    this.particles.spawnSparks(x, y, '#FFFFFF');

    // Damage number
    this.particles.spawnDamageNumber(x, y, damage);
  }

  handleEnemyDeath(enemy, index) {
    const enemies = this.enemies.getEnemies();
    const e = enemies[index];

    // Explosion effects
    this.particles.spawnExplosion(e.x, e.y, e.color);
    this.particles.spawnInkSplatter(e.x, e.y, e.color);
    this.applyScreenShake(10);
    this.audio.playExplosion(e.type);

    // Score
    this.ui.addScore(e.score);

    // Power-up drop
    if ((e.type === 'medium' || e.type === 'boss') && Math.random() < Config.powerup.dropChance) {
      this.spawnPowerup(e.x, e.y);
    }

    // Spawn babies from medium enemies
    if (e.type === 'medium') {
      this.enemies.spawnBabyEnemies(e.x, e.y, e.color);
    }

    // Level up player
    this.player.addLevel();

    // Remove enemy
    enemies.splice(index, 1);
  }

  spawnPowerup(x, y) {
    this.powerups.push({
      x: x,
      y: y,
      radius: Config.powerup.radius,
      life: 600, // frames
    });
    AudioSys.playPowerup();
  }

  nextWave() {
    this.enemies.incrementWave();
    this.player.addLevel();
    this.enemies.startWave();

    // Spawn comet for visual flair
    this.particles.spawnComet();
  }

  applyScreenShake(intensity) {
    this.screenShake = Math.min(Config.screenShake.maxIntensity, this.screenShake + intensity);
  }

  draw() {
    // Clear canvas
    this.ctx.fillStyle = Config.colors.background;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Apply screen shake
    this.ctx.save();
    if (this.screenShake > 0) {
      const dx = (Math.random() - 0.5) * this.screenShake;
      const dy = (Math.random() - 0.5) * this.screenShake;
      this.ctx.translate(dx, dy);
    }

    // Draw background
    this.background.draw(this.ctx);

    if (this.state === 'playing' || this.state === 'paused') {
      // Draw power-ups
      this.drawPowerups();

      // Draw enemies
      this.enemies.draw(this.ctx);

      // Draw player bullets
      this.drawPlayerBullets();

      // Draw player
      this.player.draw(this.ctx);

      // Draw particles (MUST call particles.draw(ctx))
      this.particles.draw(this.ctx);
    }

    this.ctx.restore();

    // Draw UI
    this.ui.draw(this.ctx);
  }

  drawPlayerBullets() {
    const bullets = this.player.bullets || [];
    bullets.forEach((bullet) => {
      this.ctx.fillStyle = bullet.color;
      this.ctx.globalAlpha = 0.8;

      // Bullet trail
      this.particles.spawnBulletTrail(bullet.x, bullet.y, bullet.color);

      // Bullet body
      this.ctx.beginPath();
      this.ctx.arc(bullet.x, bullet.y, bullet.radius, 0, Math.PI * 2);
      this.ctx.fill();

      // Glow
      const gradient = this.ctx.createRadialGradient(
        bullet.x,
        bullet.y,
        0,
        bullet.x,
        bullet.y,
        bullet.radius * 2
      );
      gradient.addColorStop(0, bullet.color + '80');
      gradient.addColorStop(1, bullet.color + '00');
      this.ctx.fillStyle = gradient;
      this.ctx.beginPath();
      this.ctx.arc(bullet.x, bullet.y, bullet.radius * 2, 0, Math.PI * 2);
      this.ctx.fill();

      this.ctx.globalAlpha = 1;
    });
  }

  get bullets() {
    return this.player.bullets || [];
  }

  drawPowerups() {
    this.powerups = this.powerups.filter((p) => {
      p.life--;

      // Draw power-up orb
      this.ctx.save();
      this.ctx.translate(p.x, p.y);

      const pulse = Math.sin(Date.now() * 0.005) * 3;

      // Glow
      const gradient = this.ctx.createRadialGradient(0, 0, 0, 0, 0, p.radius + pulse + 10);
      gradient.addColorStop(0, '#FFFFFF');
      gradient.addColorStop(0.5, '#4ECDC4');
      gradient.addColorStop(1, '#4ECDC400');
      this.ctx.fillStyle = gradient;
      this.ctx.beginPath();
      this.ctx.arc(0, 0, p.radius + pulse + 10, 0, Math.PI * 2);
      this.ctx.fill();

      // Core
      this.ctx.fillStyle = '#4ECDC4';
      this.ctx.beginPath();
      this.ctx.arc(0, 0, p.radius + pulse, 0, Math.PI * 2);
      this.ctx.fill();

      // Sparkles
      if (Math.random() > 0.5) {
        this.particles.spawnPowerupSparkle(p.x, p.y);
      }

      this.ctx.restore();

      return p.life > 0;
    });

    // Check power-up collection
    const player = this.player;
    for (let i = this.powerups.length - 1; i >= 0; i--) {
      const p = this.powerups[i];
      const dx = player.x - p.x;
      const dy = player.y - p.y;
      const distanceSq = dx * dx + dy * dy;

      if (distanceSq < (player.radius + p.radius) * (player.radius + p.radius)) {
        // Collect!
        this.ui.startUnleash();
        this.powerups.splice(i, 1);
      }
    }
  }
}

// Initialize game when DOM is ready
if (typeof window !== 'undefined') {
  window.Game = Game;

  // Add menu click handler
  document.addEventListener('DOMContentLoaded', () => {
    const game = new Game();

    // Start button click
    document.addEventListener('click', (e) => {
      if (game.state === 'menu') {
        game.start();
      }
    });
  });
}
