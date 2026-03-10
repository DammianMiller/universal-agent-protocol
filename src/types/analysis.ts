export interface ProjectAnalysis {
  projectName: string;
  description: string;
  defaultBranch: string;
  languages: string[];
  frameworks: string[];
  packageManagers: string[];

  issueTracker?: {
    name: string;
    url?: string;
  };

  directories: {
    source: string[];
    tests: string[];
    infrastructure: string[];
    docs: string[];
    workflows: string[];
  };

  urls: Array<{
    name: string;
    value: string;
  }>;

  clusters?: {
    enabled: boolean;
    contexts: Array<{
      name: string;
      context: string;
      purpose: string;
    }>;
  };

  components: Array<{
    name: string;
    path: string;
    language: string;
    framework?: string;
    description: string;
  }>;

  commands: {
    test?: string;
    lint?: string;
    build?: string;
    dev?: string;
    [key: string]: string | undefined;
  };

  databases: Array<{
    type: string;
    purpose: string;
  }>;

  authentication?: {
    provider: string;
    description: string;
  };

  infrastructure: {
    cloud: string[];
    iac?: string;
    containerOrchestration?: string;
  };

  ciCd?: {
    platform: string;
    workflows: Array<{
      file: string;
      purpose: string;
    }>;
  };

  existingDroids: string[];
  existingSkills: string[];
  existingCommands: string[];

  mcpPlugins?: Array<{
    name: string;
    purpose: string;
  }>;

  troubleshootingHints: Array<{
    symptom: string;
    solution: string;
  }>;

  keyFiles: Array<{
    file: string;
    purpose: string;
  }>;

  securityNotes: string[];
}
