type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'group' | 'groupEnd';

function isEnabled() {
    return localStorage.getItem('townRoadDebug') !== '0';
}

export function townLog(level: LogLevel, message?: string, payload?: unknown) {
    if (!isEnabled()) return;

    const prefix = '[TownRoad]';

    if (level === 'group') {
        console.groupCollapsed(`${prefix} ${message ?? ''}`);
        if (payload !== undefined) console.log(payload);
        return;
    }

    if (level === 'groupEnd') {
        console.groupEnd();
        return;
    }

    const text = `${prefix} ${message ?? ''}`;

    if (level === 'debug') console.debug(text, payload ?? '');
    else if (level === 'info') console.info(text, payload ?? '');
    else if (level === 'warn') console.warn(text, payload ?? '');
    else if (level === 'error') console.error(text, payload ?? '');
}
