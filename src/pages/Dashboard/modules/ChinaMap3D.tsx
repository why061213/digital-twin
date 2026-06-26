import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { geoMercator } from 'd3-geo';

const BASE_URL = 'https://geo.datav.aliyun.com/areas_v3/bound/';
const DIRECT_CITY_ADCODES = [110000, 120000, 310000, 500000];

async function loadCityGeoJson(): Promise<any> {
    const provResp = await fetch(`${BASE_URL}100000_full.json`);
    const provData = await provResp.json();
    const municipalityFeatures: any[] = [];
    const provinceAdcodes: number[] = [];
    provData.features.forEach((f: any) => {
        const adcode = f.properties.adcode;
        if (DIRECT_CITY_ADCODES.includes(adcode)) municipalityFeatures.push(f);
        else if (/^\d+$/.test(String(adcode))) provinceAdcodes.push(adcode);
    });
    const cityFeatures: any[] = [];
    await Promise.all(
        provinceAdcodes.map(async (adcode) => {
            try {
                const resp = await fetch(`${BASE_URL}${adcode}_full.json`);
                const data = await resp.json();
                if (data.features) cityFeatures.push(...data.features);
            } catch (e) {}
        })
    );
    return { type: 'FeatureCollection', features: [...municipalityFeatures, ...cityFeatures] };
}

const ChinaMap3D = forwardRef((_props: {}, ref: any) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const meshMapRef = useRef<Record<string, THREE.Group>>({});
    const cityStatusRef = useRef<Map<string, number>>(new Map());       // 0: 地面, 1: 凸起
    const animFramesRef = useRef<Map<string, number>>(new Map());       // 每个城市当前动画帧ID
    const foShanNameRef = useRef<string>('佛山市');
    const coordDivRef = useRef<HTMLDivElement>(null);

    const RISE_HEIGHT = -1.5; // 向上凸起的距离（负 Z 轴方向为世界 Y 轴正方向）

    const easeInOutCubic = (t: number) =>
        t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

    // 单个城市升降动画（独立帧管理）
    const animateCity = useCallback(
        (cityName: string, targetZ: number, duration: number = 1500) => {
            const group = meshMapRef.current[cityName];
            if (!group) return;

            // 取消该城市已有的动画
            const oldFrame = animFramesRef.current.get(cityName);
            if (oldFrame !== undefined) {
                cancelAnimationFrame(oldFrame);
                animFramesRef.current.delete(cityName);
            }

            const startZ = group.position.z;
            const delta = targetZ - startZ;
            if (Math.abs(delta) < 0.001) return;

            const startTime = performance.now();

            const step = () => {
                const now = performance.now();
                const progress = Math.min((now - startTime) / duration, 1);
                const eased = easeInOutCubic(progress);
                group.position.z = startZ + delta * eased;

                if (progress < 1) {
                    animFramesRef.current.set(cityName, requestAnimationFrame(step));
                } else {
                    group.position.z = targetZ;
                    animFramesRef.current.delete(cityName);
                }
            };

            animFramesRef.current.set(cityName, requestAnimationFrame(step));
        },
        []
    );

    // 上升方法
    const riseCity = useCallback(
        (cityName: string) => {
            const matchedKey = Object.keys(meshMapRef.current).find((n) =>
                n.includes(cityName)
            );
            if (!matchedKey) return;

            const status = cityStatusRef.current.get(matchedKey) ?? 0;
            if (status === 1) return; // 已经凸起，忽略

            // 更新状态
            cityStatusRef.current.set(matchedKey, 1);

            const group = meshMapRef.current[matchedKey];
            if (!group) return;

            // 设置颜色（佛山保持金色，其他变为亮青色）
            const isFoShan = matchedKey === foShanNameRef.current;
            group.children.forEach((child) => {
                if (child instanceof THREE.Mesh) {
                    (child.material as THREE.MeshStandardMaterial).color.set(
                        isFoShan ? '#d97706' : '#06b6d4'
                    );
                }
            });

            // 执行上升动画
            animateCity(matchedKey, RISE_HEIGHT, 1500);
        },
        [animateCity]
    );

    // 下降方法
    const fallCity = useCallback(
        (cityName: string) => {
            const matchedKey = Object.keys(meshMapRef.current).find((n) =>
                n.includes(cityName)
            );
            if (!matchedKey) return;

            const status = cityStatusRef.current.get(matchedKey) ?? 0;
            if (status === 0) return; // 已经在地面，忽略

            // 更新状态
            cityStatusRef.current.set(matchedKey, 0);

            const group = meshMapRef.current[matchedKey];
            if (!group) return;

            // 恢复默认颜色
            const isFoShan = matchedKey === foShanNameRef.current;
            group.children.forEach((child) => {
                if (child instanceof THREE.Mesh) {
                    (child.material as THREE.MeshStandardMaterial).color.set(
                        isFoShan ? '#d97706' : '#334155'
                    );
                }
            });

            // 执行下降动画
            animateCity(matchedKey, 0, 800); // 下降可以稍快
        },
        [animateCity]
    );

    // 暴露方法给父组件
    useImperativeHandle(ref, () => ({ riseCity, fallCity, flyToCity: riseCity }), [riseCity, fallCity]);

    // 场景初始化（大部分不变，只调整初始高度和状态）
    useEffect(() => {
        if (!containerRef.current) return;
        const container = containerRef.current;
        const width = container.clientWidth;
        const height = container.clientHeight;

        const scene = new THREE.Scene();
        scene.background = new THREE.Color('#0a0e17');

        const camera = new THREE.PerspectiveCamera(45, width / height, 1, 10000);
        camera.position.set(0, 25, 0);
        camera.lookAt(0, 0, 0);

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setSize(width, height);
        container.appendChild(renderer.domElement);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.target.set(0, 0, 0);
        controls.minPolarAngle = 0;
        controls.maxPolarAngle = Math.PI / 2.2;
        controls.maxDistance = 300;
        controls.minDistance = 2;
        controls.update();

        const ambient = new THREE.AmbientLight(0xffffff, 0.7);
        scene.add(ambient);
        const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
        dirLight.position.set(0, 1, 0);
        scene.add(dirLight);

        loadCityGeoJson().then((geoJson) => {
            const group = new THREE.Group();
            const allNames = geoJson.features.map((f: any) => f.properties.name);
            const foShanName = allNames.find((n: string) => n.includes('佛山')) || '佛山市';
            foShanNameRef.current = foShanName;

            const projection = geoMercator()
                .center([104.5, 35])
                .scale(80)
                .translate([0, 0]);

            geoJson.features.forEach((feature: any) => {
                const { geometry, properties } = feature;
                const name = properties.name;
                const isFoShan = name === foShanName;
                const depth = isFoShan ? 2.0 : 1.0; // 佛山厚度 2，其他 1
                const color = isFoShan ? '#d97706' : '#334155';
                const initialStatus = isFoShan ? 1 : 0;   // 佛山初始凸起

                let rings: number[][][] = [];
                if (geometry.type === 'Polygon') {
                    rings = [geometry.coordinates[0]];
                } else if (geometry.type === 'MultiPolygon') {
                    rings = geometry.coordinates.map((poly: any) => poly[0]);
                }

                const cityGroup = new THREE.Group();
                cityGroup.name = name;
                // 初始位置：佛山凸起，其他在地面
                cityGroup.position.set(0, 0, initialStatus ? RISE_HEIGHT : 0);
                cityGroup.userData = { baseDepth: depth, isFoShan };

                rings.forEach((ring) => {
                    const shape = new THREE.Shape();
                    ring.forEach(([lng, lat], i) => {
                        const [x, y] = projection([lng, lat])!;
                        if (i === 0) shape.moveTo(-x, -y);
                        else shape.lineTo(-x, -y);
                    });

                    const geom = new THREE.ExtrudeGeometry(shape, {
                        depth: depth,
                        bevelEnabled: false,
                    });
                    const mesh = new THREE.Mesh(
                        geom,
                        new THREE.MeshStandardMaterial({
                            color,
                            roughness: 0.6,
                            metalness: 0.2,
                            side: THREE.DoubleSide,
                        })
                    );
                    cityGroup.add(mesh);
                });

                group.add(cityGroup);
                meshMapRef.current[name] = cityGroup;
                cityStatusRef.current.set(name, initialStatus);
            });

            group.rotation.x = Math.PI / 2;
            scene.add(group);
        });

        const animate = () => {
            requestAnimationFrame(animate);
            controls.update();

            if (coordDivRef.current) {
                coordDivRef.current.textContent =
                    `相机 (X:${camera.position.x.toFixed(2)} Y:${camera.position.y.toFixed(2)} Z:${camera.position.z.toFixed(2)})`;
            }

            renderer.render(scene, camera);
        };
        animate();

        const handleResize = () => {
            camera.aspect = container.clientWidth / container.clientHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(container.clientWidth, container.clientHeight);
        };
        window.addEventListener('resize', handleResize);

        return () => {
            // 清理所有动画帧
            animFramesRef.current.forEach((frame) => cancelAnimationFrame(frame));
            window.removeEventListener('resize', handleResize);
            renderer.dispose();
            if (container) container.removeChild(renderer.domElement);
        };
    }, []);

    return (
        <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
            <div
                ref={coordDivRef}
                style={{
                    position: 'absolute',
                    top: '50%',
                    left: '50%',
                    transform: 'translate(-50%, -50%)',
                    background: 'rgba(0,0,0,0.7)',
                    color: '#0ff',
                    padding: '5px 10px',
                    borderRadius: 4,
                    fontFamily: 'monospace',
                    fontSize: 12,
                    pointerEvents: 'none',
                    zIndex: 100,
                }}
            />
        </div>
    );
});

export default ChinaMap3D;
