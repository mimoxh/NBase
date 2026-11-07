export interface TextCount { words: number; characters: number; minutes: number }

const hanCharacter = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const latinWord = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

/** CJK counts by character and other scripts by word; reading time assumes 400 and 200 per minute. */
export function countText(text: string): TextCount {
  const han = text.match(hanCharacter)?.length ?? 0;
  const latin = text.replace(hanCharacter, ' ').match(latinWord)?.length ?? 0;
  const characters = [...text.replace(/\s/g, '')].length;
  const minutes = han + latin ? Math.max(1, Math.ceil(han / 400 + latin / 200)) : 0;
  return { words: han + latin, characters, minutes };
}
