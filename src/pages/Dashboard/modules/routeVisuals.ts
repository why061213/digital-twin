/* Hallmark · pre-emit critique: P4 H4 E4 S5 R4 V4 */
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

/* Hallmark: restrained route hierarchy for an operational map surface. */
type RouteVisualPreset = {
    foundationRadius: number;
    flowRadius: number;
    edgeOffset: number;
    edgeRadius: number;
    markerScale: number;
    flowRepeats: number;
    screenCoreWidth: number;
    screenGlowWidth: number;
};

const PRESETS: Record<'rm1' | 'rm2', RouteVisualPreset> = {
    rm1: {
        foundationRadius: 0.32,
        flowRadius: 0.21,
        edgeOffset: 0.34,
        edgeRadius: 0.024,
        markerScale: 0.28,
        flowRepeats: 22,
        screenCoreWidth: 5,
        screenGlowWidth: 10,
    },
    rm2: {
        foundationRadius: 0.76,
        flowRadius: 0.49,
        edgeOffset: 0.8,
        edgeRadius: 0.055,
        markerScale: 0.62,
        flowRepeats: 18,
        screenCoreWidth: 7,
        screenGlowWidth: 14,
    },
};

function createScreenSpaceLine(samples: THREE.Vector3[], color: number, width: number, opacity: number) {
    const geometry = new LineGeometry();
    geometry.setPositions(samples.flatMap((point) => [point.x, point.y, point.z]));
    const material = new LineMaterial({
        color,
        linewidth: width,
        transparent: true,
        opacity,
        depthWrite: false,
        worldUnits: false,
    });
    const line = new Line2(geometry, material);
    line.computeLineDistances();
    line.onBeforeRender = (renderer) => {
        material.resolution.set(renderer.domElement.width, renderer.domElement.height);
    };
    return line;
}

function offsetCurve(samples: THREE.Vector3[], offset: number) {
    const points = samples.map((point, index) => {
        const previous = samples[Math.max(0, index - 1)] ?? point;
        const next = samples[Math.min(samples.length - 1, index + 1)] ?? point;
        const tangent = next.clone().sub(previous);
        if (tangent.lengthSq() < 0.000001) tangent.set(1, 0, 0);
        tangent.normalize();
        const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
        return point.clone().addScaledVector(normal, offset);
    });

    const curve = new THREE.CurvePath<THREE.Vector3>();
    for (let index = 1; index < points.length; index += 1) {
        curve.add(new THREE.LineCurve3(points[index - 1], points[index]));
    }
    return curve;
}

function createEndpointMarker(
    point: THREE.Vector3,
    radius: number,
    color: number,
    renderOrder: number,
) {
    const marker = new THREE.Group();
    marker.position.copy(point);
    marker.position.y += radius * 0.42;

    const halo = new THREE.Mesh(
        new THREE.RingGeometry(radius * 1.45, radius * 1.78, 32),
        new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.22,
            side: THREE.DoubleSide,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        }),
    );
    halo.rotation.x = -Math.PI / 2;
    halo.renderOrder = renderOrder;

    const core = new THREE.Mesh(
        new THREE.CircleGeometry(radius * 0.52, 24),
        new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.86,
            side: THREE.DoubleSide,
            depthWrite: false,
        }),
    );
    core.rotation.x = -Math.PI / 2;
    core.position.y = radius * 0.015;
    core.renderOrder = renderOrder + 1;
    marker.add(halo, core);
    return marker;
}

function createFlowMaterial(repeats: number) {
    return new THREE.ShaderMaterial({
        uniforms: {
            uTime: { value: 0 },
            uColor: { value: new THREE.Color(0xa5f3fc) },
            uRepeats: { value: repeats },
        },
        vertexShader: `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            uniform float uTime;
            uniform float uRepeats;
            uniform vec3 uColor;
            varying vec2 vUv;
            void main() {
                float phase = fract(vUv.x * uRepeats - uTime * 0.34);
                float dash = smoothstep(0.02, 0.13, phase) * (1.0 - smoothstep(0.32, 0.48, phase));
                float crown = 0.42 + 0.58 * pow(abs(sin(vUv.y * 3.14159265)), 5.0);
                float alpha = dash * crown * 0.46;
                if (alpha < 0.025) discard;
                gl_FragColor = vec4(uColor, alpha);
            }
        `,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
    });
}

export function createRouteVisualLayers(
    pathCurve: THREE.CurvePath<THREE.Vector3>,
    tubularSegments: number,
    radialSegments: number,
    samples: THREE.Vector3[],
    mode: 'rm1' | 'rm2',
) {
    const preset = PRESETS[mode];
    const layers = new THREE.Group();
    layers.name = `route-visual-layers-${mode}`;

    const screenGlow = createScreenSpaceLine(samples, 0x38bdf8, preset.screenGlowWidth, 0.12);
    screenGlow.renderOrder = 0;
    const screenCore = createScreenSpaceLine(samples, 0x07111d, preset.screenCoreWidth, 0.88);
    screenCore.renderOrder = 1;

    const foundation = new THREE.Mesh(
        new THREE.TubeGeometry(
            pathCurve,
            tubularSegments,
            preset.foundationRadius,
            radialSegments,
            false,
        ),
        new THREE.MeshBasicMaterial({
            color: 0x07111d,
            transparent: true,
            opacity: 0.72,
            depthWrite: false,
        }),
    );
    foundation.renderOrder = 1;

    const edgeSamples = pathCurve.getSpacedPoints(Math.min(160, Math.max(32, samples.length - 1)));
    const leftEdge = new THREE.Mesh(
        new THREE.TubeGeometry(
            offsetCurve(edgeSamples, preset.edgeOffset),
            Math.min(tubularSegments, 160),
            preset.edgeRadius,
            4,
            false,
        ),
        new THREE.MeshBasicMaterial({
            color: 0x7dd3fc,
            transparent: true,
            opacity: 0.42,
            depthWrite: false,
        }),
    );
    const rightEdge = leftEdge.clone();
    rightEdge.geometry = new THREE.TubeGeometry(
        offsetCurve(edgeSamples, -preset.edgeOffset),
        Math.min(tubularSegments, 160),
        preset.edgeRadius,
        4,
        false,
    );
    rightEdge.material = (leftEdge.material as THREE.MeshBasicMaterial).clone();
    leftEdge.renderOrder = 3;
    rightEdge.renderOrder = 3;

    const flowMaterial = createFlowMaterial(preset.flowRepeats);
    const flow = new THREE.Mesh(
        new THREE.TubeGeometry(
            pathCurve,
            tubularSegments,
            preset.flowRadius,
            radialSegments,
            false,
        ),
        flowMaterial,
    );
    flow.renderOrder = 8;
    flow.onBeforeRender = () => {
        flowMaterial.uniforms.uTime.value = performance.now() / 1_000;
    };

    const start = createEndpointMarker(samples[0], preset.markerScale, 0x67e8f9, 10);
    const end = createEndpointMarker(samples[samples.length - 1], preset.markerScale, 0xfbbf24, 10);
    layers.add(screenGlow, screenCore, foundation, leftEdge, rightEdge, flow, start, end);
    return layers;
}
