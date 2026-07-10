import { geoMercator } from 'd3-geo';
import { BASE_URL } from './constants';
import type { LonLat, TownGeoFeatureCollection, TownRoadRenderCommand, TownTransportTask } from './types';

const geoJsonCache = new Map<string, Promise<any>>();
export const projection = geoMercator().center([104.5, 35]).scale(80).translate([0, 0]);

/**
 * 旧 ChinaMap/RoadMap 中需要特殊处理的省级 adcode：
 * - 直辖市：北京、天津、上海、重庆。它们的 province_full 直接给区县，不能再按普通省份继续“市 -> 区县”下钻。
 * - 台湾、香港、澳门：行政层级/公开边界数据不稳定，按叶子区域处理，失败时回退到 100000_full 里的省级外壳。
 */
const MUNICIPALITY_ADCODES = new Set(['110000', '120000', '310000', '500000']);
const SPECIAL_REGION_ADCODES = new Set(['710000', '810000', '820000']);
const DIRECT_CITY_PROVINCE_ADCODES = new Set([
    ...Array.from(MUNICIPALITY_ADCODES),
    ...Array.from(SPECIAL_REGION_ADCODES),
]);

/**
 * 省直管 / 直筒子市。它们在省级 _full 中已经是叶子块，通常没有稳定的 {city}_full.json。
 * 已知会 404 的典型：东莞 441900、中山 442000。
 */
const DIRECT_MANAGED_CITY_ADCODES = new Set([
    '419001', // 河南 济源
    '429004', // 湖北 仙桃
    '429005', // 湖北 潜江
    '429006', // 湖北 天门
    '429021', // 湖北 神农架
    '441900', // 广东 东莞
    '442000', // 广东 中山
    '460400', // 海南 儋州
    '469001', // 海南 五指山
    '469002', // 海南 琼海
    '469005', // 海南 文昌
    '469006', // 海南 万宁
    '469007', // 海南 东方
    '469021', // 海南 定安
    '469022', // 海南 屯昌
    '469023', // 海南 澄迈
    '469024', // 海南 临高
    '469025', // 海南 白沙
    '469026', // 海南 昌江
    '469027', // 海南 乐东
    '469028', // 海南 陵水
    '469029', // 海南 保亭
    '469030', // 海南 琼中
    '659001', // 新疆 石河子
    '659002', // 新疆 阿拉尔
    '659003', // 新疆 图木舒克
    '659004', // 新疆 五家渠
    '659005', // 新疆 北屯
    '659006', // 新疆 铁门关
    '659007', // 新疆 双河
    '659008', // 新疆 可克达拉
    '659009', // 新疆 昆玉
    '659010', // 新疆 胡杨河
    '659011', // 新疆 新星
]);

export function normalizeAdcode(adcode?: string | number | null) {
    if (adcode === undefined || adcode === null) return null;
    const value = String(adcode).trim();
    return /^\d{6}$/.test(value) ? value : null;
}

function provinceAdcode(adcode: string) {
    return `${adcode.slice(0, 2)}0000`;
}

function cityParentAdcode(adcode: string) {
    const province = provinceAdcode(adcode);
    if (DIRECT_CITY_PROVINCE_ADCODES.has(province)) {
        return province;
    }
    return `${adcode.slice(0, 4)}00`;
}

function isProvinceAdcode(adcode: string) {
    return /^\d{2}0000$/.test(adcode);
}

function isCityAdcode(adcode: string) {
    return /^\d{4}00$/.test(adcode) && !isProvinceAdcode(adcode);
}

function isMunicipalityProvince(adcode: string) {
    return MUNICIPALITY_ADCODES.has(provinceAdcode(adcode));
}

function hasKnownNoStableChildren(feature: any) {
    const adcode = featureAdcode(feature);
    if (!adcode) return false;
    if (DIRECT_MANAGED_CITY_ADCODES.has(adcode)) return true;

    const childrenNum = Number(feature?.properties?.childrenNum);
    return Number.isFinite(childrenNum) && childrenNum <= 0;
}

export function isLonLat(value: unknown): value is LonLat {
    return Array.isArray(value)
        && value.length === 2
        && Number.isFinite(value[0])
        && Number.isFinite(value[1]);
}

export function collectRenderAdcodes(tasks: TownTransportTask[]) {
    const adcodes = new Set<string>();
    tasks.forEach((task) => {
        const fromAdcode = normalizeAdcode(task.from.adcode);
        const toAdcode = normalizeAdcode(task.to.adcode);
        if (fromAdcode) adcodes.add(fromAdcode);
        if (toAdcode) adcodes.add(toAdcode);
    });
    return Array.from(adcodes);
}

export function collectRenderProvinceAdcodes(tasks: TownTransportTask[]) {
    return uniq(collectRenderAdcodes(tasks).map(provinceAdcode));
}

export function commandOrders(command: TownRoadRenderCommand) {
    return command.orders?.length ? command.orders : (command.tasks ?? []);
}

export function commandRenderProvinces(command: TownRoadRenderCommand) {
    const source = command.renderProvinces?.length ? command.renderProvinces : (command.renderAdcodes ?? []);
    return uniq(
        source
            .map(normalizeAdcode)
            .filter((code): code is string => Boolean(code))
            .map(provinceAdcode)
    );
}

export function collectTaskCoords(tasks: TownTransportTask[]) {
    const coords: LonLat[] = [];
    tasks.forEach((task) => {
        if (isLonLat(task.from.coords)) coords.push(task.from.coords);
        if (isLonLat(task.to.coords)) coords.push(task.to.coords);
        task.coordinates?.forEach((coord) => {
            if (isLonLat(coord)) coords.push(coord);
        });
    });
    return coords;
}

function fetchGeoJson(adcode: string, full = true) {
    const cacheKey = `${adcode}:${full ? 'full' : 'plain'}`;
    const cached = geoJsonCache.get(cacheKey);
    if (cached) return cached;

    const suffix = full ? '_full' : '';
    const request = fetch(`${BASE_URL}${adcode}${suffix}.json`)
        .then((response) => {
            if (!response.ok) {
                throw new Error(`GeoJSON request failed: ${response.status} (${adcode}${suffix})`);
            }
            return response.json();
        })
        .catch((error) => {
            geoJsonCache.delete(cacheKey);
            throw error;
        });

    geoJsonCache.set(cacheKey, request);
    return request;
}

function featureAdcode(feature: any) {
    return normalizeAdcode(feature?.properties?.adcode);
}

function uniq<T>(items: T[]) {
    return Array.from(new Set(items));
}

function dedupeFeatures(features: any[]) {
    const seen = new Set<string>();
    const result: any[] = [];

    features.forEach((feature, index) => {
        const adcode = featureAdcode(feature);
        const key = adcode ?? `${feature?.properties?.name ?? 'unknown'}:${index}`;
        if (seen.has(key)) return;
        seen.add(key);
        result.push(feature);
    });

    return result;
}

async function loadCountryProvinceShellMap() {
    const country = await fetchGeoJson('100000', true);
    const map = new Map<string, any>();
    (country.features ?? []).forEach((feature: any) => {
        const adcode = featureAdcode(feature);
        if (adcode) map.set(adcode, feature);
    });
    return map;
}

async function loadProvinceShellFeatures(adcodes: string[]) {
    const targetProvinceAdcodes = new Set(
        adcodes
            .map(normalizeAdcode)
            .filter((code): code is string => Boolean(code))
            .map(provinceAdcode)
    );
    if (targetProvinceAdcodes.size === 0) return [];

    const provinceShellMap = await loadCountryProvinceShellMap();
    return Array.from(targetProvinceAdcodes)
        .map((adcode) => provinceShellMap.get(adcode))
        .filter(Boolean);
}

async function loadProvinceChildrenFeatures(province: string) {
    if (SPECIAL_REGION_ADCODES.has(province)) {
        // 台湾 / 香港 / 澳门按旧地图的特殊区域逻辑处理：优先直接使用全国省级外壳。
        const provinceShellMap = await loadCountryProvinceShellMap();
        const shell = provinceShellMap.get(province);
        return shell ? [shell] : [];
    }

    try {
        const geoJson = await fetchGeoJson(province, true);
        const children = geoJson.features ?? [];
        if (children.length > 0) return children;
    } catch (error) {
        console.warn(`[TownRoadMap3D] 省级 GeoJSON 加载失败，回退到省级外壳: ${province}`, error);
    }

    const provinceShellMap = await loadCountryProvinceShellMap();
    const shell = provinceShellMap.get(province);
    return shell ? [shell] : [];
}

/**
 * 旧地图第一层下钻：省 -> 地市/直辖市区县。
 */
async function loadProvinceCityFeatures(provinceCodes: string[]) {
    const features: any[] = [];

    await Promise.all(
        provinceCodes.map(async (province) => {
            const children = await loadProvinceChildrenFeatures(province);
            features.push(...children);
        })
    );

    return dedupeFeatures(features);
}

async function loadCityDistrictFeatures(cityFeature: any) {
    const city = featureAdcode(cityFeature);
    if (!city) return [];

    // 直辖市的 province_full 已经是区县，不需要再对每个区县请求 _full。
    if (isMunicipalityProvince(city)) {
        return [cityFeature];
    }

    // 东莞、中山、省直管县级市等没有稳定下级文件，直接使用地市/县级市 feature。
    if (!isCityAdcode(city) || hasKnownNoStableChildren(cityFeature)) {
        return [cityFeature];
    }

    try {
        const geoJson = await fetchGeoJson(city, true);
        const children = geoJson.features ?? [];
        return children.length > 0 ? children : [cityFeature];
    } catch {
        // 不警告刷屏：部分地市确实没有下级 full 文件，回退到地市块即可。
        return [cityFeature];
    }
}

/**
 * 短途地图第二层下钻：省 -> 地市 -> 区县。
 * 特殊规则：
 * - 北京/天津/上海/重庆：省 full 直接就是区县，停止下钻。
 * - 台湾/香港/澳门：按省级外壳叶子块处理。
 * - 东莞/中山/省直管县级市：无稳定下级 full，使用自身地市/县级市边界。
 */
async function loadProvinceDistrictLayers(provinceCodes: string[]) {
    const normalizedProvinces = uniq(
        provinceCodes
            .map(normalizeAdcode)
            .filter((code): code is string => Boolean(code))
            .map(provinceAdcode)
    );

    const [provinceFeatures, cityOrDistrictFeatures] = await Promise.all([
        loadProvinceShellFeatures(normalizedProvinces),
        loadProvinceCityFeatures(normalizedProvinces),
    ]);

    const districtFeatures: any[] = [];
    await Promise.all(
        cityOrDistrictFeatures.map(async (feature) => {
            const children = await loadCityDistrictFeatures(feature);
            districtFeatures.push(...children);
        })
    );

    return {
        provinceFeatures: dedupeFeatures(provinceFeatures),
        cityFeatures: dedupeFeatures(cityOrDistrictFeatures),
        districtFeatures: dedupeFeatures(districtFeatures),
    };
}

async function loadProvinceDistrictFeatures(provinceCodes: string[]) {
    const layers = await loadProvinceDistrictLayers(provinceCodes);
    return layers.districtFeatures;
}

async function loadDistrictOrCityFeatures(adcodes: string[]) {
    const normalized = adcodes
        .map(normalizeAdcode)
        .filter((code): code is string => Boolean(code));

    if (normalized.length === 0) return [];

    const target = new Set(normalized);
    const provinceTargets = normalized.filter(isProvinceAdcode);
    const cityTargets = normalized.filter(isCityAdcode);
    const districtTargets = normalized.filter((code) => !isProvinceAdcode(code) && !isCityAdcode(code));
    const features: any[] = [];

    if (provinceTargets.length > 0) {
        features.push(...await loadProvinceDistrictFeatures(provinceTargets));
    }

    if (cityTargets.length > 0) {
        const citySet = new Set(cityTargets);
        const cityShells = await loadProvinceCityFeatures(uniq(cityTargets.map(provinceAdcode)));
        const cityShellByAdcode = new Map<string, any>();
        cityShells.forEach((feature) => {
            const adcode = featureAdcode(feature);
            if (adcode && citySet.has(adcode)) {
                cityShellByAdcode.set(adcode, feature);
            }
        });

        await Promise.all(
            cityTargets.map(async (city) => {
                const shell = cityShellByAdcode.get(city);
                if (!shell) return;
                const children = await loadCityDistrictFeatures(shell);
                features.push(...children);
            })
        );
    }

    if (districtTargets.length > 0) {
        const parentAdcodes = uniq(districtTargets.map(cityParentAdcode));
        await Promise.all(
            parentAdcodes.map(async (parent) => {
                try {
                    const geoJson = await fetchGeoJson(parent, true);
                    const matched = (geoJson.features ?? []).filter((feature: any) => {
                        const adcode = featureAdcode(feature);
                        return adcode ? target.has(adcode) : false;
                    });
                    features.push(...matched);
                } catch (error) {
                    // 直辖市区县、台湾/港澳、或者部分省直管区域：回退到省 full 里筛选。
                    const parentProvince = provinceAdcode(parent);
                    try {
                        const provinceChildren = await loadProvinceChildrenFeatures(parentProvince);
                        const matched = provinceChildren.filter((feature: any) => {
                            const adcode = featureAdcode(feature);
                            return adcode ? target.has(adcode) : false;
                        });
                        features.push(...matched);
                    } catch {
                        console.warn(`[TownRoadMap3D] 区县父级 GeoJSON 加载失败: ${parent}`, error);
                    }
                }
            })
        );
    }

    return dedupeFeatures(features);
}

export async function loadGeoJsonByAdcodes(adcodes: string[]): Promise<TownGeoFeatureCollection> {
    const normalized = adcodes
        .map(normalizeAdcode)
        .filter((code): code is string => Boolean(code));
    const features = await loadDistrictOrCityFeatures(normalized);
    const provinceFeatures = await loadProvinceShellFeatures(normalized);

    return {
        type: 'FeatureCollection',
        features: dedupeFeatures(features),
        boundaryFeatures: {
            province: dedupeFeatures(provinceFeatures),
            district: dedupeFeatures(features),
        },
    };
}

export async function loadCitiesByAdcodes(adcodes: Array<string | number>): Promise<TownGeoFeatureCollection> {
    return loadGeoJsonByAdcodes(adcodes.map(String));
}

export function findNearestCity<T extends { lng: number; lat: number }>(coords: LonLat, cities: T[]): T {
    if (cities.length === 0) {
        throw new Error('findNearestCity requires at least one city');
    }

    let nearest = cities[0];
    let nearestDistance = Number.POSITIVE_INFINITY;
    cities.forEach((city) => {
        const distance = Math.hypot(coords[0] - city.lng, coords[1] - city.lat);
        if (distance < nearestDistance) {
            nearest = city;
            nearestDistance = distance;
        }
    });
    return nearest;
}

export async function loadGeoJsonByRenderCommand(command: TownRoadRenderCommand): Promise<TownGeoFeatureCollection> {
    // 正式协议只要求后端给 renderProvinces；默认执行省 -> 市 -> 区县下钻。
    // renderLevel / renderAdcodes 仅用于兼容旧 mock 命令。
    const renderLevel = command.renderLevel ?? 'province-district';
    const provinceCodes = commandRenderProvinces(command);
    const normalized = provinceCodes;

    console.info('[TownRoadMap3D] loadGeoJsonByRenderCommand', {
        renderLevel,
        provinceCodes,
        commandId: command.commandId,
    });

    if (renderLevel === 'province') {
        const provinceFeatures = await loadProvinceShellFeatures(normalized);
        return {
            type: 'FeatureCollection',
            features: dedupeFeatures(provinceFeatures),
            boundaryFeatures: {
                province: dedupeFeatures(provinceFeatures),
            },
        };
    }

    if (renderLevel === 'province-city') {
        const [provinceFeatures, cityFeatures] = await Promise.all([
            loadProvinceShellFeatures(provinceCodes),
            loadProvinceCityFeatures(provinceCodes),
        ]);
        // 区县边界数据：对每个城市加载其子区县，只用于画线不创建实体填充
        const districtFeatures: any[] = [];
        await Promise.all(
            cityFeatures.map(async (cityFeature: any) => {
                const children = await loadCityDistrictFeatures(cityFeature);
                districtFeatures.push(...children);
            })
        );
        // 诊断：打印 features 的 adcode 级别
        const sampleAdcodes = cityFeatures.slice(0, 10).map((f: any) => ({
            adcode: featureAdcode(f),
            name: f?.properties?.name,
            isCity: isCityAdcode(featureAdcode(f) ?? ''),
        }));
        console.info('[TownRoadMap3D] province-city features sample', {
            total: cityFeatures.length,
            districtTotal: districtFeatures.length,
            sampleAdcodes,
        });
        return {
            type: 'FeatureCollection',
            features: dedupeFeatures(cityFeatures),
            boundaryFeatures: {
                province: dedupeFeatures(provinceFeatures),
                city: dedupeFeatures(cityFeatures),
                district: dedupeFeatures(districtFeatures),
            },
        };
    }

    if (renderLevel === 'province-district') {
        const layers = await loadProvinceDistrictLayers(provinceCodes);
        return {
            type: 'FeatureCollection',
            features: dedupeFeatures(layers.districtFeatures),
            boundaryFeatures: {
                province: layers.provinceFeatures,
                city: layers.cityFeatures,
                district: layers.districtFeatures,
            },
        };
    }

    const features = await loadDistrictOrCityFeatures(normalized);
    const provinceFeatures = await loadProvinceShellFeatures(normalized);
    return {
        type: 'FeatureCollection',
        features: dedupeFeatures(features),
        boundaryFeatures: {
            province: dedupeFeatures(provinceFeatures),
            district: dedupeFeatures(features),
        },
    };
}

export function createLocalProjection(coords: LonLat[]) {
    let minLng = Number.POSITIVE_INFINITY;
    let maxLng = Number.NEGATIVE_INFINITY;
    let minLat = Number.POSITIVE_INFINITY;
    let maxLat = Number.NEGATIVE_INFINITY;

    // 不能使用 Math.min(...lngs) / Math.max(...lngs)。
    // 区县下钻后坐标点可能达到数十万，展开参数会触发 Maximum call stack size exceeded。
    coords.forEach(([lng, lat]) => {
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
    });

    if (
        minLng === Number.POSITIVE_INFINITY ||
        maxLng === Number.NEGATIVE_INFINITY ||
        minLat === Number.POSITIVE_INFINITY ||
        maxLat === Number.NEGATIVE_INFINITY
    ) {
        return geoMercator().center([104.5, 35]).scale(80).translate([0, 0]);
    }

    const center: LonLat = [(minLng + maxLng) / 2, (minLat + maxLat) / 2];
    const deltaDeg = Math.max(maxLng - minLng, maxLat - minLat, 0.08);
    const deltaRad = (deltaDeg * Math.PI) / 180;
    const scale = Math.min(Math.max(76 / deltaRad, 220), 4200);

    return geoMercator().center(center).scale(scale).translate([0, 0]);
}

export function featureCoords(feature: any): LonLat[] {
    const coords: LonLat[] = [];
    const geometry = feature?.geometry;
    if (!geometry) return coords;

    if (geometry.type === 'Polygon') {
        geometry.coordinates?.forEach((ring: LonLat[]) => coords.push(...ring));
    } else if (geometry.type === 'MultiPolygon') {
        geometry.coordinates?.forEach((polygon: LonLat[][]) => {
            polygon.forEach((ring) => coords.push(...ring));
        });
    }

    return coords;
}
