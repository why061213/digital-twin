import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
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

const ChinaMap3D = forwardRef((props: {}, ref: any) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const groupRef = useRef<THREE.Group | null>(null);
    const meshMapRef = useRef<Record<string, THREE.Group>>({});
    const foShanNameRef = useRef<string>('佛山市');
    const currentTargetRef = useRef<string | null>(null);
    const animFrameRef = useRef<number | null>(null);

    // 缓动函数
    const easeInOutCubic = (t: number) =>
        t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

    // 单个城市升降动画
    const animateCity = useCallback(
        (cityName: string, targetHeight: number, duration: number = 1500) => {
            const group = meshMapRef.current[cityName];
            if (!group) return;

            const baseHeight = (group.userData as any)?.baseHeight ?? 0.5;
            (group.userData as any).baseHeight = baseHeight;

            const startScaleY = group.scale.y;
            const endScaleY = targetHeight / baseHeight;
            const startTime = performance.now();

            if (animFrameRef.current !== null) {
                cancelAnimationFrame(animFrameRef.current);
                animFrameRef.current = null;
            }

            const step = () => {
                const now = performance.now();
                const progress = Math.min((now - startTime) / duration, 1);
                const eased = easeInOutCubic(progress);
                group.scale.y = startScaleY + (endScaleY - startScaleY) * eased;

                if (progress < 1) {
                    animFrameRef.current = requestAnimationFrame(step);
                } else {
                    group.scale.y = endScaleY;
                    animFrameRef.current = null;
                }
            };
            animFrameRef.current = requestAnimationFrame(step);
        },
        []
    );

    // 外部调用
    const flyToCity = useCallback(
        (cityName: string) => {
            const matchedKey = Object.keys(meshMapRef.current).find((n) =>
                n.includes(cityName)
            );
            if (!matchedKey) return;

            if (currentTargetRef.current === matchedKey) return;

            const oldTarget = currentTargetRef.current;
            if (oldTarget && oldTarget !== matchedKey) {
                const oldGroup = meshMapRef.current[oldTarget];
                if (oldGroup) {
                    const oldBaseHeight = (oldGroup.userData as any)?.baseHeight ?? 0.5;
                    animateCity(oldTarget, oldBaseHeight, 800);
                    const isFoShan = oldTarget === foShanNameRef.current;
                    oldGroup.children.forEach((child) => {
                        if (child instanceof THREE.Mesh) {
                            (child.material as THREE.MeshStandardMaterial).color.set(
                                isFoShan ? '#d97706' : '#334155'
                            );
                        }
                    });
                }
            }

            const newGroup = meshMapRef.current[matchedKey];
            if (newGroup) {
                const isFoShan = matchedKey === foShanNameRef.current;
                const newBaseHeight = (newGroup.userData as any)?.baseHeight ?? 0.5;
                animateCity(matchedKey, 1.5, 1500);
                newGroup.children.forEach((child) => {
                    if (child instanceof THREE.Mesh) {
                        (child.material as THREE.MeshStandardMaterial).color.set(
                            isFoShan ? '#d97706' : '#06b6d4'
                        );
                    }
                });
            }
            currentTargetRef.current = matchedKey;
        },
        [animateCity]
    );

    // 暴露给父组件
    useImperativeHandle(ref, () => ({ flyToCity }), [flyToCity]);

    // 场景初始化
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
                const height = isFoShan ? 1.5 : 0.5;
                const color = isFoShan ? '#d97706' : '#334155';

                let rings: number[][][] = [];
                if (geometry.type === 'Polygon') {
                    rings = [geometry.coordinates[0]];
                } else if (geometry.type === 'MultiPolygon') {
                    rings = geometry.coordinates.map((poly: any) => poly[0]);
                }

                const cityGroup = new THREE.Group();
                cityGroup.name = name;

                rings.forEach((ring) => {
                    const shape = new THREE.Shape();
                    ring.forEach(([lng, lat], i) => {
                        const [x, y] = projection([lng, lat])!;
                        if (i === 0) shape.moveTo(x, y);
                        else shape.lineTo(x, y);
                    });

                    const geom = new THREE.ExtrudeGeometry(shape, {
                        depth: height,
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
                // 记录基础高度
                (cityGroup.userData as any).baseHeight = height;
            });

            group.rotation.x = Math.PI / 2;
            scene.add(group);
            groupRef.current = group;
        });

        const animate = () => {
            requestAnimationFrame(animate);
            controls.update();
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
            if (animFrameRef.current !== null) cancelAnimationFrame(animFrameRef.current);
            window.removeEventListener('resize', handleResize);
            renderer.dispose();
            if (container) container.removeChild(renderer.domElement);
        };
    }, []);

    return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
});

export default ChinaMap3D;