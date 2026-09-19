import { describe, expect, it } from 'vitest';
import {
  safeName,
  toolDescriptionSteers,
  toolDescriptionsUnscreened,
  toolListChanged,
} from './notices.js';

const ESC = String.fromCharCode(0x1b);
const CR = String.fromCharCode(0x0d);
const LINE_SEPARATOR = String.fromCharCode(0x2028);

describe('a name a server chose, printed to a terminal', () => {
  it('cannot add a line of its own to the report', () => {
    const forged = 'read_file"\n  everything_else (0.00) and nothing wrong here';
    const notice = toolDescriptionSteers('files', [{ name: forged, probability: 0.9 }]);

    // One tool was reported, so the notice must carry exactly one tool line.
    const toolLines = notice.split('\n').filter((line) => line.startsWith('  '));
    expect(toolLines).toHaveLength(1);
  });

  it('strips control characters rather than sending them to the terminal', () => {
    expect(safeName(`a${ESC}[2Jb`)).not.toContain(ESC);
    expect(safeName(`a${CR}b`)).not.toContain(CR);
    expect(safeName(`a${LINE_SEPARATOR}b`)).not.toContain(LINE_SEPARATOR);
  });

  it('bounds a name long enough to push the rest off the screen', () => {
    expect(safeName('x'.repeat(5_000)).length).toBeLessThan(80);
  });

  it('quotes the name so its edges are visible', () => {
    expect(safeName('read_file')).toBe('"read_file"');
    expect(safeName(' read_file ')).toBe('" read_file "');
  });

  it('says plainly that the reading is unmeasured', () => {
    expect(toolDescriptionSteers('files', [{ name: 'x', probability: 0.9 }])).toContain(
      'unmeasured',
    );
  });

  it('says an unread description was neither cleared nor flagged', () => {
    const notice = toolDescriptionsUnscreened('files', ['a', 'b']);

    expect(notice).toContain('neither cleared nor flagged');
    expect(notice).toContain('2 tool descriptions were not read');
  });

  it('escapes names in the changed-list report as well', () => {
    const forged = 'read_file\n  added   everything_else';
    const notice = toolListChanged(
      'files',
      [{ kind: 'changed', name: forged }],
      '2026-01-01T00:00:00.000Z',
      'agent-chaperone trust files',
    );
    const reported = notice.split('\n').filter((line) => line.startsWith('  '));

    expect(reported).toHaveLength(1);
  });

  it('does not list every name when a server advertises thousands', () => {
    const many = Array.from({ length: 2_000 }, (_, i) => `tool_${i}`);
    const notice = toolDescriptionsUnscreened('files', many);

    expect(notice.length).toBeLessThan(500);
    expect(notice).toContain('1990 more');
  });
});
