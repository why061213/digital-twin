import { describe, expect, it } from 'vitest';
import { configureSharedProgressMaterial, createSharedProgressMaterial } from './routeVisuals';

describe('route snake overlay material', () => {
    it('uses a dedicated overlay mode that remains occluded by vehicles', () => {
        const material = createSharedProgressMaterial('snake');

        expect(material.uniforms.uLayerMode.value).toBe(3);
        expect(material.depthTest).toBe(true);
        expect(material.depthWrite).toBe(false);
        expect(material.fragmentShader).not.toContain('currentHead');

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

    it('uses one absolute world speed, spacing and segment length for all RM2 routes', () => {
        const first = createSharedProgressMaterial('snake');
        const second = createSharedProgressMaterial('snake');
        configureSharedProgressMaterial(first, 0x3b82f6, 'route-blue-a', 'rm2-synchronized', 20);
        configureSharedProgressMaterial(second, 0xf59e0b, 'route-orange-b', 'rm2-synchronized', 200);

        expect(first.uniforms.uUseWorldMotion.value).toBe(1);
        expect(second.uniforms.uUseWorldMotion.value).toBe(1);
        expect(first.uniforms.uRouteLength.value).toBe(20);
        expect(second.uniforms.uRouteLength.value).toBe(200);
        expect(first.uniforms.uSnakeWorldSpeed.value).toBe(second.uniforms.uSnakeWorldSpeed.value);
        expect(first.uniforms.uSnakeWorldSpacing.value).toBe(second.uniforms.uSnakeWorldSpacing.value);
        expect(first.uniforms.uSnakeWorldLength.value).toBe(second.uniforms.uSnakeWorldLength.value);

        first.dispose();
        second.dispose();
    });
});
