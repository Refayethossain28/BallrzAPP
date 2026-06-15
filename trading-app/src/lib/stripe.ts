import Stripe from 'stripe'

export const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' })
  : null

export const PRO_PRICE_ID = process.env.STRIPE_PRO_PRICE_ID ?? ''
