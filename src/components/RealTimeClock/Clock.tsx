import { useState, useEffect } from 'react';

function Clock() {
    const [time, setTime] = useState(new Date());

    useEffect(() => {
        const timer = setInterval(() => setTime(new Date()), 1000);
        return () => clearInterval(timer);
    }, []);

    const format = (t: Date) => {
        const year = t.getFullYear();
        const month = String(t.getMonth() + 1).padStart(2, '0');
        const day = String(t.getDate()).padStart(2, '0');
        const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
        const weekday = weekdays[t.getDay()];
        const hours = String(t.getHours()).padStart(2, '0');
        const minutes = String(t.getMinutes()).padStart(2, '0');
        const seconds = String(t.getSeconds()).padStart(2, '0');
        return `${year}-${month}-${day} 星期${weekday} ${hours}:${minutes}:${seconds}`;
    };

    return (
        <div className="text-cyan-300 text-lg font-mono tracking-wider">
            {format(time)}
        </div>
    );
}

export default Clock;