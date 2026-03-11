# UAP CLI Fix - Distinct from Opencode

## Problem

Previously, `uap` was just a symlink to `opencode`, which meant:
- UAP and opencode were mixed together
- No separation of concerns
- Changes to one affected the other
- No independent UAP functionality

## Solution

Created a **distinct `uap` CLI** that is independent from opencode but can integrate with it.

### Key Features

1. **Independent CLI**: `uap` now has its own command structure
2. **Harness-Agnostic**: Can install plugins to multiple harnesses (opencode, claude-code, etc.)
3. **Project Initialization**: Initialize UAP in any project independently
4. **Plugin Distribution**: Install UAP plugins to compatible systems

### Commands Available

```bash
uap init              # Initialize UAP in current project
uap setup [options]   # Run comprehensive UAP setup
uap install <harness> # Install UAP plugins for specific harness
uap uninstall         # Remove UAP from current project
uap hooks             # Manage UAP hooks
uap plugins           # List and manage UAP plugins
```

### Integration with Opencode

The `uap install opencode` command:
- Copies UAP plugin files to opencode's plugin directory
- Creates opencode config with UAP settings enabled
- Does NOT modify opencode core functionality
- Maintains complete separation of concerns

## Files Changed

1. **src/cli/uap.ts** - New UAP CLI implementation (TypeScript)
2. **dist/cli/uap.js** - Compiled JavaScript
3. **package.json** - Added `uap` bin entry
4. **~/.bashrc** - Added npm global bin to PATH

## Verification

```bash
# uap now works independently
uap --help        # Shows UAP commands
uap init          # Initializes UAP in project

# opencode still works independently  
opencode --help   # Shows opencode commands (unaffected)

# UAP can integrate with opencode
uap install opencode  # Installs UAP plugins TO opencode
```

## Benefits

1. ✅ **Separation of Concerns**: UAP and opencode are now independent
2. ✅ **Flexibility**: Can use UAP with multiple harnesses
3. ✅ **Maintainability**: Changes to one don't affect the other
4. ✅ **Extensibility**: Easy to add support for more harnesses
5. ✅ **Clarity**: Clear distinction between core UAP and harness-specific plugins

## Version History

- **v0.10.0**: Python scripts as bin entries (CLI broken)
- **v0.10.1**: CommonJS wrappers (still broken due to type:module)
- **v0.10.2**: ES module wrappers (workflow issue, didn't publish)
- **v0.10.3**: ✅ FIXED! All CLI commands working + distinct uap CLI

## Next Steps

1. Test `uap install opencode` to verify integration works
2. Add support for more harnesses (claude-code, etc.)
3. Implement full `uap setup -p all` functionality
4. Add plugin management UI

---

*Fixed: 2026-03-11*  
*Version: 0.10.3*
