import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { messageMarkdown } from "../src/browser-markdown.js";

function fixture() {
  const dom = new JSDOM("<!doctype html>", { url: "https://sideband.example/chat" });
  const render = messageMarkdown(dom.window as unknown as Window);
  return { dom, render(text: string) { const body = dom.window.document.createElement("div"); body.append(render(text)); return body; } };
}
test("chat Markdown emits explicit line breaks for LF, CRLF and CR instead of relying on whitespace CSS", () => {
  const f = fixture();
  try {
    for (const separator of ["\n", "\r\n", "\r"]) {
      const body = f.render(`First${separator}Second${separator}Third${separator}${separator}New paragraph`);
      assert.equal(body.querySelectorAll("p").length, 2); assert.equal(body.querySelectorAll("br").length, 2);
      assert.deepEqual([...body.querySelector("p")!.childNodes].map(node => node.nodeName === "BR" ? "\n" : node.textContent), ["First", "\n", "Second", "\n", "Third"]);
      assert.equal(body.querySelectorAll("p")[1]!.textContent, "New paragraph");
    }
    assert.equal(f.render(String.raw`literal \n and C:\new\folder`).querySelectorAll("br").length, 0, "do not decode literal escapes in paths/code");
  } finally { f.dom.window.close(); }
});
test("Markdown renders formatting, lists, tables, quotes, task markers, links and unchanged code indentation", () => {
  const f = fixture();
  try {
    const body = f.render("# Heading\n\n**bold** and *italic* and ~~deleted~~ and `inline`\n\n- first\n- second\n\n3. third\n4. fourth\n\n> quoted\n\n- [x] done\n- [ ] pending\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n[link](https://example.com/ \"Title\")\n\n```js\n  const x = '<script>';\n\n    x();\n```" );
    assert.equal(body.querySelector("h1")?.textContent, "Heading"); assert.equal(body.querySelector("strong")?.textContent, "bold");
    assert.equal(body.querySelector("em")?.textContent, "italic"); assert.equal(body.querySelector("del")?.textContent, "deleted");
    assert.equal(body.querySelectorAll("li").length, 6); assert.equal(body.querySelector("ol")?.getAttribute("start"), "3");
    assert.match(body.textContent!, /☑ done/); assert.match(body.textContent!, /☐ pending/); assert.equal(body.querySelectorAll("input").length, 0);
    assert.equal(body.querySelector("blockquote p")?.textContent, "quoted"); assert.equal(body.querySelectorAll("table td").length, 2);
    assert.equal(body.querySelector("a")?.getAttribute("href"), "https://example.com/");
    assert.equal(body.querySelector("a")?.getAttribute("target"), "_blank"); assert.equal(body.querySelector("a")?.getAttribute("rel"), "noopener noreferrer");
    assert.equal(body.querySelector("pre code")?.textContent, "  const x = '<script>';\n\n    x();\n"); assert.equal(body.querySelector("script"), null);
  } finally { f.dom.window.close(); }
});
test("untrusted Markdown cannot inject HTML, scripts, images, styling, forms or executable link protocols", () => {
  const f = fixture();
  try {
    for (const attack of [
      '<img src="https://tracker.example/pixel" onerror="alert(1)">', '<script>alert(1)</script>', '<svg/onload=alert(1)>',
      '<iframe srcdoc="<script>alert(1)</script>"></iframe>', '<form id="app"><input name="password"></form>', '<style>body{display:none}</style>',
      '[bad](javascript:alert%281%29)', '[bad](data:text/html,test)', '[bad](vbscript:msgbox%281%29)', '[bad](file:///etc/passwd)',
      '![tracker](https://tracker.example/pixel)', '[bad](java&#x73;cript:alert%281%29)', '[bad](javascript&colon;alert%281%29)',
      '[link](https://example.com/\"onmouseover=\"alert%281%29)', '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=1 onerror=alert(1)>">',
    ]) {
      const body = f.render(attack);
      assert.equal(body.querySelector("script,img,svg,math,iframe,form,input,style,button,object,embed"), null);
      for (const element of body.querySelectorAll("*")) for (const attr of element.attributes) {
        assert.ok(!/^on|^style$|^src|^id$|^name$/i.test(attr.name));
        if (attr.name === "href") assert.ok(["https:", "http:", "mailto:"].includes(new URL(attr.value).protocol));
      }
    }
    assert.ok(f.render('<script>alert(1)</script>').textContent!.includes('<script>alert(1)</script>'), "raw HTML remains visible literal text");
  } finally { f.dom.window.close(); }
});
