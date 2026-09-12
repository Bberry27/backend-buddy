import { build } from 'esbuild';
await build({entryPoints:['src/index.tsx'],bundle:true,minify:true,format:'iife',globalName:'BackendBuddyViews',outfile:'dist/extensions.js',jsx:'automatic',target:['es2022'],define:{'process.env.NODE_ENV':'"production"'},legalComments:'eof'});
