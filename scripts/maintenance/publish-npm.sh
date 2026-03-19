#!/bin/bash
# Quick NPM Publish Script - Triggers GitHub Actions Workflow

set -e

VERSION=$(node -p 'require("./package.json").version' 2>/dev/null || echo "unknown")
echo "=========================================="
echo "  Universal Agent Protocol v${VERSION}"
echo "  Publishing to NPM..."
echo "=========================================="
echo ""

REPO="DammianMiller/universal-agent-protocol"
WORKFLOW_ID="deploy-publish.yml"

# Check if gh CLI is installed
if ! command -v gh &> /dev/null; then
    echo "❌ GitHub CLI (gh) not found!"
    echo ""
    echo "Install it first:"
    echo "  macOS: brew install gh"
    echo "  Linux: https://cli.github.com/"
    echo "  Windows: winget install github.cli"
    echo ""
    echo "Then run this script again."
    exit 1
fi

# Check if logged in to GitHub
if ! gh auth status &> /dev/null; then
    echo "❌ Not logged in to GitHub!"
    echo ""
    echo "Login first:"
    echo "  gh auth login"
    echo ""
    echo "Use -H flag for HTTP host if needed."
    exit 1
fi

echo "✅ GitHub CLI authenticated"
echo ""

# Get workflow ID
echo "🔄 Fetching workflow information..."
WORKFLOW_ID=$(gh api "/repos/$REPO/actions/workflows" \
  --jq '.workflows[] | select(.name == "Build, Publish & Deploy") | .id')

if [ -z "$WORKFLOW_ID" ]; then
    echo "❌ Could not find workflow: $WORKFLOW_ID"
    exit 1
fi

echo "✅ Found workflow ID: $WORKFLOW_ID"
echo ""

# Trigger the workflow
echo "🚀 Triggering publish workflow..."
RESPONSE=$(gh api \
  --method POST \
  "/repos/$REPO/actions/workflows/${WORKFLOW_ID}/dispatches" \
  -f ref="master" \
  -f inputs='{"publish":"true","dry_run":"false"}')

echo "$RESPONSE" | jq '.workflow_run.id' > /tmp/run_id.txt
RUN_ID=$(cat /tmp/run_id.txt)

if [ -z "$RUN_ID" ]; then
    echo "❌ Failed to trigger workflow"
    exit 1
fi

echo ""
echo "✅ Workflow triggered successfully!"
echo ""
echo "📊 Run ID: $RUN_ID"
echo ""
echo "Monitor progress at:"
echo "https://github.com/$REPO/actions/runs/$RUN_ID"
echo ""
echo "=========================================="
echo "  Your NPM publish is in progress!"
echo "=========================================="
