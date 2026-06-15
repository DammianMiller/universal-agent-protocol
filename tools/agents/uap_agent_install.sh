#!/bin/bash
# UAP v{{ version }} Agent Installation Script
# This is a no-op installation for UAP since it runs via API calls

echo "UAP v{{ version }} installed successfully"
echo "Agent will run via HTTP API calls to configured endpoint"

# Create necessary directories
mkdir -p /app/results
mkdir -p /logs/agent

exit 0
