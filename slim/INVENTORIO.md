# QAyaba slim — inventario para la revisión de seguridad

Inventario de lo que contiene la imagen, de lo que ejecuta y de lo que toca la red. Está derivado de
[`Dockerfile`](Dockerfile) y [`compose.yml`](compose.yml); si cualquiera de los dos cambia, este documento
debe cambiar con ellos. Para obtener la lista de paquetes **realmente** instalada en la imagen construida
(incluidas las dependencias transitivas de apt y PyPI, que no están fijadas una a una), ejecuta:

```bash
./slim/qayaba.sh sbom                      # docker scout sbom, o docker sbom; admite los argumentos de esas herramientas
./slim/qayaba.sh sbom --format spdx -o sbom.spdx.json
```

Si el equipo no dispone de ninguna de las dos herramientas, el comando remite a este documento.

## 1. Resumen

| Aspecto | Valor |
|---|---|
| Imagen | Una sola (`qayaba-slim`), usada por tres servicios: `orchestrator`, `agents` y `tui` (bajo demanda) |
| Puerto publicado en el equipo | Solo `127.0.0.1:8080` (consola web, API y webhook). Nada escucha en otras interfaces |
| Socket de Docker, modo privilegiado, red del host | No se usan ni se montan |
| Descargas en ejecución | Ninguna: todo se obtiene durante el build (`npm ci`, `pip`, `apt`, binarios verificados por SHA-256) |
| Secretos en la imagen | Ninguno (ver §7) |
| Publicación remota | Retirada: el resultado se exporta a disco (`slim/exports/`) para que una persona lo suba al SCM |

## 2. Componentes de la imagen

### 2.1 Imágenes base (etapas de construcción)

| Etapa | Imagen (argumento) | Qué aporta | Llega a la imagen final |
|---|---|---|---|
| `deps` | `node:24-bookworm` (`NODE_IMAGE`) | Compila `better-sqlite3` desde fuente y ejecuta `npm ci` | Solo `node_modules` y el `opencode.json` efectivo |
| `tui` | `golang:1.26-bookworm` (`GO_IMAGE`) | Compila la consola de terminal (`CGO_ENABLED=0`) | Solo el binario Linux `qayaba` |
| `runtime` | `mcr.microsoft.com/playwright:v1.60.0-noble` (`PW_IMAGE`) | Ubuntu 24.04, Node 24, git y los navegadores de Playwright con sus librerías (solo se usa Chromium) | Es la base de la imagen final |

Las tres referencias son **etiquetas**, no resúmenes (*digest*). Para fijarlas de forma inmutable, indica
`PW_IMAGE=<repo>@sha256:…` (y equivalentes) en `slim/.env`. El build comprueba que el Node de la imagen final
sea ≥ 24 y que `better-sqlite3` abra una base de datos, e imprime la versión de Node.

La verificación de la clave contra el gateway (`agents/agent-supervisor.mjs`) necesita **Node ≥ 24.14**, que es
la versión que incorpora `http.setGlobalProxyFromEnv`: con ella la consulta a `<baseURL>/models` respeta
`HTTPS_PROXY`/`NO_PROXY`. En un Node anterior la consulta sale directa; si hay un proxy configurado para el
host del gateway y la conexión falla, el estado es `degraded` («key not verified (no proxy support in this
Node)») y no `failed`, porque ese fallo no dice nada sobre la clave. El build avisa en su salida cuando la
imagen final no tiene esa función.

### 2.2 Paquetes del sistema (apt, Ubuntu 24.04)

Origen: `archive.ubuntu.com` / `security.ubuntu.com` (amd64) o `ports.ubuntu.com` (arm64), sustituibles por
`APT_MIRROR` / `APT_PORTS_MIRROR`. La lista `nodesource` de la imagen base se elimina.

| Paquete | Versión | Uso |
|---|---|---|
| `python3`, `python3-venv` | La de Ubuntu 24.04 (no fijada) | Entorno virtual de Serena |
| `openjdk-21-jdk-headless` | La de Ubuntu 24.04 (no fijada) | JDK de JDTLS (`/opt/java21`); incluye `ca-certificates-java` |

### 2.3 Paquetes npm (registro: `NPM_REGISTRY`)

| Componente | Versión | Dónde queda | Verificación |
|---|---|---|---|
| Dependencias del orquestador | `package-lock.json`: 372 paquetes, todos con `integrity` | `/app/node_modules` | `npm ci` falla si el árbol o las sumas no coinciden |
| `better-sqlite3` | 12.10.1 | Compilado en el build contra las cabeceras locales de Node 24 | Sin binario precompilado ni descarga de cabeceras |
| `@opencode-ai/sdk` | 1.17.7 | `/app/node_modules` | Lockfile |
| `opencode-ai` (agente) | 1.17.7 | Global (`npm install -g`) | Versión exacta |
| `@playwright/mcp` | 0.0.76 (depende de `playwright` 1.61.0-alpha) | Global | Versión exacta |
| Servidor de lenguaje de TypeScript de Serena | `typescript` 5.9.3 + `typescript-language-server` 5.1.3 | `~/.serena/language_servers/static/` | Aprovisionado en el build; el build comprueba el binario |
| Dependencias del proyecto `e2e/` del repositorio vigilado | `config/e2e/package.json` (`@playwright/test` 1.60.0 exacto, resto por rango) | `<repo>/e2e/node_modules`, **en ejecución** (ver §6.2) | Lockfile del repositorio vigilado |

Scripts de instalación en el árbol del orquestador: `better-sqlite3` (compila) y `esbuild` (verifica su binario);
`fsevents` solo aplica a macOS y no se instala en Linux.

### 2.4 PyPI (`PIP_INDEX_URL`)

| Componente | Versión | Nota |
|---|---|---|
| `serena-agent` | 1.5.3 | Sus dependencias directas están fijadas por la propia Serena; las transitivas las resuelve el índice en el build (usa `./slim/qayaba.sh sbom` para verlas) |

### 2.5 Binarios y artefactos fuera de los gestores de paquetes

Cada uno se toma de `slim/vendor/` si existe o se descarga de su URL base, y **debe coincidir** con su línea de
[`vendor/SHA256SUMS`](vendor/SHA256SUMS); si falta la línea o la suma difiere, el build falla.

| Artefacto | Versión | Origen oficial | SHA-256 (linux-arm64 / linux-amd64) |
|---|---|---|---|
| `codebase-memory-mcp` | 0.8.1 | GitHub Releases `DeusData/codebase-memory-mcp` (`GITHUB_RELEASES_BASE`) | `d2f842d1…d46091` / `dbd3b92e…470973` |
| `engram` | 1.16.1 | GitHub Releases `Gentleman-Programming/engram` (`GITHUB_RELEASES_BASE`) | `56a2cb3c…d27827` / `d95202f1…3dbdf7` |
| JDT Language Server | 1.58.0-202604151538 | `download.eclipse.org` (`JDTLS_BASE_URL`) | `2a5bbe55…4a50d9` (único, independiente de la arquitectura) |
| Lombok | 1.18.38 | Maven Central (`MAVEN_REPO`) | `1e1e427c…c50fb9` (único) |

Las sumas completas están en `slim/vendor/SHA256SUMS`.

### 2.6 Go (`GOPROXY`, `GOSUMDB`)

La consola de terminal se compila desde `client/` (`go.mod` / `go.sum`, `-mod=readonly`, `-trimpath`). Dependencias
directas: `charmbracelet/bubbletea` 1.3.10, `bubbles` 1.0.0, `glamour` 1.0.0, `lipgloss`, `x/ansi` 0.11.6,
`oapi-codegen/runtime` 1.4.2 y `zalando/go-keyring` 0.2.8. `GOSUMDB` es configurable (`off` o una base de sumas
interna) si el proxy de módulos no replica `sum.golang.org`.

### 2.7 Código propio y configuración que entra por `COPY . .`

El contexto de build es la raíz del repositorio, filtrado por [`Dockerfile.dockerignore`](Dockerfile.dockerignore).
Entran el código de `src/`, `qa-engine/`, `agents/`, `agent/`, `web/`, `config/` y `slim/` (incluida la CA pública
de `slim/certs/*.crt`). `config/apps/*.yaml` (si existen) y `slim/opencode.override.json` (obligatorio) entran también: no
contienen secretos (las variables van como `${VAR}`; cada proveedor del override ha de tener un
`baseURL` http(s) y leer la clave exactamente como `{env:OPENCODE_API_KEY}`, y el build rechaza una clave literal), y en ejecución `../config` se monta encima de `/app/config`.

## 3. Usuarios y privilegios

La imagen no declara `USER`: **todos los procesos de los tres servicios se ejecutan como `root` dentro del
contenedor.** Existe un usuario `sandbox` (uid 1002), pero solo lo usa el modo `target: code`, que slim no emplea.

| Contenedor | Proceso | Usuario | Notas |
|---|---|---|---|
| `orchestrator` | `npm run start` → `node boot-guard.mjs` + `tsx src/index.ts` (API, cola secuencial, git, publicación local) | root | `no-new-privileges:true`; límites 2560m / 2 CPU |
| `orchestrator` | `git` (clonar, `fetch`, `diff`, exportar) | root | El token se inyecta en el `git clone`/`fetch` con `-c url.<…>.insteadOf` (solo esa invocación); no se guarda en `.git/config` |
| `orchestrator` | `npm ci`/`npm install` del `e2e/` del repositorio vigilado, `tsc`, ESLint, `playwright test`, captura del DOM, `codebase-memory-mcp` | root, con entorno filtrado (`scrubEnv`) | El filtrado quita `GIT_TOKEN`, `OPENCODE_API_KEY`, `WEBHOOK_SECRET`, `QA_API_TOKEN`… del entorno de estos procesos, pero **no cambian de usuario** (ver §8, punto 1) |
| `agents` | `agent-supervisor.mjs` → `opencode serve`, y sus MCP: Serena (+ JDTLS, servidor de TypeScript), engram, `playwright-mcp` + Chromium | root | Límites 4g / 3 CPU. Sin `no-new-privileges` |
| `tui` | `qayaba` (consola de terminal) | root | 128m. Solo mientras está abierta |
| `config-init` | `sh` (copia la configuración efectiva de OpenCode a sus volúmenes y termina) | root | 64m. Un solo uso, antes que `agents` (`depends_on: service_completed_successfully`); `restart: "no"` |

El agente de IA es de **solo lectura** sobre los repositorios vigilados: solo el orquestador ejecuta `git`. El agente
únicamente escribe ficheros (los `.spec.ts` y el manifiesto) en la copia de trabajo; el orquestador los valida
(`tsc`, ESLint, `playwright --list`) antes de ejecutarlos.

## 4. Red

| Servicio | Puerto | Publicado en el equipo | Quién lo usa |
|---|---|---|---|
| `orchestrator` | 8080 | **Sí, solo `127.0.0.1:${QAYABA_PORT:-8080}`** | Navegador del operador (consola `/app`), API, webhook; `tui` por `orchestrator:8080` |
| `agents` | 4096 (`opencode serve`) | No | Solo el orquestador, por `agents:4096` |
| `agents` | 4097 (supervisor) | No | Solo el orquestador, por `agents:4097` |

`./slim/qayaba.sh check` verifica que el puerto 8080 está publicado únicamente en loopback y que el orquestador
responde por su dirección de la red de compose. La consola web no tiene inicio de sesión automático
(`QA_WEB_AUTO_LOGIN` no se define): se accede con el token local, que `./slim/qayaba.sh console` copia al
portapapeles. Un contenedor de la red de compose no puede obtener una sesión de operador.

## 5. Volúmenes y montajes

| Montaje | Servicio | Contenido | Persistencia |
|---|---|---|---|
| `../config` → `/app/config` | `orchestrator` (lectura/escritura), `tui` (solo lectura) | YAML de las apps, semilla `e2e`, `config/.api_token` (se genera aquí) | Anfitrión; el `.api_token` no se versiona |
| `./exports` → `/app/exports` | `orchestrator` | Parche y cuerpos de MR/Issue de cada ejecución | Anfitrión; no se versiona |
| `./maven` → `/root/.m2-settings` (solo lectura) | `agents` | `settings.xml` opcional con el mirror de Artifactory (puede contener credenciales); el arranque lo enlaza en `~/.m2/settings.xml` | Anfitrión; no se versiona ni entra en el build |
| `maven-repository` → `/root/.m2/repository` | `agents` | Repositorio local de Maven (dependencias que resuelve JDTLS) | Volumen; regenerable |
| `mirrors` → `/app/.mirrors` | ambos | Copias de trabajo de los repositorios (cwd de las sesiones del agente) | Volumen; regenerable |
| `qa-data` → `/app/data` | `orchestrator` | Historial de ejecuciones (SQLite) y estado | Volumen |
| `codebase-memory` → `/app/.codebase-memory` | `orchestrator` | Grafo de código por proyecto | Volumen; regenerable |
| `engram-data` → `/data` | `agents` | Memoria episódica de engram (SQLite) | Volumen; el único dato no regenerable |
| `opencode-data` → `/root/.local/share/opencode` | `agents` | Sesiones de OpenCode | Volumen |
| `opencode-config` → `/root/.config/opencode` (solo lectura) | `agents`; `config-init` lo escribe | Configuración efectiva de OpenCode (`opencode.json`, `agents/`, `AGENTS.md`, skills), copiada de la imagen en cada `up` | Volumen; regenerable. El agente no puede escribirla |
| `agent-prompts` → `/root/.config/agent` (solo lectura) | `agents`; `config-init` lo escribe | Prompts neutrales respecto al proveedor | Volumen; regenerable. El agente no puede escribirlo |
| `opencode-home` → `/root/.opencode` (solo lectura) | `agents`; `config-init` lo vacía | Nada: OpenCode lee `~/.opencode/` como directorio de configuración, así que se mantiene vacío y no escribible | Volumen; siempre vacío |

## 6. Salida de red

### 6.1 En el build (solo las fuentes configuradas)

| Destino | Argumento | Qué se obtiene |
|---|---|---|
| Registro de imágenes | `PW_IMAGE`, `NODE_IMAGE`, `GO_IMAGE` | Imágenes base (lo hace el motor de Docker) |
| Mirror apt | `APT_MIRROR`, `APT_PORTS_MIRROR` (por defecto Ubuntu) | `python3`, `python3-venv`, `openjdk-21-jdk-headless` |
| Registro npm | `NPM_REGISTRY` | Dependencias, `opencode-ai`, `@playwright/mcp`, servidor de TypeScript de Serena |
| Índice PyPI | `PIP_INDEX_URL` | `serena-agent` y sus dependencias |
| Proxy de módulos Go | `GOPROXY`, `GOSUMDB` | Módulos de la consola |
| Maven | `MAVEN_REPO` | Lombok (o `slim/vendor/`) |
| GitHub Releases | `GITHUB_RELEASES_BASE` | `codebase-memory-mcp`, engram (o `slim/vendor/`) |
| eclipse.org | `JDTLS_BASE_URL` | JDTLS (o `slim/vendor/`) |

Todos los destinos se pueden apuntar a remotos internos (Artifactory) y la CA corporativa se instala para
cada cliente, Java incluido (`java-trust-ca` falla el build si algún certificado no queda confiado).

### 6.2 En ejecución (lista cerrada)

| Destino | Quién | Para qué | Control |
|---|---|---|---|
| Pasarela de LLM (`options.baseURL` del override) | `agents` (OpenCode y el supervisor) | Inferencia, y `GET <baseURL>/models` con la clave del día para comprobar que la acepta (el supervisor aplica `HTTPS_PROXY`/`NO_PROXY` del entorno; la clave no se registra ni se devuelve) | OpenCode queda limitado a los proveedores del override (`enabled_providers`); sin catálogo de modelos, sin auto-actualización, sin plugins por defecto, sin descarga de LSP y sin compartir sesiones (`share: disabled`). La configuración de OpenCode es de solo lectura para el agente y el repositorio vigilado no aporta la suya (`OPENCODE_DISABLE_PROJECT_CONFIG`, ver §8, punto 8) |
| Servidor git (`GIT_REMOTE_BASE`) | `orchestrator` | Clonar y `fetch` de los repositorios (token de solo lectura) | Solo el orquestador recibe el token |
| Aplicación bajo prueba en DEV y su proveedor de identidad (origen de `e2e.auth.loginUrl`) | `orchestrator` (specs, captura del DOM) y `agents` (MCP de Playwright) | Ejecutar y explorar la aplicación | Dominios de la propia aplicación |
| Registro npm interno (`NPM_REGISTRY`, tomado del npmrc global) | `orchestrator` | `npm ci` del `e2e/` del repositorio vigilado al preparar cada ejecución | Es el mismo mirror que el del build; no hay otra descarga |

Se buscaron llamadas salientes en `src/`, `qa-engine/src/` y `agents/` (`fetch`, `http(s).request`, `undici`,
`WebSocket`, `net.connect`) y en el código de Serena 1.5.3. No hay más destinos activos en el perfil slim:

- Las llamadas a `api.github.com` (PR, Issues, comprobaciones de CI, listado de repositorios) están detrás de
  `remotePublication` o de que el servidor git sea GitHub (`isGithubRemote()`); con un servidor GitLab no se ejecutan.
- El auto-mantenimiento y el inicio de sesión de GitHub están desactivados por el perfil.
- Serena envía por defecto un aviso de uso a un servidor de su proveedor; la imagen lo desactiva con
  `SERENA_USAGE_REPORTING=false`. Su panel web está desactivado y su estimador de tokens es local.
- OpenCode no recibe otro catálogo ni otro destino que los del override.
- engram (`engram mcp --tools=agent`, por stdio) y `codebase-memory-mcp` (CLI local) trabajan sobre ficheros
  locales; son binarios de terceros y su código no está en este repositorio.

En el **navegador del operador** (no en los contenedores), la consola web no pide nada fuera de su origen: los
iconos (`lucide` 0.460.0) y las tipografías (Archivo y JetBrains Mono, licencia OFL) se sirven desde
`web/public/vendor/` y la consola se entrega con una política de seguridad de contenido que solo admite su propio
origen (ver §8, punto 4).

## 7. Tratamiento de secretos

| Secreto | Cómo llega | Dónde vive | Protecciones |
|---|---|---|---|
| Clave de la pasarela de LLM (caduca a diario) | Se pega en la consola web o en la TUI; opcionalmente `OPENCODE_API_KEY` en `slim/.env` | Memoria y entorno de los procesos de `orchestrator` y `agents`; el perfil slim no escribe ningún fichero (ni `/app/.env`). Ningún volumen la conserva | No se guarda en el navegador ni en URL; se enmascara en errores de transporte y en las salidas registradas; el filtrado de entorno la quita de los procesos del repositorio vigilado |
| Token de git | `GIT_TOKEN` (solo lectura) en `slim/.env` | Entorno de `orchestrator` | `agents` no lo recibe; se aplica con `-c url.<…>.insteadOf` solo en `clone`/`fetch` y no queda en `.git/config`; se oculta en logs y se bloquea en el entorno de procesos no confiables |
| Token de la API local | `config/.api_token` (generado) o `QA_API_TOKEN` | Anfitrión (`config/`, no versionado) | La consola pide este token (sin login automático) y lo guarda solo en `sessionStorage`; `./slim/qayaba.sh console` lo copia al portapapeles sin imprimirlo |
| `WEBHOOK_SECRET` | `slim/.env` | Entorno de `orchestrator` | Firma HMAC del webhook |
| Credenciales de DEV (`DEV_ENV_*`, `DEV_TEST_*`) | `slim/.env` | Entorno de ambos servicios (el MCP de Playwright inicia sesión) | Alcance limitado al origen de la aplicación |
| `settings.xml` de Maven | Fichero local | `./maven` (solo `agents`) | No versionado; excluido del contexto de build |

**Nada de esto entra en la imagen.** `Dockerfile.dockerignore` excluye `.env`, `.env.*` (salvo el ejemplo),
`slim/.env`, `.api_token`, `config/.api_token`, `*.pem`, `*.key`, `slim/exports/` y `slim/maven/`; `.git/` tampoco
entra. La redacción de datos que salen del sistema (logs, Issues, errores del agente) la hace el
`RedactionPortAdapter` del orquestador, y los diffs y mensajes de commit que se envían al modelo pasan por
`sanitize-text.ts`.

## 8. Observaciones para la revisión

Hechos comprobados en el código y la configuración que conviene valorar; ninguno es un fallo del build.

1. **El código del repositorio vigilado se ejecuta como root en el orquestador.** El cambio de usuario a `sandbox`
   solo se aplica en `target: code`. En el modo e2e (el de slim), `npm ci` del `e2e/` (con sus scripts de
   instalación), `tsc`, ESLint y los specs de Playwright —ficheros que genera el agente— corren como root con el
   entorno filtrado, pero con acceso al sistema de ficheros del contenedor (`config/.api_token`,
   `/app/data`) y al entorno del proceso principal. La frontera efectiva es el contenedor, no el usuario.
2. **El servicio `agents` corre entero como root**, sin `no-new-privileges` ni retirada de capacidades; solo el
   orquestador tiene `no-new-privileges`.
3. **Los puertos 4096 y 4097 no tienen autenticación propia.** No se publican, pero cualquier contenedor de la red
   de compose (incluido `tui`) puede alcanzarlos.
4. **La consola web no carga recursos de terceros.** Iconos y tipografías están en `web/public/vendor/` (con su
   licencia y sus sumas SHA-256 en `web/public/vendor/README.md`) y cada respuesta de `/app` lleva
   `Content-Security-Policy` (`default-src`, `script-src` y `connect-src` solo `'self'`; sin script en línea;
   `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'self'`), `X-Content-Type-Options: nosniff` y
   `Referrer-Policy: no-referrer`. Queda `style-src 'unsafe-inline'`, porque la consola fija atributos `style` en
   el HTML que pinta.
5. **Dependencias no fijadas una a una:** paquetes apt (los de Ubuntu 24.04 en la fecha del build), dependencias
   transitivas de `serena-agent` y las etiquetas de las imágenes base. `./slim/qayaba.sh sbom` captura lo instalado.
6. **Servidores de lenguaje de otros idiomas.** Solo TypeScript y Java están aprovisionados en el build. Si Serena
   activa otro lenguaje presente en un repositorio, intentaría aprovisionar su servidor en ejecución (npm interno o
   descarga directa); la hermeticidad cubre los lenguajes de la versión actual de los repositorios objetivo.
7. **Binarios de terceros** (`engram`, `codebase-memory-mcp`): verificados por SHA-256 contra la versión fijada,
   pero sin auditoría de su código ni de su comportamiento de red en este repositorio.
8. **La configuración de OpenCode no se puede cambiar desde el repositorio vigilado ni desde el agente.** OpenCode
   fusiona el `opencode.json`, el `.opencode/` y el `AGENTS.md` de la copia de trabajo sobre su configuración
   global; la imagen fija `OPENCODE_DISABLE_PROJECT_CONFIG=true`, de modo que solo rige la global. Además, esa
   configuración llega a `agents` por volúmenes de solo lectura que rellena `config-init` desde la imagen en cada
   arranque (§5): el shell del agente (root) no puede reescribirla para el siguiente reinicio, y `~/.opencode/`,
   que OpenCode también lee como directorio de configuración, queda vacío y no escribible. Contrapartida: el
   `AGENTS.md` y la configuración propios del repositorio vigilado no se cargan. Las *skills* externas que OpenCode
   descubre en la copia de trabajo no son configuración sino contexto y esta medida no las desactiva.

## 9. Cómo verificarlo

```bash
./slim/qayaba.sh preflight      # alcance de cada destino de build y de la pasarela de LLM, desde un contenedor
./slim/qayaba.sh build          # falla si una suma SHA-256, la CA de Java, el Node o la configuración de modelos no cuadran
./slim/qayaba.sh check          # herramientas presentes, puerto solo en loopback, consola alcanzable desde la red de compose
./slim/qayaba.sh sbom           # lista real de paquetes de la imagen construida
cd slim/vendor && shasum -a 256 -c SHA256SUMS 2>/dev/null | grep -v "No such file"
```

Para comprobar la ausencia de descargas en ejecución se puede arrancar la pila sin salida de red a Internet
(solo hacia la pasarela, el servidor git y DEV) y revisar `./slim/qayaba.sh logs`.
