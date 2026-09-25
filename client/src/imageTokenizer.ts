import { Tokenizer } from "@huggingface/tokenizers";

type Kind = "qwen" | "t5" | "clip";

export type ImageTokenizerSpec = { kind: Kind; limit: number; name: string };

// The official image client uses Qwen for V5, T5 for V4/4.5, and CLIP for V3.
// Keep the vocabulary on this origin: counting a draft must never send it to a service.
export function imageTokenizerSpec(model: string): ImageTokenizerSpec | null {
  if (model === "nai-diffusion-5-full") return { kind: "qwen", limit: 1471, name: "Qwen" };
  if (model === "nai-diffusion-5-curated") return { kind: "qwen", limit: 703, name: "Qwen" };
  if (model.startsWith("nai-diffusion-4")) return { kind: "t5", limit: 512, name: "T5" };
  if (model === "nai-diffusion-3" || model === "nai-diffusion-furry-3")
    return { kind: "clip", limit: 225, name: "CLIP" };
  return null;
}

const loaded = new Map<Kind, Promise<Tokenizer>>();

export function imageTokenizer(kind: Kind): Promise<Tokenizer> {
  const existing = loaded.get(kind);
  if (existing) return existing;
  const promise = fetch(`/tokenizers/${kind}.json`)
    .then(async response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const config = await response.json();
      // NAI's T5 meter keeps Unicode spelling, boundary spaces and literal
      // special-token text. Avoid NFKC, whitespace trimming and added-token splits.
      return new Tokenizer(kind === "t5" ? {
        ...config, normalizer: null, added_tokens: [],
        pre_tokenizer: { type: "Metaspace", prepend_scheme: "never" },
      } : config, {});
    })
    .catch(error => {
      loaded.delete(kind); // A failed asset load may be retried from the meter.
      throw error;
    });
  loaded.set(kind, promise);
  return promise;
}

// NovelAI counts a prompt mix after choosing the longest text alternative in
// each ||...|| group. Plain | then separates up to six prompt segments.
// Weight syntax is handled separately below: T5 and Qwen count it differently.
export function imageTokenSegments(text: string): string[] {
  const chosen = text.split("||").map((part, index) => {
    if (index % 2 === 0) return part;
    return part.split("|").reduce((longest, option) => longest.length > option.length ? longest : option);
  }).join("");
  const segments = chosen.split("|");
  return segments.length > 6 ? [...segments.slice(0, 5), segments.slice(5).join("|")] : segments;
}

export function countImageTokenSegments(tokenizer: Tokenizer, text: string, kind: Kind): number[] {
  return imageTokenSegments(text).map(segment => {
    if (kind !== "t5") return segment ? tokenizer.encode(segment, { add_special_tokens: false }).ids.length : 0;
    // T5 counts emphasis content, with one EOS per segment (including empty
    // base/character prompts). Qwen must retain its original, unstripped input.
    const content = segment.replace(/-?(?:\d+(?:\.\d*)?|\.\d+)::|::|[{}\[\]]/g, "");
    // Collapse whitespace runs but keep their boundaries. Every nonempty
    // segment gets a prefix space, even when it already begins with whitespace.
    const input = content ? " " + content.replace(/\s+/g, " ") : "";
    const encoded = tokenizer.encode(input, { add_special_tokens: true });
    const unknownId = tokenizer.token_to_id("<unk>");
    return encoded.ids.reduce((count, id, index) => {
      const token = encoded.tokens[index];
      // The official T5 meter counts unknown UTF-16 units separately; the
      // library fuses them. A literal vocabulary token <unk> still counts once.
      return count + (id === unknownId && token !== "<unk>" ? token.length : 1);
    }, 0);
  });
}
