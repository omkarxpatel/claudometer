import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
});

if (watch) {
  await ctx.watch();
  console.log('[claudometer] watching…');
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
