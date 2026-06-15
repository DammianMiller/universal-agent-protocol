#!/usr/bin/env bash
# RTK (Rust Token Killer) Installation Script for UAP
# Auto-detects OS and installs RTK via appropriate method

set -euo pipefail

echo "🔧 Installing RTK (Rust Token Killer)..."
echo "   Reduces LLM token consumption by 60-90% on CLI commands"
echo ""

# Detect OS and architecture
detect_os() {
    if [[ "$(uname -s)" == "Darwin" ]]; then
        echo "macOS"
    elif [[ "$(uname -s)" == "Linux" ]]; then
        echo "Linux"
    elif [[ "$(uname -s)" =~ MINGW.* || "$(uname -s)" =~ MSYS* ]]; then
        echo "Windows"
    else
        echo "Unknown"
    fi
}

detect_arch() {
    local arch=$(uname -m)
    case $arch in
        x86_64) echo "x86_64" ;;
        arm64|aarch64) echo "arm64" ;;
        *) echo "$arch" ;;
    esac
}

OS=$(detect_os)
ARCH=$(detect_arch)

echo "Detected: $OS ($ARCH)"
echo ""

# Check if Homebrew is available (macOS/Linux)
check_brew() {
    command -v brew &> /dev/null && echo "yes" || echo "no"
}

# Check if cargo is installed
check_cargo() {
    command -v cargo &> /dev/null && echo "yes" || echo "no"
}

# Check if RTK is already installed
check_rtk_installed() {
    command -v rtk &> /dev/null && echo "yes" || echo "no"
}

RTK_INSTALLED=$(check_rtk_installed)

if [[ "$RTK_INSTALLED" == "yes" ]]; then
    CURRENT_VERSION=$(rtk --version 2>&1 | head -1)
    echo "ℹ RTK is already installed: $CURRENT_VERSION"
    echo ""
    read -p "Do you want to upgrade to the latest version? [y/N] " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Skipping installation."
        exit 0
    fi
fi

# Installation methods (in order of preference)
install_methods=(
    "homebrew"
    "cargo"
    "curl_install"
)

INSTALL_SUCCESS=false

for method in "${install_methods[@]}"; do
    echo "📦 Trying installation method: $method"
    
    case $method in
        homebrew)
            if [[ "$OS" == "macOS" ]] || (check_brew == "yes"); then
                echo "   Installing via Homebrew..."
                if brew install rtk &> /dev/null; then
                    INSTALL_SUCCESS=true
                    break
                fi
            fi
            ;;
            
        cargo)
            if check_cargo == "yes"; then
                echo "   Installing via Cargo..."
                if cargo install --git https://github.com/rtk-ai/rtk --quiet 2>&1; then
                    INSTALL_SUCCESS=true
                    break
                fi
            fi
            ;;
            
        curl_install)
            if [[ "$OS" == "macOS" ]] || [[ "$OS" == "Linux" ]]; then
                echo "   Installing via curl..."
                TEMP_DIR=$(mktemp -d)
                cd "$TEMP_DIR"
                
                # Download appropriate binary based on OS/arch
                if [[ "$ARCH" == "arm64" ]]; then
                    BINARY="rtk-aarch64-apple-darwin.tar.gz"
                else
                    BINARY="rtk-x86_64-apple-darwin.tar.gz"
                fi
                
                if [[ "$OS" == "Linux" ]]; then
                    if [[ "$ARCH" == "arm64" ]]; then
                        BINARY="rtk-aarch64-unknown-linux-gnu.tar.gz"
                    else
                        BINARY="rtk-x86_64-unknown-linux-musl.tar.gz"
                    fi
                fi
                
                echo "   Downloading: $BINARY"
                
                if curl -fsSL "https://github.com/rtk-ai/rtk/releases/latest/download/$BINARY" -o rtk.tar.gz 2>&1; then
                    tar -xzf rtk.tar.gz
                    chmod +x rtk
                    
                    # Move to local bin or PATH
                    if [[ -d "$HOME/.local/bin" ]] || echo "$PATH" | grep -q "$HOME/.local/bin"; then
                        mkdir -p "$HOME/.local/bin"
                        mv rtk "$HOME/.local/bin/"
                        echo "   Installed to: $HOME/.local/bin/rtk"
                    else
                        sudo mkdir -p /usr/local/bin
                        sudo mv rtk /usr/local/bin/
                        echo "   Installed to: /usr/local/bin/rtk"
                    fi
                    
                    INSTALL_SUCCESS=true
                    cd ..
                    rm -rf "$TEMP_DIR"
                    break
                fi
            fi
            ;;
    esac
    
    echo "   ✗ Failed: $method"
done

# Verify installation
if [[ "$INSTALL_SUCCESS" == "true" ]]; then
    if command -v rtk &> /dev/null; then
        VERSION=$(rtk --version 2>&1 | head -1)
        echo ""
        echo "✅ RTK installed successfully!"
        echo "   Version: $VERSION"
        echo ""
        echo "📚 Next steps:"
        echo "   1. Initialize hook for Claude Code:"
        echo "      rtk init --global"
        echo ""
        echo "   2. Verify installation:"
        echo "      rtk gain"
        echo ""
        echo "   3. View token savings:"
        echo "      rtk gain --graph"
        echo ""
    else
        echo "❌ Installation completed but RTK binary not found in PATH"
        echo "   Please ensure $HOME/.local/bin is in your PATH:"
        echo '   echo '\''export PATH="$HOME/.local/bin:$PATH"'\'' >> ~/.bashrc'
        exit 1
    fi
else
    echo ""
    echo "❌ All installation methods failed"
    echo ""
    echo "Manual installation options:"
    echo "  1. Homebrew (macOS/Linux): brew install rtk"
    echo "  2. Cargo: cargo install --git https://github.com/rtk-ai/rtk"
    echo "  3. Pre-built binaries: https://github.com/rtk-ai/rtk/releases"
    exit 1
fi