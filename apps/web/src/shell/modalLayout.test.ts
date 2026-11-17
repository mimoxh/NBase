import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./shell.css', import.meta.url), 'utf8');

describe('large dialog layout', () => {
  it('hides its own overflow, so its scroll area shrinks and scrolls instead', () => {
    expect(css).toMatch(/\.nb-app \.modal-large \{[^}]*height: min\(86dvh, 860px\);[^}]*overflow: hidden;/);
    expect(css).toContain('.nb-app .modal-large > .modal-scroll { flex: 1; min-height: 0; overflow-y: auto; }');
  });
});
