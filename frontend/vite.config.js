import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react()],
    server: {
        // shared/plans.js lives above this root and is imported by the
        // checkout modal; without this the dev server refuses to serve it.
        fs: { allow: ['..'] },
        proxy: {
            '/api': {
                target: 'http://localhost:5500',
                changeOrigin: true,
                secure: false,
            }
        }
    }
})