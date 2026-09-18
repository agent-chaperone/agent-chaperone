/**
 * Splitting a tool result into the numbered blocks the post-result screen uses.
 *
 * The screen asks which block is trying to instruct the reader, so the blocks
 * have to be small enough for that answer to be useful and stable enough that
 * the same result always numbers the same way.
 */

export interface Block {
  readonly id: number;
  readonly text: string;
}

/** Beyond this a paragraph is split further, so one block cannot swallow the result. */
export const DEFAULT_MAX_BLOCK_CHARS = 2000;

/** Past this the result is truncated, and the caller is told how much was dropped. */
export const DEFAULT_MAX_BLOCKS = 200;

export interface SplitResult {
  readonly blocks: readonly Block[];
  /** Blocks beyond the limit, which were not included. */
  readonly dropped: number;
  /** Characters in those dropped blocks, so a caller can tell how much went unscreened. */
  readonly dropped_chars: number;
}

/** Split a slice without cutting a surrogate pair in half. */
function cutAt(text: string, at: number): number {
  const code = text.charCodeAt(at);
  // A low surrogate here means the pair started at at-1, so step back one.
  return code >= 0xdc00 && code <= 0xdfff ? at - 1 : at;
}

export function splitIntoBlocks(
  text: string,
  options: { readonly maxBlockChars?: number; readonly maxBlocks?: number } = {},
): SplitResult {
  const maxBlockChars = Math.max(2, options.maxBlockChars ?? DEFAULT_MAX_BLOCK_CHARS);
  const maxBlocks = Math.max(1, options.maxBlocks ?? DEFAULT_MAX_BLOCKS);

  const blocks: Block[] = [];
  let dropped = 0;
  let droppedChars = 0;

  const add = (piece: string): void => {
    if (piece.length === 0) {
      return;
    }
    if (blocks.length >= maxBlocks) {
      dropped += 1;
      droppedChars += piece.length;
      return;
    }
    blocks.push({ id: blocks.length, text: piece });
  };

  // A blank line separates paragraphs whichever line ending the source uses.
  // Matching only LF would turn a CRLF document into one paragraph chopped at
  // arbitrary offsets.
  for (const paragraph of text.split(/\r?\n[ \t]*\r?\n/)) {
    const trimmed = paragraph.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let at = 0;
    while (at < trimmed.length) {
      const end =
        at + maxBlockChars >= trimmed.length ? trimmed.length : cutAt(trimmed, at + maxBlockChars);
      add(trimmed.slice(at, end));
      at = end;
    }
  }

  return { blocks, dropped, dropped_chars: droppedChars };
}
