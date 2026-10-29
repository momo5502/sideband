import { Marked } from "marked";
import createDOMPurify, { type WindowLike } from "dompurify";

const escape = (text: string) => text.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

/** Untrusted chat Markdown. Return sanitized DOM, never an HTML string for later reparsing. */
export function messageMarkdown(window: Window): (text: string) => DocumentFragment {
  const purify = createDOMPurify(window as unknown as WindowLike);
  const markdown = new Marked({ gfm: true, breaks: true, renderer: {
    html: ({ text }) => escape(text).replace(/\r\n|\r|\n/g, "<br>"),
    image: ({ text }) => escape(text), // No tracking pixels, remote requests, or data-URL images.
    checkbox: ({ checked }) => checked ? "☑ " : "☐ ",
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      let url: URL;
      try { url = new URL(href, window.location.href); } catch { return text; }
      if (!["http:", "https:", "mailto:"].includes(url.protocol)) return text;
      return `<a href="${escape(url.href)}"${title ? ` title="${escape(title)}"` : ""} target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
  } });
  return text => {
    try {
      if (!purify.isSupported) throw new Error("Sanitizer unavailable");
      return purify.sanitize(markdown.parse(text, { async: false }), {
        ALLOWED_TAGS: ["p", "br", "strong", "em", "del", "s", "code", "pre", "blockquote", "ul", "ol", "li", "a", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tr", "th", "td"],
        ALLOWED_ATTR: ["href", "title", "target", "rel", "start", "align"],
        ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false, RETURN_DOM_FRAGMENT: true,
      });
    } catch {
      // Fail closed to literal text with explicit breaks if parsing/sanitization is unavailable.
      const fragment = window.document.createDocumentFragment();
      text.split(/\r\n|\r|\n/).forEach((line, index) => { if (index) fragment.append(window.document.createElement("br")); fragment.append(window.document.createTextNode(line)); });
      return fragment;
    }
  };
}
