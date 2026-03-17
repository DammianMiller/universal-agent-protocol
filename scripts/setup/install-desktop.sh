#!/usr/bin/env bash
set -euo pipefail

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

REPO_URL="https://github.com/DammianMiller/universal-agent-protocol"

echo -e "${GREEN}Universal Agent Memory - Desktop Installation${NC}"
echo "============================================"
echo ""

# Check for Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js is not installed${NC}"
    echo "Please install Node.js 18+ from https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo -e "${RED}Error: Node.js 18+ required (you have $(node -v))${NC}"
    exit 1
fi

echo -e "${GREEN}✓${NC} Node.js $(node -v) detected"

# Check for npm
if ! command -v npm &> /dev/null; then
    echo -e "${RED}Error: npm is not installed${NC}"
    exit 1
fi

echo -e "${GREEN}✓${NC} npm $(npm -v) detected"

# Check for Docker (optional)
if command -v docker &> /dev/null; then
    echo -e "${GREEN}✓${NC} Docker detected - local Qdrant available"
    DOCKER_AVAILABLE=true
else
    echo -e "${YELLOW}⚠${NC} Docker not found - will use cloud backends only"
    DOCKER_AVAILABLE=false
fi

# Install the CLI globally
echo ""
echo "Installing universal-agent-protocol..."

# Try npm install first, fall back to git clone if package not published yet
if npm install -g universal-agent-protocol 2>/dev/null; then
    echo -e "${GREEN}✓${NC} Installed from npm registry"
else
    echo -e "${YELLOW}Package not yet on npm, installing from GitHub...${NC}"
    
    # Install to user's local directory
    INSTALL_DIR="${HOME}/.universal-agent-protocol"
    
    # Remove old installation if exists
    if [ -d "$INSTALL_DIR" ]; then
        echo "Removing previous installation..."
        rm -rf "$INSTALL_DIR"
    fi
    
    # Clone and install
    git clone --depth 1 "$REPO_URL.git" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
    npm install --production=false
    npm run build
    npm link
    
    echo -e "${GREEN}✓${NC} Installed from GitHub to $INSTALL_DIR"
fi

echo ""
echo -e "${GREEN}Installation complete!${NC}"
echo ""
echo "Next steps:"
echo "  1. Initialize UAP in your project:"
echo "     $ cd /path/to/your/project"
echo "     $ uap init"
echo ""
echo "  2. Review the generated CLAUDE.md"
echo ""
echo "  3. Start working - your AI assistant will follow the workflows!"
echo ""

if [ "$DOCKER_AVAILABLE" = true ]; then
    echo "  2. Start local memory services (optional):"
    echo "     $ uap memory start"
    echo ""
    echo "     Or use cloud backends:"
else
    echo "  2. Configure cloud memory backends:"
fi

echo "     - GitHub: export GITHUB_TOKEN=your_token"
echo "     - Qdrant Cloud: export QDRANT_API_KEY=your_key && export QDRANT_URL=your_url"
echo ""
echo "  3. Generate CLAUDE.md for your project:"
echo "     $ uap generate"
echo ""
echo "Documentation: ${REPO_URL}#readme"
