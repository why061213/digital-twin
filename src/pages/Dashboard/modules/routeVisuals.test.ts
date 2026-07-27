import { describe, expect, it } from 'vitest';
import { configureSharedProgressMaterial, createSharedProgressMaterial } from './routeVisuals';

describe('route snake overlay material', () => {
    it('uses a dedicated top overlay mode without depth occlusion', () => {
        const material = createSharedProgressMaterial('snake');

        expect(material.uniforms.uLayerMode.value).toBe(3);
        expect(material.depthTest).toBe(false);
        expect(material.depthWrite).toBe(false);

        material.dispose();
    });

    it('keeps the travelled base route depth-tested', () => {
        const material = createSharedProgressMaterial('travelled');

        expect(material.uniforms.uLayerMode.value).toBe(2);
        expect(material.depthTest).toBe(true);

        material.dispose();
    });

    it('keeps actual route speed identical across different prime frequencies', () => {
        const first = createSharedProgressMaterial('snake');
        const second = createSharedProgressMaterial('snake');
        configureSharedProgressMaterial(first, 0x3b82f6, 'route-blue-a');
        configureSharedProgressMaterial(second, 0xf59e0b, 'route-orange-b');

        expect(first.uniforms.uSnakeFrequency.value).not.toBe(second.uniforms.uSnakeFrequency.value);
        const firstRouteSpeed = first.uniforms.uSnakeSpeed.value / first.uniforms.uSnakeFrequency.value;
        const secondRouteSpeed = second.uniforms.uSnakeSpeed.value / second.uniforms.uSnakeFrequency.value;
        expect(firstRouteSpeed).toBeCloseTo(secondRouteSpeed, 10);

        first.dispose();
        second.dispose();
    });

    it('uses one low frequency and one segment length for RM2 routes', () => {
        const first = createSharedProgressMaterial('snake');
        const second = createSharedProgressMaterial('snake');
        configureSharedProgressMaterial(first, 0x3b82f6, 'route-blue-a', 'rm2-synchronized');
        configureSharedProgressMaterial(second, 0xf59e0b, 'route-orange-b', 'rm2-synchronized');

        expect(first.uniforms.uSnakeFrequency.value).toBe(5);
        expect(second.uniforms.uSnakeFrequency.value).toBe(5);
        expect(first.uniforms.uSnakeLength.value).toBeCloseTo(0.24, 10);
        expect(second.uniforms.uSnakeLength.value).toBeCloseTo(0.24, 10);

        first.dispose();
        second.dispose();
    });
});
