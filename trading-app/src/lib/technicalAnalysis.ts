import type { OHLCVData, TechnicalIndicators, TradingSignal, SignalScore, SignalType } from './types'

// --- Indicator Calculations ---

export function calcSMA(closes: number[], period: number): number[] {
  const result: number[] = []
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { result.push(NaN); continue }
    const sum = closes.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0)
    result.push(sum / period)
  }
  return result
}

export function calcEMA(closes: number[], period: number): number[] {
  const k = 2 / (period + 1)
  const result: number[] = []
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) { result.push(closes[0]); continue }
    if (i < period - 1) { result.push(NaN); continue }
    if (i === period - 1) {
      const sum = closes.slice(0, period).reduce((a, b) => a + b, 0)
      result.push(sum / period)
      continue
    }
    const prev = result[i - 1]
    result.push(closes[i] * k + prev * (1 - k))
  }
  return result
}

export function calcRSI(closes: number[], period = 14): number[] {
  const result: number[] = Array(closes.length).fill(NaN)
  if (closes.length < period + 1) return result

  let gains = 0, losses = 0
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff >= 0) gains += diff; else losses -= diff
  }
  let avgGain = gains / period
  let avgLoss = losses / period
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }
  return result
}

export function calcMACD(closes: number[], fast = 12, slow = 26, signal = 9) {
  const emaFast = calcEMA(closes, fast)
  const emaSlow = calcEMA(closes, slow)
  const macdLine = closes.map((_, i) => {
    if (isNaN(emaFast[i]) || isNaN(emaSlow[i])) return NaN
    return emaFast[i] - emaSlow[i]
  })
  const validMacd = macdLine.filter(v => !isNaN(v))
  const signalLine = calcEMA(validMacd, signal)
  const fullSignal: number[] = Array(macdLine.length).fill(NaN)
  let idx = 0
  macdLine.forEach((v, i) => {
    if (!isNaN(v)) { fullSignal[i] = signalLine[idx++] }
  })
  return macdLine.map((v, i) => ({
    macd: isNaN(v) ? 0 : v,
    signal: isNaN(fullSignal[i]) ? 0 : fullSignal[i],
    histogram: isNaN(v) || isNaN(fullSignal[i]) ? 0 : v - fullSignal[i],
  }))
}

export function calcBollingerBands(closes: number[], period = 20, stdDev = 2) {
  const sma = calcSMA(closes, period)
  return closes.map((_, i) => {
    if (isNaN(sma[i])) return { upper: NaN, middle: NaN, lower: NaN }
    const slice = closes.slice(i - period + 1, i + 1)
    const mean = sma[i]
    const variance = slice.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / period
    const std = Math.sqrt(variance)
    return { upper: mean + stdDev * std, middle: mean, lower: mean - stdDev * std }
  })
}

export function calcATR(data: OHLCVData[], period = 14): number[] {
  const trs = data.map((bar, i) => {
    if (i === 0) return bar.high - bar.low
    const prev = data[i - 1].close
    return Math.max(bar.high - bar.low, Math.abs(bar.high - prev), Math.abs(bar.low - prev))
  })
  const result: number[] = Array(data.length).fill(NaN)
  if (trs.length < period) return result
  result[period - 1] = trs.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < trs.length; i++) {
    result[i] = (result[i - 1] * (period - 1) + trs[i]) / period
  }
  return result
}

export function calcStochastic(data: OHLCVData[], kPeriod = 14, dPeriod = 3) {
  const highs = data.map(d => d.high)
  const lows = data.map(d => d.low)
  const closes = data.map(d => d.close)
  const kValues: number[] = []
  for (let i = 0; i < data.length; i++) {
    if (i < kPeriod - 1) { kValues.push(NaN); continue }
    const highSlice = highs.slice(i - kPeriod + 1, i + 1)
    const lowSlice = lows.slice(i - kPeriod + 1, i + 1)
    const hh = Math.max(...highSlice)
    const ll = Math.min(...lowSlice)
    kValues.push(hh === ll ? 50 : ((closes[i] - ll) / (hh - ll)) * 100)
  }
  const dValues = calcSMA(kValues.filter(v => !isNaN(v)), dPeriod)
  const result = kValues.map((k, i) => {
    const validIdx = kValues.slice(0, i + 1).filter(v => !isNaN(v)).length - 1
    return { k: isNaN(k) ? 50 : k, d: validIdx >= 0 && !isNaN(dValues[validIdx]) ? dValues[validIdx] : 50 }
  })
  return result
}

export function calcADX(data: OHLCVData[], period = 14): number[] {
  if (data.length < period * 2) return Array(data.length).fill(25)
  const result: number[] = Array(data.length).fill(NaN)
  const trueRanges: number[] = []
  const plusDMs: number[] = []
  const minusDMs: number[] = []

  for (let i = 1; i < data.length; i++) {
    const curr = data[i], prev = data[i - 1]
    trueRanges.push(Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close)))
    const upMove = curr.high - prev.high
    const downMove = prev.low - curr.low
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0)
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0)
  }

  let atr14 = trueRanges.slice(0, period).reduce((a, b) => a + b, 0)
  let plusDM14 = plusDMs.slice(0, period).reduce((a, b) => a + b, 0)
  let minusDM14 = minusDMs.slice(0, period).reduce((a, b) => a + b, 0)
  const dxValues: number[] = []

  for (let i = period; i < trueRanges.length; i++) {
    atr14 = atr14 - atr14 / period + trueRanges[i]
    plusDM14 = plusDM14 - plusDM14 / period + plusDMs[i]
    minusDM14 = minusDM14 - minusDM14 / period + minusDMs[i]
    const plusDI = (plusDM14 / atr14) * 100
    const minusDI = (minusDM14 / atr14) * 100
    const diSum = plusDI + minusDI
    dxValues.push(diSum === 0 ? 0 : (Math.abs(plusDI - minusDI) / diSum) * 100)
  }

  if (dxValues.length >= period) {
    let adx = dxValues.slice(0, period).reduce((a, b) => a + b, 0) / period
    result[period * 2] = adx
    for (let i = period; i < dxValues.length; i++) {
      adx = (adx * (period - 1) + dxValues[i]) / period
      result[period + i] = adx
    }
  }
  return result.map(v => isNaN(v) ? 25 : v)
}

// --- Main Analysis ---

export function computeIndicators(data: OHLCVData[]): TechnicalIndicators {
  const closes = data.map(d => d.close)
  const last = closes.length - 1

  const rsiArr = calcRSI(closes)
  const macdArr = calcMACD(closes)
  const sma20Arr = calcSMA(closes, 20)
  const sma50Arr = calcSMA(closes, 50)
  const ema20Arr = calcEMA(closes, 20)
  const ema50Arr = calcEMA(closes, 50)
  const bbArr = calcBollingerBands(closes)
  const atrArr = calcATR(data)
  const stochArr = calcStochastic(data)
  const adxArr = calcADX(data)

  return {
    rsi: isNaN(rsiArr[last]) ? 50 : rsiArr[last],
    macd: macdArr[last],
    sma20: isNaN(sma20Arr[last]) ? closes[last] : sma20Arr[last],
    sma50: isNaN(sma50Arr[last]) ? closes[last] : sma50Arr[last],
    ema20: isNaN(ema20Arr[last]) ? closes[last] : ema20Arr[last],
    ema50: isNaN(ema50Arr[last]) ? closes[last] : ema50Arr[last],
    bollingerBands: isNaN(bbArr[last].upper) ? { upper: closes[last] * 1.01, middle: closes[last], lower: closes[last] * 0.99 } : bbArr[last],
    atr: isNaN(atrArr[last]) ? closes[last] * 0.005 : atrArr[last],
    stochastic: stochArr[last],
    adx: adxArr[last],
  }
}

export function generateSignal(ind: TechnicalIndicators, currentPrice: number, pair: string): TradingSignal {
  const scores: SignalScore[] = []
  let buyScore = 0, sellScore = 0

  // RSI
  const rsiSig: SignalType = ind.rsi < 35 ? 'BUY' : ind.rsi > 65 ? 'SELL' : 'NEUTRAL'
  const rsiWeight = ind.rsi < 25 || ind.rsi > 75 ? 25 : 15
  scores.push({
    indicator: 'RSI', signal: rsiSig, weight: rsiWeight,
    value: ind.rsi.toFixed(1),
    description: ind.rsi < 35 ? 'Oversold — bullish reversal likely' : ind.rsi > 65 ? 'Overbought — bearish reversal likely' : 'Neutral territory',
  })
  if (rsiSig === 'BUY') buyScore += rsiWeight
  else if (rsiSig === 'SELL') sellScore += rsiWeight

  // MACD
  const macdSig: SignalType = ind.macd.histogram > 0 && ind.macd.macd > ind.macd.signal ? 'BUY'
    : ind.macd.histogram < 0 && ind.macd.macd < ind.macd.signal ? 'SELL' : 'NEUTRAL'
  scores.push({
    indicator: 'MACD', signal: macdSig, weight: 20,
    value: `${ind.macd.macd.toFixed(5)} / ${ind.macd.signal.toFixed(5)}`,
    description: macdSig === 'BUY' ? 'MACD above signal line — bullish momentum' : macdSig === 'SELL' ? 'MACD below signal line — bearish momentum' : 'MACD and signal converging',
  })
  if (macdSig === 'BUY') buyScore += 20
  else if (macdSig === 'SELL') sellScore += 20

  // Moving Averages
  const maSig: SignalType = ind.ema20 > ind.ema50 && ind.sma20 > ind.sma50 ? 'BUY'
    : ind.ema20 < ind.ema50 && ind.sma20 < ind.sma50 ? 'SELL' : 'NEUTRAL'
  scores.push({
    indicator: 'MA Cross (20/50)', signal: maSig, weight: 20,
    value: `EMA20: ${ind.ema20.toFixed(5)}`,
    description: maSig === 'BUY' ? 'Short MA above long MA — uptrend' : maSig === 'SELL' ? 'Short MA below long MA — downtrend' : 'MAs in mixed alignment',
  })
  if (maSig === 'BUY') buyScore += 20
  else if (maSig === 'SELL') sellScore += 20

  // Bollinger Bands
  const bbRange = ind.bollingerBands.upper - ind.bollingerBands.lower
  const bbPos = bbRange === 0 ? 0.5 : (currentPrice - ind.bollingerBands.lower) / bbRange
  const bbSig: SignalType = bbPos < 0.2 ? 'BUY' : bbPos > 0.8 ? 'SELL' : 'NEUTRAL'
  scores.push({
    indicator: 'Bollinger Bands', signal: bbSig, weight: 15,
    value: `${(bbPos * 100).toFixed(0)}% of band`,
    description: bbSig === 'BUY' ? 'Price near lower band — potential bounce' : bbSig === 'SELL' ? 'Price near upper band — potential reversal' : 'Price within normal band range',
  })
  if (bbSig === 'BUY') buyScore += 15
  else if (bbSig === 'SELL') sellScore += 15

  // Stochastic
  const stochSig: SignalType = ind.stochastic.k < 25 && ind.stochastic.d < 25 ? 'BUY'
    : ind.stochastic.k > 75 && ind.stochastic.d > 75 ? 'SELL' : 'NEUTRAL'
  scores.push({
    indicator: 'Stochastic', signal: stochSig, weight: 15,
    value: `%K: ${ind.stochastic.k.toFixed(1)}`,
    description: stochSig === 'BUY' ? 'Stochastic in oversold zone' : stochSig === 'SELL' ? 'Stochastic in overbought zone' : 'Stochastic in neutral range',
  })
  if (stochSig === 'BUY') buyScore += 15
  else if (stochSig === 'SELL') sellScore += 15

  // ADX (trend strength modifier)
  const trendStrong = ind.adx > 25
  scores.push({
    indicator: 'ADX (Trend Strength)', signal: 'NEUTRAL', weight: 0,
    value: ind.adx.toFixed(1),
    description: trendStrong ? 'Strong trend in play — signals more reliable' : 'Weak trend — signals less reliable',
  })

  const total = buyScore + sellScore
  let signalType: SignalType = 'NEUTRAL'
  let confidence = 50

  if (total > 0) {
    const buyPct = (buyScore / (buyScore + sellScore)) * 100
    if (buyPct >= 60) { signalType = 'BUY'; confidence = Math.min(95, 50 + (buyPct - 50) * 1.8) }
    else if (buyPct <= 40) { signalType = 'SELL'; confidence = Math.min(95, 50 + (50 - buyPct) * 1.8) }
    else { signalType = 'NEUTRAL'; confidence = 50 }
  }

  if (trendStrong) confidence = Math.min(95, confidence + 5)

  // TP / SL levels based on ATR
  const atr = ind.atr
  const isGold = pair.includes('XAU')
  const atrMult = isGold ? 1.5 : 1.0

  if (signalType === 'BUY') {
    return {
      type: 'BUY', confidence, scores, entryPrice: currentPrice,
      takeProfit1: currentPrice + atr * atrMult * 1.0,
      takeProfit2: currentPrice + atr * atrMult * 2.0,
      takeProfit3: currentPrice + atr * atrMult * 3.0,
      stopLoss: currentPrice - atr * atrMult * 1.5,
      riskRewardRatio: 2,
      pipValue: atr,
    }
  } else if (signalType === 'SELL') {
    return {
      type: 'SELL', confidence, scores, entryPrice: currentPrice,
      takeProfit1: currentPrice - atr * atrMult * 1.0,
      takeProfit2: currentPrice - atr * atrMult * 2.0,
      takeProfit3: currentPrice - atr * atrMult * 3.0,
      stopLoss: currentPrice + atr * atrMult * 1.5,
      riskRewardRatio: 2,
      pipValue: atr,
    }
  } else {
    return {
      type: 'NEUTRAL', confidence, scores, entryPrice: currentPrice,
      takeProfit1: currentPrice + atr,
      takeProfit2: currentPrice + atr * 2,
      takeProfit3: currentPrice + atr * 3,
      stopLoss: currentPrice - atr,
      riskRewardRatio: 1,
      pipValue: atr,
    }
  }
}
