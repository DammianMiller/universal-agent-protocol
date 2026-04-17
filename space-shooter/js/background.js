/**
 * background.js - 4-layer parallax scrolling background
 * Stars, nebula clouds, planets, and comets all scrolling downward for vertical shooter
 */

class Background {
    constructor() {
        this.stars = [];
        this.nebulaClouds = [];
        this.planets = [];
        this.comets = [];
        this.mouseX = window.innerWidth / 2;
        this.mouseY = window.innerHeight / 2;
        this.scrollSpeed = 0.25;

        this.init();
        this.setupEventListeners();
    }

    init() {
        // Initialize stars (layer 1 - furthest)
        for (let i = 0; i < 150; i++) {
            this.stars.push({
                x: Math.random() * window.innerWidth,
                y: Math.random() * window.innerHeight,
                size: Math.random() * 1.5 + 0.5,
                speed: Math.random() * 0.3 + 0.1,
                brightness: Math.random()
            });
        }

        // Initialize nebula clouds (layer 2)
        for (let i = 0; i < 8; i++) {
            this.nebulaClouds.push({
                x: Math.random() * window.innerWidth,
                y: -100 - Math.random() * 200,
                radius: Math.random() * 80 + 60,
                color: this.getRandomNebulaColor(),
                speed: Math.random() * 0.3 + 0.1
            });
        }

        // Initialize planets (layer 3)
        for (let i = 0; i < 12; i++) {
            this.planets.push({
                x: Math.random() * window.innerWidth,
                y: -150 - Math.random() * 300,
                radius: Math.random() < 0.5 ? Math.random() * 20 + 20 : Math.random() * 40 + 60,
                isNear: Math.random() > 0.5,
                color: this.getRandomPlanetColor(),
                speed: Math.random() * 0.5 + 0.1
            });
        }

        // Initialize comets (layer 4 - closest)
        for (let i = 0; i < 3; i++) {
            this.comets.push({
                x: Math.random() * window.innerWidth,
                y: -50 - Math.random() * 100,
                vx: Math.random() * 2 + 1,
                vy: Math.random() * 3 + 2,
                length: Math.random() * 50 + 30
            });
        }
    }

    getRandomNebulaColor() {
        const colors = [
            'rgba(78, 205, 196, ',
            'rgba(149, 225, 211, ',
            'rgba(255, 230, 109, ',
            'rgba(255, 100, 150, '
        ];
        return colors[Math.floor(Math.random() * colors.length)];
    }

    getRandomPlanetColor() {
        const colors = [
            'rgba(78, 205, 196, ',
            'rgba(155, 89, 182, ',
            'rgba(100, 149, 237, '
        ];
        return colors[Math.floor(Math.random() * colors.length)];
    }

    setupEventListeners() {
        window.addEventListener('mousemove', (e) => {
            this.mouseX = e.clientX;
            this.mouseY = e.clientY;
        });

        window.addEventListener('resize', () => {
            this.init();
        });
    }

    update(dt) {
        // Update stars with parallax effect based on mouse position
        this.stars.forEach(star => {
            const parallaxX = (this.mouseX - window.innerWidth / 2) * 0.01;
            const parallaxY = (this.mouseY - window.innerHeight / 2) * 0.01;
            star.x += (parallaxX + star.speed * this.scrollSpeed) * dt * 60;
            star.y += (star.speed + this.scrollSpeed * 0.5) * dt * 60;

            if (star.y > window.innerHeight) {
                star.y = 0;
                star.x = Math.random() * window.innerWidth;
            }
        });

        // Update nebula clouds
        this.nebulaClouds.forEach(cloud => {
            cloud.y += (cloud.speed + this.scrollSpeed * 0.3) * dt * 60;
            if (cloud.y > window.innerHeight + 200) {
                cloud.y = -200;
                cloud.x = Math.random() * window.innerWidth;
            }
        });

        // Update planets with depth variation
        this.planets.forEach(planet => {
            const depthFactor = planet.isNear ? 1 : 0.4;
            planet.y += (planet.speed + this.scrollSpeed * depthFactor) * dt * 60;
            if (planet.y > window.innerHeight + 100) {
                planet.y = -150;
                planet.x = Math.random() * window.innerWidth;
                planet.radius = Math.random() < 0.5 ? Math.random() * 20 + 20 : Math.random() * 40 + 60;
                planet.isNear = planet.radius > 50;
            }
        });

        // Update comets
        this.comets.forEach(comet => {
            comet.x += comet.vx * dt * 60;
            comet.y += comet.vy * dt * 60;

            if (comet.y > window.innerHeight || comet.x > window.innerWidth) {
                comet.x = Math.random() * window.innerWidth * 0.4;
                comet.y = -50;
                comet.vx = Math.random() * 2 + 1;
                comet.vy = Math.random() * 3 + 2;
            }
        });
    }

    draw(ctx) {
        // Draw stars (layer 1)
        this.stars.forEach(star => {
            ctx.fillStyle = `rgba(255, 255, 255, ${star.brightness})`;
            ctx.fillRect(star.x, star.y, star.size, star.size);
        });

        // Draw nebula clouds (layer 2)
        this.nebulaClouds.forEach(cloud => {
            const gradient = ctx.createRadialGradient(
                cloud.x, cloud.y, 0,
                cloud.x, cloud.y, cloud.radius
            );
            gradient.addColorStop(0, cloud.color + '0.15)');
            gradient.addColorStop(1, cloud.color + '0)');
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(cloud.x, cloud.y, cloud.radius, 0, Math.PI * 2);
            ctx.fill();
        });

        // Draw planets (layer 3)
        this.planets.forEach(planet => {
            const opacity = planet.isNear ? 1 : 0.4;
            ctx.fillStyle = planet.color + opacity + ')';
            ctx.beginPath();
            ctx.arc(planet.x, planet.y, planet.radius, 0, Math.PI * 2);
            ctx.fill();
        });

        // Draw comets (layer 4)
        this.comets.forEach(comet => {
            const gradient = ctx.createLinearGradient(
                comet.x, comet.y,
                comet.x + comet.vx * comet.length,
                comet.y + comet.vy * comet.length
            );
            gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
            gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.moveTo(comet.x, comet.y);
            ctx.lineTo(comet.x + comet.vx * comet.length, comet.y + comet.vy * comet.length);
            ctx.lineTo(comet.x + comet.vx * comet.length - 5, comet.y + comet.vy * comet.length + 3);
            ctx.closePath();
            ctx.fill();
        });
    }

    setScrollSpeed(speed) {
        this.scrollSpeed = speed;
    }
}

if (typeof window !== 'undefined') {
    window.Background = Background;
}