# slim/vendor — artefactos sin remoto en Artifactory

El build toma cada fichero de aquí si existe; si no, lo descarga de su URL base (configurable en
`slim/.env`). En ambos casos debe coincidir con su línea en `SHA256SUMS`, o el build falla.

Descarga con el navegador solo lo que tu red no alcance durante el build. Hacen falta los binarios
de la arquitectura del Mac: `arm64` en Apple Silicon, `amd64` en Intel.

| Fichero | URL |
|---|---|
| `codebase-memory-mcp-linux-arm64.tar.gz` | https://github.com/DeusData/codebase-memory-mcp/releases/download/v0.8.1/codebase-memory-mcp-linux-arm64.tar.gz |
| `codebase-memory-mcp-linux-amd64.tar.gz` | https://github.com/DeusData/codebase-memory-mcp/releases/download/v0.8.1/codebase-memory-mcp-linux-amd64.tar.gz |
| `engram_1.16.1_linux_arm64.tar.gz` | https://github.com/Gentleman-Programming/engram/releases/download/v1.16.1/engram_1.16.1_linux_arm64.tar.gz |
| `engram_1.16.1_linux_amd64.tar.gz` | https://github.com/Gentleman-Programming/engram/releases/download/v1.16.1/engram_1.16.1_linux_amd64.tar.gz |
| `jdt-language-server-1.58.0-202604151538.tar.gz` | https://download.eclipse.org/jdtls/milestones/1.58.0/jdt-language-server-1.58.0-202604151538.tar.gz |
| `lombok-1.18.38.jar` | https://repo.maven.apache.org/maven2/org/projectlombok/lombok/1.18.38/lombok-1.18.38.jar |

Comprueba las sumas en macOS antes de construir:

```bash
cd slim/vendor && shasum -a 256 -c SHA256SUMS 2>/dev/null | grep -v "No such file"
```
