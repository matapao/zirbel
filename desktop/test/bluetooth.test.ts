import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { BluetoothDevice, WebContents } from 'electron';
import { chooseBluetooth, chooserButtons } from '../src/bluetooth.js';

const timing = { gatherMs: 20, giveUpMs: 120, recheckMs: 10 };
const box = (deviceName: string, deviceId = deviceName.toLowerCase()): BluetoothDevice => ({ deviceName, deviceId });

/** A page asking for a device, as Chromium tells the app: again with each device it finds, and the answer it gets. */
function page(allowed: boolean, choose: (buttons: string[], cancelId: number) => number) {
  const contents = new EventEmitter() as unknown as WebContents;
  const asked: string[][] = [];
  chooseBluetooth(
    contents,
    () => allowed,
    async (_contents, buttons, cancelId) => {
      asked.push(buttons);
      return choose(buttons, cancelId);
    },
    timing,
  );
  const answers: string[] = [];
  let prevented = 0;
  const found = (devices: BluetoothDevice[]) =>
    (contents as unknown as EventEmitter).emit(
      'select-bluetooth-device',
      { preventDefault: () => prevented++ },
      devices,
      (id: string) => answers.push(id),
    );
  const settled = () =>
    new Promise<void>((resolve) => {
      const check = () => (answers.length ? resolve() : setTimeout(check, 5));
      check();
    });
  return { found, answers, asked, settled, prevented: () => prevented };
}

test('the chooser names each box, at most six, then Cancel', () => {
  const { buttons, cancelId } = chooserButtons([box('Zirbel-3456'), { deviceName: '', deviceId: 'x' }]);
  assert.deepEqual(buttons, ['Zirbel-3456', 'Unnamed box', 'Cancel']);
  assert.equal(cancelId, 2);
  assert.equal(chooserButtons(Array.from({ length: 9 }, (_, index) => box('Box ' + index))).cancelId, 6);
});

test('the editor’s page gets the box chosen from what was found by the time the chooser shows', async () => {
  const request = page(true, (buttons) => buttons.indexOf('Zirbel-BEEF'));
  request.found([box('Zirbel-3456')]);
  request.found([box('Zirbel-3456'), box('Zirbel-BEEF')]);
  await request.settled();
  assert.deepEqual(request.answers, ['zirbel-beef']);
  assert.deepEqual(request.asked, [['Zirbel-3456', 'Zirbel-BEEF', 'Cancel']]);
  assert.equal(request.prevented(), 2);
});

test('Cancel, another page, or no box found in time answer with no device', async () => {
  const cancelled = page(true, (_buttons, cancelId) => cancelId);
  cancelled.found([box('Zirbel-3456')]);
  await cancelled.settled();
  assert.deepEqual(cancelled.answers, ['']);
  const other = page(false, () => 0);
  other.found([box('Zirbel-3456')]);
  assert.deepEqual(other.answers, ['']);
  assert.deepEqual(other.asked, []);
  const none = page(true, () => 0);
  none.found([]);
  await none.settled();
  assert.deepEqual(none.answers, ['']);
  assert.deepEqual(none.asked, []);
});
