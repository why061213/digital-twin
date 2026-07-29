/* Hallmark · pre-emit critique: P4 H4 E4 S5 R4 V4 */
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { registerRouteLabel } from './routeLabelLayout';

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
    routeIndex?: number;
};

export type RouteStopVisualInfo = {
    point: THREE.Vector3;
    action: 'PICKUP' | 'DELIVERY';
    sequence: number;
    locationName?: string | null;
    currentTarget?: boolean;
    markerColor?: string;
};

export type RouteStopVisualGroup = {
    point: THREE.Vector3;
    stops: RouteStopVisualInfo[];
    firstIndex: number;
    lastIndex: number;
};

const SAME_STOP_POINT_DISTANCE_SQ = 0.001 ** 2;

/**
 * 同一个园区可能既是上一单卸货点，也是下一单装货点；业务动作保留，地图实体合并。
 */
export function groupRouteStopsByPoint(stops: RouteStopVisualInfo[]): RouteStopVisualGroup[] {
    return stops.reduce<RouteStopVisualGroup[]>((groups, stop, index) => {
        const existing = groups.find((group) => (
            group.point.distanceToSquared(stop.point) <= SAME_STOP_POINT_DISTANCE_SQ
        ));
        if (existing) {
            existing.stops.push(stop);
            existing.lastIndex = index;
            return groups;
        }
        groups.push({
            point: stop.point.clone(),
            stops: [stop],
            firstIndex: index,
            lastIndex: index,
        });
        return groups;
    }, []);
}

function groupedStopRole(group: RouteStopVisualGroup, stopCount: number) {
    const isStart = group.firstIndex === 0;
    const isEnd = group.lastIndex === stopCount - 1;
    if (isStart && isEnd) return '起点 / 最终终点';
    if (isStart) return group.stops.length > 1 ? '第一起点 / 途经点' : '第一起点';
    if (isEnd) return group.stops.length > 1 ? '途经点 / 最终终点' : '最终终点';
    const actions = new Set(group.stops.map((stop) => stop.action));
    if (actions.size > 1) return '途经卸货 / 装货点';
    return actions.has('DELIVERY') ? '途经目的地' : '途经装载点';
}

const MAX_SHARED_ROUTE_RANGES = 24;
// Shader 相位为 x * frequency - time * speed，因此真实沿线速度是 speed / frequency。
const SHARED_SNAKE_ROUTE_SPEED = 0.014;
const RM2_SNAKE_WORLD_SPEED = 0.7;
const RM2_SNAKE_WORLD_SPACING = 10;
const RM2_SNAKE_WORLD_LENGTH = 2.4;

export type SharedRouteColorRange = {
    start: number;
    end: number;
    color: number;
    snakeColor?: number;
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
        new THREE.RingGeometry(radius * 0.85, radius * 1.25, 32),
        new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.45,
            side: THREE.DoubleSide,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        }),
    );
    halo.rotation.x = -Math.PI / 2;
    halo.renderOrder = renderOrder;

    const stemHeight = radius * 2.15;
    const stem = new THREE.Mesh(
        new THREE.CylinderGeometry(radius * 0.1, radius * 0.14, stemHeight, 12),
        new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.95,
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
            opacity: 1.0,
            side: THREE.DoubleSide,
            depthTest: false,
            depthWrite: false,
        }),
    );
    pin.position.y = stemHeight + radius * 0.82;
    pin.renderOrder = renderOrder + 3;

    const pinCore = new THREE.Mesh(
        new THREE.CircleGeometry(radius * 0.28, 20),
        new THREE.MeshBasicMaterial({
            color: 0xf8fafc,
            transparent: true,
            opacity: 1.0,
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
        marker.scale.setScalar(THREE.MathUtils.clamp(distance / referenceDistance, 1.05, 2.2));
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
    prefix: string,
    value: string | undefined,
    color: string,
    mode: 'rm1' | 'rm2',
    laneIndex: number,
    routeName?: string,
    collisionPriority?: number,
) {
    const canvas = document.createElement('canvas');
    const label = `${routeName ? `${routeName} · ` : ''}${prefix} · ${fullEndpoint(value)}`;
    const fontWeight = prefix.includes('终点') || prefix.includes('目的地') ? 600 : 500;
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
    context.arc(22, 44, prefix.includes('终点') || prefix.includes('目的地') ? 8 : 6, 0, Math.PI * 2);
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
    const baseScale: [number, number] = [baseHeight * (canvas.width / canvas.height), baseHeight];
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
    if (typeof collisionPriority === 'number') {
        registerRouteLabel(sprite, {
            anchor: point,
            baseScale,
            referenceDistance,
            priority: collisionPriority,
            pinRightGap: 12,
        });
    }
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
    const routeIndex = info.routeIndex ?? laneIndex;
    const markerScale = preset.markerScale * (1 + Math.min(routeIndex, 4) * 0.1);
    const startPoint = endpointMarkerPoint(samples, true, routeIndex, markerScale);
    const endPoint = endpointMarkerPoint(samples, false, routeIndex, markerScale);
    const start = createEndpointMarker(startPoint, markerScale, color, 10 + routeIndex, mode);
    const end = createEndpointMarker(endPoint, markerScale, 0xef4444, 10 + routeIndex, mode);
    const routeName = `路线${routeIndex + 1}${info.plate ? ` · ${info.plate}` : ''}`;
    const startLabel = createEndpointLabel(
        samples[0], '起点', info.from, colorText(color), mode, routeIndex, routeName,
    );
    const endLabel = createEndpointLabel(
        samples[samples.length - 1], '终点', info.to, colorText(color), mode, routeIndex, routeName,
    );
    layer.add(start, end, startLabel, endLabel);
    return layer;
}

export function createRouteStopLayer(
    stops: RouteStopVisualInfo[],
    mode: 'rm1' | 'rm2',
    routeColor: number,
    avoidLabelCollisions = false,
) {
    const preset = PRESETS[mode];
    const layer = new THREE.Group();
    const groupedStops = groupRouteStopsByPoint(stops);
    groupedStops.forEach((group, index) => {
        const stop = group.stops.find((candidate) => candidate.currentTarget)
            ?? group.stops[group.stops.length - 1];
        const delivery = stop.action === 'DELIVERY';
        const color = delivery
            ? 0xef4444
            : new THREE.Color(stop.markerColor || '#38bdf8').getHex();
        const point = group.point.clone();
        const currentTarget = group.stops.some((candidate) => candidate.currentTarget);
        const markerScale = preset.markerScale
            * (avoidLabelCollisions ? 1.35 : 1)
            * (currentTarget ? (avoidLabelCollisions ? 1.16 : 1.24) : 1);
        const marker = createEndpointMarker(point, markerScale, color, 30 + index, mode);
        const role = groupedStopRole(group, stops.length);
        const label = createEndpointLabel(
            point,
            role,
            stop.locationName ?? undefined,
            colorText(routeColor),
            mode,
            index,
            undefined,
            avoidLabelCollisions
                ? currentTarget ? 0 : group.firstIndex === 0 || group.lastIndex === stops.length - 1 ? 10 + index : 30 + index
                : undefined,
        );
        layer.add(marker, label);
    });
    return layer;
}

export function createSharedProgressMaterial(
    layerMode: 'combined' | 'untravelled' | 'travelled' | 'snake' = 'combined',
) {
    return new THREE.ShaderMaterial({
        uniforms: {
            uColor0: { value: new THREE.Color(0x38bdf8) },
            uSnakeColor: { value: new THREE.Color(0x0ea5e9) },
            uProgress: { value: 0 },
            uTime: { value: 0 },
            uSnakeFrequency: { value: 17 },
            uSnakeSpeed: { value: 0.23 },
            uSnakeLength: { value: 0.29 },
            uUseWorldMotion: { value: 0 },
            uRouteLength: { value: 1 },
            uSnakeWorldSpeed: { value: RM2_SNAKE_WORLD_SPEED },
            uSnakeWorldSpacing: { value: RM2_SNAKE_WORLD_SPACING },
            uSnakeWorldLength: { value: RM2_SNAKE_WORLD_LENGTH },
            uLayerMode: {
                value: layerMode === 'untravelled' ? 1 : layerMode === 'travelled' ? 2 : layerMode === 'snake' ? 3 : 0,
            },
            uSharedRanges: { value: Array.from({ length: MAX_SHARED_ROUTE_RANGES }, () => new THREE.Vector2(-1, -1)) },
            uSharedColors: { value: Array.from({ length: MAX_SHARED_ROUTE_RANGES }, () => new THREE.Color(0xffffff)) },
            uSharedSnakeColors: { value: Array.from({ length: MAX_SHARED_ROUTE_RANGES }, () => new THREE.Color(0xffffff)) },
            uSharedRangeCount: { value: 0 },
        },
        vertexShader: `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            uniform vec3 uColor0;
            uniform vec3 uSnakeColor;
            uniform float uProgress;
            uniform float uTime;
            uniform float uSnakeFrequency;
            uniform float uSnakeSpeed;
            uniform float uSnakeLength;
            uniform int uUseWorldMotion;
            uniform float uRouteLength;
            uniform float uSnakeWorldSpeed;
            uniform float uSnakeWorldSpacing;
            uniform float uSnakeWorldLength;
            uniform int uLayerMode;
            uniform vec2 uSharedRanges[${MAX_SHARED_ROUTE_RANGES}];
            uniform vec3 uSharedColors[${MAX_SHARED_ROUTE_RANGES}];
            uniform vec3 uSharedSnakeColors[${MAX_SHARED_ROUTE_RANGES}];
            uniform int uSharedRangeCount;
            varying vec2 vUv;

            void main() {
                vec3 color = uColor0;
                vec3 snakeColor = uSnakeColor;
                for (int i = 0; i < ${MAX_SHARED_ROUTE_RANGES}; i++) {
                    if (i >= uSharedRangeCount) break;
                    if (vUv.x >= uSharedRanges[i].x && vUv.x <= uSharedRanges[i].y) {
                        color = uSharedColors[i];
                        snakeColor = uSharedSnakeColors[i];
                    }
                }

                float travelled = 1.0 - step(uProgress, vUv.x);
                float crown = 0.72 + 0.28 * pow(abs(sin(vUv.y * 3.14159265)), 4.0);
                float phase = fract(vUv.x * uSnakeFrequency - uTime * uSnakeSpeed);
                float tail = smoothstep(0.0, 0.055, phase);
                float head = 1.0 - smoothstep(uSnakeLength - 0.07, uSnakeLength, phase);
                if (uUseWorldMotion == 1) {
                    float spacing = max(0.001, uSnakeWorldSpacing);
                    float phaseDistance = mod(vUv.x * uRouteLength - uTime * uSnakeWorldSpeed, spacing);
                    float edge = min(0.35, uSnakeWorldLength * 0.2);
                    tail = smoothstep(0.0, edge, phaseDistance);
                    head = 1.0 - smoothstep(max(edge, uSnakeWorldLength - edge), uSnakeWorldLength, phaseDistance);
                }
                float movingSnake = travelled * tail * head;
                float snakeMask = movingSnake;
                if (uLayerMode == 1) {
                    if (travelled > 0.5) discard;
                    // 未走路线统一使用导航灰，不再混入订单主色；中间略亮，保留管线体积感。
                    vec3 ghostColor = mix(vec3(0.36, 0.40, 0.45), vec3(0.52, 0.56, 0.61), crown);
                    gl_FragColor = vec4(ghostColor, 0.48 + crown * 0.16);
                    return;
                }
                if (uLayerMode == 2) {
                    if (travelled < 0.5) discard;
                    gl_FragColor = vec4(color, 0.88 + crown * 0.12);
                    return;
                }
                if (uLayerMode == 3) {
                    if (snakeMask < 0.02) discard;
                    gl_FragColor = vec4(snakeColor, smoothstep(0.02, 0.18, snakeMask));
                    return;
                }

                color = mix(color, snakeColor, snakeMask * 0.96);
                float travelledAlpha = 0.88 + crown * 0.12;
                float routeAlpha = mix(0.10, travelledAlpha, travelled);
                gl_FragColor = vec4(color, routeAlpha);
            }
        `,
        transparent: true,
        // 蛇仍在路线透明层之后绘制，但必须接受车辆写入的深度，不能穿透车辆模型。
        depthTest: true,
        depthWrite: false,
        blending: THREE.NormalBlending,
    });
}

export function updateSharedProgressMaterial(
    material: THREE.ShaderMaterial,
    lanes: Array<{ color: number; progress: number }>,
) {
    material.uniforms.uProgress.value = Math.max(0, ...lanes.map((lane) => THREE.MathUtils.clamp(lane.progress, 0, 1)));
}

export function configureSharedProgressMaterial(
    material: THREE.ShaderMaterial,
    baseColor: number,
    routeKey: string,
    motionProfile: 'varied' | 'rm2-synchronized' = 'varied',
    routeLength = 1,
) {
    const primes = [11, 13, 17, 19, 23, 29, 31];
    let hash = 2166136261;
    for (let index = 0; index < routeKey.length; index += 1) {
        hash ^= routeKey.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    const positiveHash = hash >>> 0;
    const frequency = primes[positiveHash % primes.length];
    const lengthPrime = primes[Math.floor(positiveHash / (primes.length * primes.length)) % primes.length];
    const base = new THREE.Color(baseColor);
    const snake = base.clone();
    const hsl = { h: 0, s: 0, l: 0 };
    snake.getHSL(hsl);
    snake.setHSL(hsl.h, hsl.s, Math.max(0.12, hsl.l * 0.8));
    (material.uniforms.uColor0.value as THREE.Color).copy(base);
    (material.uniforms.uSnakeColor.value as THREE.Color).copy(snake);
    material.uniforms.uSnakeFrequency.value = frequency;
    // 不同质数频率仍保持差异，但所有蛇沿路线前进的速度完全一致，避免共线时相互追赶。
    material.uniforms.uSnakeSpeed.value = frequency * SHARED_SNAKE_ROUTE_SPEED;
    material.uniforms.uSnakeLength.value = THREE.MathUtils.clamp(lengthPrime / 67, 0.18, 0.46);
    material.uniforms.uUseWorldMotion.value = motionProfile === 'rm2-synchronized' ? 1 : 0;
    material.uniforms.uRouteLength.value = Math.max(0.001, routeLength);
    material.uniforms.uSnakeWorldSpeed.value = RM2_SNAKE_WORLD_SPEED;
    material.uniforms.uSnakeWorldSpacing.value = RM2_SNAKE_WORLD_SPACING;
    material.uniforms.uSnakeWorldLength.value = RM2_SNAKE_WORLD_LENGTH;
}

export function updateSharedRouteColorRanges(
    material: THREE.ShaderMaterial,
    ranges: SharedRouteColorRange[],
) {
    const visible = ranges.slice(0, MAX_SHARED_ROUTE_RANGES);
    const rangeUniforms = material.uniforms.uSharedRanges.value as THREE.Vector2[];
    const colorUniforms = material.uniforms.uSharedColors.value as THREE.Color[];
    const snakeColorUniforms = material.uniforms.uSharedSnakeColors.value as THREE.Color[];
    material.uniforms.uSharedRangeCount.value = visible.length;
    for (let index = 0; index < MAX_SHARED_ROUTE_RANGES; index += 1) {
        const range = visible[index];
        const rangeUniform = rangeUniforms[index];
        const colorUniform = colorUniforms[index];
        if (!range) {
            rangeUniform.set(-1, -1);
            continue;
        }
        rangeUniform.set(
            THREE.MathUtils.clamp(Math.min(range.start, range.end), 0, 1),
            THREE.MathUtils.clamp(Math.max(range.start, range.end), 0, 1),
        );
        colorUniform.setHex(range.color);
        snakeColorUniforms[index].setHex(range.snakeColor ?? range.color);
    }
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

    const screenGlow = createScreenSpaceLine(samples, 0x94a3b8, preset.screenGlowWidth, 0.08);
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
            color: 0x64748b,
            transparent: true,
            opacity: 0.22,
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
    flow.visible = false;
    flow.onBeforeRender = () => {
        flowMaterial.uniforms.uTime.value = performance.now() / 1_000;
    };

    layers.add(screenGlow, screenCore, foundation, leftEdge, rightEdge, flow);
    return layers;
}
