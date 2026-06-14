'use client'
import type { SignalType } from '@/lib/types'

interface Broker {
  name: string
  url: string
  color: string
}

const BROKERS: Broker[] = [
  {
    name: 'eToro',
    url: 'https://www.etoro.com/?utm_source=fxsignalpro',
    color: '#00C805',
  },
  {
    name: 'IC Markets',
    url: 'https://www.icmarkets.com/?utm_source=fxsignalpro',
    color: '#004097',
  },
  {
    name: 'XM',
    url: 'https://www.xm.com/?utm_source=fxsignalpro',
    color: '#E0261B',
  },
  {
    name: 'Pepperstone',
    url: 'https://pepperstone.com/?utm_source=fxsignalpro',
    color: '#00A651',
  },
]

interface Props {
  signal: SignalType
}

export default function BrokerButtons({ signal }: Props) {
  const accentColor =
    signal === 'BUY' ? '#00c853' : signal === 'SELL' ? '#d50000' : '#f59e0b'
  const label =
    signal === 'BUY'
      ? 'Trade this BUY signal at:'
      : signal === 'SELL'
      ? 'Trade this SELL signal at:'
      : 'Open a position at:'

  return (
    <div className="mt-4 pt-4 border-t border-surface-border">
      <p className="text-xs text-gray-500 mb-3">{label}</p>
      <div className="grid grid-cols-2 gap-2">
        {BROKERS.map(broker => (
          <a
            key={broker.name}
            href={broker.url}
            target="_blank"
            rel="noopener noreferrer sponsored"
            className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition-all hover:scale-105"
            style={{
              backgroundColor: `${accentColor}15`,
              borderColor: `${accentColor}40`,
              color: '#e2e8f0',
              border: `1px solid ${accentColor}30`,
            }}
          >
            <span
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: broker.color }}
            />
            {broker.name}
          </a>
        ))}
      </div>
      <p className="text-xs text-gray-600 mt-2 text-center">
        Affiliate links — we may earn a commission
      </p>
    </div>
  )
}
