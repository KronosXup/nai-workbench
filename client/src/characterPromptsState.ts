import type { CharacterPrompt } from "./types";

export type CharacterGender = "female" | "male" | "other";

export type CharacterPromptEntry = CharacterPrompt & {
  ui_id?: string;
  name?: string;
  gender?: CharacterGender;
};

export function enabledCharacterCount(characters: CharacterPromptEntry[]) {
  return characters.reduce((count, character) => count + (character.enabled === false ? 0 : 1), 0);
}

export function createCharacterPrompt(gender: CharacterGender, uiId: string): CharacterPromptEntry {
  return {
    ui_id: uiId,
    name: "",
    gender,
    enabled: true,
    prompt: gender === "female" ? "girl, " : gender === "male" ? "boy, " : "",
    negative_prompt: "",
    x: 0.5,
    y: 0.5,
  };
}

export function withUniqueCharacterIds(
  characters: CharacterPromptEntry[],
  makeId: (character: CharacterPromptEntry, index: number, used: ReadonlySet<string>) => string,
) {
  const seen = new Set<string>();
  let changed = false;
  const next = characters.map((character, index) => {
    const current = typeof character.ui_id === "string" ? character.ui_id.trim() : "";
    if (current && !seen.has(current)) {
      seen.add(current);
      return character;
    }
    let id = makeId(character, index, seen);
    while (!id || seen.has(id)) id = makeId(character, index, seen);
    seen.add(id);
    changed = true;
    return { ...character, ui_id: id };
  });
  return changed ? next : null;
}

export function moveCharacter<T>(items: T[], from: number, to: number) {
  if (from < 0 || to < 0 || from >= items.length || to >= items.length || from === to) return items;
  const next = [...items];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}
