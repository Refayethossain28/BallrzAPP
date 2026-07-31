'use client'
import { useEffect, useMemo, useState } from 'react'
import { Calculator } from 'lucide-react'

// Turns the verdict's entry/stop distance into a concrete position size for
// the trader's account and risk tolerance. Pure client-side arithmetic;
// settings persist across sessions.

const SETTINGS_KEY = 'apexfx-risk-settings'

function parsePrice(s: string): number | null {
  const n = parseFloat(s.replace(/[,\s]/g, ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

export default function PositionSizeCalculator({
  entry,
  stopLoss,
  takeProfit1,
}: {
  entry: string
  stopLoss: string
  takeProfit1: string
}) {
  const [balance, setBalance] = useState(1000)
  const [riskPct, setRiskPct] = useState(1)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY)
      if (raw) {
        const s = JSON.parse(raw) as { balance?: number; riskPct?: number }
        if (typeof s.balance === 'number' && s.balance > 0) setBalance(s.balance)
        if (typeof s.riskPct === 'number' && s.riskPct > 0) setRiskPct(s.riskPct)
      }
    } catch { /* defaults are fine */ }
  }, [])

  useEffect(() => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ balance, riskPct })) } catch { /* ignore */ }
  }, [balance, riskPct])

  const calc = useMemo(() => {
    const e = parsePrice(entry)
    const sl = parsePrice(stopLoss)
    const tp = parsePrice(takeProfit1)
    if (!e || !sl || e === sl) return null
    const dist = Math.abs(e - sl)
    const riskAmount = (balance * riskPct) / 100
    const units = riskAmount / dist
    return {
      riskAmount,
      units,
      lots: units / 100_000, // standard FX lot
      potentialProfit: tp ? units * Math.abs(tp - e) : null,
    }
  }, [entry, stopLoss, takeProfit1, balance, riskPct])

  if (!calc) return null

  const fmt = (n: number, digits = 2) =>
    n.toLocaleString(undefined, { maximumFractionDigits: digits })

  return (
    <div className="card p-5">
      <h3 className="text-white font-semibold text-sm mb-3 flex items-center gap-2">
        <Calculator className="w-4 h-4 text-blue-400" /> Position Size
      </h3>
      <div className="grid grid-cols-2 gap-3 mb-4">
        <label className="block">
          <span className="text-xs text-gray-500">Account balance</span>
          <input
            type="number"
            min={1}
            value={balance}
            onChange={e => setBalance(Math.max(0, Number(e.target.value)))}
            className="mt-1 w-full bg-surface-muted border border-surface-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
          />
        </label>
        <label className="block">
          <span className="text-xs text-gray-500">Risk per trade (%)</span>
          <input
            type="number"
            min={0.1}
            max={100}
            step={0.1}
            value={riskPct}
            onChange={e => setRiskPct(Math.max(0, Number(e.target.value)))}
            className="mt-1 w-full bg-surface-muted border border-surface-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
          />
        </label>
      </div>
      <div className="space-y-1.5 text-sm">
        <Row label="You're risking" value={fmt(calc.riskAmount)} tone="text-sell" />
        <Row label="Position size" value={`${fmt(calc.units, 0)} units`} tone="text-white" />
        <Row label="≈ Standard lots (FX)" value={fmt(calc.lots, 3)} tone="text-white" />
        {calc.potentialProfit !== null && (
          <Row label="Potential at TP1" value={`+${fmt(calc.potentialProfit)}`} tone="text-buy" />
        )}
      </div>
      <p className="text-[11px] text-gray-600 mt-3">
        Units = risk amount ÷ entry-to-stop distance, in your account currency. Check your broker&apos;s
        contract sizes and margin before placing the trade.
      </p>
    </div>
  )
}

function Row({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-gray-500">{label}</span>
      <span className={`font-mono font-semibold ${tone}`}>{value}</span>
    </div>
  )
}
