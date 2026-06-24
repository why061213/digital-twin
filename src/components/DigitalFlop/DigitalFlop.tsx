interface DigitalFlopProps {
    value: number | string;
    unit?: string;
}

function DigitalFlop({ value, unit }: DigitalFlopProps) {
    return (
        <span className="text-2xl font-bold text-white font-mono">
      {value}
            {unit && <span className="text-sm text-gray-400 ml-1">{unit}</span>}
    </span>
    );
}

export default DigitalFlop;