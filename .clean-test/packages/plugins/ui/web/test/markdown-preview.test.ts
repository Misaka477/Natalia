import { expect, test } from "bun:test";
import { renderMarkdownHtml } from "@natalia/ui-kit";

test("markdown preview renders a table immediately after prose", () => {
  const html = renderMarkdownHtml(
    "说明：\n| 方向 | 环境变量 | 说明 |\n| --- | --- | --- |\n| 宿主→内核 | KERNEL_TOKEN | token |",
  );
  expect(html).toContain("<table>");
  expect(html).toContain("<th>方向</th>");
  expect(html).toContain("<td>KERNEL_TOKEN</td>");
});
