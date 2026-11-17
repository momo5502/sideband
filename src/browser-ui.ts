import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./browser-app.js";
import { BrowserWorkspace } from "./browser-workspace.js";

const store = new BrowserWorkspace(window);
createRoot(document.getElementById("root")!).render(createElement(App, { store }));
