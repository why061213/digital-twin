import { forwardRef, useImperativeHandle } from 'react';
import { ChinaMap3DHandle } from './types';
import { useChinaMapRefs } from './hooks/useChinaMapRefs';
import { useCityControls } from './hooks/useCityControls';
import { useFlyLines } from './hooks/useFlyLines';
import { useCameraControls } from './hooks/useCameraControls';
import { useWarehouseLabels } from './hooks/useWarehouseLabels';
import { useCityPanels } from './hooks/useCityPanels';
import { useWarehouseTour } from './hooks/useWarehouseTour';
import { useMapHover } from './hooks/useMapHover';
import { useMapScene } from './hooks/useMapScene';

const ChinaMap3D = forwardRef<ChinaMap3DHandle>((_props, ref) => {
    const refs = useChinaMapRefs();

    const labels = useWarehouseLabels(refs);
    const camera = useCameraControls(refs, labels.setLabelVisibility, labels.applyLabelVisibility);
    const cities = useCityControls(refs, labels, camera.focusFreightNodes);
    const flyLines = useFlyLines(refs, camera.focusFreightNodes);
    const panels = useCityPanels(refs, cities.findCityKey, labels.applyLabelVisibility);
    const tour = useWarehouseTour(refs, camera.focusPoints, labels.refreshWarehouseLabels, labels.setLabelVisibility, cities.findCityKey);
    const hover = useMapHover(refs);

    useMapScene(refs, {
        cities,
        labels,
        camera,
        flyLines,
        panels,
        hover,
    });

    useImperativeHandle(ref, () => ({
        riseCity: cities.riseCity,
        fallCity: cities.fallCity,
        flyToCity: cities.riseCity,
        addFlyLine: flyLines.addFlyLine,
        removeFlyLine: flyLines.removeFlyLine,
        updateCityData: cities.updateCityData,
        focusOnCities: camera.focusOnCities,
        startWarehouseTour: tour.startWarehouseTour,
        showCityPanels: panels.showCityPanels,
        clearCityPanels: panels.clearCityPanels,
    }));

    return <div ref={refs.containerRef} style={{ width: '100%', height: '100%', position: 'relative' }} />;
});

export default ChinaMap3D;
export type { ChinaMap3DHandle };