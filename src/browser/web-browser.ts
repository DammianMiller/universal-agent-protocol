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
  /**
   * Chrome's "Failed to load resource: ... 404" console error omits the URL
   * from its text — the URL rides in the message's location. Without it the
   * feedback is unactionable (run V, octopus variant, 2026-07-18: two full
   * attempts lost to an anonymous 404). Appends the location URL when the
   * text doesn't already carry it.
   */
  static formatConsoleError(text: string, url?: string): string {
    if (!url || text.includes(url)) return text;
    return `${text} (resource: ${url})`;
  }

  private attachErrorCapture(): void {
    const page = this.page;
    if (!page || typeof page.on !== 'function') return;
    try {
      // Auto-dismiss modal dialogs. A validation browser has no human to click
      // "OK", and an open alert()/confirm()/prompt() blocks EVERY subsequent
      // command (evaluate, screenshot, goto) — the whole gate wedges. This is a
      // real risk now that the visual gate synthetically fires the page's own
      // click/keydown handlers to drive a game past its start screen: a game
      // that pops a "Ready?" confirm() on start would otherwise hang the run.
      page.on('dialog', (dialog: { dismiss?: () => Promise<unknown> }) => {
        try {
          void dialog.dismiss?.();
        } catch {
          /* best-effort — if dismiss throws, the per-call timeouts still bound us */
        }
      });
      page.on('pageerror', (err: unknown) => {
        const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
        this.errors.push({ kind: 'pageerror', message: msg });
      });
      page.on('console', (msg: { type?: () => string; text?: () => string; location?: () => { url?: string } }) => {
        try {
          if (typeof msg.type === 'function' && msg.type() === 'error') {
            let loc: string | undefined;
            try {
              loc = typeof msg.location === 'function' ? msg.location()?.url : undefined;
            } catch { loc = undefined; }
            this.errors.push({ kind: 'console', message: WebBrowser.formatConsoleError(msg.text ? msg.text() : '', loc) });
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

  /**
   * Register a script that runs in every page BEFORE its own scripts — used to
   * instrument the page (e.g. count requestAnimationFrame calls) so the
   * execution gate can tell a live render loop from a frozen one. Must be called
   * before goto. No-op if the underlying engine lacks addInitScript.
   */
  async addInitScript(script: string): Promise<void> {
    if (!this.page) throw new Error('Browser not initialized');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx: any = this.context ?? this.page;
    if (typeof ctx.addInitScript === 'function') {
      await ctx.addInitScript(script);
    }
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
    // Close BOTH handles. The non-persistent launch() path sets `context` AND
    // `browser` (see launch(): it creates the browser, then newContext() off
    // it), so the previous `else if` closed only the context and left the
    // Chromium PROCESS alive. Closing a BrowserContext does not terminate the
    // browser. That is why callers with a correct `finally { close() }` — the
    // execution gate has always had one — still leaked: every gate pass left a
    // live Chromium behind (observed: 89 processes / ~33 GB RSS, and the leaked
    // children held a SIGTERM'd deliver process alive for 2h).
    // Each close is independently guarded so a failure to close the context
    // cannot prevent the process itself from being reaped.
    try {
      if (this.context) await this.context!['close']();
    } catch {
      /* context may already be gone; the process still must be reaped below */
    }
    try {
      if (this.browser) await this.browser!['close']();
    } catch {
      /* already exited */
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
