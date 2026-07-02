export type RouteDTO = {
    id: string;
    coords: [number, number][];
    plate?: string;
    cargo?: string;
    from?: string;
    to?: string;
    status?: string;
    routeLengthKm?: number;
};

export type VehiclePositionDTO = {
    routeId: string;
    lng: number;
    lat: number;
    plate?: string;
    cargo?: string;
    from?: string;
    to?: string;
    status?: string;
    speedKmh?: number | null;
    routeLengthKm?: number;
    updatedAt?: string;
};

async function requestJson<T>(url: string): Promise<T> {
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Request failed: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<T>;
}

export async function fetchRoadRoutes(): Promise<RouteDTO[]> {
    return requestJson<RouteDTO[]>('/api/road/routes');
}

export async function fetchVehiclePositions(): Promise<VehiclePositionDTO[]> {
    return requestJson<VehiclePositionDTO[]>('/api/road/vehicles/positions');
}