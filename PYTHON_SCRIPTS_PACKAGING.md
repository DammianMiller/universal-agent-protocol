# Python Scripts Packaging for UAP

## Overview

All Qwen3.5 tool-call Python scripts are now properly packaged with UAP and will be installed when you install the package.

## Included Scripts

| Script | Purpose | CLI Command |
|--------|---------|-------------|
| `qwen_tool_call_test.py` | Reliability testing for tool calls | `qwen-tool-call-test` |
| `qwen_tool_call_wrapper.py` | Tool call wrapper with retry logic | `qwen-tool-call-wrapper` |
| `fix_qwen_chat_template.py` | Fix chat template configuration | `fix-qwen-template` |

## Package Configuration

### package.json Updates

Added `bin` entry points for easy CLI access:

```json
{
  "bin": {
    "qwen-tool-call-test": "./tools/agents/scripts/qwen_tool_call_test.py",
    "qwen-tool-call-wrapper": "./tools/agents/scripts/qwen_tool_call_wrapper.py",
    "fix-qwen-template": "./tools/agents/scripts/fix_qwen_chat_template.py"
  }
}
```

### MANIFEST.in

Created `MANIFEST.in` to ensure Python scripts are included in source distributions:

```
recursive-include tools/agents *.py
recursive-include tools/agents/scripts *.py
recursive-include tools/agents/config *.jinja
recursive-include tools/agents/UAP *.py
```

## Installation

### Local Development

When you install the package locally:

```bash
npm install
```

All Python scripts will be available in `tools/agents/scripts/`.

### As a Published Package

When published and installed via npm:

```bash
npm install universal-agent-protocol
```

The CLI commands will be available globally (if using `--global` or `npx`):

```bash
# Run tests
qwen-tool-call-test --help

# Run wrapper
qwen-tool-call-wrapper --help

# Fix template
fix-qwen-template --help
```

Or use npx:

```bash
npx qwen-tool-call-test --help
```

## File Structure

```
tools/agents/
├── scripts/
│   ├── fix_qwen_chat_template.py      ✅ Included
│   ├── init_qdrant.py                 ✅ Included
│   ├── memory_migration.py            ✅ Included
│   ├── migrate_memory_to_qdrant.py    ✅ Included
│   ├── query_memory.py                ✅ Included
│   ├── qwen_tool_call_test.py         ✅ Included (CLI)
│   ├── qwen_tool_call_wrapper.py      ✅ Included (CLI)
│   └── start-services.sh              ✅ Included
├── config/
│   └── chat_template.jinja            ✅ Included
├── UAP/
│   ├── __init__.py                    ✅ Included
│   ├── cli.py                         ✅ Included
│   └── version.py                     ✅ Included
└── ... (other directories)
```

## Verification

### Check Scripts Are Included

```bash
# List all Python scripts in tools/agents
find tools/agents -name "*.py" | sort
```

### Test CLI Commands

After installing the package:

```bash
# Verify CLI commands are available
which qwen-tool-call-test
which qwen-tool-call-wrapper
which fix-qwen-template
```

Or use npx:

```bash
npx qwen-tool-call-test --help
```

## Usage Examples

### Run Tool Call Tests

```bash
# With verbose output
qwen-tool-call-test --verbose

# Save results to file
qwen-tool-call-test --output results.json
```

### Test Wrapper Directly

```bash
# Initialize and test wrapper
qwen-tool-call-wrapper
```

### Fix Chat Template

```bash
# Apply template fixes
fix-qwen-template
```

## Notes

1. **Python 3 Required**: All scripts require Python 3.8+

2. **Dependencies**: Scripts use standard library + `openai` package

3. **Executable Permission**: Scripts are marked as executable with shebang lines (`#!/usr/bin/env python3`)

4. **Path Handling**: Scripts use relative paths from the installation directory

## Troubleshooting

### Scripts Not Found After Install

```bash
# Verify installation location
npm list universal-agent-protocol

# Check if tools/agents exists
ls node_modules/universal-agent-protocol/tools/agents/scripts/
```

### Permission Denied When Running CLI

```bash
# Make scripts executable (if needed)
chmod +x tools/agents/scripts/*.py

# Or use python directly
python3 tools/agents/scripts/qwen_tool_call_test.py --help
```

### Module Import Errors

```bash
# Ensure you're in the project root
cd /path/to/universal-agent-memory

# Check Python path
PYTHONPATH=tools/agents python3 -c "import qwen_tool_call_wrapper"
```

## Summary

✅ All Python scripts are included in package.json `files` array  
✅ CLI entry points added to `bin` field  
✅ MANIFEST.in created for source distributions  
✅ Scripts have proper shebang and executable permissions  
✅ Ready for installation via npm  

The scripts will be available both as:
- Local files in `tools/agents/scripts/`
- CLI commands when installed globally or via npx
