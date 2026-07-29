import { describe, expect, it } from 'vitest';
import type { RoadPathMessage } from './useDashboardRealtime';
import type { Rm2GroupDTO } from '../services/renderRouteApi';
import { advanceRm2LoopCounter, assignRm2RouteColorSlots } from './useRm2PlaybackController';

function route(lineId: string, businessLineId: string): RoadPathMessage {
    return {
        type: 'road_path',
        lineId,
        orderId: 'shared-trip-order-id',
        orderFamilyId: businessLineId,
        colorKey: 'same-origin-or-destination',
        coordinates: [[113, 23], [114, 24]],
    };
}

describe('RM2 visible-group color slots', () => {
    it('does not collide when different orders share an origin or destination', () => {
        const group = {
            orderLineIds: ['order-a', 'order-b', 'order-c'],
            vehicleLineIdsByOrderLineId: {
                'order-a': ['vehicle-a'],
                'order-b': ['vehicle-b'],
                'order-c': ['vehicle-c'],
            },
        } satisfies Pick<Rm2GroupDTO, 'orderLineIds' | 'vehicleLineIdsByOrderLineId'>;

        const assigned = assignRm2RouteColorSlots([
            route('vehicle-a', 'order-a'),
            route('vehicle-b', 'order-b'),
            route('vehicle-c', 'order-c'),
        ], group);

        expect(assigned.map((item) => item.routeColorIndex)).toEqual([0, 1, 2]);
        expect(new Set(assigned.map((item) => item.routeColorIndex)).size).toBe(3);
    });

    it('keeps vehicles from the same order on the same slot', () => {
        const group = {
            orderLineIds: ['order-a'],
            vehicleLineIdsByOrderLineId: { 'order-a': ['vehicle-a1', 'vehicle-a2'] },
        } satisfies Pick<Rm2GroupDTO, 'orderLineIds' | 'vehicleLineIdsByOrderLineId'>;

        const assigned = assignRm2RouteColorSlots([
            route('vehicle-a1', 'order-a'),
            route('vehicle-a2', 'order-a'),
        ], group);

        expect(assigned.map((item) => item.routeColorIndex)).toEqual([0, 0]);
    });
});

describe('RM2 internal loop counter', () => {
    it('increments only when playback wraps from the tail to the head', () => {
        expect(advanceRm2LoopCounter(0, 'group-2', 'group-1', 2)).toEqual({
            cycleCompleted: false,
            completedLoopCount: 0,
            shouldExit: false,
        });
        expect(advanceRm2LoopCounter(0, 'group-1', 'group-1', 2)).toEqual({
            cycleCompleted: true,
            completedLoopCount: 1,
            shouldExit: false,
        });
    });

    it('exits after the configured number of complete loops', () => {
        expect(advanceRm2LoopCounter(1, 'group-1', 'group-1', 2)).toEqual({
            cycleCompleted: true,
            completedLoopCount: 2,
            shouldExit: true,
        });
    });

    it('keeps looping when the configured limit is zero', () => {
        expect(advanceRm2LoopCounter(8, 'group-1', 'group-1', 0)).toEqual({
            cycleCompleted: true,
            completedLoopCount: 9,
            shouldExit: false,
        });
    });
});
