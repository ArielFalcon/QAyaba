# QAyaba Slim — POC E2E en un entorno restringido

| | |
|---|---|
| **Estado** | **Implementado** y verificado (ver §12), integrado con `main`. Pendiente la construcción de la imagen con el endurecimiento de §14 y la ejecución en el entorno corporativo restringido. |
| **Rama** | `claude/merge-main-restricted-env-925a71` (integra `main`; la implementación original está en `claude/qayaba-restricted-env-poc-hytgtl`) |
| **Alcance** | `target: e2e` (Playwright contra DEV). Un solo runtime de agente (OpenCode). SCM: GitLab. |
| **Entorno objetivo** | Portátil corporativo gestionado (MacBook M4 con 16 GB, sin sudo, con lista de aplicaciones permitidas); Docker Desktop; Artifactory; proxy con inspección TLS; una pasarela de LLM corporativa compatible con OpenAI; DEV con login central (mTLS opcional y usuario/contraseña). |
| **Runbook operativo** | [`slim/README.md`](../../slim/README.md) |
| **Fecha** | 2026-09-27 (actualizado el 2026-10-06 tras integrar `main` y adaptar el empaquetado al equipo objetivo) |

---

## Índice

0. [Resumen](#0-resumen)
1. [Contexto y requisitos](#1-contexto-y-requisitos)
2. [Diagnóstico: por qué fallaba](#2-diagnóstico-por-qué-fallaba)
3. [Criterio de recorte: núcleo vs. periferia](#3-criterio-de-recorte-núcleo-vs-periferia)
4. [Arquitectura](#4-arquitectura)
5. [Build hermético](#5-build-hermético)
6. [Red dentro de los contenedores](#6-red-dentro-de-los-contenedores)
7. [OpenCode y el proveedor LLM](#7-opencode-y-el-proveedor-llm)
8. [GitLab y publicación local](#8-gitlab-y-publicación-local)
9. [Login central con redirección](#9-login-central-con-redirección)
10. [Consolas: TUI y web](#10-consolas-tui-y-web)
11. [Cambios de código](#11-cambios-de-código)
12. [Verificación realizada](#12-verificación-realizada)
13. [Riesgos, límites y siguientes pasos](#13-riesgos-límites-y-siguientes-pasos)
14. [Actualización: integración con `main` y adaptación al equipo objetivo](#14-actualización-integración-con-main-y-adaptación-al-equipo-objetivo)
- [Apéndice — Referencias al código](#apéndice--referencias-al-código)

---

## 0. Resumen

QAyaba fallaba en el entorno corporativo restringido por un motivo **estructural**: descargaba cosas de Internet no
solo al construir las imágenes, sino también **al ejecutarse**. La más probable, el fallo observado:
Serena hace `npm install` de su *language server* de TypeScript la primera vez que abre un proyecto.
A eso se sumaban OpenCode (catálogo, plugins, LSPs), `npx`, un `npm install` que perdía el proxy y la CA
por el filtrado de entorno, y unos DNS públicos fijados en el compose.

La versión **slim** (`slim/`) resuelve esto con cuatro decisiones:

1. **Hermeticidad.** Toda adquisición ocurre en el *build*, desde fuentes configurables (los remotos de
   Artifactory). Lo que solo existe en GitHub o eclipse.org se toma de `slim/vendor/` o de un mirror, y
   siempre se verifica por SHA-256. En ejecución no se instala nada.
2. **Recortar la periferia, nunca el núcleo.** Se conserva todo lo que alimenta una decisión: el pipeline
   completo, el stitcher FE↔BE/BE↔BE, el grafo de código, `context.json`, la cobertura de cambio, el
   *grounding*, el revisor independiente, Serena, engram y el aprendizaje. Se retira lo que actúa
   después de decidir: publicación remota, auto-mantenimiento y login con GitHub.
3. **Publicación local.** La decisión (PR/Issue/cuarentena/no-op) se calcula igual, pero su efecto es una
   exportación a disco (parche + cuerpo del MR/Issue) que una persona sube a GitLab. Nada escribe
   automáticamente en los repos de la organización.
4. **Una imagen, dos servicios.** Una sola cadena de construcción: CA, mirrors y versiones fijadas.

Además, como requisito general (no solo de slim), QAyaba soporta ahora un **login en una web central
con redirección** declarado por configuración, y lo usan por igual los tests, la captura de DOM y el agente.

---

## 1. Contexto y requisitos

| Aspecto | Situación |
|---|---|
| Máquina | MacBook M4, 16 GB, sin sudo; apps de una tienda interna. Equipo gestionado: la lista de aplicaciones permitidas bloquea los binarios sin firmar, así que nada se ejecuta en el equipo salvo Docker |
| Contenedores | Docker Desktop, probablemente con controles de Docker Business: solo imágenes del Artifactory interno, sin montar `docker.sock` y ajustes bloqueados, de modo que la máquina virtual conserva su memoria por defecto (la mitad de la RAM: 8 GB) |
| Paquetes | Artifactory (npm confirmado; el resto de remotos se configuran por URL) |
| LLM | Una única pasarela corporativa compatible con OpenAI, declarada en el override local. La clave caduca a diario y se pega en tiempo de ejecución (§7) |
| SCM | GitLab |
| Entrada del código | ZIP descargado de GitHub (sin `.git`; la imagen ya se construía sin `.git`) |
| DEV | Login en una web central (otro origen). Pide certificado de cliente (mTLS, con Touch ID); si se cancela, ofrece usuario y contraseña. La redirección de ida y vuelta debe funcionar |
| Consolas | TUI imprescindible, consola web preferible |

**Principio rector — hermeticidad.** Un artefacto es hermético cuando todo lo que necesita se obtiene en
*build-time*, desde fuentes fijadas y verificables. Es la condición para funcionar en una red restringida
y también la forma concreta de la prioridad del proyecto (*stable, reliable, deterministic*): una descarga
en ejecución es una entrada no fijada.

**Egress permitido en ejecución (lista cerrada):** proveedor LLM (solo `agents`), GitLab (solo el
orquestador, lectura), DEV (ambos: el orquestador ejecuta los specs y el agente explora con el MCP de
Playwright) y el mirror npm (el `npm ci` del proyecto `e2e/` del repo vigilado).

---

## 2. Diagnóstico: por qué fallaba

### 2.1 Descargas en tiempo de ejecución

| # | Dónde | Mecanismo | Solución slim |
|---|---|---|---|
| R1 | `agents` | Serena instala su LS de TypeScript con `npm install` en `~/.serena/language_servers/static/TypeScriptLanguageServer` y, para Java, descarga el VSIX de `vscode-java` y Gradle desde GitHub y `services.gradle.org` | Calentamiento en el build (TS) y modo *upstream JDTLS* (Java): §5.3 |
| R2 | ambos | `dns: [1.1.1.1, 8.8.8.8]` fijado: sin DNS interno | El compose slim no fija DNS |
| R3 | `orchestrator` | `npm install` del seed con un entorno filtrado que descartaba `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS` y `NPM_CONFIG_REGISTRY`, ejecutado como otro usuario | npmrc **global** (registro + CA) y paso de las variables de red por `scrubEnv` (§6) |
| R4 | `agents` | `npx @playwright/mcp` y un Chromium de otra revisión | Binario global `playwright-mcp` con `--executable-path` al Chromium de la imagen |
| R5 | `agents` | OpenCode: catálogo `models.dev`, auto-actualización, plugins por defecto, LSPs | `OPENCODE_DISABLE_*` en la imagen (§7) |

### 2.2 Descargas en el build (antes)

NodeSource, JDK, Maven, Gradle, Rust, Go, `difft`, `ast-grep`, `codebase-memory-mcp`, `lizard`, `uv`, Python
gestionado desde GitHub, Serena desde `git+https://github.com`, Chromium desde la CDN de Playwright y engram
(solo `amd64`). Slim reduce esto a lo indispensable (§5.2).

### 2.3 Regresiones previas encontradas y corregidas

El commit de limpieza de comentarios (`0cd32f5`) había roto dos cosas del camino real. Esta rama las
corrigió primero (commit `884d6d9`), y `main` las resolvió después a su manera; la integración conserva la
solución de `main` y la rama ya no tiene cambios propios en esos puntos:

- Eliminó la línea marcador de `FAILURE_CAPTURE_BLOCK`: `ensureFailureCapture` volvía a añadir el bloque en
  cada ejecución a los `fixtures.ts` sin marcador, y las declaraciones `let` duplicadas hacían fallar el
  *static gate* (run `invalid`). `main` lo resuelve en `setup.adapter.ts` con marcadores de apertura y cierre
  del bloque, un conjunto de hashes de las revisiones anteriores (`EARLIER_FAILURE_CAPTURE_BLOCKS`: un bloque
  que coincide byte a byte se actualiza en su sitio y uno editado se respeta) y el reconocimiento de la
  revisión sin marcador (`UNMARKED_FAILURE_CAPTURE_BLOCK`), que se sustituye por el bloque actual en lugar de
  añadir otra copia al lado.
- Cambió la regex de `merge-guard` de `/^\.\//` a `/^\.\/*/`, que quitaba el punto de `.github/` y dejaba esas
  rutas fuera de la protección. `main` la sustituye por `normalizeRepoPath` (`src/server/merge-guard.ts`), que
  unifica separadores, colapsa barras repetidas y quita solo grupos completos `./`, conservando el punto de
  `.github/` y `.dockerignore`.

---

## 3. Criterio de recorte: núcleo vs. periferia

**Definición operativa.** Un componente es **núcleo** si su salida influye en las entradas del agente, en
algún paso anterior a *Decide* o en la propia decisión. Es **periferia** si solo consume la decisión o
actúa fuera del run.

### 3.1 Núcleo conservado

| Mecanismo | Estado en slim |
|---|---|
| Pipeline de `RunQaUseCase`: gate, clasificación, setup, generación, *static gate*, *health*, ejecución, cobertura de cambio, decisión | Intacto |
| Stitcher FE↔BE / BE↔BE (`service-topology/`, tree-sitter WASM) | Intacto |
| Grafo de código (`codebase-memory-mcp`): nivel `IMPACTED_SYMBOL` del stitcher, señal estructural, blast radius. Sin él, el stitcher caería a `CONTRACT_FILE` sin avisar | Incluido (verificado) |
| Onboarding por *job*: clona los mirrors de **todos** los servicios, indexa y propone `boundaries:`. Es el único camino que clona los servicios | Incluido (`qayaba.sh onboard`) |
| Mapa FE↔BE (modo `context`) → *context pack* | Incluido; `main` lo guarda en SQLite (`context_maps`) y, con `qa.shadow: false`, además se exporta como `context.json` para un MR (§8) |
| *Grounding*: captura de DOM, catálogo de selectores, *pre-exec grounding* | Intacto, y ahora con login (§9) |
| Oráculo de valor e2e (inyección de fallos) | Intacto; ahora no corrompe el tráfico del login |
| Agentes: generator, reviewer, explorer, reflector, worker, proposer, sidekick, assistant | Intactos |
| MCP Serena (explorer, generator, worker, sidekick y **proposer** del stitcher) | Incluido, con LS aprovisionados en build |
| MCP engram, MCP Playwright | Incluidos |
| Aprendizaje (fold + `qa-reflector`), historial SQLite | Intactos |

### 3.2 Periferia retirada (perfil `QAYABA_PROFILE=slim`)

| Componente | Cómo |
|---|---|
| Publicación en GitHub (PR, auto-merge, Issues) | Sustituida por exportación local (misma decisión) |
| Auto-mantenimiento (`qa-maintainer`, *hot-swap*) | No se dispara; los incidentes se siguen registrando |
| Login OAuth de GitHub | No se ofrece; consola con token local |
| Codex, toolchains del modo `code`, `difft`/`ast-grep`/`lizard` | No se instalan (los tres últimos no se invocan en el código) |

### 3.3 Riesgos de calidad que dependen del entorno, no del recorte

| Riesgo | Efecto | Mitigación |
|---|---|---|
| DEV sin *source maps* | Cobertura de cambio `unknown` (nunca bloquea, pero se pierde la señal objetiva) | Publicar *source maps* (aunque sean *hidden*) en DEV |
| Mismo modelo para generador y revisor | Se pierde la independencia | Modelos distintos en el override (§7) |
| Sin `settings.xml` de Maven | JDTLS no resuelve dependencias externas (navega igual por el código del repo) | `slim/maven/settings.xml` |

---

## 4. Arquitectura

```
                    ┌──────────────────────────── Mac (Docker) ─────────────────────────────┐
  navegador/TUI ───►│ orchestrator (imagen qayaba-slim)        127.0.0.1:8080 (solo loopback)│
                    │  API · consola web /app · cola secuencial · RunQaUseCase               │
                    │  git (lectura) · npm ci e2e · Playwright + Chromium · codebase-memory  │
                    │  SQLite · exportación local → slim/exports/                            │
                    │        │ HTTP :4096 / :4097                                             │
                    │        ▼                                                               │
                    │ agents (MISMA imagen)                                                  │
                    │  supervisor → opencode serve · MCP: Serena(+LS TS/Java) · engram ·     │
                    │  playwright-mcp (Chromium de la imagen)                                │
                    │ tui (misma imagen, bajo demanda) → orchestrator:8080                   │
                    └──────┬───────────────┬────────────────┬──────────────┬─────────────────┘
                        GitLab           DEV / SSO        LLM          mirror npm
```

**Una imagen, dos roles.** Una sola cadena de CA, mirrors y versiones. La frontera de seguridad no depende
de la imagen, sino del entorno inyectado por servicio: `agents` **no recibe** el token de GitLab ni el
de la API (el agente sigue siendo de solo lectura sobre los repos vigilados).

**Recursos para la máquina virtual por defecto (8 GiB).** Los límites por defecto son 2560m para el
orquestador, 4g para `agents` y 128m para la consola de terminal: 6,6 GiB en total, con el heap de JDTLS en
1 GiB (`JDTLS_XMX`). Quedan ≈ 1,4 GiB para el núcleo, el motor de Docker y la caché de páginas. Chromium no
necesita `shm_size`: Playwright 1.60.0 lo lanza con `--disable-dev-shm-usage`. Un test del compose comprueba que
cada servicio declara límite y que la suma cabe; todo es ajustable en `slim/.env` (ver «Presupuesto de memoria»
en [`slim/README.md`](../../slim/README.md)).

**Puerto.** Slim publica `127.0.0.1:8080` (`PORT=8080` en el orquestador). El valor por defecto de `main` es el
458 (`src/server/port.ts`), un puerto privilegiado: la imagen corre como root y puede enlazarlo, pero Docker en
modo *rootless* no puede publicarlo. Un cliente que use el puerto por defecto debe indicar `QA_HOST=…:8080`
(la consola de terminal del compose ya lo hace).

---

## 5. Build hermético

### 5.1 Fuentes (todas configurables en `slim/.env`)

| Fuente | Variable | Qué sirve |
|---|---|---|
| Registro Docker | `PW_IMAGE`, `NODE_IMAGE`, `GO_IMAGE` | Imágenes base |
| npm | `NPM_REGISTRY` | Dependencias, OpenCode, Playwright MCP, LS de TypeScript (y el `npm ci` en ejecución) |
| PyPI | `PIP_INDEX_URL` | Serena (`serena-agent==1.5.3`) |
| Go | `GOPROXY`, `GOSUMDB` | Módulos de la TUI |
| apt Ubuntu | `APT_MIRROR` (amd64), `APT_PORTS_MIRROR` (arm64) | `python3`, `python3-venv`, `openjdk-21-jdk-headless` |
| Maven | `MAVEN_REPO` | Lombok |
| Genéricos | `GITHUB_RELEASES_BASE`, `JDTLS_BASE_URL` | `codebase-memory-mcp`, engram, JDTLS (o `slim/vendor/`) |

### 5.2 Inventario (BOM)

| Artefacto | Versión | Fuente | Verificación |
|---|---|---|---|
| Playwright (base: Node 24, git, Chromium + libs) | `v1.60.0-noble` | Registro | Versión fijada |
| Node (etapa de compilación) | `24-bookworm` | Registro | — |
| Dependencias del orquestador | `package-lock.json` | npm | Lockfile; `better-sqlite3` **compilado** (sin binario de GitHub ni cabeceras de nodejs.org) |
| `opencode-ai` / `@playwright/mcp` | 1.17.7 / 0.0.76 | npm | Versiones exactas |
| Serena | 1.5.3 | PyPI | Versión exacta |
| LS TypeScript de Serena | typescript 5.9.3 + typescript-language-server 5.1.3 (fijados por Serena) | npm (calentamiento en build) | Comprobado en build |
| JDTLS | 1.58.0-202604151538 | eclipse.org o `vendor/` | SHA-256 |
| Lombok | 1.18.38 | Maven o `vendor/` | SHA-256 |
| JDK | 21 (Ubuntu) | apt | — |
| `codebase-memory-mcp` | 0.8.1 (`linux-amd64`/`linux-arm64`) | GitHub o `vendor/` | SHA-256 |
| engram | 1.16.1 (`linux_amd64`/`linux_arm64`) | GitHub o `vendor/` | SHA-256 |
| TUI | módulo `client/` | Go | `go.sum` |

Las sumas SHA-256 de `slim/vendor/SHA256SUMS` se calcularon descargando cada fichero de su origen oficial.
El detalle completo para la revisión de seguridad (usuarios, puertos, volúmenes, salida de red, secretos) está en
[`slim/INVENTORIO.md`](../../slim/INVENTORIO.md), y `./slim/qayaba.sh sbom` genera la lista real de paquetes de la
imagen construida.

### 5.3 Serena sin descargas en ejecución

- **TypeScript.** Serena no usa el LS global: instala el suyo con `npm install` la primera vez. El build
  ejecuta `serena project index` sobre un proyecto mínimo, con el npmrc apuntando al mirror; el LS queda
  congelado en la imagen. Si aun así hiciera falta otro LS basado en npm, el mirror está configurado y
  también funcionaría en ejecución.
- **Java.** Se usa el modo *upstream JDTLS* que Serena documenta para redes restringidas: `jdtls_path`
  (JDTLS instalado) + `lombok_path` + `java_home` (JDK 21). Así no descarga el VSIX ni Gradle. El build lo
  prueba indexando un proyecto Java mínimo.
- La configuración global de Serena (`~/.serena/serena_config.yml`) se genera en el build: modo upstream,
  `jdtls_xmx`, sin dashboard.

### 5.4 Arquitectura de CPU

Todo el inventario existe para `arm64` y `amd64`; el build elige el binario con `TARGETARCH`. En un M4 se
construye y ejecuta `linux/arm64` de forma nativa. Se verificó que engram publica `linux_arm64` (la imagen
anterior lo fijaba a `amd64`).

### 5.5 Comprobaciones que hacen fallar el build

| Comprobación | Qué evita |
|---|---|
| SHA-256 de cada artefacto fuera de los gestores de paquetes (`fetch-artifact`) | Un fichero distinto al fijado |
| `java-trust-ca`: cada certificado de `slim/certs/*.crt` debe quedar en el almacén de Java | Java (Serena/JDTLS, Maven) sin confiar en la CA corporativa |
| Node de la imagen final ≥ 24 y apertura de una base con `better-sqlite3` | Una discordancia entre el Node de la base de Playwright y el del módulo nativo compilado en la etapa `deps` |
| `slim/opencode-config.mjs`: `model`, `small_model` y el `model` de cada agente deben resolver a un proveedor habilitado y a un modelo declarado | Un rol que llame en silencio a un proveedor inalcanzable |
| LS de TypeScript aprovisionado, JDTLS probado sobre un proyecto mínimo | Descargas de servidores de lenguaje en ejecución |

---

## 6. Red dentro de los contenedores

- **DNS.** Sin `dns:` fijado: los contenedores usan el DNS del host/VPN.
- **CA corporativa.** `./slim/qayaba.sh export-ca` exporta el llavero del sistema de macOS (sin sudo) a
  `slim/certs/corporate-ca.crt`. El build la instala para apt, curl, npm/Node (`cafile` +
  `NODE_EXTRA_CA_CERTS`), pip (`PIP_CERT`), Python (`SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`), Go, git
  (`http.sslCAInfo` del sistema apunta al almacén del sistema) y Java. El JDK se instala **después** de
  `update-ca-certificates`, por lo que su almacén propio (`/etc/ssl/certs/java/cacerts`) podía no recibir los
  certificados; `slim/java-trust-ca.sh` los importa uno a uno con `keytool` y hace fallar el build si alguno no
  queda confiado.
- **Proxy.** Docker Desktop lo inyecta desde `~/.docker/config.json` (nivel usuario, sin sudo). El compose
  añade a `NO_PROXY` los nombres de servicio y `EXTRA_NO_PROXY` para los dominios internos, en **los tres**
  servicios: la consola de terminal (cliente Go) habla con `orchestrator:8080` y, sin esa entrada, un proxy
  interceptaría el nombre del servicio.
- **Diagnóstico.** `./slim/qayaba.sh preflight` sondea además, desde un contenedor con las CA del build y la misma
  lista `NO_PROXY`, que la pasarela de LLM del override responde (cualquier estado HTTP cuenta; no se envían
  credenciales) e imprime el remedio según el fallo (DNS, proxy o TLS); sin pasarela declarada, falla. `./slim/qayaba.sh check` verifica que el
  puerto de la consola está publicado solo en loopback y que el orquestador responde por su dirección de la red
  de compose, como lo alcanza la consola de terminal.
- **npm con entorno filtrado.** El `npm ci` del e2e corre con el entorno filtrado, y el npmrc **global**
  (registro + `cafile`) se lee igualmente. El cambio de usuario a `sandbox` solo se aplica en `target: code`: en
  el modo e2e estos procesos se ejecutan como el usuario del contenedor (root); ver
  [`slim/INVENTORIO.md`](../../slim/INVENTORIO.md), §3 y §8. Además, `scrubEnv` deja pasar ya
  `HTTP(S)_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS` y `SSL_CERT_*`, **salvo** un proxy con credenciales
  en la URL (sería un secreto al alcance de código no confiable).

---

## 7. OpenCode y el proveedor LLM

- **Flags** (en la imagen): `OPENCODE_DISABLE_MODELS_FETCH`, `OPENCODE_DISABLE_AUTOUPDATE`,
  `OPENCODE_DISABLE_LSP_DOWNLOAD`, `OPENCODE_DISABLE_DEFAULT_PLUGINS`.
- **Configuración efectiva** (`slim/opencode-config.mjs`, generada en el build a partir de
  `agents/opencode.json`):
  - `playwright-mcp` global con `--executable-path` al Chromium de la imagen;
  - sin auto-actualización y con la compartición de sesiones desactivada (`share: "disabled"`);
  - Serena y engram intactos;
  - fusión final con `slim/opencode.override.json`, **obligatorio**: el build falla si falta, si no declara
    ningún `provider` (la configuración base solo nombra un proveedor público) o si el `options.apiKey` de un
    proveedor no es una referencia `{env:VAR}` (una clave literal quedaría grabada en las capas de la imagen);
  - `enabled_providers` queda fijado a exactamente los proveedores del override, y el build **falla** si `model`,
    `small_model` o el `model` de algún agente no apunta a un proveedor habilitado y a un modelo declarado en su
    `models` (la salida lista cada clave afectada).
- **Una sola fuente de verdad para los modelos.** Ambos roles leen el mismo `opencode.json` efectivo:
  - el orquestador dimensiona los prompts con el `limit.context` declarado por el proveedor;
  - los modelos de generador, revisor y chat salen de sus agentes;
  - el *proposer* del stitcher usa el modelo de `qa-proposer`.

  Cambiar de proveedor es editar **un** fichero y reconstruir.
- **Proveedor propio.** Se declara en el override (hay un ejemplo compatible con OpenAI en
  `slim/opencode.override.example.json`) y referencia la clave como `{env:OPENCODE_API_KEY}`. La clave **no**
  se declara en ningún fichero ni hace falta para arrancar: como caduca a diario, se pega en tiempo de ejecución
  en la consola web (panel «agent runtime · LLM gateway») o en la TUI (tecla `a`), y el supervisor reinicia
  OpenCode con ella y comprueba contra la pasarela (`GET <baseURL>/models`) que la acepta: `healthy` si responde 2xx,
  `failed` con «key rejected by the LLM gateway» (401/403) o «LLM gateway unreachable», `degraded` si responde otra
  cosa; sin clave, el servicio de agentes queda en `needs_config`. Se pierde al reiniciar el
  servicio de agentes (flujo completo en «Clave diaria del LLM», [`slim/README.md`](../../slim/README.md)).
  Generador y revisor deben usar **modelos distintos**.

---

## 8. GitLab y publicación local

- **Clonado.** `GIT_REMOTE_BASE` + `GIT_TOKEN`. La autenticación se deriva del host configurado (usuario
  `oauth2` fuera de github.com, configurable con `GIT_TOKEN_USER`) mediante una reescritura
  `-c url.<…>.insteadOf` transitoria: el token nunca queda en `.git/config`. Admite subgrupos
  (`grupo/subgrupo/proyecto`). El token se oculta en los logs (`glpat-…`) y se bloquea para el código
  no confiable.
- **Validación de repos** (alta desde la consola): fuera de github.com se usa `git ls-remote --symref`
  con la misma credencial; no depende de ninguna API.
- **Disparo.** CLI (`qayaba.sh run`). Más adelante, un job post-deploy de GitLab CI puede enviar el payload
  genérico `{repo, sha}` firmado con HMAC; `webhook.ts` ya lo acepta.
- **Publicación local.** Con `QAYABA_PROFILE=slim`, un único `LocalExportPublicationAdapter` sirve las
  cuatro facetas: escritura git, PR, Issue y vista previa en shadow. Escribe en
  `slim/exports/<app>/<run>/`:
  - `files/`;
  - `changes.patch` (aplicable con `git apply --index`);
  - `MR.md`, con la rama sugerida, la rama destino, los pasos, la descripción y, si hubo archivos que no salieron, la sección «Left out» (ruta y motivo, nunca el contenido);
  - `ISSUE.md`;
  - `export.json` (con `skipped` y `leftOut`).

  Antes de escribir, cada archivo y el parche pasan por un filtro de secretos inyectado desde la
  composición (valor exacto de variables de entorno con nombre de credencial y tokens con forma
  reconocible); un acierto deja ese archivo fuera con el motivo «contains a secret».

  La decisión no cambia. La fuente de verdad sigue siendo git: tras fusionar el MR, la siguiente
  ejecución parte de la suite actualizada.
- **Mapa de contexto.** `main` guarda además el mapa FE↔BE validado en SQLite (tabla `context_maps`, vía
  `ContextMapCapturePort`), que es la fuente que consulta el motor y sobrevive a que se borre el mirror; el
  fichero `e2e/.qa/context.json` del repositorio queda como alternativa (p. ej. antes de la primera ejecución de
  contexto o en un clon nuevo). Las ejecuciones de contexto que lanza el onboarding siguen el `qa.shadow` de la
  app: con `shadow: false` exportan el `context.json` como un MR en `slim/exports/` para subirlo al repositorio;
  con `shadow: true` el mapa queda igualmente en SQLite sin necesidad de MR.

---

## 9. Login central con redirección

Requisito general, no solo de slim. La app declara su login en `config/apps/<app>.yaml`:

```yaml
e2e:
  auth:
    loginUrl: "https://sso.corp.example/"      # prefijo de la página de login central (otro origen)
    passwordEntry: "text=Usuario y contraseña"   # si antes ofrece login con certificado
    successSelector: "[data-testid=user-menu]"   # visible solo con sesión (recomendado)
```

El *Setup* lo materializa en el *working copy* como `e2e/.qa/auth.local.json`, ignorado por git y
excluido de la publicación. Todos los consumidores ejecutan el mismo flujo:

| Consumidor | Comportamiento |
|---|---|
| `authenticate()` del seed | Detecta la redirección por URL (sin `networkidle`, que el lint del seed rechaza). Admite formulario en dos pasos. Si la sesión central sigue válida, vuelve directamente a la app. Hace un login por *worker*, reutilizado por cookies (menos logins contra el IdP, sin bloqueos por repetición). Si no se vuelve a la app, falla con un error claro |
| Captura de DOM (*grounding*) | Inicia sesión tras registrar sus *listeners* de error, así que las rutas autenticadas se anclan en la página real. Una captura que termina en otro origen se marca como degradada aunque la ruta coincida |
| Oráculo de inyección de fallos | Nunca corrompe el tráfico del origen del login |
| Agente | La skill `playwright-authoring/auth.md` le indica llamar a `authenticate()` y seguir el mismo flujo al explorar DEV |

**mTLS.** El navegador automatizado no tiene certificado de cliente. Con un IdP que pide certificado de
forma opcional, Chromium continúa sin él y el IdP muestra usuario y contraseña; esto se verificó contra
un servidor HTTPS con `requestCert`. Si el IdP **exige** certificado sin alternativa, hace falta un
usuario técnico con contraseña en DEV.

---

## 10. Consolas: TUI y web

- **Web** (`http://localhost:8080/app`): estática, sin build; **sin login automático**. `QA_WEB_AUTO_LOGIN`
  entregaría una sesión de operador de 24 h a cualquier par de la red de compose que envíe `Host: localhost`
  (el contenedor de agentes incluido, cuyo código dirige un LLM), así que slim no lo define. La consola pide el
  token local de la API (`config/.api_token`) y lo guarda solo en `sessionStorage`; `./slim/qayaba.sh console`
  lo copia al portapapeles (`pbcopy`) sin imprimirlo (salvo `--print`), imprime la URL y la abre.
- **TUI**: la imagen compila la consola Go solo para Linux. No se entrega ningún binario para ejecutar
  en el equipo: la lista de aplicaciones permitidas de un portátil gestionado bloquea los binarios sin firmar.
  - `qayaba.sh tui` la ejecuta en un contenedor que llega al orquestador por nombre de servicio y
    descubre el token en `config/.api_token`.
  - Se corrigió un hueco general: la pantalla de conexión ignoraba `QA_HOST`.

---

## 11. Cambios de código

| Id | Cambio | Ubicación principal | Estado |
|---|---|---|---|
| C1 | Perfil de despliegue `QAYABA_PROFILE` (`full` \| `slim`; un valor desconocido detiene el arranque) | `src/server/deployment-profile.ts`, composición, `src/index.ts` | Hecho |
| C2 | Exportación local de la publicación (cuatro facetas) | `qa-engine/.../local-export-publication.adapter.ts` | Hecho |
| C3 | Git independiente del host: auth por `GIT_REMOTE_BASE`, `ls-remote` para validar, redacción/bloqueo de tokens GitLab | `src/integrations/repo-mirror.ts`, `sanitizer.ts`, `sanitize-text.ts`, `scrub-env.ts` | Hecho |
| C4 | Variables de proxy y CA hacia instalaciones no confiables (sin credenciales) | `scrub-env.ts` | Hecho |
| C5 | Auto-mantenimiento y login GitHub gobernados por el perfil | `src/index.ts` | Hecho |
| C7 | Modelos desde `agents/`: ventana de contexto declarada por el proveedor, modelo del *proposer* y *defaults* de rol | `model-window-catalog.ts`, `llm-profile-proposer.adapter.ts`, `agent-runtime/config.ts` | Hecho |
| L1 | Login central declarativo (`e2e.auth`) | `schemas.ts`, `shared-kernel/e2e-auth.ts`, `setup.adapter.ts`, `dom-snapshot.ts`, `route-catalog.ts`, `config/e2e/fixtures.ts`, skills | Hecho |
| T1 | La TUI respeta `QA_HOST` | `client/internal/ui/connect.go` | Hecho |
| F1 | Regresiones del commit de comentarios | `setup.adapter.ts`, `merge-guard.ts` | Superado por `main` (`FAILURE_CAPTURE_BLOCK` con hashes de revisiones anteriores; `normalizeRepoPath`): ver §2.3 |
| C8 | GitLab nativo (MR/Issue automáticos, webhook con `X-Gitlab-Token`) | — | Después de la POC |
| S1 | OpenCode limitado a la pasarela del operador (`enabled_providers`, `share: "disabled"`) y validación de los modelos en el build | `slim/opencode-config.mjs` | Hecho |
| S2 | Nada que ejecutar en el equipo: sin binarios de la consola para macOS ni `tui-install` | `slim/Dockerfile`, `slim/qayaba.sh` | Hecho |
| S3 | Presupuesto de memoria para la máquina virtual por defecto de 8 GiB (2560m + 4g + 128m, JDTLS a 1 GiB) | `slim/compose.yml`, `slim/Dockerfile` | Hecho |
| S4 | CA corporativa en cada cliente: almacén de Java verificado en el build, git del sistema, Serena sin informe de uso | `slim/java-trust-ca.sh`, `slim/Dockerfile` | Hecho |
| S5 | El build exige Node ≥ 24 y que `better-sqlite3` abra una base | `slim/Dockerfile` | Hecho |
| S6 | `NO_PROXY` en la consola de terminal; sin login automático de la consola web y `./slim/qayaba.sh console` | `slim/compose.yml`, `slim/qayaba.sh` | Hecho |
| S7 | Diagnóstico: alcance de la pasarela de LLM (`preflight`) y puerto/red de compose (`check`) | `slim/qayaba.sh`, `slim/probe-gateway.sh` | Hecho |
| S8 | Inventario para la revisión de seguridad y `qayaba.sh sbom` | `slim/INVENTORIO.md`, `slim/qayaba.sh` | Hecho |

Ningún cambio toca `PublishDecisionService`, `DecideCoverageService`, el stitcher, el clasificador, el
*static gate* ni los prompts de generación. Los ficheros nuevos que deciden escrituras (el exportador y el
perfil) se añadieron a `PROTECTED_PATHS`.

---

## 12. Verificación realizada

El sandbox de desarrollo sale a Internet por un **proxy que re-termina TLS con su propia CA**, un análogo
fiel de la red corporativa restringida. Su CA hizo el papel de la corporativa.

| Prueba | Resultado |
|---|---|
| `npm test` (rama integrada con `main`, 2026-10-06) | 6114 tests: 6112 correctos, 1 omitido y 1 fallo ajeno a slim (una prueba dependiente de la configuración regional en `vcs-write.adapter.test.ts`, anterior a estos cambios). Incluye los de `slim/`: configuración de OpenCode, compose (memoria, `NO_PROXY`, lista de hosts del login), Dockerfile, `java-trust-ca.sh`, `probe-gateway.sh` y `qayaba.sh` con un `docker` simulado |
| `npm run typecheck` / `npm run arch:check` | Limpios (qa-engine no importa `src/`) |
| Tests Go de la TUI (Go 1.26) | En verde |
| `docker build` de `slim/Dockerfile` detrás del proxy TLS | Correcto; cada artefacto verificado por SHA-256. Un 429 de Maven Central se resolvió con la vía `vendor/` (`lombok … verified (from slim/vendor)`) |
| Arranque del stack **sin red** en ejecución | `orchestrator` y `agents` *healthy*, `[profile: slim]` |
| MCP de OpenCode sin red | `{"serena":"connected","engram":"connected","playwright":"connected"}` |
| `qayaba.sh check` | OpenCode, Serena, engram, playwright-mcp, Chromium, LS de TS y Java, codebase-memory y `better-sqlite3` presentes |
| API / consola web / login GitHub | `/app` 200; onboarding responde; login GitHub: *not configured* |
| TUI en contenedor (pseudo-terminal) | Conecta sola con el token descubierto y muestra el panel |
| `npm` como `sandbox` con entorno vacío | Usa registro y CA del npmrc global a través del proxy |
| Seed e2e **dentro de la imagen** | `npm install` + tsc + ESLint correctos; tests de login central en verde con el Chromium de la imagen |
| Login central contra un IdP simulado (otro origen) | Redirección de ida y vuelta, botón de certificado → usuario/contraseña, login en dos pasos, sesión reutilizada (sin segundo POST), error claro con credenciales malas |
| IdP HTTPS con mTLS opcional | Chromium sin certificado → formulario → vuelta a la app |
| Captura de DOM con login | Rutas autenticadas capturadas en la app; sin login quedan degradadas |

**No verificable aquí:**

- Un run completo contra el GitLab, el LLM y el DEV reales del entorno corporativo.
- La construcción de la imagen con el endurecimiento de §14 (`java-trust-ca`, la comprobación de Node y
  `better-sqlite3`, la validación de modelos): Docker no estaba disponible donde se integró `main`. Los scripts
  se probaron con `keytool`, `curl` y `docker` simulados (y `java-trust-ca.sh` además contra el `keytool` real
  con un almacén temporal); la comprobación definitiva es `./slim/qayaba.sh build && ./slim/qayaba.sh check`.

---

## 13. Riesgos, límites y siguientes pasos

| Riesgo | Mitigación |
|---|---|
| Cumplimiento del envío de código al LLM | Usar el proveedor aprobado vía override |
| IdP que exige certificado sin alternativa | Usuario técnico con contraseña en DEV |
| Remotos de Artifactory que falten | `slim/vendor/` para lo que no sea paquete; el `preflight` dice qué hay |
| Memoria en la máquina virtual por defecto (8 GiB) | Presupuesto de 6,6 GiB comprobado por un test del compose; límites y `JDTLS_XMX` ajustables (§4). Un repositorio Java muy grande puede necesitar más heap de JDTLS |
| El código del repositorio vigilado se ejecuta como root en el contenedor del orquestador (el cambio a `sandbox` solo existe en `target: code`) | El filtrado de entorno quita los secretos de esos procesos y el contenedor es la frontera; endurecerlo (cambio de usuario también en e2e) es un cambio del motor que debe ir en su propio PR. Ver `slim/INVENTORIO.md`, §8 |
| La consola web cargaba fuentes de Google y un script de `unpkg.com` en la página donde se pega la clave del LLM | Resuelto: iconos y tipografías vendorizados en `web/public/vendor/` y política de seguridad de contenido (`script-src 'self'`, sin script en línea) más `nosniff` y `no-referrer` en cada respuesta de `/app`. Pendiente solo `style-src 'unsafe-inline'`, por los atributos `style` que pinta la consola |
| Serena aprovisiona en ejecución el servidor de lenguaje de otro lenguaje presente en un repositorio | Solo TypeScript y Java están aprovisionados en el build; revisar los lenguajes de los repositorios objetivo |
| Tamaño de imagen (~6 GB) | Asumible en POC; a medio plazo, construir en GitLab CI y publicar en un registro interno |
| `npm` avisa de que `nodedir`/`build-from-source` como variables de entorno dejarán de funcionar en su próxima versión mayor | Fijado a la versión de npm de Node 24; revisar al subir de mayor |

**Siguientes pasos:**
0. Construir la imagen con el endurecimiento de §14 (`./slim/qayaba.sh build`, `check`, `preflight`) y pasar la revisión de seguridad con `slim/INVENTORIO.md`.
1. POC en el Mac según `slim/README.md`.
2. MR/Issues nativos de GitLab (C8) y disparo desde GitLab CI.
3. Construir la imagen en GitLab CI y publicarla en un registro interno.
4. Pasar `changeCoverage` a `enforce` donde se lo gane.

---

## 14. Actualización: integración con `main` y adaptación al equipo objetivo

### 14.1 Qué aporta `main` a slim

| Cambio de `main` | Efecto en slim | Dónde |
|---|---|---|
| Arreglos propios de `FAILURE_CAPTURE_BLOCK` y de la normalización de rutas del *merge-guard* | Sustituyen a los de esta rama (F1) | §2.3 |
| Mapa FE↔BE en SQLite (`context_maps`) además de `e2e/.qa/context.json`; las ejecuciones de contexto del onboarding siguen el `qa.shadow` de la app | Con `shadow: false` se exporta un MR con el `context.json` a `slim/exports/`; con `shadow: true` el mapa queda en SQLite | §8 |
| Clave de la pasarela de LLM pegada desde la consola y enmascarada en errores del agente | La pila arranca sin clave y se la entrega en ejecución | §7 |
| `QA_WEB_LOGIN_HOST_ALLOWLIST` y `QA_WEB_AUTO_LOGIN` | Slim no los define: la consola web se abre con el token local | §10 |
| Puerto por defecto 458 | Slim sigue publicando `127.0.0.1:8080` | §4 |

### 14.2 Adaptación al equipo objetivo

Un portátil gestionado con lista de aplicaciones permitidas, Docker Desktop con controles de empresa y una
única pasarela de LLM motivó ocho cambios, cada uno con sus pruebas:

1. **Pasarela fija.** OpenCode solo puede usar los proveedores del override, sin compartir sesiones, y el build
   falla si un rol apunta a un modelo que no resuelve (§7).
2. **Nada en el equipo.** Se retiran los binarios de la consola para macOS y `tui-install`; la consola corre en
   un contenedor o en el navegador (§10).
3. **Memoria.** Presupuesto de 6,6 GiB para una máquina virtual de 8 GiB, comprobado por un test (§4).
4. **CA en cada cliente.** El almacén de Java se verifica en el build; git y Serena quedan configurados (§6).
5. **Node y módulo nativo.** El build lo comprueba (§5.5).
6. **Consola.** Sin login automático (se accede con el token local, `qayaba.sh console`) y `NO_PROXY` en la consola de terminal (§6, §10).
7. **Diagnóstico.** `preflight` sondea la pasarela y `check` el puerto y la red de compose (§6).
8. **Revisión de seguridad.** `slim/INVENTORIO.md` y `./slim/qayaba.sh sbom` (§5.2).

La construcción de la imagen con estos cambios no se ha ejecutado todavía (Docker no estaba disponible donde se
integraron): se cubre con pruebas unitarias de los scripts y de los ficheros de configuración, y queda
pendiente la verificación con `./slim/qayaba.sh build` (§12).

---

## Apéndice — Referencias al código

| Tema | Fichero |
|---|---|
| Empaquetado slim | `slim/Dockerfile`, `slim/compose.yml`, `slim/qayaba.sh`, `slim/opencode-config.mjs`, `slim/fetch-artifact.sh`, `slim/java-trust-ca.sh`, `slim/probe-gateway.sh`, `slim/vendor/SHA256SUMS` |
| Inventario de seguridad | `slim/INVENTORIO.md` |
| Pruebas del empaquetado | `slim/*.test.mjs` (configuración de OpenCode, compose, Dockerfile, CA de Java, sondeo de la pasarela, `qayaba.sh`) |
| Perfil y efectores | `src/server/deployment-profile.ts`, `src/server/rewritten-engine-factory.ts` (`buildPublicationEffectors`), `qa-engine/.../composition/composition-root.ts` (`shadowPublication`) |
| Exportación local | `qa-engine/src/contexts/workspace-and-publication/infrastructure/local-export-publication.adapter.ts` |
| Git/GitLab | `src/integrations/repo-mirror.ts` (`authHeaderArgs`, `gitRemoteBase`, `getRepoInfoViaGit`) |
| Entorno de procesos no confiables | `qa-engine/src/shared-infrastructure/process-sandbox/scrub-env.ts` |
| Modelos | `qa-engine/.../prompt-builders/model-window-catalog.ts`, `src/agent-runtime/config.ts`, `src/server/onboarding/llm-profile-proposer.adapter.ts` |
| Login central | `qa-engine/src/shared-kernel/e2e-auth.ts`, `config/e2e/fixtures.ts`, `qa-engine/.../generation/infrastructure/dom-snapshot.ts`, `route-catalog.ts`, `agents/skill/playwright-authoring/auth.md` |
| Orquestación | `qa-engine/src/contexts/qa-run-orchestration/application/run-qa.use-case.ts` |
