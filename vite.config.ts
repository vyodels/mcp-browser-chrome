import { build as esbuildBuild } from 'esbuild'
import { defineConfig, type Plugin } from 'vite'
import { resolve } from 'path'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import { existsSync, readdirSync, renameSync, rmdirSync } from 'fs'

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/background.ts'),
        content: resolve(__dirname, 'src/content.ts'),
        popup: resolve(__dirname, 'src/popup.html'),
        mockBoss: resolve(__dirname, 'src/mock-boss.html'),
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
      async closeBundle() {
        await esbuildBuild({
          entryPoints: [resolve(__dirname, 'src/content.ts')],
          bundle: true,
          format: 'iife',
          platform: 'browser',
          target: ['chrome114'],
          outfile: resolve(__dirname, 'dist/content.js'),
          logLevel: 'silent',
        })

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
