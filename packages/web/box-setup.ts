// "Set up a Zirbel box": a box without Wi-Fi waits for it over Bluetooth (Improv Wi-Fi, improv.ts), and this puts it on
// a network from Chrome, Edge or the desktop app, then opens the link it returns to pair with its editor. Where Web
// Bluetooth is missing (Safari, or a page that is not a secure context), the person joins the box's setup hotspot instead.
import { action, el, inform, openDialog, dialog } from './editor-ui.ts';
import {
  CAPABILITY,
  CHARACTERISTIC,
  chunks,
  COMMAND,
  ERROR_TEXT,
  finishLink,
  IMPROV_SERVICE,
  parseResult,
  rpcPacket,
  scannedNetworks,
  STATE,
  wifiSettings,
  type ScannedNetwork,
} from './improv.ts';

// The part of Web Bluetooth this uses; TypeScript's DOM library does not describe it.
type Characteristic = EventTarget & {
  value?: DataView;
  readValue(): Promise<DataView>;
  writeValueWithResponse(value: BufferSource): Promise<void>;
  startNotifications(): Promise<Characteristic>;
};
type Server = {
  connect(): Promise<Server>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<{ getCharacteristic(uuid: string): Promise<Characteristic> }>;
};
type Device = EventTarget & { name?: string; gatt?: Server };
type Bluetooth = { requestDevice(options: { filters: { services: string[] }[] }): Promise<Device> };

const bluetooth = () =>
  window.isSecureContext ? (navigator as Navigator & { bluetooth?: Bluetooth }).bluetooth : undefined;
const bytes = (view: DataView) => new Uint8Array(view.buffer, view.byteOffset, view.byteLength);

type Change = { kind: 'state' | 'error'; value: number } | { kind: 'result'; command: number; strings: string[] };

/** A box found over Bluetooth, with its Improv characteristics and what they last said. */
class ImprovBox {
  state = 0;
  error = 0;
  private listeners = new Set<(change: Change) => void>();

  private constructor(
    readonly device: Device,
    readonly capabilities: number,
    private readonly chars: Record<keyof typeof CHARACTERISTIC, Characteristic>,
  ) {}

  get name() {
    return this.device.name || 'the box';
  }

  static async find() {
    const device = await bluetooth()!.requestDevice({ filters: [{ services: [IMPROV_SERVICE] }] });
    const server = await device.gatt!.connect();
    const service = await server.getPrimaryService(IMPROV_SERVICE);
    const entries = await Promise.all(
      (Object.keys(CHARACTERISTIC) as (keyof typeof CHARACTERISTIC)[]).map(
        async (key) => [key, await service.getCharacteristic(CHARACTERISTIC[key])] as const,
      ),
    );
    const chars = Object.fromEntries(entries) as Record<keyof typeof CHARACTERISTIC, Characteristic>;
    const box = new ImprovBox(device, bytes(await chars.capabilities.readValue())[0] ?? 0, chars);
    box.state = bytes(await chars.state.readValue())[0] ?? 0;
    box.error = bytes(await chars.error.readValue())[0] ?? 0;
    for (const kind of ['state', 'error', 'result'] as const) {
      chars[kind].addEventListener('characteristicvaluechanged', () => box.heard(kind, chars[kind].value));
      await chars[kind].startNotifications();
    }
    return box;
  }

  private heard(kind: 'state' | 'error' | 'result', view?: DataView) {
    if (!view) return;
    const value = bytes(view);
    let change: Change;
    if (kind === 'result') {
      try {
        change = { kind, ...parseResult(value) };
      } catch {
        return;
      }
    } else {
      change = { kind, value: value[0] ?? 0 };
      this[kind] = change.value;
    }
    for (const listener of this.listeners) listener(change);
  }

  /** Sends a command and waits for what ends it, or for an error the box reports meanwhile. */
  private async ask<T>(packet: Uint8Array, ends: (change: Change) => T | undefined, waitMs: number) {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => finish(() => reject(new Error('The box did not answer. Bring it closer and try again.'))),
        waitMs,
      );
      const listener = (change: Change) => {
        if (change.kind === 'error' && change.value) {
          finish(() => reject(new Error(ERROR_TEXT[change.value] ?? ERROR_TEXT[255])));
          return;
        }
        const done = ends(change);
        if (done !== undefined) finish(() => resolve(done));
      };
      const finish = (settle: () => void) => {
        clearTimeout(timer);
        this.listeners.delete(listener);
        settle();
      };
      this.listeners.add(listener);
      void (async () => {
        for (const part of chunks(packet)) await this.chars.command.writeValueWithResponse(part);
      })().catch((error: Error) => finish(() => reject(error)));
    });
  }

  scan() {
    return this.ask(
      rpcPacket(COMMAND.scan),
      (change) =>
        change.kind === 'result' && change.command === COMMAND.scan ? scannedNetworks(change.strings) : undefined,
      20_000,
    );
  }

  identify() {
    return this.chars.command.writeValueWithResponse(rpcPacket(COMMAND.identify));
  }

  /** Puts the box on the network: done once it says it is provisioned, with the link it returns. */
  async provision(ssid: string, password: string) {
    let link: string | undefined;
    await this.ask(
      wifiSettings(ssid, password),
      (change) => {
        if (change.kind === 'result' && change.command === COMMAND.wifiSettings) link = finishLink(change.strings);
        return change.kind === 'state' && change.value === STATE.provisioned ? true : undefined;
      },
      90_000,
    );
    if (!link) {
      try {
        link = finishLink(parseResult(bytes(await this.chars.result.readValue())).strings);
      } catch {
        /* none sent */
      }
    }
    return link;
  }

  disconnect() {
    this.device.gatt?.disconnect();
  }
}

/** The person cancelled the browser's chooser: nothing to say. */
const cancelled = (error: unknown) => error instanceof DOMException && error.name === 'NotFoundError';

export function boxSetupDialog() {
  const body = openDialog('Set up a Zirbel box');
  if (!bluetooth()) {
    body.append(
      el('p', 'This browser can’t use Bluetooth.'),
      el(
        'p',
        'While the box waits for Wi-Fi, it also opens a Wi-Fi network called “Zirbel setup”. Join it on this phone or computer, and the box’s setup page opens.',
      ),
      el('p', 'Chrome, Edge and the Zirbel desktop app can set up the box over Bluetooth instead.'),
    );
    return;
  }
  body.append(
    el(
      'p',
      'Start the box and keep it near. A box without Wi-Fi waits for it over Bluetooth for a while after it starts.',
    ),
    action(
      'Find the box',
      async () => {
        let box: ImprovBox;
        try {
          box = await ImprovBox.find();
        } catch (error) {
          if (cancelled(error)) return;
          throw error;
        }
        dialog.addEventListener('close', () => box.disconnect(), { once: true });
        networkStep(box);
      },
      'primary',
    ),
  );
}

function networkStep(box: ImprovBox, failure = '') {
  const body = openDialog('Set up ' + box.name);
  if (failure) body.append(el('p', failure, 'error'));
  const form = el('form');
  const pick = el('select');
  pick.name = 'network';
  pick.setAttribute('aria-label', 'Wi-Fi network');
  const other = el('input');
  other.name = 'other';
  other.placeholder = 'Network name';
  other.autocomplete = 'off';
  other.spellcheck = false;
  const password = el('input');
  password.type = 'password';
  password.name = 'password';
  password.autocomplete = 'off';
  const passwordLabel = el('label', 'Password');
  passwordLabel.append(password);
  const otherLabel = el('label', 'Network name');
  otherLabel.append(other);
  const join = el('button', 'Join', 'primary');
  join.type = 'submit';
  const fill = (networks: ScannedNetwork[]) => {
    pick.replaceChildren(
      ...networks.map((network) => {
        const option = el('option', network.ssid + (network.auth === 'NO' ? '' : ' 🔒'));
        option.value = network.ssid;
        return option;
      }),
      Object.assign(el('option', 'Another network…'), { value: '' }),
    );
    otherLabel.hidden = pick.value !== '';
  };
  pick.addEventListener('change', () => {
    otherLabel.hidden = pick.value !== '';
  });
  fill([]);
  form.append(pick, otherLabel, passwordLabel, join);
  body.append(el('p', 'Choose the Wi-Fi network the box should join.'), form);
  if (box.capabilities & CAPABILITY.identify) body.append(action('Blink the box’s light', () => box.identify()));
  if (box.capabilities & CAPABILITY.scan)
    void box.scan().then(fill, () => {
      /* the person types the name instead */
    });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const ssid = pick.value || other.value.trim();
    if (!ssid) {
      inform('Choose a network, or type its name.', true);
      return;
    }
    joiningStep(box, ssid, password.value);
  });
}

function joiningStep(box: ImprovBox, ssid: string, password: string) {
  const body = openDialog('Set up ' + box.name);
  body.append(el('p', `${box.name} is joining ${ssid}…`));
  box.provision(ssid, password).then(
    (link) => doneStep(box, ssid, link),
    (error: Error) => networkStep(box, error.message),
  );
}

function doneStep(box: ImprovBox, ssid: string, link: string | undefined) {
  const body = openDialog('Set up ' + box.name);
  body.append(el('p', `${box.name} is on ${ssid}.`));
  if (!link) {
    body.append(el('p', 'Open http://zirbel.local on a device on the same network.'));
    return;
  }
  // Opened from the person's click, which a browser lets open a window; in the desktop app it opens in the browser.
  body.append(
    el(
      'p',
      'Open its editor on this device, on the same network, and tap Pair this device. The link works once, for 10 minutes.',
    ),
    action(
      'Open Zirbel on the box',
      () => {
        window.open(link, '_blank', 'noopener,noreferrer');
      },
      'primary',
    ),
    el('p', link),
  );
}
