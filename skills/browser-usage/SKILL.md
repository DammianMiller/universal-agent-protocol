---
name: browser-usage
description: "When using browser automation:"
---

# Browser Usage

When using browser automation:

- **ALWAYS** save a screenshot after every browser action
- Save screenshots to: `agents/data/screenshots/`
- Filename format: `{timestamp}_{action}.png`

```typescript
import { createWebBrowser } from '@miller-tech/uap/browser';

const browser = createWebBrowser();
await browser.launch({ headless: true, humanize: true });

// Take screenshot after each action
await browser.screenshot('agents/data/screenshots/1704067200000_navigation.png');

await browser.close();
```

---
