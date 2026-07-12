interface WebBrowserOptions {
  headless?: boolean;
  humanize?: boolean;
  proxy?: string;
  persistent?: boolean;
  userDataDir?: string;
  [key: string]: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BrowserLike = any;

/** A runtime error observed in the page (uncaught throw, console.error, failed request). */
export interface PageError {
  kind: 'pageerror' | 'console' | 'requestfailed';
  message: string;
}

export class WebBrowser {
  private browser: BrowserLike | null = null;
  private context: BrowserLike | null = null;
  private page: BrowserLike | null = null;
  private errors: PageError[] = [];

  async launch(options: WebBrowserOptions = {}): Promise<WebBrowser> {
    const { persistent = false, userDataDir, ...launchOptions } = options;

    if (persistent && userDataDir) {
      // For persistent contexts, use launchPersistentContext which returns a context directly
      this.context = await this.launchPersistentContext(userDataDir, launchOptions);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.page = await (this.context as any).newPage();
    } else {
      // For regular launch, CloakBrowser's launch() returns a Browser
      const { launch } = await import('cloakbrowser');
      this.browser = await launch(launchOptions);
      // Create a context from the browser (CloakBrowser extends Playwright API)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.context = await (this.browser as any).newContext();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.page = await (this.context as any).newPage();
    }

    this.attachErrorCapture();
    return this;
  }

  /**
   * Record uncaught exceptions, console.error output, and failed requests so an
   * execution gate can fail a page that loads but throws at runtime (e.g. a
   * temporal-dead-zone ReferenceError that static checks never see). Best-effort:
   * if the underlying page has no event emitter, capture silently degrades.
   */
  private attachErrorCapture(): void {
    const page = this.page;
    if (!page || typeof page.on !== 'function') return;
    try {
      page.on('pageerror', (err: unknown) => {
        const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
        this.errors.push({ kind: 'pageerror', message: msg });
      });
      page.on('console', (msg: { type?: () => string; text?: () => string }) => {
        try {
          if (typeof msg.type === 'function' && msg.type() === 'error') {
            this.errors.push({ kind: 'console', message: msg.text ? msg.text() : '' });
          }
        } catch {
          /* malformed console event — ignore */
        }
      });
      page.on('requestfailed', (req: { url?: () => string; failure?: () => { errorText?: string } | null }) => {
        try {
          const url = typeof req.url === 'function' ? req.url() : '';
          const failure = typeof req.failure === 'function' ? req.failure() : null;
          this.errors.push({ kind: 'requestfailed', message: `${url} ${failure?.errorText ?? ''}`.trim() });
        } catch {
          /* malformed event — ignore */
        }
      });
    } catch {
      /* page emitter unavailable — error capture degrades, gate still runs */
    }
  }

  /** Runtime errors observed since launch (uncaught throws, console.error, failed requests). */
  getErrors(): PageError[] {
    return [...this.errors];
  }

  /** Drop captured errors (e.g. to scope capture to a single interaction). */
  clearErrors(): void {
    this.errors = [];
  }

  private async launchPersistentContext(
    userDataDir: string,
    options: WebBrowserOptions
  ): Promise<unknown> {
    const { launchPersistentContext } = await import('cloakbrowser');
    // cloakbrowser's launchPersistentContext(userDataDir, options) takes options as second param
    return (launchPersistentContext as any)(userDataDir, options);
  }

  async goto(url: string): Promise<string> {
    if (!this.page) throw new Error('Browser not initialized');
    const response = await this.page!['goto'](url);
    if (!response) return '0';
    // CloakBrowser/Playwright: status() is a method, not a property
    const status = typeof response.status === 'function' ? response.status() : response.status;
    return String(status || '0');
  }

  async getContent(): Promise<string> {
    if (!this.page) throw new Error('Browser not initialized');
    return await this.page!['content']();
  }

  async getText(selector: string): Promise<string> {
    if (!this.page) throw new Error('Browser not initialized');
    const element = await this.page!['locator'](selector);
    return await element!['textContent']();
  }

  async screenshot(path: string): Promise<void> {
    if (!this.page) throw new Error('Browser not initialized');
    await this.page!['screenshot']({ path });
  }

  async evaluate<T>(script: string | ((arg: unknown) => unknown)): Promise<T> {
    if (!this.page) throw new Error('Browser not initialized');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const page: any = this.page;
    // CloakBrowser requires a function, not a string
    // If a string is passed, wrap it in a function
    const func = typeof script === 'string' ? new Function('return (' + script + ')()') : script;
    return await page.evaluate(func);
  }

  async waitForLoadState(
    state: 'load' | 'domcontentloaded' | 'networkidle' = 'load'
  ): Promise<void> {
    if (!this.page) throw new Error('Browser not initialized');
    await this.page!['waitForLoadState'](state);
  }

  async click(selector: string): Promise<void> {
    if (!this.page) throw new Error('Browser not initialized');
    await this.page!['locator'](selector)['click']({ timeout: 10_000 });
  }

  async fill(selector: string, value: string): Promise<void> {
    if (!this.page) throw new Error('Browser not initialized');
    await this.page!['locator'](selector)['fill'](value, { timeout: 10_000 });
  }

  async press(key: string): Promise<void> {
    if (!this.page) throw new Error('Browser not initialized');
    await this.page!['keyboard']['press'](key);
  }

  async isVisible(selector: string): Promise<boolean> {
    if (!this.page) throw new Error('Browser not initialized');
    return await this.page!['locator'](selector)['isVisible']();
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context!['close']();
    } else if (this.browser) {
      await this.browser!['close']();
    }
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async findElements(selector: string): Promise<PageElement[]> {
    if (!this.page) throw new Error('Browser not initialized');
    const elements = await this.page!['locator'](selector)['all']();
    return (
      elements?.map((el: any) => ({
        textContent: el['textContent'](),
        exists: el['count'](),
      })) || []
    );
  }
}

interface PageElement {
  textContent: Promise<string | null>;
  exists: Promise<number>;
}

export const createWebBrowser = (): WebBrowser => new WebBrowser();
