import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发模式：前端 5173，后端 6688；/api 和 /files 转发给后端
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:6688',
      '/files': 'http://127.0.0.1:6688',
    },
  },
});
