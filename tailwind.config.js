/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}', './src/portal/index.html', './src/portal/**/*.{ts,tsx}', './src/codigo/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { 50: '#f5f7fa', 100: '#e9edf3', 200: '#d3dae5', 300: '#aab6c8', 400: '#7c8ba3', 500: '#56657f', 600: '#3f4c62', 700: '#2f394b', 800: '#1f2632', 900: '#141a23' },
        brand: { 400: '#4f8cff', 500: '#2d6df6', 600: '#1f57d1' },
        ok: '#22c55e', warn: '#f59e0b', bad: '#ef4444'
      },
      fontFamily: { mono: ['"SF Mono"', 'Menlo', 'monospace'] }
    }
  },
  plugins: []
}
