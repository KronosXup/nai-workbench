const transparentTag = /(^|[,\n{}\[\]:])([ \t]*)transparent[ \t]+background[ \t]*(?=$|[,\n{}\[\]:])/gi;

export function adjustPromptWeight(value: string, start: number, end: number, direction: number, model: string) {
  if (start >= end || !value.slice(start, end).trim() || !direction) return null;
  start += value.slice(start, end).match(/^\s*/)?.[0].length ?? 0;
  end -= value.slice(start, end).match(/\s*$/)?.[0].length ?? 0;
  let text = value.slice(start, end), weight = 1, weighted = false, depth = 0;
  const numeric = model.startsWith('nai-diffusion-4') || model.startsWith('nai-diffusion-5');
  const escaped = (at: number) => (value.slice(0, at).match(/\\*$/)?.[0].length ?? 0) % 2 === 1;
  if (numeric) {
    const whole = text.match(/^(-?(?:\d+(?:\.\d*)?|\.\d+))::([\s\S]*)::$/);
    const before = value.slice(0, start).match(/(-?(?:\d+(?:\.\d*)?|\.\d+))::$/);
    if (whole) { weight = Number(whole[1]); text = whole[2]; weighted = true; }
    else if (before && value.slice(end, end + 2) === '::' && !escaped(start - before[0].length)) {
      weight = Number(before[1]); weighted = true; start -= before[0].length; end += 2;
    }
  }
  while (start > 0 && !escaped(start - 1) && !escaped(end)
    && ((value[start - 1] === '{' && value[end] === '}') || (value[start - 1] === '[' && value[end] === ']'))) {
    depth += value[start - 1] === '{' ? 1 : -1;
    start--; end++;
  }
  let prefix: string, suffix: string;
  if (numeric) {
    if (!Number.isFinite(weight)) return null;
    weight = Number(((weighted ? weight : 1.05 ** depth) + Math.sign(direction) * .1).toFixed(10));
    prefix = weight === 1 ? '' : `${weight}::`;
    suffix = weight === 1 ? '' : '::';
  } else {
    depth += Math.sign(direction);
    prefix = (depth > 0 ? '{' : '[').repeat(Math.abs(depth));
    suffix = (depth > 0 ? '}' : ']').repeat(Math.abs(depth));
  }
  const replacement = prefix + text + suffix;
  return { start, end, replacement, value: value.slice(0, start) + replacement + value.slice(end),
    selectionStart: start + prefix.length, selectionEnd: start + prefix.length + text.length };
}

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
