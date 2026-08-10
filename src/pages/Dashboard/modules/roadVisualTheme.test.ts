import { describe, expect, it } from 'vitest';
import { ROUTE_COLORS, branchRouteColors, routeColorFor } from './roadVisualTheme';

describe('shared road visual theme', () => {
    it('honours the backend route color slot', () => {
        expect(routeColorFor('order-a', 1)).toBe(ROUTE_COLORS[1]);
    });

    it('assigns a stable fallback color', () => {
        expect(routeColorFor('order-a')).toBe(routeColorFor('order-a'));
    });

    it('derives stable branch and snake colors', () => {
        expect(branchRouteColors(ROUTE_COLORS[0], 'branch-a'))
            .toEqual(branchRouteColors(ROUTE_COLORS[0], 'branch-a'));
    });
});
