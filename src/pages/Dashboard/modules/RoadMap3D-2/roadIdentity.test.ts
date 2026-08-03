import { describe, expect, it } from 'vitest';
import { roadTrackKey } from './roadIdentity';

const coordinates = [[113.1, 23.1], [112.7, 23.3]] as const;

describe('RM2 road identity', () => {
    it('shares one road for multiple vehicles on the same route', () => {
        const first = roadTrackKey('vehicle-line-1', coordinates, { pathKey: 'same-route' });
        const second = roadTrackKey('vehicle-line-2', coordinates, { pathKey: 'same-route' });

        expect(first).toBe('route:same-route');
        expect(second).toBe(first);
    });

    it('keeps different routes and baseline roads separate', () => {
        expect(roadTrackKey('vehicle-line-1', coordinates, { pathKey: 'route-a' }))
            .not.toBe(roadTrackKey('vehicle-line-2', coordinates, { pathKey: 'route-b' }));
        expect(roadTrackKey('baseline', coordinates, { pathKey: 'route-a', isBaselineRoute: true }))
            .toBe('baseline:route-a');
    });
});
