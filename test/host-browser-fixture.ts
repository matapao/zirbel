// What the host-browser e2e tests share (`pnpm test:browser` runs host-browser.ts, host-browser-net.ts,
// host-browser-sandbox.ts and host-browser-editor.ts): the hosts under test, the WCAG check, a folder's files as base64.
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from 'playwright';
import { hostsUnderTest } from './helpers.ts';

export const hosts = hostsUnderTest();

// WCAG checks on a real page. Serious and critical violations fail the test;
// the game canvas is the author's content and is left out.
export async function accessibility(page: Page) {
  const result = await new AxeBuilder({ page }).exclude('canvas').exclude('iframe').analyze();
  return result.violations.filter((item) => item.impact === 'serious' || item.impact === 'critical')
    .map((item) => item.id + ': ' + item.help + ' (' + item.nodes.map((node) => node.target.join(' ')).slice(0, 3).join(', ') + ')');
}

export const encoded = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).map(([path, text]) => [path, Buffer.from(text).toString('base64')]));
