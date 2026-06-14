import type { Metadata } from 'next'
import './globals.css'
import SplashScreen from '@/components/SplashScreen'

export const metadata: Metadata = {
  title: 'ApexTrade — AI-Powered Forex Signals',
  description: 'Real-time forex analysis with AI buy/sell signals, take profit, and stop loss levels',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SplashScreen />
        {children}
      </body>
    </html>
  )
}
