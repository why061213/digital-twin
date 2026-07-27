import { describe, expect, it } from 'vitest';
import {
    removedSceneRouteIds,
    routeRequiresSync,
    sceneRouteId,
    tripBusinessStage,
} from './rm2RouteIdentity';

const coordinates = [[113, 23], [114, 24]] as const;

describe('RM2 Trip identity and route replacement', () => {
    it('keeps one scene vehicle while the same visualKey changes Leg', () => {
        const previous = { lineId: 'line-old', visualKey: 'trip-1', currentLegId: 'leg-1', planVersion: 1, coordinates };
        const next = { lineId: 'line-new', visualKey: 'trip-1', currentLegId: 'leg-2', planVersion: 2, coordinates };

        expect(sceneRouteId(previous)).toBe('trip-1');
        expect(sceneRouteId(next)).toBe('trip-1');
        expect(routeRequiresSync(previous, next)).toBe(true);
        expect(removedSceneRouteIds([previous], [next])).toEqual([]);
    });

    it('replaces geometry when lineId stays unchanged', () => {
        const previous = { lineId: 'line-1', visualKey: 'trip-1', coordinates };
        const next = { lineId: 'line-1', visualKey: 'trip-1', coordinates: [[113, 23], [115, 25]] as const };

        expect(routeRequiresSync(previous, next)).toBe(true);
    });

    it('does not rebuild a route for a state-only GPS update', () => {
        const previous = { lineId: 'line-1', visualKey: 'trip-1', currentLegId: 'leg-1', planVersion: 1, coordinates, tripDecision: 'ARRIVED' };
        const next = { ...previous, tripDecision: 'LOADING' };

        expect(routeRequiresSync(previous, next)).toBe(false);
        expect(tripBusinessStage(previous)).toBe('已到达');
        expect(tripBusinessStage(next)).toBe('装货中');
        expect(tripBusinessStage({ ...next, tripDecision: 'EN_ROUTE_TO_DELIVERY' })).toBe('前往卸货点');
        expect(tripBusinessStage({ ...next, tripDecision: 'UNLOADING' })).toBe('卸货中');
    });

    it('removes the stable scene object after the final Trip completes', () => {
        const previous = { lineId: 'line-1', visualKey: 'trip-1', coordinates };

        expect(removedSceneRouteIds([previous], [])).toEqual(['trip-1']);
        expect(tripBusinessStage({ ...previous, tripDecision: 'TRIP_COMPLETED_LOCAL' })).toBe('已完成');
    });
});
