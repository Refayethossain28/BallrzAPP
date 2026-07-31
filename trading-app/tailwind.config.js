/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        buy: {
          DEFAULT: '#00c853',
          dark: '#009624',
          light: '#e8f5e9',
        },
        sell: {
          DEFAULT: '#d50000',
          dark: '#9b0000',
          light: '#ffebee',
        },
        neutral: {
          signal: '#f59e0b',
        },
        surface: {
          DEFAULT: '#0f1117',
          card: '#1a1d2e',
          border: '#2a2d3e',
          muted: '#262a3d',
        },
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'fade-in': 'fadeIn 0.5s ease-in-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
}
