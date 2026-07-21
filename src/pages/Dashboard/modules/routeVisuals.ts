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

type RouteEndpointInfo = {
    from?: string;
    to?: string;
    plate?: string;
    orderId?: string;
    orderName?: string;
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
    mode: 'rm1' | 'rm2',
) {
    const marker = new THREE.Group();
    marker.position.copy(point);
    marker.position.y += radius * 0.08;

    const halo = new THREE.Mesh(
        new THREE.RingGeometry(radius * 0.72, radius * 1.08, 32),
        new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.3,
            side: THREE.DoubleSide,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        }),
    );
    halo.rotation.x = -Math.PI / 2;
    halo.renderOrder = renderOrder;

    const stemHeight = radius * 2.15;
    const stem = new THREE.Mesh(
        new THREE.CylinderGeometry(radius * 0.085, radius * 0.12, stemHeight, 12),
        new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.92,
            depthWrite: false,
        }),
    );
    stem.position.y = stemHeight / 2;
    stem.renderOrder = renderOrder + 1;

    const pinShape = new THREE.Shape();
    pinShape.moveTo(0, -radius * 0.96);
    pinShape.bezierCurveTo(
        -radius * 0.18, -radius * 0.64,
        -radius * 0.72, -radius * 0.22,
        -radius * 0.72, radius * 0.3,
    );
    pinShape.bezierCurveTo(
        -radius * 0.72, radius * 0.78,
        -radius * 0.4, radius * 1.08,
        0, radius * 1.08,
    );
    pinShape.bezierCurveTo(
        radius * 0.4, radius * 1.08,
        radius * 0.72, radius * 0.78,
        radius * 0.72, radius * 0.3,
    );
    pinShape.bezierCurveTo(
        radius * 0.72, -radius * 0.22,
        radius * 0.18, -radius * 0.64,
        0, -radius * 0.96,
    );

    const pin = new THREE.Mesh(
        new THREE.ShapeGeometry(pinShape, 8),
        new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.98,
            side: THREE.DoubleSide,
            depthTest: false,
            depthWrite: false,
        }),
    );
    pin.position.y = stemHeight + radius * 0.82;
    pin.renderOrder = renderOrder + 3;

    const pinCore = new THREE.Mesh(
        new THREE.CircleGeometry(radius * 0.23, 20),
        new THREE.MeshBasicMaterial({
            color: 0xf8fafc,
            transparent: true,
            opacity: 0.96,
            side: THREE.DoubleSide,
            depthTest: false,
            depthWrite: false,
        }),
    );
    pinCore.position.set(0, pin.position.y + radius * 0.28, radius * 0.012);
    pinCore.renderOrder = renderOrder + 4;

    const worldPosition = new THREE.Vector3();
    const referenceDistance = mode === 'rm2' ? 120 : 190;
    pin.onBeforeRender = (_renderer, _scene, camera) => {
        pin.quaternion.copy(camera.quaternion);
        pinCore.quaternion.copy(camera.quaternion);
        const distance = camera.position.distanceTo(marker.getWorldPosition(worldPosition));
        marker.scale.setScalar(THREE.MathUtils.clamp(distance / referenceDistance, 0.92, 1.75));
    };

    marker.add(halo, stem, pin, pinCore);
    return marker;
}

function endpointMarkerPoint(
    samples: THREE.Vector3[],
    atStart: boolean,
    laneIndex: number,
    markerScale: number,
) {
    const index = atStart ? 0 : samples.length - 1;
    const neighbourIndex = atStart ? Math.min(1, samples.length - 1) : Math.max(0, samples.length - 2);
    const point = samples[index].clone();
    const tangent = atStart
        ? samples[neighbourIndex].clone().sub(point)
        : point.clone().sub(samples[neighbourIndex]);
    if (tangent.lengthSq() < 0.000001) tangent.set(1, 0, 0);
    tangent.normalize();
    const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
    const laneOffset = [0, 1, -1][laneIndex % 3] ?? 0;
    return point.addScaledVector(normal, laneOffset * markerScale * 1.45);
}

function fullEndpoint(value: string | undefined) {
    const normalized = value?.replace(/\s+/g, ' ').trim();
    return normalized || '位置待确认';
}

function createEndpointLabel(
    point: THREE.Vector3,
    prefix: '起点' | '终点',
    value: string | undefined,
    color: string,
    mode: 'rm1' | 'rm2',
    laneIndex: number,
) {
    const canvas = document.createElement('canvas');
    const label = `${prefix} · ${fullEndpoint(value)}`;
    const fontWeight = prefix === '终点' ? 600 : 500;
    const font = `${fontWeight} 22px "Microsoft YaHei", sans-serif`;
    const measuringContext = canvas.getContext('2d');
    if (!measuringContext) return new THREE.Group();
    measuringContext.font = font;
    canvas.width = Math.max(320, Math.ceil(44 + measuringContext.measureText(label).width + 28));
    canvas.height = 88;
    const context = canvas.getContext('2d');
    if (!context) return new THREE.Group();

    context.fillStyle = color;
    context.beginPath();
    context.arc(22, 44, prefix === '终点' ? 8 : 6, 0, Math.PI * 2);
    context.fill();
    context.font = font;
    context.lineWidth = 7;
    context.strokeStyle = 'rgba(2, 8, 20, 0.92)';
    context.strokeText(label, 44, 54);
    context.fillText(label, 44, 54);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    const material = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
    });
    const sprite = new THREE.Sprite(material);
    const baseHeight = mode === 'rm2' ? 3.02 : 1.58;
    const baseScale = [baseHeight * (canvas.width / canvas.height), baseHeight];
    const referenceDistance = mode === 'rm2' ? 115 : 180;
    const offset = mode === 'rm2' ? 3.7 : 1.85;
    const offsetVariant = Array.from(value ?? prefix)
        .reduce((sum, character) => sum + character.charCodeAt(0), 0) % 3 - 1;
    const laneSpread = [0, 1, -1][laneIndex % 3] ?? 0;
    sprite.scale.set(baseScale[0], baseScale[1], 1);
    sprite.position.copy(point);
    sprite.position.x += (prefix === '起点' ? -offset : offset) + offsetVariant * (mode === 'rm2' ? 1.1 : 0.55);
    sprite.position.y += (mode === 'rm2' ? 0.86 : 0.42)
        + offsetVariant * (mode === 'rm2' ? 0.34 : 0.16)
        + laneSpread * (mode === 'rm2' ? 1.05 : 0.48);
    sprite.renderOrder = 58;
    const worldPosition = new THREE.Vector3();
    sprite.onBeforeRender = (_renderer, _scene, camera) => {
        const distance = camera.position.distanceTo(sprite.getWorldPosition(worldPosition));
        const distanceScale = THREE.MathUtils.clamp(distance / referenceDistance, 0.88, 2.25);
        sprite.scale.set(baseScale[0] * distanceScale, baseScale[1] * distanceScale, 1);
    };
    return sprite;
}

function colorText(color: number) {
    return `#${new THREE.Color(color).getHexString()}`;
}

export function createRouteEndpointLayer(
    samples: THREE.Vector3[],
    mode: 'rm1' | 'rm2',
    info: RouteEndpointInfo,
    color: number,
    laneIndex: number,
) {
    const preset = PRESETS[mode];
    const layer = new THREE.Group();
    const markerScale = preset.markerScale * (1 + laneIndex * 0.18);
    const startPoint = endpointMarkerPoint(samples, true, laneIndex, markerScale);
    const endPoint = endpointMarkerPoint(samples, false, laneIndex, markerScale);
    const start = createEndpointMarker(startPoint, markerScale, color, 10 + laneIndex, mode);
    const end = createEndpointMarker(endPoint, markerScale, 0xef4444, 10 + laneIndex, mode);
    const startLabel = createEndpointLabel(
        samples[0], '起点', info.from, colorText(color), mode, laneIndex,
    );
    const endLabel = createEndpointLabel(
        samples[samples.length - 1], '终点', info.to, '#ef4444', mode, laneIndex,
    );
    layer.add(start, end, startLabel, endLabel);
    return layer;
}

export function createSharedProgressMaterial() {
    return new THREE.ShaderMaterial({
        uniforms: {
            uTime: { value: 0 },
            uProgress: { value: new THREE.Vector3() },
            uColor0: { value: new THREE.Color(0x00ff88) },
            uColor1: { value: new THREE.Color(0x00ccff) },
            uColor2: { value: new THREE.Color(0xffaa00) },
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
            uniform vec3 uProgress;
            uniform vec3 uColor0;
            uniform vec3 uColor1;
            uniform vec3 uColor2;
            varying vec2 vUv;
            void main() {
                bool active0 = uProgress.x > 0.0001 && vUv.x <= uProgress.x;
                bool active1 = uProgress.y > 0.0001 && vUv.x <= uProgress.y;
                bool active2 = uProgress.z > 0.0001 && vUv.x <= uProgress.z;
                float activeCount = (active0 ? 1.0 : 0.0)
                    + (active1 ? 1.0 : 0.0)
                    + (active2 ? 1.0 : 0.0);
                if (activeCount < 0.5) discard;

                float phase = fract(vUv.x * 26.0 - uTime * 0.48);
                vec3 color = active0 ? uColor0 : (active1 ? uColor1 : uColor2);
                if (activeCount > 2.5) {
                    color = phase < 0.333 ? uColor0 : (phase < 0.666 ? uColor1 : uColor2);
                } else if (activeCount > 1.5) {
                    vec3 first = active0 ? uColor0 : uColor1;
                    vec3 second = active2 ? uColor2 : uColor1;
                    color = phase < 0.5 ? first : second;
                }
                float crown = 0.72 + 0.28 * pow(abs(sin(vUv.y * 3.14159265)), 4.0);
                float pulse = 0.82 + 0.18 * sin((vUv.x * 38.0 - uTime * 3.6) * 3.14159265);
                gl_FragColor = vec4(color * (0.9 + pulse * 0.18), crown * 0.96);
            }
        `,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
    });
}

export function updateSharedProgressMaterial(
    material: THREE.ShaderMaterial,
    lanes: Array<{ color: number; progress: number }>,
) {
    const visible = lanes.slice(0, 3);
    const progresses = [0, 0, 0];
    visible.forEach((lane, index) => {
        progresses[index] = THREE.MathUtils.clamp(lane.progress, 0, 1);
        (material.uniforms[`uColor${index}`].value as THREE.Color).setHex(lane.color);
    });
    material.uniforms.uProgress.value.set(progresses[0], progresses[1], progresses[2]);
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
    _info: RouteEndpointInfo = {},
) {
    void _info;
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

    layers.add(screenGlow, screenCore, foundation, leftEdge, rightEdge, flow);
    return layers;
}
