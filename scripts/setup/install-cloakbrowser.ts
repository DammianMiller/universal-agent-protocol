#!/usr/bin/env node
import { execSync } from 'node:child_process';

try {
  console.log('Installing CloakBrowser dependencies...');
  execSync('npm install cloakbrowser playwright-core', { stdio: 'inherit' });
  console.log('\nInstalling Playwright browsers...');
  execSync('npx playwright install chromium', { stdio: 'inherit' });
  console.log('\n✅ CloakBrowser ready!');
  console.log('\nTo use: import { createWebBrowser } from "universal-agent-protocol/browser";');
} catch (error) {
  console.error('❌ Installation failed:', error.message);
  process.exit(1);
}
