# UAP Harbor agent implementations
# Note: This module is named uap_harbor to avoid collision with the harbor package

from .supergenius_agent import SuperGeniusAgent, SuperGeniusOpus, SuperGeniusSonnet

__all__ = ['SuperGeniusAgent', 'SuperGeniusOpus', 'SuperGeniusSonnet']
