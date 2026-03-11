# NPM Publish Instructions for v0.10.0

## Current Status

✅ Version bumped to 0.10.0  
✅ Git commit created  
✅ Pushed to GitHub (master branch)  
❌ NPM publish not completed (authentication required)

## Steps to Complete Publish

### 1. Login to NPM

```bash
npm login
```

Enter your npm username, email, and password when prompted.

### 2. Verify Package Name

The package name is `universal-agent-protocol`. If you haven't published this name before:

```bash
# Create the package on npm first (only needed once)
npm publish --dry-run  # Test the publication
```

If it says "Not found", you may need to:
- Use a scoped name like `@your-org/universal-agent-protocol`
- Or create the unscoped package with your npm account

### 3. Publish to NPM

```bash
# Dry run first (recommended)
npm publish --dry-run

# Then publish for real
npm publish
```

### 4. Verify Publication

```bash
# Check if package is published
npm view universal-agent-protocol

# Or check your packages
npm whoami
npm ls --global --depth=0
```

## Package Details

| Field | Value |
|-------|-------|
| **Name** | `universal-agent-protocol` |
| **Version** | 0.10.0 (minor bump) |
| **Scope** | Public (`--access public`) |
| **Tag** | latest |

## What's Included in v0.10.0

### Python Scripts Packaging
- ✅ `qwen_tool_call_test.py` - Reliability testing CLI
- ✅ `qwen_tool_call_wrapper.py` - Tool call wrapper CLI  
- ✅ `fix_qwen_chat_template.py` - Template fixer CLI
- ✅ Plus 4 utility scripts (memory, Qdrant, migrations)

### Documentation
- ✅ MANIFEST.in for proper source distribution
- ✅ PYTHON_SCRIPTS_PACKAGING.md - Complete documentation
- ✅ TOOL_CALLS_FIX_SUMMARY.md - Bug fixes documented
- ✅ UBAP_PATTERN_DISTILLATION_REPORT.md - Generic patterns

### Tool-Call Fixes
- ✅ Fixed missing `Path` import in test script
- ✅ Removed invalid `top_k` parameter from wrapper
- ✅ All scripts now executable and functional

## Post-Publish Verification

After publishing, verify:

```bash
# Install the published package
npm install universal-agent-protocol

# Test CLI commands (if installed globally)
npx qwen-tool-call-test --help
npx qwen-tool-call-wrapper --help
npx fix-qwen-template --help
```

## Troubleshooting

### "Not found in registry" Error

This means the package name hasn't been created yet. Options:

1. **Use scoped name** (recommended for organizations):
   ```bash
   # Update package.json
   npm init -y  # Create new package.json with scoped name
   # OR manually edit package.json to add "name": "@your-org/universal-agent-protocol"
   
   # Then publish
   npm publish
   ```

2. **Create unscoped package** (only if you own the username):
   ```bash
   # Make sure you're logged in as the owner
   npm login
   
   # Publish with your username
   npm publish
   ```

### 401 Unauthorized Error

You're not logged in or token expired:

```bash
npm logout
npm login
```

### Permission Denied

Make sure you have publishing rights to the package name.

## Next Steps After Publish

1. Update README.md with installation instructions
2. Create GitHub release for v0.10.0
3. Announce changes in project documentation
4. Test installation from npm: `npm install universal-agent-protocol`

## Summary

The version has been bumped to 0.10.0 and pushed to GitHub. The final step is to authenticate with npm and publish the package using the commands above.
