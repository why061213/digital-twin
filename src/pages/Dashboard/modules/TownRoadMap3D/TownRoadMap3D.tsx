import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createLocalProjection, collectRenderProvinceAdcodes, collectTaskCoords, commandOrders, commandRenderProvinces, featureCoords, loadGeoJsonByRenderCommand } from './geo';
import { MAP_LIFT, ROUTE_LIFT } from './constants';
import { buildRouteFromTasks, progressOnRoad, updateOrderVisuals } from './townRouteRenderer';

import type { TownRoadState } from './townRouteRenderer';
import type { LonLat, TownAnimationStage, TownBoundaryLayers, TownGeoFeatureCollection, TownRoadMap3DHandle, TownRoadRenderCommand, TownTransportTask } from './types';

type TownRoadMap3DProps = {
    onVisualReady?: () => void;
};

type TownHoverInfo = {
    x: number;
    y: number;
    title: string;
    subtitle: string;
    status: string;
    rows: Array<[string, string]>;
};

type BoundaryLevel = 'province' | 'city' | 'district';

type BoundaryStyle = {
    color: number;
    opacity: number;
    lift: number;
    lineWidth: number;
    renderOrder: number;
};

const BOUNDARY_STYLES: Record<BoundaryLevel, BoundaryStyle> = {
    // 省界：最高、最亮，用暖色，负责告诉用户“这是一整个省的外边界”。
    province: { color: 0xfbbf24, opacity: 0.88, lift: MAP_LIFT + 0.88, lineWidth: 3, renderOrder: 30 },
    // 市界：次高、偏 cyan，负责在省内分出地市层级。
    city: { color: 0x22d3ee, opacity: 0.54, lift: MAP_LIFT + 0.76, lineWidth: 2, renderOrder: 24 },
    // 县界：最细、最暗，主要由每个区县块自己的 EdgesGeometry 表达。
    district: { color: 0x93c5fd, opacity: 0.48, lift: MAP_LIFT + 0.58, lineWidth: 1, renderOrder: 12 },
};

function commandMapKey(command: TownRoadRenderCommand) {
    const renderLevel = command.renderLevel ?? 'province-district';
    const provinces = commandRenderProvinces(command).slice().sort().join('|');
    return `${renderLevel}:${provinces}`;
}

function extractFeatureRings(feature: any): LonLat[][] {
    const geometry = feature?.geometry;
    if (!geometry) return [];

    if (geometry.type === 'Polygon') {
        return (geometry.coordinates ?? []).filter((ring: LonLat[]) => Array.isArray(ring) && ring.length >= 2);
    }

    if (geometry.type === 'MultiPolygon') {
        const rings: LonLat[][] = [];
        geometry.coordinates?.forEach((polygon: LonLat[][]) => {
            polygon?.forEach((ring) => {
                if (Array.isArray(ring) && ring.length >= 2) rings.push(ring);
            });
        });
        return rings;
    }

    return [];
}

function createBoundaryOverlay(
    features: any[] | undefined,
    projection: ReturnType<typeof createLocalProjection>,
    level: BoundaryLevel
) {
    const group = new THREE.Group();
    const style = BOUNDARY_STYLES[level];
    const source = features ?? [];

    source.forEach((feature) => {
        const rings = extractFeatureRings(feature);
        rings.forEach((ring) => {
            const points: THREE.Vector3[] = [];
            ring.forEach((coord) => {
                const projected = projection(coord);
                if (!projected) return;
                points.push(new THREE.Vector3(-projected[0], style.lift, -projected[1]));
            });

            if (points.length < 2) return;
            const first = points[0];
            const last = points[points.length - 1];
            if (first.distanceToSquared(last) > 0.000001) {
                points.push(first.clone());
            }

            const geometry = new THREE.BufferGeometry().setFromPoints(points);
            const material = new THREE.LineBasicMaterial({
                color: style.color,
                transparent: true,
                opacity: style.opacity,
                depthTest: false,
                depthWrite: false,
            });
            const line = new THREE.Line(geometry, material);
            line.renderOrder = style.renderOrder;
            line.userData = { objectType: level === 'province' ? '省界' : level === 'city' ? '市界' : '县界' };
            group.add(line);
        });
    });

    return group;
}

function screenPosition(point: THREE.Vector3, camera: THREE.Camera, container: HTMLDivElement) {
    const projected = point.clone().project(camera);
    return {
        x: (projected.x * 0.5 + 0.5) * container.clientWidth,
        y: (-projected.y * 0.5 + 0.5) * container.clientHeight,
    };
}

const TownRoadMap3D = forwardRef<TownRoadMap3DHandle, TownRoadMap3DProps>(({ onVisualReady }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const onVisualReadyRef = useRef(onVisualReady);
    const sceneRef = useRef<THREE.Scene | null>(null);
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const controlsRef = useRef<OrbitControls | null>(null);
    const mapGroupRef = useRef<THREE.Group | null>(null);
    const routesGroupRef = useRef<THREE.Group | null>(null);
    const transformGroupRef = useRef<THREE.Group | null>(null); // 拉伸地图板块用
    const projectionRef = useRef<ReturnType<typeof createLocalProjection> | null>(null);
    const renderedMapKeyRef = useRef<string | null>(null);
    const renderedMapPointsRef = useRef<THREE.Vector3[]>([]);
    const renderFrameRef = useRef(0);
    const renderRunRef = useRef(0);
    const inFlightMapKeyRef = useRef<string | null>(null);
    const pendingCommandForMapKeyRef = useRef<TownRoadRenderCommand | null>(null);
    const pendingCommandBeforeSceneRef = useRef<TownRoadRenderCommand | null>(null);
    const renderCommandRef = useRef<((command: TownRoadRenderCommand) => void) | null>(null);
    const raycasterRef = useRef(new THREE.Raycaster());
    const pointerRef = useRef(new THREE.Vector2());
    const interactiveObjectsRef = useRef<THREE.Object3D[]>([]);
    const renderedRoadsRef = useRef<TownRoadState[]>([]);
    const [hoverInfo, setHoverInfo] = useState<TownHoverInfo | null>(null);

    /** 地图数据缓存：只缓存 GeoJSON 数据和 projection，不缓存 Three.js 对象。key = mapKey */
    const mapDataCacheRef = useRef<Map<string, { geoJson: TownGeoFeatureCollection; boundaryFeatures: TownBoundaryLayers; projection: ReturnType<typeof createLocalProjection> }>>(new Map());
    /** 已 dispose 标记，防止重复 dispose */
    const disposedMaterialsRef = useRef<WeakSet<THREE.Material>>(new WeakSet());
    const disposedGeometriesRef = useRef<WeakSet<THREE.BufferGeometry>>(new WeakSet());
    /** 车辆最新位置跨阶段持久化：key = lineId */
    const latestPositionByLineId = useRef<Map<string, { position: LonLat; progress: number; timestamp: number; pathSignature: string }>>(new Map());

    const safeDisposeObject3D = useCallback((object: THREE.Object3D) => {
        object.traverse((child) => {
            if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
                const geom = child.geometry;
                if (geom && !disposedGeometriesRef.current.has(geom)) {
                    disposedGeometriesRef.current.add(geom);
                    geom.dispose();
                }
                const material = child.material;
                if (Array.isArray(material)) {
                    material.forEach((item) => {
                        if (!disposedMaterialsRef.current.has(item)) {
                            disposedMaterialsRef.current.add(item);
                            item.dispose();
                        }
                    });
                } else if (material && !disposedMaterialsRef.current.has(material)) {
                    disposedMaterialsRef.current.add(material);
                    material.dispose();
                }
            }
        });
    }, []);

    onVisualReadyRef.current = onVisualReady;

    const clearMapData = useCallback(() => {
        const tg = transformGroupRef.current;
        if (mapGroupRef.current) {
            tg?.remove(mapGroupRef.current);
            safeDisposeObject3D(mapGroupRef.current);
            mapGroupRef.current = null;
        }
        renderedMapKeyRef.current = null;
        renderedMapPointsRef.current = [];
        projectionRef.current = null;
    }, [safeDisposeObject3D]);

    const clearRouteData = useCallback(() => {
        const tg = transformGroupRef.current;
        if (routesGroupRef.current) {
            tg?.remove(routesGroupRef.current);
            safeDisposeObject3D(routesGroupRef.current);
            routesGroupRef.current = null;
        }
        interactiveObjectsRef.current = [];
        renderedRoadsRef.current = [];
        setHoverInfo(null);
    }, [safeDisposeObject3D]);

    const clearRenderedData = useCallback(() => {
        clearRouteData();
        clearMapData();
    }, [clearMapData, clearRouteData]);

    const focusPoints = useCallback((points: THREE.Vector3[], mapKey?: string) => {
        const camera = cameraRef.current;
        const controls = controlsRef.current;
        const transformGroup = transformGroupRef.current;
        if (!camera || !controls || points.length === 0) return;

        // 1. 重置 transform，确保地图在世界坐标中处于原始位置
        if (transformGroup) {
            transformGroup.scale.set(1, 1, 1);
            transformGroup.rotation.set(0, 0, 0);
            transformGroup.position.set(0, 0, 0);
        }

        // 2. 从输入 points 计算本地包围盒（这些 points 已经是世界坐标，但 transformGroup 已重置）
        const localBox = new THREE.Box3().setFromPoints(points);
        const localCenter = localBox.getCenter(new THREE.Vector3());
        const localSize = localBox.getSize(new THREE.Vector3());
        const span = Math.max(localSize.x, localSize.z, 3);
        const height = THREE.MathUtils.clamp(span * 0.72 + 12, 14, 72);
        const tilt = THREE.MathUtils.clamp(span * 0.30 + 6, 8, 36);

        // 3. 直接根据未变换 points 设置相机，不使用 transform 拉伸
        //    之前这里的 transform 拉伸会导致相机基于变换前坐标定位，但地图已被缩放/旋转移出视野
        camera.position.set(localCenter.x, height, localCenter.z - tilt);
        controls.target.set(localCenter.x, 0, localCenter.z);
        camera.lookAt(controls.target);
        controls.update();

        // 4. 根据场景实际状态（含地图和路线），用 setFromObject 获取世界坐标包围盒做最终校验
        if (transformGroup) {
            const worldBox = new THREE.Box3().setFromObject(transformGroup);
            if (!worldBox.isEmpty()) {
                const worldCenter = worldBox.getCenter(new THREE.Vector3());
                const worldSize = worldBox.getSize(new THREE.Vector3());
                const worldSpan = Math.max(worldSize.x, worldSize.z, 1);

                // 调整 camera near/far 以匹配实际场景范围，避免 z-fighting 和裁剪
                const near = Math.max(0.5, worldSpan * 0.01);
                const far = Math.max(worldSpan * 3, 200);
                camera.near = near;
                camera.far = far;
                camera.updateProjectionMatrix();

                // 更新 fog 范围以匹配新场景
                if (sceneRef.current?.fog instanceof THREE.Fog) {
                    sceneRef.current.fog.near = far * 0.25;
                    sceneRef.current.fog.far = far * 0.85;
                }

                console.info('[TownRoadMap3D] focusPoints applied', {
                    mapKey: mapKey ?? 'unknown',
                    pointsCount: points.length,
                    localBoxCenter: localCenter.toArray(),
                    localBoxSize: localSize.toArray(),
                    worldBoxCenter: worldCenter.toArray(),
                    worldBoxSize: worldSize.toArray(),
                    cameraPos: camera.position.toArray(),
                    controlsTarget: controls.target.toArray(),
                    near,
                    far,
                    transformScale: transformGroup.scale.toArray(),
                    transformRotation: transformGroup.rotation.toArray(),
                });
            }
        }
    }, []);

    const mapPositionFactory = useCallback((projection: ReturnType<typeof createLocalProjection>) => {
        return (coords: LonLat, lift = 0) => {
            const projected = projection(coords);
            if (!projected) return null;
            return new THREE.Vector3(-projected[0], lift, -projected[1]);
        };
    }, []);

    const renderMapFeatures = useCallback((
        features: any[],
        projection: ReturnType<typeof createLocalProjection>,
        boundaryFeatures?: TownBoundaryLayers
    ) => {
        const group = new THREE.Group();
        const allPoints: THREE.Vector3[] = [];

        // 区县级区块：轻量平面填充 + 淡色细线边界
        features.forEach((feature) => {
            const geometry = feature.geometry;
            if (!geometry) return;

            const cityGroup = new THREE.Group();
            const rings: LonLat[][] = [];
            if (geometry.type === 'Polygon') {
                rings.push(...(geometry.coordinates ?? []));
            } else if (geometry.type === 'MultiPolygon') {
                geometry.coordinates?.forEach((polygon: LonLat[][]) => rings.push(...polygon));
            }

            rings.forEach((ring) => {
                if (!Array.isArray(ring) || ring.length < 3) return;
                const shape = new THREE.Shape();
                ring.forEach((coord, index) => {
                    const projected = projection(coord);
                    if (!projected) return;
                    const x = -projected[0];
                    const y = -projected[1];
                    if (index === 0) shape.moveTo(x, y);
                    else shape.lineTo(x, y);
                    allPoints.push(new THREE.Vector3(x, MAP_LIFT, y));
                });

                // 轻量平面实体填充（城市级块）
                const geom = new THREE.ShapeGeometry(shape);
                const mesh = new THREE.Mesh(
                    geom,
                    new THREE.MeshBasicMaterial({
                        color: 0x1e3d5c,
                        transparent: true,
                        opacity: 0.88,
                        side: THREE.DoubleSide,
                        depthWrite: false,
                    })
                );
                mesh.renderOrder = 8;
                cityGroup.add(mesh);


            });

            cityGroup.rotation.x = Math.PI / 2;
            group.add(cityGroup);
        });

        // 行政边界分级覆盖层：省界 + 市界 + 区县界浮在上面
        const overlayGroup = new THREE.Group();
        overlayGroup.add(createBoundaryOverlay(boundaryFeatures?.district, projection, 'district'));
        overlayGroup.add(createBoundaryOverlay(boundaryFeatures?.city, projection, 'city'));
        overlayGroup.add(createBoundaryOverlay(boundaryFeatures?.province, projection, 'province'));
        group.add(overlayGroup);

        return { group, points: allPoints };
    }, []);

    const renderRoutes = useCallback((tasks: TownTransportTask[], projection: ReturnType<typeof createLocalProjection>) => {
        const scene = sceneRef.current;
        if (!scene) return { group: new THREE.Group(), points: [] as THREE.Vector3[] };

        const mp = (coords: [number, number], lift: number) => {
            const p = projection(coords);
            if (!p) return null;
            return new THREE.Vector3(-p[0], lift, -p[1]);
        };

        const roads = buildRouteFromTasks(
            tasks.filter(t => !t.deleted && t.from.coords && t.to.coords),
            mp, scene, ROUTE_LIFT, ROUTE_LIFT + 0.28,
        );

        const allPoints: THREE.Vector3[] = [];
        const interactiveObjects: THREE.Object3D[] = [];
        roads.forEach(r => {
            allPoints.push(r.samples[0], r.samples[r.samples.length - 1]);
            r.orders.forEach(l => l.vehicles.forEach(v => { interactiveObjects.push(v.bar); allPoints.push(v.bar.position); }));
        });
        interactiveObjectsRef.current = interactiveObjects;
        renderedRoadsRef.current = roads;

        // 把所有路线放到一个统一 group 里
        const group = new THREE.Group();
        roads.forEach(r => { scene.remove(r.group); group.add(r.group); });

        return { group, points: allPoints };
    }, []);

    const renderCommand = useCallback((command: TownRoadRenderCommand) => {
        const scene = sceneRef.current;
        const nextMapKey = commandMapKey(command);

        if (!scene) {
            pendingCommandBeforeSceneRef.current = command;
            console.info('[TownRoadMap3D] defer render command until scene ready', {
                nextMapKey,
                commandId: command.commandId,
            });
            return;
        }

        if (inFlightMapKeyRef.current === nextMapKey) {
            pendingCommandForMapKeyRef.current = command;
            console.info('[TownRoadMap3D] skip duplicate render while map loading', {
                nextMapKey,
                commandId: command.commandId,
            });
            return;
        }

        const runId = renderRunRef.current + 1;
        renderRunRef.current = runId;
        const isStale = () => renderRunRef.current !== runId;

        void (async () => {
            const validTasks = commandOrders(command).filter((task) => !task.deleted);
            const taskCoords = collectTaskCoords(validTasks);
            const targetProvinces = commandRenderProvinces(command);

            let projection = projectionRef.current;
            const shouldReloadMap = renderedMapKeyRef.current !== nextMapKey || !projection;

            // ---------- 计算 primary/along 视觉区分标记 ----------
            const routeGroups = command.displayRouteGroups ?? command.routeGroups ?? [];
            const primaryLineIdSet = new Set(routeGroups.flatMap((g) => g.primaryOrderLineIds ?? []));
            const alongLineIdSet = new Set(routeGroups.flatMap((g) => g.alongOrderLineIds ?? []));
            const styledTasks: Array<TownTransportTask & { _townVisualStyle: 'primary' | 'along' }> = validTasks.map((task) => ({
                ...task,
                _townVisualStyle: (primaryLineIdSet.has(task.lineId) ? 'primary' : alongLineIdSet.has(task.lineId) ? 'along' : 'primary') as 'primary' | 'along',
            }));

            if (shouldReloadMap) {
                inFlightMapKeyRef.current = nextMapKey;

                try {
                    // Step 1: 获取地图数据（缓存优先，未命中则请求）
                    const cached = mapDataCacheRef.current.get(nextMapKey);
                    let geoJson: TownGeoFeatureCollection;
                    let boundaryFeatures: TownBoundaryLayers;

                    if (cached) {
                        geoJson = cached.geoJson;
                        boundaryFeatures = cached.boundaryFeatures;
                        projection = cached.projection;
                        console.info('[TownRoadMap3D] using cached GeoJSON data', {
                            nextMapKey,
                            cacheSize: mapDataCacheRef.current.size,
                            fillFeatureCount: geoJson.features?.length ?? 0,
                        });
                    } else {
                        geoJson = targetProvinces.length > 0
                            ? await loadGeoJsonByRenderCommand(command)
                            : { type: 'FeatureCollection', features: [], boundaryFeatures: {} };
                        if (isStale()) { inFlightMapKeyRef.current = null; return; }

                        boundaryFeatures = geoJson.boundaryFeatures ?? {};
                        const boundaryFeatureList = Object.values(boundaryFeatures).flat();
                        const featurePoints = [...(geoJson.features ?? []), ...boundaryFeatureList].flatMap(featureCoords);
                        projection = createLocalProjection([...taskCoords, ...featurePoints]);
                        if (isStale()) { inFlightMapKeyRef.current = null; return; }

                        // 缓存地图数据（只缓存原始数据，不缓存 Three.js 对象）
                        mapDataCacheRef.current.set(nextMapKey, {
                            geoJson,
                            boundaryFeatures,
                            projection,
                        });
                        console.info('[TownRoadMap3D] GeoJSON data cached', {
                            nextMapKey,
                            cacheSize: mapDataCacheRef.current.size,
                            fillFeatureCount: geoJson.features?.length ?? 0,
                        });
                    }

                    if (isStale()) { inFlightMapKeyRef.current = null; return; }

                    // Step 2: 无条件创建新地图 Group（即使 features 为空，boundaryFeatures 也可能存在）
                    const features = geoJson.features ?? [];
                    const renderedMap = renderMapFeatures(features, projection, boundaryFeatures);

                    if (isStale()) { inFlightMapKeyRef.current = null; return; }

                    // Step 3: 原子替换——先准备好新 Group，再一次性清理旧数据并挂载
                    clearRenderedData();
                    if (isStale()) { inFlightMapKeyRef.current = null; return; }

                    mapGroupRef.current = renderedMap.group;
                    transformGroupRef.current?.add(renderedMap.group);
                    projectionRef.current = projection;
                    renderedMapKeyRef.current = nextMapKey;
                    renderedMapPointsRef.current = renderedMap.points;

                    // 地图场景诊断日志
                    const boundaryProvinceCount = boundaryFeatures.province?.length ?? 0;
                    const boundaryCityCount = boundaryFeatures.city?.length ?? 0;
                    const boundaryDistrictCount = boundaryFeatures.district?.length ?? 0;
                    const mapChildren = mapGroupRef.current?.children.length ?? 0;
                    const mapPointCount = renderedMap.points.length;
                    const cacheHit = Boolean(cached);
                    const cancelled = isStale();

                    console.info('[TownRoadMap3D] map features rendered', {
                        nextMapKey,
                        cacheHit,
                        fillFeatureCount: features.length,
                        boundaryProvinceCount,
                        boundaryCityCount,
                        boundaryDistrictCount,
                        mapChildren,
                        mapPointCount,
                        stale: cancelled,
                    });

                    if (mapChildren === 0) {
                        console.error('[TownRoadMap3D] map group is empty after render!', {
                            nextMapKey,
                            cacheHit,
                            fillFeatureCount: features.length,
                            hasProvince: boundaryProvinceCount > 0,
                            hasCity: boundaryCityCount > 0,
                            hasDistrict: boundaryDistrictCount > 0,
                            boundaryKeys: Object.keys(boundaryFeatures).filter((k) => (boundaryFeatures as Record<string, unknown[]>)[k]?.length > 0),
                        });
                    }
                } catch (error) {
                    console.error('[TownRoadMap3D] map render failed', { nextMapKey, error });
                } finally {
                    if (inFlightMapKeyRef.current === nextMapKey) {
                        inFlightMapKeyRef.current = null;
                    }
                }
            } else {
                // 省份范围没变时，只重画路线/车辆，不重新请求 GeoJSON，也不重建省市县 3D 区块。
                if (isStale()) return;
                clearRouteData();
                if (isStale()) return;
            }

            if (isStale()) return;
            if (!projection) return;

            // 注入跨阶段持久化的最新车辆位置到 styledTasks
            const positionStore = latestPositionByLineId.current;
            if (positionStore.size > 0) {
                styledTasks.forEach((task) => {
                    const latest = positionStore.get(task.lineId);
                    if (!latest || !task.vehicle) return;
                    // 只注入比 task 中更晚的位置
                    if (latest.timestamp > new Date(task.updatedAt ?? 0).getTime()) {
                        (task as Record<string, unknown>).vehicle = {
                            ...task.vehicle,
                            currentCoords: latest.position,
                        };
                        (task as Record<string, unknown>).updatedAt = new Date(latest.timestamp).toISOString();
                    }
                });
            }

            const renderedRoutes = renderRoutes(styledTasks, projection);
            if (isStale()) return;
            routesGroupRef.current = renderedRoutes.group;
            transformGroupRef.current?.add(renderedRoutes.group);

            const routeCount = renderedRoutes.group.children.length;
            console.info('[TownRoadMap3D] route features rendered', {
                nextMapKey,
                taskCount: styledTasks.length,
                primaryCount: styledTasks.filter((t) => t._townVisualStyle === 'primary').length,
                alongCount: styledTasks.filter((t) => t._townVisualStyle === 'along').length,
                routeCount,
            });

            // ---------- 相机 focus：地图点 + 线路点并集，防止地图被排除在镜头外 ----------
            const renderedMapPoints = renderedMapPointsRef.current;
            const routePoints = renderedRoutes.points;

            const mapBox = renderedMapPoints.length > 0
                ? new THREE.Box3().setFromPoints(renderedMapPoints)
                : new THREE.Box3();
            const routeBox = routePoints.length > 0
                ? new THREE.Box3().setFromPoints(routePoints)
                : new THREE.Box3();

            let focusSource: THREE.Vector3[];
            if (mapBox.isEmpty() && routeBox.isEmpty()) {
                focusSource = [];
            } else if (mapBox.isEmpty()) {
                focusSource = routePoints;
            } else if (routeBox.isEmpty()) {
                focusSource = renderedMapPoints;
            } else {
                const mapSpan = Math.max(
                    mapBox.max.x - mapBox.min.x,
                    mapBox.max.z - mapBox.min.z,
                );
                const routeSpan = Math.max(
                    routeBox.max.x - routeBox.min.x,
                    routeBox.max.z - routeBox.min.z,
                );
                // 线路跨度超过地图 3 倍时，以地图为主，避免异常长线路把地图缩成一个点
                if (routeSpan > mapSpan * 3 && mapSpan > 0) {
                    focusSource = renderedMapPoints;
                    console.info('[TownRoadMap3D] route span too large, using map-only focus', {
                        mapSpan: mapSpan.toFixed(1),
                        routeSpan: routeSpan.toFixed(1),
                        ratio: (routeSpan / mapSpan).toFixed(2),
                    });
                } else {
                    focusSource = [...renderedMapPoints, ...routePoints];
                }
            }

            if (isStale()) return;
            if (focusSource.length > 0) {
                const mapPointCount = renderedMapPoints.length;
                const routePointCount = routePoints.length;
                console.info('[TownRoadMap3D] camera focus', {
                    nextMapKey,
                    mapPointCount,
                    routePointCount,
                    focusPointCount: focusSource.length,
                });
                focusPoints(focusSource, nextMapKey);
            }

            const pending = pendingCommandForMapKeyRef.current;
            if (pending && commandMapKey(pending) === nextMapKey && pending !== command) {
                pendingCommandForMapKeyRef.current = null;
                console.info('[TownRoadMap3D] apply pending command after map ready', {
                    nextMapKey,
                    pendingCommandId: pending.commandId,
                });
                renderCommandRef.current?.(pending);
            }
        })();
    }, [clearRenderedData, clearRouteData, focusPoints, mapPositionFactory, renderMapFeatures, renderRoutes]);

    useEffect(() => {
        renderCommandRef.current = renderCommand;
    }, [renderCommand]);

    const setTransportTasks = useCallback((tasks: TownTransportTask[]) => {
        const validTasks = tasks.filter((task) => !task.deleted);
        renderCommand({
            type: 'town_road_render',
            commandId: `local-${Date.now()}`,
            title: validTasks[0]?.groupName ?? '区镇短途配送',
            renderLevel: 'province-district',
            renderProvinces: collectRenderProvinceAdcodes(validTasks),
            orders: validTasks,
            issuedAt: new Date().toISOString(),
        });
    }, [renderCommand]);

    const setRoute = useCallback((fromCoords: LonLat, toCoords: LonLat) => {
        setTransportTasks([
            {
                orderId: 'preview-order',
                lineId: 'preview-line',
                from: { name: '起点', coords: fromCoords },
                to: { name: '目的地', coords: toCoords },
                vehicle: { plate: '短途预览车', carId: 'preview-car' },
                status: '运输中',
                updatedAt: new Date().toISOString(),
            },
        ]);
    }, [setTransportTasks]);

    const updateTruckPosition = useCallback((lineId: string, position: LonLat, meta?: { speedKmh?: number; status?: string; updatedAt?: string }) => {
        const projection = projectionRef.current;
        if (!projection || !lineId || !Array.isArray(position) || position.length < 2) return;

        const projected = mapPositionFactory(projection)(position, ROUTE_LIFT + 0.28);
        if (!projected) return;

        const now = Date.now();
        const timestamp = meta?.updatedAt ? new Date(meta.updatedAt).getTime() : now;

        const found = (() => {
            for (const road of renderedRoadsRef.current) {
                if (!road.lineIds.has(lineId)) continue;

                for (const lane of road.orders.values()) {
                    const vehicle = lane.vehicles.get(lineId);
                    if (!vehicle) continue;

                    const progress = progressOnRoad(road, projected);

                    // 进度单调性检查：同一路径签名下进度不应明显倒退
                    const pathSignature = road.pathKey;
                    const latest = latestPositionByLineId.current.get(lineId);
                    if (latest && latest.pathSignature === pathSignature && progress < latest.progress - 0.05) {
                        console.warn('[TownRoadMap3D] progress regression detected', {
                            lineId,
                            oldProgress: latest.progress.toFixed(4),
                            newProgress: progress.toFixed(4),
                            pathSignature,
                        });
                    }

                    // 距离诊断：车辆点到线路的最近距离过大时输出警告
                    const nearestDist = Math.sqrt(
                        road.samples.reduce((minDist, sample) => {
                            const dx = projected.x - sample.x;
                            const dz = projected.z - sample.z;
                            const d = dx * dx + dz * dz;
                            return d < minDist ? d : minDist;
                        }, Number.POSITIVE_INFINITY)
                    );
                    if (nearestDist > 25) {
                        console.warn('[TownRoadMap3D] vehicle position far from route', {
                            lineId,
                            nearestDist: Math.sqrt(nearestDist).toFixed(2),
                            position,
                            pathSignature,
                        });
                    }

                    vehicle.progress = progress;
                    vehicle.currentCoords = position;
                    vehicle.info = {
                        ...vehicle.info,
                        status: meta?.status ?? vehicle.info.status,
                        rows: Array.isArray(vehicle.info.rows)
                            ? (vehicle.info.rows as Array<[string, string]>).map(([label, value]) => {
                                if (label === '当前经度') return [label, position[0].toFixed(6)];
                                if (label === '当前纬度') return [label, position[1].toFixed(6)];
                                if (label === '时速' && typeof meta?.speedKmh === 'number') return [label, `${meta.speedKmh.toFixed(1)} km/h`];
                                if (label === '状态' && meta?.status) return [label, meta.status];
                                return [label, value];
                            })
                            : vehicle.info.rows,
                        realtimeUpdatedAt: meta?.updatedAt ?? new Date().toISOString(),
                        speedKmh: meta?.speedKmh,
                        currentCoords: position,
                    };
                    updateOrderVisuals(road, ROUTE_LIFT + 0.28);

                    // 持久化到跨阶段存储
                    latestPositionByLineId.current.set(lineId, {
                        position,
                        progress,
                        timestamp,
                        pathSignature,
                    });

                    return true;
                }
            }
            return false;
        })();

        // 即使当前没有匹配的 road（线路尚未渲染），仍然持久化位置，供后续渲染使用
        if (!found) {
            latestPositionByLineId.current.set(lineId, {
                position,
                progress: 0,
                timestamp,
                pathSignature: '',
            });
        }
    }, [mapPositionFactory]);
    const startAnimationStage = useCallback((stage: TownAnimationStage) => {
        // 预留入口：后面具体动画可以在这里根据 stage.kind 调 camera、路线高亮、边高亮。
        // 当前阶段先只暴露入口，不改变地图状态，避免影响已调好的渲染链路。
        console.debug('[TownRoadMap3D] animation stage ready', stage.kind, stage.id, stage.payload);
    }, []);

    const playAnimationStage = useCallback((stage: TownAnimationStage) => {
        console.info('[TownRoadMap3D] playAnimationStage placeholder', {
            stageId: stage.id,
            stageKind: stage.kind,
            groupId: stage.payload.routeGroupId,
            pathId: stage.payload.candidatePathId,
            edgeKey: stage.payload.edgeKey,
            renderProvinces: stage.payload.renderProvinces,
        });
    }, []);

    useImperativeHandle(ref, () => ({
        setRoute,
        setTransportTasks,
        setRenderCommand: renderCommand,
        startAnimationStage,
        playAnimationStage,
        updateTruckPosition,
        clearRoutes: clearRenderedData,
    }), [clearRenderedData, playAnimationStage, renderCommand, setRoute, setTransportTasks, startAnimationStage, updateTruckPosition]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const scene = new THREE.Scene();
        scene.background = new THREE.Color('#07111f');
        scene.fog = new THREE.Fog('#07111f', 70, 210);
        sceneRef.current = scene;

        const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 10000);
        camera.position.set(0, 18, -14);
        cameraRef.current = camera;

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(container.clientWidth, container.clientHeight);
        rendererRef.current = renderer;
        container.appendChild(renderer.domElement);

        const onContextLost = (event: Event) => {
            event.preventDefault();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const memoryInfo = (renderer.info as any)?.memory;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const renderInfo = (renderer.info as any)?.render;
            console.error('[TownRoadMap3D] WebGL context lost', {
                renderedMapKey: renderedMapKeyRef.current,
                inFlightMapKey: inFlightMapKeyRef.current,
                renderRunId: renderRunRef.current,
                mapChildren: mapGroupRef.current?.children.length,
                routeChildren: routesGroupRef.current?.children.length,
                geoJsonCacheSize: mapDataCacheRef.current.size,
                memory: memoryInfo ? {
                    geometries: memoryInfo.geometries,
                    textures: memoryInfo.textures,
                } : 'unavailable',
                render: renderInfo ? {
                    calls: renderInfo.calls,
                    triangles: renderInfo.triangles,
                    points: renderInfo.points,
                    lines: renderInfo.lines,
                } : 'unavailable',
            });
        };
        const onContextRestored = () => {
            console.warn('[TownRoadMap3D] WebGL context restored');
        };
        renderer.domElement.addEventListener('webglcontextlost', onContextLost);
        renderer.domElement.addEventListener('webglcontextrestored', onContextRestored);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.target.set(0, 0, 0);
        controls.minPolarAngle = Math.PI / 10;
        controls.maxPolarAngle = Math.PI / 2 - 0.035;
        controls.minDistance = 4;
        controls.maxDistance = 80;
        controls.update();
        controlsRef.current = controls;

        // 拉伸容器：包裹地图+路线，focus 时缩放它而不是拉相机
        const transformGroup = new THREE.Group();
        transformGroup.name = 'townTransform';
        transformGroup.scale.setScalar(1);
        scene.add(transformGroup);
        transformGroupRef.current = transformGroup;

        scene.add(new THREE.AmbientLight(0xdbeafe, 0.82));
        const keyLight = new THREE.DirectionalLight(0xe0f2fe, 1.25);
        keyLight.position.set(-16, 28, 20);
        scene.add(keyLight);
        const cyanLight = new THREE.PointLight(0x22d3ee, 1.8, 100);
        cyanLight.position.set(0, 12, -8);
        scene.add(cyanLight);

        const onResize = () => {
            camera.aspect = container.clientWidth / container.clientHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(container.clientWidth, container.clientHeight);
        };
        window.addEventListener('resize', onResize);

        const onPointerMove = (event: PointerEvent) => {
            const rect = renderer.domElement.getBoundingClientRect();
            pointerRef.current.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
            pointerRef.current.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
            raycasterRef.current.setFromCamera(pointerRef.current, camera);
            const hit = raycasterRef.current.intersectObjects(interactiveObjectsRef.current, false)[0];
            if (!hit) {
                setHoverInfo(null);
                return;
            }
            const data = hit.object.userData;
            const point = screenPosition(hit.point, camera, container);
            setHoverInfo({
                x: point.x,
                y: point.y,
                title: data.title ?? '短途任务',
                subtitle: data.subtitle ?? data.objectType ?? '',
                status: data.status ?? '--',
                rows: data.rows ?? [],
            });
        };
        const onPointerLeave = () => setHoverInfo(null);
        renderer.domElement.addEventListener('pointermove', onPointerMove);
        renderer.domElement.addEventListener('pointerleave', onPointerLeave);

        const animate = () => {
            renderFrameRef.current = requestAnimationFrame(animate);
            controls.update();
            renderer.render(scene, camera);
        };
        animate();
        requestAnimationFrame(() => {
            onVisualReadyRef.current?.();

            const pending = pendingCommandBeforeSceneRef.current;
            if (pending) {
                pendingCommandBeforeSceneRef.current = null;
                console.info('[TownRoadMap3D] apply deferred render command after scene ready', {
                    commandId: pending.commandId,
                    mapKey: commandMapKey(pending),
                });
                renderCommandRef.current?.(pending);
            }
        });

        return () => {
            window.removeEventListener('resize', onResize);
            renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
            renderer.domElement.removeEventListener('webglcontextrestored', onContextRestored);
            renderer.domElement.removeEventListener('pointermove', onPointerMove);
            renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
            cancelAnimationFrame(renderFrameRef.current);
            clearRenderedData();
            controls.dispose();
            renderer.dispose();
            if (renderer.domElement.parentElement === container) {
                container.removeChild(renderer.domElement);
            }
            sceneRef.current = null;
            cameraRef.current = null;
            rendererRef.current = null;
            controlsRef.current = null;
        };
    }, [clearRenderedData]);

    return (
        <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
            <div className="pointer-events-none absolute left-5 top-5 z-40 rounded-lg border border-cyan-300/20 bg-slate-950/72 px-4 py-3 text-xs text-slate-300 shadow-2xl shadow-cyan-950/25 backdrop-blur-md">
                <div className="text-sm font-semibold text-cyan-100">区镇短途运输</div>
                <div className="mt-1 text-slate-400">按后端命令动态渲染省市县区块</div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-[10px] text-slate-300">
                    <span className="inline-flex items-center gap-1"><i className="h-0.5 w-5 rounded bg-amber-300" />省界</span>
                    <span className="inline-flex items-center gap-1"><i className="h-0.5 w-5 rounded bg-cyan-300" />市界</span>
                    <span className="inline-flex items-center gap-1"><i className="h-px w-5 rounded bg-blue-200/60" />县界</span>
                </div>
            </div>
            {hoverInfo && (
                <div
                    className="pointer-events-none absolute z-50 w-64 -translate-x-1/2 -translate-y-full rounded-md border border-cyan-300/35 bg-slate-950/92 px-3 py-2.5 text-xs text-slate-100 shadow-2xl shadow-cyan-950/40 backdrop-blur-md"
                    style={{
                        left: Math.min(Math.max(132, hoverInfo.x), Math.max(132, (containerRef.current?.clientWidth ?? 264) - 132)),
                        top: Math.min(Math.max(116, hoverInfo.y - 18), Math.max(116, (containerRef.current?.clientHeight ?? 180) - 12)),
                    }}
                >
                    <div className="mb-2 flex items-start justify-between gap-3 border-b border-white/10 pb-2">
                        <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-cyan-100">{hoverInfo.title}</div>
                            <div className="mt-0.5 truncate text-[11px] text-slate-400" title={hoverInfo.subtitle}>{hoverInfo.subtitle}</div>
                        </div>
                        <span className="shrink-0 rounded border border-emerald-300/25 bg-emerald-400/10 px-1.5 py-0.5 text-[10px] text-emerald-200">
                            {hoverInfo.status}
                        </span>
                    </div>
                    <div className="space-y-1.5">
                        {hoverInfo.rows.map(([label, value]) => (
                            <div key={label} className="grid grid-cols-[4.5rem_1fr] gap-2">
                                <span className="text-slate-400">{label}</span>
                                <span className="truncate text-right text-slate-100" title={value}>{value}</span>
                            </div>
                        ))}
                    </div>
                    <div className="absolute left-1/2 top-full h-4 w-px -translate-x-1/2 bg-cyan-300/45" />
                    <div className="absolute left-1/2 top-[calc(100%+1rem)] h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-cyan-200 shadow-[0_0_12px_rgba(125,211,252,0.8)]" />
                </div>
            )}
        </div>
    );
});

export default TownRoadMap3D;
