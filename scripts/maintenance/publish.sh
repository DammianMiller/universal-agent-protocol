#!/bin/bash
set -e

echo "🚀 Publishing universal-agent-protocol to npm..."

# Check if NPM_TOKEN is set
if [ -z "$NPM_TOKEN" ]; then
  echo "❌ Error: NPM_TOKEN environment variable is not set"
  echo "   Please set it before running this script"
  exit 1
fi

# Build the project
echo "📦 Building project..."
npm run build

# Run tests
echo "🧪 Running tests..."
npm test

# Run lint
echo "🔍 Running lint..."
npm run lint

# Publish to npm
echo "📤 Publishing to npm..."
npm publish --access public

echo "✅ Published successfully!"
