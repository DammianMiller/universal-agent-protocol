/**
 * ui.js - User interface rendering and management
 * HUD with score, level, combo, health bar
 * Start screen, game over screen, pause screen
 */

class UIManager {
  constructor(game) {
    this.game = game;
    this.score = 0;
    this.highScore = localStorage.getItem('spaceShooterHighScore') || 0;
    this.combo = 0;
    this.comboTimer = 0;
    this.comboMultiplier = 1;
    this.unleashMode = false;
    this.unleashEndTime = 0;
  }

  update(dt, gameTime) {
    // Update combo timer
    if (this.combo > 0) {
      this.comboTimer -= dt * 1000;
      if (this.comboTimer <= 0) {
        this.combo = 0;
        this.comboMultiplier = 1;
      }
    }

    // Update unleash mode
    if (this.unleashMode && gameTime > this.unleashEndTime) {
      this.endUnleash();
    }
  }

  addScore(amount) {
    const multiplier = this.unleashMode ? Config.powerup.scoreMultiplier : this.comboMultiplier;
    const actualAmount = Math.floor(amount * multiplier);
    this.score += actualAmount;

    // Update combo
    this.combo++;
    this.comboTimer = Config.combo.maxTimeBetweenKills;
    this.comboMultiplier = Math.min(
      Config.combo.maxMultiplier,
      Config.combo.baseMultiplier + this.combo * Config.combo.multiplierPerKill
    );

    // Save high score
    if (this.score > this.highScore) {
      this.highScore = this.score;
      localStorage.setItem('spaceShooterHighScore', this.highScore);
    }
  }

  startUnleash() {
    this.unleashMode = true;
    this.unleashEndTime = Date.now() + Config.powerup.unleashDuration;
    AudioSys.playUnleashStart();
  }

  endUnleash() {
    this.unleashMode = false;
    AudioSys.playUnleashEnd();
  }

  draw(ctx) {
    if (this.game.state === 'menu') {
      this.drawStartScreen(ctx);
    } else if (this.game.state === 'playing') {
      this.drawHUD(ctx);
    } else if (this.game.state === 'gameover') {
      this.drawGameOverScreen(ctx);
    }

    if (this.game.state === 'paused') {
      this.drawPauseScreen(ctx);
    }
  }

  drawStartScreen(ctx) {
    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;

    // Pulsing title effect
    const pulse = Math.sin(Date.now() * 0.003) * 0.15 + 1;

    ctx.save();
    ctx.translate(centerX, centerY - 100);
    ctx.scale(pulse, pulse);

    // Title glow
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 200);
    gradient.addColorStop(0, '#4ECDC4');
    gradient.addColorStop(1, '#4ECDC400');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(0, 0, 200, 0, Math.PI * 2);
    ctx.fill();

    // Title text
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 72px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = '#4ECDC4';
    ctx.shadowBlur = 30;
    ctx.fillText('OCTOPUS', 0, -30);
    ctx.fillText('INVADERS', 0, 40);
    ctx.shadowBlur = 0;

    // Subtitle
    ctx.fillStyle = '#888888';
    ctx.font = '24px "Courier New", monospace';
    ctx.fillText('A Space Shooter Adventure', centerX, centerY + 100);

    ctx.restore();

    // Octopus previews
    this.drawOctopusPreview(ctx, centerX - 200, centerY + 100, '#FF00FF', 0.5);
    this.drawOctopusPreview(ctx, centerX, centerY + 100, '#00BFFF', 0.7);
    this.drawOctopusPreview(ctx, centerX + 200, centerY + 100, '#9B59B6', 1);

    // Instructions
    ctx.fillStyle = '#AAAAAA';
    ctx.font = '20px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Move: Mouse', centerX, centerY + 200);
    ctx.fillText('Shoot: Click / Hold', centerX, centerY + 230);
    ctx.fillText('Pause: ESC', centerX, centerY + 260);

    // Start button (click anywhere to start)
    ctx.fillStyle = '#4ECDC4';
    ctx.shadowColor = '#4ECDC4';
    ctx.shadowBlur = 20;
    ctx.fillRect(centerX - 100, centerY + 300, 200, 50);
    ctx.shadowBlur = 0;

    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 24px "Courier New", monospace';
    ctx.fillText('CLICK TO START', centerX, centerY + 325);
  }

  drawOctopusPreview(ctx, x, y, color, scale) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);

    const s = 8;

    // Tentacles
    for (let t = 0; t < 4; t++) {
      const angle = (Math.PI * 2 * t) / 4 + Date.now() * 0.002;
      for (let i = 0; i < 3; i++) {
        const progress = i / 3;
        const tx = Math.sin(angle) * 20 * progress;
        const ty = Math.cos(angle) * 20 * progress;
        ctx.fillStyle = color;
        ctx.fillRect(tx - s / 2, ty - s / 2, s, s * 1.5);
      }
    }

    // Head
    ctx.fillStyle = color;
    ctx.fillRect(-30, -30, 60, 60);

    // Eyes
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(-20, -10, 15, 15);
    ctx.fillRect(5, -10, 15, 15);

    ctx.restore();
  }

  drawHUD(ctx) {
    const player = this.game.player;
    const enemies = this.game.enemies;

    // Score (top left)
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 20px "Courier New", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const scoreText = `SCORE: ${this.score.toLocaleString()}`;
    ctx.fillText(scoreText, 20, 40);

    // Level (top center)
    const levelText = `LEVEL: ${enemies.getWave()}`;
    ctx.textAlign = 'center';
    ctx.fillText(levelText, window.innerWidth / 2, 40);

    // Combo (top right)
    if (this.combo > 1) {
      const comboText = `${this.combo}x COMBO!`;
      ctx.fillStyle = '#FFE66D';
      ctx.textAlign = 'right';
      ctx.fillText(comboText, window.innerWidth - 20, 40);
    }

    // Unleash mode indicator
    if (this.unleashMode) {
      const timeLeft = Math.max(0, Math.ceil((this.unleashEndTime - Date.now()) / 1000));
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 24px "Courier New", monospace';
      ctx.textAlign = 'center';
      ctx.shadowColor = '#FFFFFF';
      ctx.shadowBlur = 20;
      ctx.fillText(`UNLEASH MODE! ${timeLeft}s`, window.innerWidth / 2, 80);
      ctx.shadowBlur = 0;
    }

    // Health bar (bottom center)
    const healthBarWidth = 300;
    const healthBarHeight = 20;
    const healthX = window.innerWidth / 2 - healthBarWidth / 2;
    const healthY = window.innerHeight - 50;

    // Background
    ctx.fillStyle = Config.colors.healthBarBg;
    ctx.strokeStyle = Config.colors.healthBarBorder;
    ctx.lineWidth = 2;
    ctx.fillRect(healthX, healthY, healthBarWidth, healthBarHeight);
    ctx.strokeRect(healthX, healthY, healthBarWidth, healthBarHeight);

    // Health fill
    const healthPercent = player.getHealthPercent();
    const healthColor =
      healthPercent > 0.5
        ? Config.colors.healthBarFill
        : healthPercent > 0.25
          ? '#FFE66D'
          : '#E74C3C';
    ctx.fillStyle = healthColor;
    ctx.fillRect(healthX, healthY, healthBarWidth * healthPercent, healthBarHeight);

    // Health text
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '16px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(
      `${Math.ceil(player.health)} / ${player.maxHealth}`,
      window.innerWidth / 2,
      healthY + healthBarHeight / 2
    );
  }

  drawGameOverScreen(ctx) {
    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;

    // Game over text
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 64px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = '#E74C3C';
    ctx.shadowBlur = 30;
    ctx.fillText('GAME OVER', centerX, centerY - 80);
    ctx.shadowBlur = 0;

    // Stats
    ctx.fillStyle = '#AAAAAA';
    ctx.font = '24px "Courier New", monospace';
    ctx.fillText(`Final Score: ${this.score.toLocaleString()}`, centerX, centerY);
    ctx.fillText(`High Score: ${this.highScore.toLocaleString()}`, centerX, centerY + 50);
    ctx.fillText(`Level Reached: ${this.game.enemies.getWave()}`, centerX, centerY + 100);

    // Restart button (click anywhere to restart)
    ctx.fillStyle = '#E74C3C';
    ctx.shadowColor = '#E74C3C';
    ctx.shadowBlur = 20;
    ctx.fillRect(centerX - 100, centerY + 180, 200, 50);
    ctx.shadowBlur = 0;

    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 24px "Courier New", monospace';
    ctx.fillText('CLICK TO RESTART', centerX, centerY + 205);
  }

  drawPauseScreen(ctx) {
    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;

    // Semi-transparent overlay
    ctx.fillStyle = 'rgba(13, 17, 23, 0.7)';
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);

    // Pause text
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 56px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('PAUSED', centerX, centerY - 50);

    // Instructions
    ctx.fillStyle = '#AAAAAA';
    ctx.font = '24px "Courier New", monospace';
    ctx.fillText('Press ESC to Resume', centerX, centerY + 50);
  }

  getScore() {
    return this.score;
  }

  getHighScore() {
    return this.highScore;
  }
}

if (typeof window !== 'undefined') {
  window.UIManager = UIManager;
}
