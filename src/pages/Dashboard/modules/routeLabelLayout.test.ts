import { describe, expect, it } from 'vitest';
import { arrangeRouteLabelRects, type RouteLabelLayoutInput } from './routeLabelLayout';

const overlappingLabels: RouteLabelLayoutInput[] = [
    { id: 'current', x: 400, y: 300, width: 260, height: 34, priority: 0 },
    { id: 'next', x: 402, y: 302, width: 260, height: 34, priority: 20 },
    { id: 'later', x: 398, y: 299, width: 260, height: 34, priority: 30 },
];

describe('route label collision layout', () => {
    it('keeps the priority label at its anchor and separates nearby labels', () => {
        const placements = arrangeRouteLabelRects(overlappingLabels, { width: 800, height: 600 });
        expect(placements.get('current')).toEqual({ x: 400, y: 300 });
        expect(new Set([...placements.values()].map(({ x, y }) => `${x}:${y}`)).size).toBe(3);
        expect(placements.get('next')?.y).not.toBe(placements.get('current')?.y);
    });

    it('keeps displaced labels inside the viewport', () => {
        const placements = arrangeRouteLabelRects(
            overlappingLabels.map((label) => ({ ...label, x: 5, y: 5 })),
            { width: 800, height: 600 },
        );
        placements.forEach(({ x, y }) => {
            expect(x).toBeGreaterThan(0);
            expect(y).toBeGreaterThan(0);
            expect(x).toBeLessThan(800);
            expect(y).toBeLessThan(600);
        });
    });
});
