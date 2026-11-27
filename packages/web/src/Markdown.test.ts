import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown.tsx";

describe("chat markdown (task 052)", () => {
  it("shows an image as its alt text and never loads it", () => {
    const html = renderToStaticMarkup(createElement(Markdown, { text: "see ![a cat](https://evil.example/t.png) and ![](https://evil.example/u.png)" }));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("evil.example");
    expect(html).toContain("[image: a cat]");
    expect(html).toContain("[image]");
  });
});

describe("code block copy button (task 090)", () => {
  it("wraps a fenced block with a copy button", () => {
    const html = renderToStaticMarkup(createElement(Markdown, { text: "```js\nlet a = 1;\n```" }));
    expect(html).toContain('data-testid="code-copy"');
    expect(html).toContain("let a = 1;");
  });
  it("gives inline code no button", () => {
    expect(renderToStaticMarkup(createElement(Markdown, { text: "use `x` here" }))).not.toContain("code-copy");
  });
});
