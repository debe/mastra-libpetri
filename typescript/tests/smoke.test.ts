import { describe, expect, it } from 'vitest';
import { PetriNet, Transition, place, one, outPlace, tokenOf, PrecompiledNetExecutor, Marking } from 'libpetri';

/** The net runs at all, through the executor this engine uses. */
describe('smoke', () => {
  it('fires a transition and moves a token', async () => {
    const input = place<string>('smoke/input');
    const output = place<string>('smoke/output');
    const move = Transition.builder('smoke/move')
      .inputs(one(input))
      .outputs(outPlace(output))
      .action(async (ctx) => { ctx.output(output, ctx.input(input)); })
      .build();

    const net = PetriNet.builder('smoke').transitions(move).build();
    const executor = new PrecompiledNetExecutor(net, new Map([[input, [tokenOf('ok')]]]));
    const marking: Marking = await executor.run(5_000, 'close');

    expect(marking.peekFirst(output)?.value).toBe('ok');
    expect(marking.tokenCount(input)).toBe(0);
  });
});
