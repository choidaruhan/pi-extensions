import { DIST } from "./pi-root.mjs";

const { truncateThinking } = await import(new URL("../extensions/thinking-preview.ts", import.meta.url).href);
let failures = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`      actual:   ${JSON.stringify(actual)}\n      expected: ${JSON.stringify(expected)}`);
};

// 1. long block -> first 5 lines + hint
const long = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
check(
  "20 lines, max 5",
  truncateThinking(long, 5),
  "line 1\nline 2\nline 3\nline 4\nline 5\n\n... (15 more lines, 20 total, Ctrl+T to hide)",
);

// 2. short block untouched
check("3 lines, max 5", truncateThinking("a\nb\nc", 5), "a\nb\nc");

// 3. exactly max lines untouched
check("5 lines, max 5", truncateThinking("a\nb\nc\nd\ne", 5), "a\nb\nc\nd\ne");

// 4. max 0 disables
check("max 0 disables", truncateThinking(long, 0), long);

// 5. singular hint
check("6 lines, max 5 (singular)", truncateThinking("a\nb\nc\nd\ne\nf", 5), "a\nb\nc\nd\ne\n\n... (1 more line, 6 total, Ctrl+T to hide)");

// 6. dangling code fence gets closed before the hint
const fenced = ["here is code:", "```python", "x = 1", "y = 2", "z = 3", "```", "after"].join("\n");
check(
  "dangling fence closed",
  truncateThinking(fenced, 3),
  "here is code:\n```python\nx = 1\n```\n\n... (4 more lines, 7 total, Ctrl+T to hide)",
);

// 7. trailing whitespace does not inflate the count
check("trailing blank lines", truncateThinking("a\nb\nc\nd\ne\nf\n\n\n", 5), "a\nb\nc\nd\ne\n\n... (1 more line, 6 total, Ctrl+T to hide)");

// 8. empty input
check("empty", truncateThinking("", 5), "");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
