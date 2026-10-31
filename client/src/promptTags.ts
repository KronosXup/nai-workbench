const transparentTag = /(^|[,\n{}\[\]:])([ \t]*)transparent[ \t]+background[ \t]*(?=$|[,\n{}\[\]:])/gi;

export function hasTransparentBackground(prompt: string): boolean {
  return new RegExp(transparentTag).test(prompt);
}

/** Remove just this tag, retaining surrounding weighted groups and other text. */
export function setTransparentBackground(prompt: string, enabled: boolean): string {
  if (enabled) return hasTransparentBackground(prompt) ? prompt : `${prompt.trimEnd()}${prompt.trim() ? ", " : ""}transparent background`;
  let marker = "\uE000";
  while (prompt.includes(marker)) marker += "\uE000";
  let next = prompt.replace(new RegExp(transparentTag), (_match, boundary: string, space: string) => boundary + space + marker);
  if (next === prompt) return prompt;
  // Empty emphasis wrappers belong to the removed tag; mixed groups stay intact.
  let previous;
  do {
    previous = next;
    next = next.replace(new RegExp(`\\{\\s*${marker}\\s*\\}|\\[\\s*${marker}\\s*\\]|[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)::\\s*${marker}\\s*::`, "g"), marker);
  } while (next !== previous);
  return next
    .replace(new RegExp(`${marker}[ \\t]*(?:,[ \\t]*|\\r?\\n[ \\t]*)`, "g"), "")
    .replace(new RegExp(`(?:,[ \\t]*|\\r?\\n[ \\t]*)${marker}`, "g"), "")
    .replaceAll(marker, "")
    .trim();
}
