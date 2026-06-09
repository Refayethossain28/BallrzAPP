import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'FX Signal Pro — Currency Trading Analysis',
  description: 'Real-time forex analysis with buy/sell signals, take profit, and stop loss levels',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
