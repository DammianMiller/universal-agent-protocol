# Octopus Invaders

A neon cyberpunk space shooter built with vanilla JavaScript and HTML5 Canvas.

![Octopus Invaders Screenshot](./screenshot.png)

## How to Run

1. **Start a local server:**

   ```bash
   python3 -m http.server 3001
   ```

2. **Open in browser:**
   Navigate to `http://localhost:3001/space-shooter/`

## Controls

- **Move:** Mouse cursor
- **Shoot:** Click and hold (or touch)
- **Pause:** ESC key

## Features

### Enemy Types

- **Small Octopus** (neon pink) - 2 tentacles, sine wave movement
- **Medium Octopus** (electric blue) - 4 tentacles, shoots ink blobs, splits into babies
- **Baby Octopus** (cyan) - Tiny, fast, fragile
- **Boss Octopus** (glowing purple) - 8 tentacles, appears every 5 levels

### Visual Effects

- 4-layer parallax background (stars, nebula, planets, comets)
- Pixelated octopus enemies with grid-based rendering
- Explosions with green core + rainbow particles
- Ink splatter on enemy death
- Screen shake on impacts
- Hit flash feedback
- Floating damage numbers

### Power-ups

- **UNLEASH MODE** - 5 seconds of 3x score, chain explosions, chromatic aberration
- Drops from medium and boss enemies

### Ship Tiers

- Tier 1-4 with visual upgrades every 3 levels
- Increasing bullet speed and count
- Engine trail effects

### Audio

- Procedural Web Audio API sounds (no external files)
- Laser pews, explosions, powerup chimes
- Boss alarm, ambient hum, hit sounds

## Project Structure

```
space-shooter/
├── index.html          # Entry point with script imports
├── css/
│   └── styles.css      # Fullscreen canvas styling
└── js/
    ├── config.js       # Colors, speeds, tuning constants
    ├── audio.js        # Web Audio API procedural sounds
    ├── particles.js    # Explosion, trail, and effect system
    ├── background.js   # 4-layer parallax scrolling
    ├── enemies.js      # Octopus enemy types and spawning
    ├── player.js       # Ship control, weapons, upgrades
    ├── ui.js           # HUD, menus, score display
    └── game.js         # Main loop, collision, game state
```

## Technical Details

- **Canvas:** Fullscreen with `imageSmoothingEnabled = false`
- **Collision:** Circle-to-circle distance checks
- **Enemy Sizes:** small=36px, medium=48px, baby=20px, boss=150px
- **Bullet Speeds:** tier1=8, tier2=10, tier3=12, tier4=14
- **Ship Tracking:** Lerp factor 0.35 for smooth mouse follow
- **Background:** Vertical scrolling (downward movement)

## License

MIT License - Feel free to use and modify!
