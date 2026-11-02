import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { VoiceMarkdown } from "../components/brain-console";

describe("VoiceMarkdown", () => {
  it("renders headings, lists, and inline styles", () => {
    const html = renderToStaticMarkup(
      VoiceMarkdown({
        body: [
          "# Voice profile",
          "",
          "## Diction & vocabulary",
          "",
          "Short **punchy** lines with `code`.",
          "",
          "### Pillar One",
          "",
          "- Never hashtag",
          '- "Quoted line"',
        ].join("\n"),
      }) as never,
    );
    assert.ok(!html.includes("Voice profile</h"), "doc title duplicates the section header");
    assert.ok(html.includes("<h3>"), "## becomes h3");
    assert.ok(html.includes("<h4>Pillar One</h4>"), "### becomes h4");
    assert.ok(html.includes("<strong>punchy</strong>"));
    assert.ok(html.includes("<code>code</code>"));
    assert.equal((html.match(/<li>/g) ?? []).length, 2);
  });

  it("renders plain text as paragraphs and escapes html", () => {
    const html = renderToStaticMarkup(
      VoiceMarkdown({ body: 'Just text.\n\n<script>alert("x")</script>' }) as never,
    );
    assert.ok(html.includes("<p>Just text.</p>"));
    assert.ok(!html.includes("<script>"));
    assert.ok(html.includes("&lt;script&gt;"));
  });
});
