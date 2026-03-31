#!/bin/bash
set -e
[ -d /app/test_repo/.git ]
[ -f /app/results/git_status.txt ]
cd /app/test_repo
git log --oneline | grep -q .
git fsck --full >/dev/null 2>&1
