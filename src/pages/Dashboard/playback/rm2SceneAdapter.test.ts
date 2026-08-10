import { describe, expect, it } from 'vitest';
import type { Rm2GroupDTO } from '../services/renderRouteApi';
import { buildRm2RouteColorIndexes } from './rm2SceneAdapter';

describe('RM2 route color allocation', () => {
    it('keeps different business orders in different slots even when their trip orderId is shared', () => {
        const group = {
            groupId: 'group-1',
            groupName: 'test group',
            index: 0,
            count: 3,
            orderLineIds: ['order-line-a', 'order-line-b', 'order-line-c'],
            vehicleLineIds: ['vehicle-a1', 'vehicle-a2', 'vehicle-b1', 'vehicle-c1'],
            vehicleLineIdsByOrderLineId: {
                'order-line-a': ['vehicle-a1', 'vehicle-a2'],
                'order-line-b': ['vehicle-b1'],
                'order-line-c': ['vehicle-c1'],
            },
            vehicleCount: 4,
            mapKey: 'map-1',
            fromProvinceKey: '44',
            toProvinceKey: '45',
            directionKey: '44-45',
            renderProvinceKeys: ['440000', '450000'],
            pageIndex: 0,
        } satisfies Rm2GroupDTO;

        const indexes = buildRm2RouteColorIndexes(group);

        expect(indexes.byBusinessLineId.get('order-line-a')).toBe(0);
        expect(indexes.byBusinessLineId.get('order-line-b')).toBe(1);
        expect(indexes.byBusinessLineId.get('order-line-c')).toBe(2);
        expect(indexes.byVehicleLineId.get('vehicle-a2')).toBe(0);
        expect(indexes.byVehicleLineId.get('vehicle-b1')).toBe(1);
        expect(indexes.byVehicleLineId.get('vehicle-c1')).toBe(2);
    });
});
