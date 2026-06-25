import { useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
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

    useEffect(() => {
        if (!containerRef.current) return;
        const container = containerRef.current;
        const width = container.clientWidth;
        const height = container.clientHeight;

        const scene = new THREE.Scene();
        scene.background = new THREE.Color('#0a0e17');

        const camera = new THREE.PerspectiveCamera(45, width / height, 1, 10000);
        camera.position.set(0, 20, 0);   // 从正上方俯视
        camera.lookAt(0, 0, 0);

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setSize(width, height);
        container.appendChild(renderer.domElement);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.target.set(0, 0, 0);

        // 灯光
        scene.add(new THREE.AmbientLight(0xffffff, 1));
        const dirLight = new THREE.DirectionalLight(0xffffff, 1);
        dirLight.position.set(0, 1, 0);
        scene.add(dirLight);

        // 可选辅助线（调试时可取消注释）
        // scene.add(new THREE.AxesHelper(20));

        loadCityGeoJson().then((geoJson) => {
            const group = new THREE.Group();
            const allNames = geoJson.features.map((f: any) => f.properties.name);
            const foShanName = allNames.find((n: string) => n.includes('佛山')) || '佛山市';

            const projection = geoMercator()
                .center([104.5, 35])
                .scale(10000)          // 更大比例，确保地图铺开
                .translate([0, 0]);

            geoJson.features.forEach((feature: any) => {
                const { geometry, properties } = feature;
                const name = properties.name;
                const isFoShan = name === foShanName;
                const height = 2; // 暂时用明显的高度，便于观察
                const color = '#00ffff'; // 统一用青色，先别太暗

                let rings: number[][][] = [];
                if (geometry.type === 'Polygon') {
                    rings = [geometry.coordinates[0]];
                } else if (geometry.type === 'MultiPolygon') {
                    rings = geometry.coordinates.map((poly: any) => poly[0]);
                }

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
                        new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.2 })
                    );
                    group.add(mesh);
                });
            });

            // 关键一步：将地图组从 XY 平面翻转到 XZ 平面（水平放置）
            group.rotation.x = -Math.PI / 2;

            scene.add(group);
            console.log('✅ 地图加载完成，城市数:', group.children.length);
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
            window.removeEventListener('resize', handleResize);
            renderer.dispose();
            if (container) container.removeChild(renderer.domElement);
        };
    }, []);

    useImperativeHandle(ref, () => ({
        flyToCity: (cityName: string) => {
            console.log('flyToCity 被调用:', cityName);
        },
    }), []);

    return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
});

export default ChinaMap3D;