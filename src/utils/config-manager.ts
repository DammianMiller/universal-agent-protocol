/**
 * Singleton configuration manager backed by an in-memory Map.
 */
export class ConfigManager {
  private static instance: ConfigManager;
  private config: Map<string, any>;

  /**
   * Creates a new ConfigManager instance.
   */
  private constructor() {
    this.config = new Map<string, any>();
  }

  /**
   * Returns the singleton instance of the ConfigManager.
   * @returns The singleton ConfigManager instance.
   */
  public static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  /**
   * Gets a configuration value by key.
   * @param key - Configuration key to retrieve.
   * @returns The stored configuration value, or undefined if missing.
   */
  public get(key: string): any {
    return this.config.get(key);
  }

  /**
   * Sets a configuration value by key.
   * @param key - Configuration key to set.
   * @param value - Configuration value to store.
   * @returns No return value.
   */
  public set(key: string, value: any): void {
    this.config.set(key, value);
  }
}
