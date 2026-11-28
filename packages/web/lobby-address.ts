// The lobby's address in the editor: the Lobby… dialog in the game menu, and Players in Box settings. Phones on the
// network scan its QR code, or open the address, to play what the lobby offers, with no address to type.
import { api, el, link, openDialog } from './editor-ui.ts';
import { qrPicture } from './qr.ts';

/** The lobby's address for other devices on the network: none while this host shares on none. */
export const lobbyLink = async () => (await api<{ link: string | null }>('lobby')).link;

/** The lobby's address and its QR code, or, without an address, when it has one. */
export async function lobbyAddress(address: string | null) {
  if (!address)
    return [el('p', 'The lobby is on your local network once this host shares on it, as when you host a game on LAN.')];
  const picture = await qrPicture(address, 'QR code that opens the lobby');
  picture.classList.add('lobby-qr');
  return [
    el('p', 'Phones and computers on your network open the lobby here, or scan this code with a camera:'),
    el('strong', address, 'lobby-address'),
    picture,
  ];
}

/** The Lobby dialog: where others open the lobby, and a link that opens it here. */
export async function lobbyDialog() {
  const body = openDialog('Lobby');
  const address = await lobbyLink();
  body.append(...(await lobbyAddress(address)));
  if (address) body.append(link('Open the lobby', address, true));
}
