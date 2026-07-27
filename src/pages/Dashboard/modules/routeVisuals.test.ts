import { describe, expect, it } from 'vitest';
import { createSharedProgressMaterial } from './routeVisuals';

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
});
