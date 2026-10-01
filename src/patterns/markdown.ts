// Markdown detection pattern.
//
// Intentionally does NOT match code fences (``` backticks), which the model
// may legitimately emit. Covers:
//   - line-leading dash/star/plus bullets
//   - #-###### headers
//   - **bold** emphasis
//   - __underline__ emphasis

export const MARKDOWN_PATTERN =
  /(?:^|\n)\s*[-*+]\s|^#{1,6}\s|\*\*[^*]+\*\*|__[^_]+__/m