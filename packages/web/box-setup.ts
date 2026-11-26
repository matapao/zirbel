// "Set up a Zirbel box": how a box comes online. A box with no network opens a Wi-Fi of its own for setup,
// "Zirbel setup XXXX"; a phone or computer that joins it gets the box's setup page (pi/setup/portal.py), where the
// person picks the network the box joins, or keeps the box on its own Wi-Fi.
import { el, openDialog } from './editor-ui.ts';

export function boxSetupDialog() {
  openDialog('Set up a Zirbel box').append(
    el(
      'p',
      'Start the box. A minute or so later, if it has no network, it opens a Wi-Fi of its own for setup, named “Zirbel setup” and four letters and digits, such as “Zirbel setup 3F2A”.',
    ),
    el(
      'p',
      'Join that Wi-Fi on this phone or computer, and the box’s setup page opens. There, choose the Wi-Fi network the box should join, or keep the box on its own Wi-Fi, which phones, tablets and computers join to play, with no internet.',
    ),
    el(
      'p',
      'On a wired network the box needs no setup: open http://zirbel.local. To move a box that is set up to another Wi-Fi, use Change Wi-Fi in its Box settings.',
    ),
  );
}
