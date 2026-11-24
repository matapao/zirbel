// Split from workspace.ts; shares state through ws in state.ts.
// A staged proposal as a card in the thread: Apply, Discard, and a Before/After switch that flips the running game
// between the saved revision and the proposal. Several proposals share the card as options.
import { $, action, api, el } from './editor-ui.ts';
import { ws } from './state.ts';
import { refreshProject, route, showProposal } from './workspace.ts';

function segment(label: string, pressed: boolean, run: () => void | Promise<void>) {
  const button = action(label, run);
  button.setAttribute('aria-pressed', String(pressed));
  return button;
}

export function renderProposalCard() {
  const host = $('proposal-card');
  if (!host) return;
  host.replaceChildren();
  if (!ws.project || !ws.proposals.length) return;
  const chosen = ws.proposals.find(({ id }) => id === ws.proposalChoice) ?? ws.proposals[0]!;
  const after = ws.candidate?.proposal.id === chosen.id;
  const card = el('section', undefined, 'proposal');
  card.setAttribute('aria-labelledby', 'proposal-title');
  const title = el('strong', ws.proposals.length > 1 ? ws.proposals.length + ' proposed changes' : 'Proposed change');
  title.id = 'proposal-title';
  card.append(title);
  if (ws.proposals.length > 1) {
    const options = el('div', undefined, 'segments');
    options.setAttribute('role', 'group');
    options.setAttribute('aria-label', 'Options');
    for (const [index, proposal] of ws.proposals.entries()) {
      const button = segment('Option ' + (index + 1), proposal.id === chosen.id, () => {
        ws.proposalChoice = proposal.id;
        return after ? showProposal(proposal.id) : renderProposalCard();
      });
      button.title = proposal.label;
      options.append(button);
    }
    card.append(options);
  }
  card.append(el('p', chosen.label, 'proposal-label'));
  const compare = el('div', undefined, 'segments');
  compare.setAttribute('role', 'group');
  compare.setAttribute('aria-label', 'Compare in the running game');
  compare.append(
    segment('Before', !after, () => showProposal(undefined)),
    segment('After', after, () => showProposal(chosen.id)),
  );
  const decide = el('div', undefined, 'row proposal-actions');
  decide.append(
    action('Discard', async () => {
      await api(route('discard/' + chosen.id), {});
      ws.candidate = undefined;
      await refreshProject();
    }),
    action(
      'Apply',
      async () => {
        await api(route('apply/' + chosen.id), {});
        ws.candidate = undefined;
        ws.region = undefined;
        await refreshProject();
      },
      'primary',
    ),
  );
  card.append(compare, decide);
  host.append(card);
}
