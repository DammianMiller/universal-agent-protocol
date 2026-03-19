"""
Universal Agent Protocol - CLI Module

This module provides the core CLI commands for UAP protocol compliance.
"""

from .cli import UAPCLI, main
from .task_classifier import classify_task, build_classified_preamble, CATEGORY_KEYWORDS

__all__ = [
    "UAPCLI",
    "main",
    "classify_task",
    "build_classified_preamble",
    "CATEGORY_KEYWORDS",
]
