import { browserStyles } from "./browser-bundle.js";
export function webPage() {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content"><meta name="theme-color" content="#111113">
<title>Sideband</title><style>${browserStyles}</style><script src="/chat.js" defer></script></head><body><div id="root"></div><noscript>Enable JavaScript to use Sideband chat and agent orchestration.</noscript></body></html>\n`;
}
//# sourceMappingURL=web-page.js.map