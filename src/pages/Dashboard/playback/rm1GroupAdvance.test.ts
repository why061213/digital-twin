import { describe, expect, it } from 'vitest';
import { singleRm1GroupAction } from './rm1GroupAdvance';

describe('RM1 single-group advance', () => {
    it('ends the RM1 round after advancing the only group', () => {
        expect(singleRm1GroupAction(1)).toBe('exhaust');
    });

    it('ends the RM1 round when the refreshed snapshot is empty', () => {
        expect(singleRm1GroupAction(0)).toBe('exhaust');
    });

    it('continues traversal when refresh discovers another group', () => {
        expect(singleRm1GroupAction(2)).toBe('traverse');
    });
});
