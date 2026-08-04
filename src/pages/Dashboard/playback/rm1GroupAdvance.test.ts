import { describe, expect, it } from 'vitest';
import { singleRm1GroupAction } from './rm1GroupAdvance';

describe('RM1 single-group advance', () => {
    it('ends the RM1 round after the only group completes', () => {
        expect(singleRm1GroupAction(true, true)).toBe('exhaust');
    });

    it('ends the RM1 round when the only group disappears from the refreshed snapshot', () => {
        expect(singleRm1GroupAction(false, false)).toBe('exhaust');
    });

    it('replays the only group while it still has unfinished routes', () => {
        expect(singleRm1GroupAction(true, false)).toBe('replay');
    });
});
