import test from "node:test";
import assert from "node:assert/strict";
import { parseDocumentGenerations } from "../routes/openai";

test("parses pptx artifact metadata and design fields", () => {
  const parsed = parseDocumentGenerations(JSON.stringify({
    data: [
      {
        filename: "quarterly-review.pptx",
        mime_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        b64_data: "A".repeat(120),
        title: "Quarterly Review",
        summary: "Executive summary deck",
        slide_count: 6,
        theme: "midnight",
        style: "editorial",
        preview_url: "https://example.com/preview.png",
        slides: [
          {
            title: "Overview",
            bullets: ["Revenue up", "Churn down"],
          },
        ],
      },
    ],
  }));

  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], {
    filename: "quarterly-review.pptx",
    mime_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    b64_data: "A".repeat(120),
    download_url: undefined,
    title: "Quarterly Review",
    summary: "Executive summary deck",
    text: undefined,
    markdown: undefined,
    html: undefined,
    page_count: undefined,
    slide_count: 6,
    theme: "midnight",
    template: undefined,
    design_style: "editorial",
    preview_url: "https://example.com/preview.png",
    preview_b64_json: undefined,
    slides: [
      {
        title: "Overview",
        subtitle: undefined,
        text: undefined,
        notes: undefined,
        bullets: ["Revenue up", "Churn down"],
        image_url: undefined,
      },
    ],
  });
});

test("parses structured document content without binary artifact", () => {
  const parsed = parseDocumentGenerations(JSON.stringify({
    documents: [
      {
        title: "Project Brief",
        markdown: "# Project Brief\n\n- Scope\n- Risks",
        page_count: 2,
        template: "briefing",
      },
    ],
  }));

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.title, "Project Brief");
  assert.equal(parsed[0]?.markdown, "# Project Brief\n\n- Scope\n- Risks");
  assert.equal(parsed[0]?.page_count, 2);
  assert.equal(parsed[0]?.template, "briefing");
});
