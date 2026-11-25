// A main process for view-game.test.ts: Electron renders the request it is given (VIEW_REQUEST) with view-game.ts, as
// the app does for the editor, prints the result as one JSON line and quits. Its profile is the test's (VIEW_PROFILE).
import { app } from 'electron';
import { answerView, VIEW_GAME } from '../src/view-game.js';

app.setPath('userData', process.env.VIEW_PROFILE ?? app.getPath('temp'));
app.enableSandbox();
app.on('window-all-closed', () => undefined);
void app.whenReady().then(async () => {
  const messages: unknown[] = [];
  for (const message of JSON.parse(process.env.VIEW_MESSAGES ?? '[]') as unknown[])
    await answerView(message, (reply) => messages.push(reply));
  await answerView({ type: VIEW_GAME, id: 'render', request: JSON.parse(process.env.VIEW_REQUEST ?? '{}') as unknown },
    (reply) => messages.push(reply));
  process.stdout.write(JSON.stringify(messages) + '\n');
  app.quit();
});
