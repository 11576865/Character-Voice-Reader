import "/foliate-assets/view.js";
import { readEpubFile } from "./epub_source.js";

const view = document.getElementById("book");
const status = document.getElementById("status");
const differences = document.getElementById("differences");
let parsed = null;

const clean = text => text.replace(/\s+/g, " ").trim();

view.addEventListener("load", event => {
  const { doc, index } = event.detail;
  const expected = parsed?.document.chapters[index]?.paragraphs || [];
  const actual = [...doc.querySelectorAll("p, li, h1, h2, h3, h4, blockquote, pre")]
    .filter(node => !(node.matches("li, blockquote") && node.querySelector("p, li")))
    .map(node => clean(node.textContent)).filter(Boolean);
  const missing = expected.filter(text => !actual.includes(clean(text)));
  status.textContent = `第 ${index + 1} 个 EPUB 内容区：CVS ${expected.length} 段，foliate-js ${actual.length} 段，精确匹配 ${expected.length - missing.length} 段。`;
  differences.textContent = missing.slice(0, 5).map(text => `未匹配：${text.slice(0, 120)}`).join("\n");
});

document.getElementById("file").addEventListener("change", async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    parsed = await readEpubFile(file, await file.arrayBuffer());
    view.close();
    await view.open(file);
    await view.goTo(0);
  } catch (error) { status.textContent = `无法验证：${error.message}`; }
});
document.getElementById("previous").addEventListener("click", () => view.prev());
document.getElementById("next").addEventListener("click", () => view.next());
