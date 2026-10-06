# Vendored third-party files

The console loads nothing from another origin: its icons and fonts are served from here, so the page
where the LLM gateway key is pasted can run under a content security policy that allows only its own
origin (`src/server/static.ts`). Each file is the upstream release, unmodified; the SHA-256 lets a
reviewer check it against the npm tarball.

| File | Source | Version | License |
|---|---|---|---|
| `lucide/lucide.min.js` | npm `lucide`, `dist/umd/lucide.min.js` | 0.460.0 | ISC (`lucide/LICENSE`) |
| `fonts/archivo-latin-wght-normal.woff2`, `fonts/archivo-latin-wght-italic.woff2` | npm `@fontsource-variable/archivo`, `files/` | 5.3.0 | SIL OFL 1.1 (`fonts/Archivo-OFL.txt`) |
| `fonts/jetbrains-mono-latin-wght-normal.woff2`, `fonts/jetbrains-mono-latin-wght-italic.woff2` | npm `@fontsource-variable/jetbrains-mono`, `files/` | 5.3.0 | SIL OFL 1.1 (`fonts/JetBrainsMono-OFL.txt`) |

```
1b22c6c04a1c69b75a41c64c7ea992657e8f628dabd6324984ffc61c3761a56a  lucide/lucide.min.js
8f704806dbedeaaeca334b11ec348bc3ac3a439d6431544b3afb54f534ee4967  fonts/archivo-latin-wght-normal.woff2
3d109f97a71d3d3d04d16e5c4b95be8f89146a55ebbed239b90f5a8c5d4f437a  fonts/archivo-latin-wght-italic.woff2
18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e  fonts/jetbrains-mono-latin-wght-normal.woff2
a8afa085e9ca5e53434e2ee918ba6b65c7dd4dda56509976b36591478c99d62e  fonts/jetbrains-mono-latin-wght-italic.woff2
```

The fonts are the latin subset (the console is English); a character outside it falls back to the system
font. `lucide.min.js` keeps its trailing `sourceMappingURL` comment; the map is not shipped.

To upgrade: `npm pack <package>@<version>`, copy the same files, update the table and the hashes.
