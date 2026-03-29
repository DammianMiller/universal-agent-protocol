#!/bin/bash
set -e
[ "$(cat /app/results/hash_check.txt)" = "HASH_OK" ]
