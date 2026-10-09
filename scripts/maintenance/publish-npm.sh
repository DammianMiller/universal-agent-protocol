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
# The ONLY publish pipeline is npm-publish-manual.yml ("NPM Publish - Manual
# Trigger"): npm's OIDC trusted-publisher entry is bound to that workflow, so
# it is the one that can actually authorize a publish (it published 2.16.2).
# deploy-publish.yml (the auto-publisher) was deleted — its publish step
# failed ENEEDAUTH on every master push because npm could never authorize a
# second workflow.
WORKFLOW_ID="npm-publish-manual.yml"

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
  --jq '.workflows[] | select(.name == "NPM Publish - Manual Trigger") | .id')

if [ -z "$WORKFLOW_ID" ]; then
    echo "❌ Could not find workflow: NPM Publish - Manual Trigger"
    exit 1
fi

echo "✅ Found workflow ID: $WORKFLOW_ID"
echo ""

# Trigger the workflow. The manual workflow takes a `version` input (and an
# optional `force`); it builds, tests, and publishes exactly that version via
# OIDC trusted publishing.
echo "🚀 Triggering publish workflow for v${VERSION}..."
gh api \
  --method POST \
  "/repos/$REPO/actions/workflows/${WORKFLOW_ID}/dispatches" \
  -f ref="master" \
  -F "inputs[version]=${VERSION}" \
  -F "inputs[force]=false"

if [ $? -ne 0 ]; then
    echo "❌ Failed to trigger workflow"
    exit 1
fi

# The dispatch endpoint returns 204 (no body) on success — resolve the run by
# the workflow + head SHA instead of parsing a response.
sleep 5
RUN_ID=$(gh api "/repos/$REPO/actions/workflows/${WORKFLOW_ID}/runs?head_sha=$(git rev-parse origin/master 2>/dev/null || git rev-parse master)" \
  --jq '.workflow_runs[0].id' 2>/dev/null || echo "")

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
