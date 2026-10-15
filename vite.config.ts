import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发模式（热更新）：界面固定在 http://127.0.0.1:5188，后端 6688；/api 和 /files 转发给后端。
// 端口固定（strictPort），被占用就直接报错，不会悄悄换成别的端口让人打开错地址。
const DEV_PORT = 5188;

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: DEV_PORT,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:6688',
      '/files': 'http://127.0.0.1:6688',
    },
  },
});
