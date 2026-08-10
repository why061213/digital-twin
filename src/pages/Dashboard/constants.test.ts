import { describe, expect, it } from 'vitest';
import { RM1_SINGLE_GROUP_DISPLAY_MIN_MS, roadGroupDisplayMs } from './constants';

describe('roadGroupDisplayMs', () => {
    it('keeps the normal route-count based duration for multi-group playback', () => {
        expect(roadGroupDisplayMs(1)).toBe(8_200);
    });

    it('applies the RM1 minimum hold when only one group exists', () => {
        expect(roadGroupDisplayMs(1, true)).toBe(RM1_SINGLE_GROUP_DISPLAY_MIN_MS);
    });
});
