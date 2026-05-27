import type { EarningsData } from '../types';

interface EarningsBarProps {
  data: EarningsData[];
  maxAmount?: number;
}

export default function EarningsBar({ data, maxAmount }: EarningsBarProps) {
  const max = maxAmount ?? Math.max(...data.map((d) => d.amount), 1);

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 120, padding: '0 4px' }}>
      {data.map((item) => {
        const heightPct = (item.amount / max) * 100;
        const isHighest = item.amount === max;
        return (
          <div
            key={item.day}
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 5,
              height: '100%',
              justifyContent: 'flex-end',
            }}
          >
            <div
              style={{
                fontSize: 9,
                color: isHighest ? '#C9A84C' : '#555555',
                fontWeight: 600,
                visibility: heightPct > 5 ? 'visible' : 'hidden',
              }}
            >
              £{item.amount}
            </div>
            <div
              style={{
                width: '100%',
                height: `${heightPct}%`,
                minHeight: 4,
                background: isHighest
                  ? 'linear-gradient(180deg, #C9A84C, #a07a2e)'
                  : 'linear-gradient(180deg, #333333, #222222)',
                borderRadius: '4px 4px 2px 2px',
                transition: 'height 0.5s ease',
                boxShadow: isHighest ? '0 0 12px rgba(201,168,76,0.3)' : 'none',
              }}
            />
            <div
              style={{
                fontSize: 10,
                color: isHighest ? '#C9A84C' : '#555555',
                fontWeight: isHighest ? 700 : 500,
              }}
            >
              {item.day}
            </div>
          </div>
        );
      })}
    </div>
  );
}
