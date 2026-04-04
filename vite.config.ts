import { defineConfig, type Plugin } from 'vite'
import { resolve } from 'path'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import { readdirSync, renameSync, rmdirSync, existsSync } from 'fs'

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/background.ts'),
        content: resolve(__dirname, 'src/content.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
  plugins: [
    viteStaticCopy({
      targets: [
        { src: 'manifest.json', dest: '.' },
        { src: 'icons', dest: '.' },
      ],
    }),
    ({
      name: 'flatten-html',
      closeBundle() {
        const srcDir = resolve(__dirname, 'dist/src')
        if (!existsSync(srcDir)) return
        for (const file of readdirSync(srcDir)) {
          if (file.endsWith('.html')) {
            renameSync(resolve(srcDir, file), resolve(__dirname, 'dist', file))
          }
        }
        rmdirSync(srcDir)
      },
    } satisfies Plugin),
  ],
})
