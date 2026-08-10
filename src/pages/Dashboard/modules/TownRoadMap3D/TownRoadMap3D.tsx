import { forwardRef, useImperativeHandle } from 'react';
import { useTownMapRefs } from './hooks/useTownMapRefs';
import { useTownMapScene } from './hooks/useTownMapScene';
import { useTownMapData } from './hooks/useTownMapData';
import type { TownRoadMap3DHandle } from './types';

const TownRoadMap3D = forwardRef<TownRoadMap3DHandle>((_props, ref) => {
    const refs = useTownMapRefs();
    useTownMapScene(refs);
    const { setRoute } = useTownMapData(refs);

    useImperativeHandle(ref, () => ({
        setRoute,
    }), [setRoute]);

    return <div ref={refs.containerRef} style={{ width: '100%', height: '100%' }} />;
});

export default TownRoadMap3D;