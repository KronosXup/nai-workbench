export type PromptEmphasisSpan = { text: string; weight: number; reset?: boolean };

const emphasisTokens = /\\(?:-?(?:\d+(?:\.\d*)?|\.\d+)::|::|[\s\S])|-?(?:\d+(?:\.\d*)?|\.\d+)::|::|[{}\[\]]/g;

// Keep the original text intact: these spans are a display layer only.
export function promptEmphasis(text: string, model: string): PromptEmphasisSpan[] {
  const numeric = model.startsWith('nai-diffusion-4') || model.startsWith('nai-diffusion-5');
  const spans: PromptEmphasisSpan[] = [];
  let factor = 1, depth = 0, offset = 0;
  const weight = () => factor === 0 ? 0 : factor * 1.05 ** depth;
  const append = (value: string, reset = false) => {
    if (!value) return;
    const current = weight(), previous = spans[spans.length - 1];
    if (!reset && previous && !previous.reset && previous.weight === current) previous.text += value;
    else spans.push({ text: value, weight: current, ...(reset ? { reset: true } : {}) });
  };
  for (const match of text.matchAll(emphasisTokens)) {
    append(text.slice(offset, match.index));
    const token = match[0];
    if (token.startsWith('\\')) append(token);
    else if (token === '::' && numeric) {
      factor = 1; depth = 0; append(token, true);
    } else if (token.endsWith('::') && numeric && Number.isFinite(Number(token.slice(0, -2)))) {
      factor = Number(token.slice(0, -2)); depth = 0; append(token);
    } else {
      if (token === '{' || token === ']') depth++;
      else if (token === '}' || token === '[') depth--;
      append(token);
    }
    offset = match.index + token.length;
  }
  append(text.slice(offset));
  return spans;
}

export function emphasisBackground(span: PromptEmphasisSpan): string | undefined {
  if (span.reset) return 'rgba(0, 151, 7, 0.5)';
  if (span.weight === 1) return undefined;
  const alpha = Math.min(0.6, Math.round((0.2 + Math.abs(span.weight - 1) * 0.4) * 40) / 40).toFixed(3);
  return span.weight > 1 ? `rgba(184, 55, 0, ${alpha})` : `rgba(4, 102, 206, ${alpha})`;
}
