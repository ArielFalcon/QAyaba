# QAyaba Slim — Plan técnico de una POC E2E en entorno restringido

| | |
|---|---|
| **Estado** | Planificación. **Ningún cambio de código aplicado.** Los fragmentos de código de este documento son diseño, no implementación. |
| **Rama** | `claude/qayaba-restricted-env-poc-hytgtl` |
| **Alcance** | `target: e2e` únicamente (Playwright contra DEV). Un solo runtime de agente (OpenCode). SCM: GitLab. |
| **Fecha** | 2026-09-27 |

---

## Índice

0. [Resumen ejecutivo](#0-resumen-ejecutivo)
1. [Contexto, restricciones y supuestos](#1-contexto-restricciones-y-supuestos)
2. [Diagnóstico: por qué falla hoy](#2-diagnóstico-por-qué-falla-hoy)
3. [Criterio de recorte: núcleo vs. periferia](#3-criterio-de-recorte-núcleo-vs-periferia)
4. [Arquitectura objetivo](#4-arquitectura-objetivo)
5. [Adquisición hermética en build-time](#5-adquisición-hermética-en-build-time)
6. [Red dentro de los contenedores](#6-red-dentro-de-los-contenedores)
7. [OpenCode hermético y proveedor LLM](#7-opencode-hermético-y-proveedor-llm)
8. [GitLab](#8-gitlab)
9. [Cambios de código planificados (no implementados)](#9-cambios-de-código-planificados-no-implementados)
10. [Entregables de empaquetado](#10-entregables-de-empaquetado)
11. [Runbook de la POC](#11-runbook-de-la-poc)
12. [Fases y criterios de salida](#12-fases-y-criterios-de-salida)
13. [Riesgos y mitigaciones](#13-riesgos-y-mitigaciones)
14. [Preguntas abiertas](#14-preguntas-abiertas)
- [Apéndice A — Script de preflight](#apéndice-a--script-de-preflight)
- [Apéndice B — Referencias al código](#apéndice-b--referencias-al-código)

---

## 0. Resumen ejecutivo

QAyaba falla en el entorno del banco por un motivo **estructural**, no por un bug puntual: descarga
artefactos de Internet no solo al construir las imágenes, sino también **durante la ejecución**:
- Serena instala *language servers*.
- OpenCode pide catálogos, plugins y LSPs.
- `npx` resuelve paquetes.
- El `npm install` del seed `e2e/` pierde el proxy y la CA por el filtrado de entorno.

Además, el compose fija resolvers DNS públicos.

La versión **Slim** se apoya en tres decisiones:

1. **Hermeticidad.** Todo artefacto se obtiene en *build-time* desde fuentes internas: registro Docker,
   mirror npm, mirror PyPI si existe, y una carpeta `vendor/` con sumas SHA-256. En *runtime* el tráfico de
   salida se limita a cuatro destinos: proveedor LLM, GitLab, DEV y mirror npm.
2. **Recortar la periferia, nunca el núcleo.** Se conservan íntegros todos los mecanismos que alimentan una
   decisión: el pipeline de `RunQaUseCase`, el stitcher FE↔BE / BE↔BE, el grafo de código, el mapa
   `context.json`, la cobertura de cambio, el *grounding*, el revisor independiente y el aprendizaje entre
   ejecuciones. Se eliminan los componentes que solo actúan **después** de decidir o **fuera** del run:
   publicación en GitHub, auto-mantenimiento, login OAuth, Codex y las toolchains del modo `code`.
3. **Publicación local.** La decisión (PR / Issue / cuarentena / no-op) se calcula exactamente igual. Su
   efecto se materializa como una **exportación a disco** (parche + cuerpo del MR/Issue) que una persona
   sube a GitLab. Esto endurece además la frontera de seguridad del proyecto: nada escribe
   automáticamente en los repos del banco.

Empaquetado resultante: **una única imagen con dos roles** (orquestador y agentes), un `compose`
autocontenido y una carpeta `vendor/` verificable. Nada del camino actual (`Dockerfile`,
`agents/Dockerfile`, `docker-compose.yml`) se modifica: el perfil Slim vive en ficheros nuevos.

---

## 1. Contexto, restricciones y supuestos

### 1.1 Entorno conocido

| Aspecto | Situación |
|---|---|
| Máquina | macOS corporativo, **sin sudo**; aplicaciones vía tienda interna |
| Contenedores | Docker disponible |
| Paquetes | Mirror **privado de npm** |
| Agente | OpenCode disponible; API key configurable |
| SCM | **GitLab** (no GitHub) |
| Entrada de código | **ZIP descargado desde GitHub** (sin historial `.git`) |
| Fallos observados | (a) librerías npm que descargan binarios (resuelto compilando en local); (b) una instalación en caliente dentro de un contenedor (sin resolver) |

### 1.2 Supuestos a confirmar en la Fase 0

| Id | Supuesto | Qué cambia si es falso |
|---|---|---|
| S1 | Mac Apple Silicon → imágenes `linux/arm64` | Con Intel, `amd64`; el inventario de binarios cambia de arquitectura |
| S2 | Proxy corporativo con **inspección TLS** | Sin inspección, sobra la CA corporativa |
| S3 | El mirror npm es Artifactory/Nexus; se desconoce si proxifica Docker, apt o PyPI | Define la ruta de construcción (§5.3) |
| S4 | El navegador del Mac puede descargar ficheros de GitHub (así llega el ZIP) | Si no, `vendor/` debe venir por otra vía (§5.3, ruta C) |
| S5 | DEV es accesible desde el Mac y desde un contenedor | Sin acceso no hay E2E |
| S6 | El proyecto objetivo es Angular + Spring (TS + Java) | Define qué *language servers* de Serena se aprovisionan |

### 1.3 Principio rector: hermeticidad

Un artefacto es **hermético** cuando todo lo que necesita se adquiere en *build-time*, desde fuentes
fijadas y verificables. En *runtime* no instala nada. La hermeticidad es la condición para funcionar
en un entorno restringido y a la vez la forma concreta de la prioridad del propio proyecto:
*stable, reliable, deterministic*. Una descarga en runtime es, por definición, una entrada no
fijada: puede cambiar o desaparecer entre dos ejecuciones.

**Egress permitido en runtime (lista cerrada):**

| Destino | Quién | Para qué |
|---|---|---|
| Proveedor LLM (OpenCode Go o gateway interno) | `agents` | Sesiones de los agentes |
| GitLab (HTTPS) | `orchestrator` | `clone`/`fetch` de solo lectura |
| DEV (web + API a través del navegador) | ambos | Ejecución de specs (orquestador) y exploración con Playwright MCP (agentes) |
| Mirror npm | `orchestrator` | `npm ci` del proyecto `e2e/` del repo vigilado |

Cualquier otra conexión saliente en runtime es un **defecto** del empaquetado.

---

## 2. Diagnóstico: por qué falla hoy

### 2.1 Adquisición en *runtime* (la causa del fallo observado)

| # | Contenedor | Mecanismo | Evidencia en el repo | Efecto en el banco |
|---|---|---|---|---|
| R1 | `agents` | **Serena** instala su propio *language server* de TypeScript (`npm install` en su directorio de recursos) y, para Java, descarga JDTLS (VSIX de `github.com`) y Gradle (`services.gradle.org`) la primera vez que abre un proyecto | `agents/opencode.json` → MCP `serena`. El comentario de `agents/Dockerfile` da por hecho que el LS global evita la descarga, pero Serena no usa el global | **El sospechoso nº 1** de la “instalación interna” que falló |
| R2 | ambos | `dns: [1.1.1.1, 8.8.8.8]` fijado | `docker-compose.yml` (ambos servicios) | El DNS público suele estar bloqueado y **no resuelve nombres internos** (GitLab, mirror, DEV) |
| R3 | `orchestrator` | Paso *Setup*: `npm install` del seed `config/e2e/` (sin lockfile) ejecutado con entorno filtrado | `setup.adapter.ts` → `scrubEnv({ extraAllowed: /^DEV_/ })`. `scrub-env.ts` **descarta** `HTTPS_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` y `NPM_CONFIG_REGISTRY` (en mayúsculas); solo sobrevive `npm_config_*` en minúsculas. En Docker corre además como usuario `sandbox` (`HOME=/home/sandbox`), que no ve el `.npmrc` de root | Aunque se configure el mirror por entorno, ese `npm` no lo ve |
| R4 | `agents` | Playwright MCP se lanza con `npx @playwright/mcp`. El MCP 0.0.76 usa `playwright 1.61.0-alpha`, pero el Chromium de la imagen lo instaló otro `npx playwright` | `agents/opencode.json`, `agents/agent-supervisor.mjs`, `agents/Dockerfile` | `npx` puede consultar el registro; si la revisión de Chromium no cuadra, habrá un intento de descarga del navegador |
| R5 | `agents` | OpenCode: catálogo `models.dev`, auto-actualización, *plugins* por defecto y descarga de LSPs al abrir ficheros `.java`/`.ts` | Flags de OpenCode (§7.1) | Egress bloqueado, arranques lentos o fallidos |

### 2.2 Adquisición en *build-time* (bloquea `docker build` fuera de Internet abierto)

| Imagen | Descarga | Origen |
|---|---|---|
| orquestador | Node 24 vía `curl … | bash` | `deb.nodesource.com` |
| orquestador | JDK, Maven, Gradle, Rust, Python, build-essential | apt (Ubuntu) |
| orquestador | Go 1.26.4 | `dl.google.com` |
| orquestador | `difft`, `ast-grep`, `codebase-memory-mcp` | GitHub Releases |
| orquestador | `lizard` | PyPI |
| orquestador | `better-sqlite3` (binario precompilado) → si falla, `node-gyp` descarga las cabeceras de Node | GitHub Releases → `nodejs.org` |
| agentes | `uv` | `astral.sh` |
| agentes | Python 3.11 gestionado por `uv` | GitHub (python-build-standalone) |
| agentes | Serena `git+https://github.com/oraios/serena@v1.5.3` | GitHub + PyPI |
| agentes | Chromium + dependencias de sistema (`playwright install --with-deps`) | CDN de Playwright + apt |
| agentes | `engram` **solo `linux_amd64`** (fijado en la URL) | GitHub Releases |

### 2.3 Otros acoplamientos relevantes

- **Autenticación git solo para GitHub**: `GIT_REMOTE_BASE` ya es configurable, pero `authHeaderArgs()` solo
  reescribe URLs de `https://github.com/` con `GITHUB_TOKEN` (`src/integrations/repo-mirror.ts`).
- **Publicación solo en GitHub**: los adaptadores de PR/Issue hablan con `api.github.com`
  (`qa-engine/.../workspace-and-publication/infrastructure/github-*.ts`).
- **Auto-mantenimiento** (`maintainer-runtime.ts`): abre PRs sobre el propio QAyaba en GitHub y hace *hot-swap*.
- **Login de la consola** vía OAuth de GitHub (`github-auth.ts`).

---

## 3. Criterio de recorte: núcleo vs. periferia

**Definición operativa.** Un componente es **núcleo** si su salida influye en algo de esta lista:
(a) las entradas del agente (contexto, herramientas, *grounding*); (b) cualquier paso del pipeline
anterior a *Decide*; (c) la propia decisión. Es **periferia** si solo consume la decisión ya tomada o
actúa fuera del run. El núcleo se conserva **sin modificar su lógica**. La periferia se elimina o se
desactiva.

### 3.1 Núcleo conservado

| Mecanismo | Dónde vive | Dependencia externa | En Slim |
|---|---|---|---|
| Pipeline completo de `RunQaUseCase`: gate, clasificación, setup, generación, *static gate* (tsc + ESLint + `playwright --list`), *health pre-flight*, ejecución, cobertura de cambio, decisión | `qa-engine/src/contexts/qa-run-orchestration/application/run-qa.use-case.ts` | Node, git, Playwright | ✅ Intacto |
| **Stitcher FE↔BE / BE↔BE** (`boundaries:` con transportes `http`, `event` y `http-backend`; resolvers OpenAPI; tree-sitter WASM) | `qa-engine/src/contexts/service-topology/` | `web-tree-sitter`, `tree-sitter-wasms` (npm) | ✅ Intacto |
| **Grafo de código** (codebase-memory): nivel `IMPACTED_SYMBOL` del impacto entre repos, señal estructural y blast radius | `shared-infrastructure/code-graph/`, `resolve-cross-repo-impact.use-case.ts`, `structural-signal-port.adapter.ts` | Binario `codebase-memory-mcp` v0.8.1 | ✅ Se conserva (vendorizado). **Sin él, el stitcher cae al nivel `CONTRACT_FILE` sin avisar** |
| **Mapa de arquitectura** `e2e/.qa/context.json` (modo `context`) → *context pack* | `pre-generation-grounding-port.adapter.ts`, `context-pack.ts` | — | ✅ Se conserva. Requiere persistencia (ver §8.3) |
| **Onboarding del stitcher** (*job*: clona los mirrors de servicios, indexa, `qa-proposer` propone `boundaries:`) | `src/server/onboarding/onboarding-job.ts` | git, codebase-memory, LLM | ✅ Se conserva. **Es el único camino que clona los mirrors de servicios.** Sin ellos el stitcher se degrada sin error |
| *Grounding*: captura de DOM / catálogo de selectores / *pre-exec grounding* | `dom-snapshot.ts`, `pre-exec-grounding.service.ts` | Playwright del `e2e/node_modules` + Chromium de la imagen | ✅ Intacto |
| Cobertura de cambio (V8 del navegador + *source maps*) | `objective-signal/` | Ninguna herramienta externa; necesita *source maps* en DEV | ✅ Intacto (`signal` por defecto) |
| Oráculo de valor e2e (inyección de fallos en respuestas) | `fault-injection-oracle.adapter.ts` | — | ✅ Intacto (desactivado por defecto en shadow; configurable) |
| Decisión de publicación | `PublishDecisionService` | — | ✅ **Intacta**; solo cambia el *efector* (§8.3) |
| Agentes: `qa-generator`, `qa-reviewer`, `qa-explorer`, `qa-reflector`, `qa-worker`, `qa-proposer`, `qa-sidekick`, `qa-assistant` | `agents/opencode.json`, `agents/agent/*.md` | Proveedor LLM | ✅ Intactos |
| MCP **Serena** (navegación semántica; lo usan explorer, generator, worker, sidekick y **proposer**) | `agents/opencode.json` | Python ≥ 3.11, `uv`, *language servers* | ✅ Se conserva, **aprovisionado en build** (§5.4) |
| MCP **engram** (memoria episódica entre ejecuciones) | `agents/opencode.json` | Binario Go | ✅ Se conserva (vendorizado, arquitectura correcta) |
| MCP **Playwright** (exploración en vivo de DEV) | `agents/opencode.json` | `@playwright/mcp` + Chromium | ✅ Se conserva (binario global, Chromium de la imagen) |
| Aprendizaje: *learning fold*, `qa-reflector`, historial SQLite | `cross-run-learning/`, `src/server/history.ts` | `better-sqlite3` (nativo) | ✅ Intacto (compilado en build) |
| Saneado de datos salientes, *sandbox* de privilegios | `sanitizer.ts`, `sanitize-text.ts`, `process-sandbox/` | — | ✅ Intacto |
| Consola web `/app` + API con token | `web/public` (estático, sin build), `src/server/api.ts` | — | ✅ Se conserva (login por token, sin OAuth) |

### 3.2 Periferia eliminada o desactivada

| Componente | Por qué es periferia | Cómo se retira |
|---|---|---|
| Publicación en GitHub (PR, *auto-merge*, Issues) | Consume la decisión; no la produce | Se sustituye el efector por la **exportación local** (C2). El `qa.shadow` actual solo registra en log y perdería los artefactos |
| Auto-mantenimiento (`qa-maintainer`, `merge-guard`, *hot-swap*, `self-update`, *rollback*) | Repara QAyaba, no testea la app | Interruptor de perfil (C1/C5). `boot-guard.mjs` se queda: es inocuo sin marcador |
| Login OAuth de GitHub | Autenticación de operadores | `GITHUB_OAUTH_CLIENT_ID` vacío. Consola con `QA_API_TOKEN` / `QA_WEB_AUTO_LOGIN` |
| Runtime **Codex** | Runtime alternativo; OpenCode cubre todos los roles | `AGENT_RUNTIME_MODE=single`, `AGENT_SINGLE_PROVIDER=opencode`; `@openai/codex` no se instala |
| Toolchains del modo `code`: Go, Rust/Cargo, Maven, Gradle, pip, JDK en el orquestador; oráculo Stryker | Solo se usan con `target: code` | No se instalan. Stryker queda como dependencia npm inerte |
| `difft`, `ast-grep`, `lizard` | **No se invocan en ningún punto del código** (verificado: solo aparecen como tipo literal en `static-signal.ts`) | No se instalan. Pérdida de calidad: nula |
| `docker-compose.override.yml` (montajes de desarrollo) | Desarrollo local | El compose Slim es autocontenido |
| Listado de repos de GitHub en la consola | Asistente de alta | La app se da de alta por YAML + API de onboarding |

### 3.3 Garantía de no regresión y riesgos de calidad residuales

Ningún elemento de §3.2 escribe en el estado que lee el pipeline antes de *Decide*. Por construcción,
las decisiones de Slim son las mismas que en el perfil completo con las mismas entradas. Quedan riesgos
de calidad que **no vienen del recorte, sino del entorno**, y que conviene gestionar explícitamente:

| Riesgo | Mecanismo afectado | Mitigación |
|---|---|---|
| DEV sin *source maps* | La cobertura de cambio pasa a `unknown`: nunca bloquea, pero se pierde la señal objetiva (la *keystone*) | Publicar *source maps* (aunque sean *hidden*) en DEV |
| Modelos desconocidos para `model-window-catalog.ts` | Presupuesto de prompt por defecto de **32k tokens** → recorte del contexto | C7 (§9) |
| Mismo modelo para generador y revisor | Se pierde la independencia del juicio | Dos familias de modelo distintas (§7.3) |
| Mirrors de servicios ausentes | El stitcher se degrada sin error | Onboarding por *job* (§11, paso 7) |
| `context.json` no persistido | El *context pack* se reduce a blast radius + DOM | MR manual del export del modo `context` (§8.3) |
| Serena sin LS de Java | Navegación peor en el backend | Aprovisionar JDTLS en build (§5.4) |

---

## 4. Arquitectura objetivo

### 4.1 Diagrama

```
                    ┌────────────────────── Mac (Docker) ───────────────────────┐
                    │                                                           │
  operador ──HTTP──►│  orchestrator (imagen qayaba-slim, rol "orchestrator")    │
  127.0.0.1:8080    │   · webhook/API/consola · cola secuencial · RunQaUseCase  │
                    │   · git (solo lectura) · npm ci e2e · Playwright + Chromium│
                    │   · codebase-memory · SQLite · export local                │
                    │        │ HTTP :4096/:4097                                  │
                    │        ▼                                                   │
                    │  agents (MISMA imagen, rol "agents")                       │
                    │   · supervisor → opencode serve                            │
                    │   · MCP: Serena(+LS) · engram · playwright-mcp(+Chromium)  │
                    │                                                           │
                    │  volúmenes: mirrors (compartido) · data · codebase-memory │
                    │             serena · engram · opencode                     │
                    └───────┬──────────────┬───────────────┬──────────┬─────────┘
                            │              │               │          │
                         GitLab          DEV          Proveedor LLM  Mirror npm
                      (clone/fetch)  (navegador)      (solo agents) (solo npm ci)
```

### 4.2 Una imagen, dos roles

Hoy hay dos imágenes con bases distintas (`playwright:noble` y `node:24-bookworm`) y dos cadenas de
adquisición. Slim construye **una sola imagen** y la ejecuta como dos servicios con distinto
`command`. Justificación:

- **Menor superficie de adquisición.** Una sola cadena de base, CA, npm y *vendor*. Las dos imágenes
  necesitaban de todas formas Node, Chromium y git.
- **La frontera de seguridad no depende de la imagen, sino del entorno.** Los secretos se inyectan en
  runtime por servicio: `agents` **no recibe** el token de GitLab ni `QA_API_TOKEN`. Esa es la
  separación que exige el invariante “el agente es de solo lectura”, y se mantiene.
- **Coste**: la imagen es algo mayor (~3–4 GB). Asumible para una POC.

---

## 5. Adquisición hermética en build-time

### 5.1 Fuentes permitidas (orden de preferencia)

1. **Registro Docker** interno o proxy (Artifactory/Nexus/Harbor/GitLab Registry) para las imágenes base.
2. **Mirror npm** para todo paquete npm (incluye los binarios de plataforma de `esbuild` y `opencode-ai`,
   que llegan como `optionalDependencies` desde el propio registro).
3. **Mirror PyPI**, si existe, para las dependencias de Serena.
4. **`vendor/`**: artefactos de GitHub Releases descargados **a mano con el navegador**, verificados por
   `SHA256SUMS` y copiados a la imagen con `COPY`. Nunca `curl` en el Dockerfile.

### 5.2 Inventario de artefactos (BOM)

| # | Artefacto | Versión (fijada) | Uso | Fuente actual | Fuente Slim |
|---|---|---|---|---|---|
| A1 | `mcr.microsoft.com/playwright` | `v1.60.0-noble` | Base: Chromium + librerías de sistema | MCR | Registro Docker |
| A2 | `node` | `24-bookworm` | Donante de Node 24 (+ npm + cabeceras) y etapa de compilación | Docker Hub | Registro Docker |
| A3 | Dependencias npm de la raíz (`package-lock.json`) | lock | Orquestador (`tsx`, `better-sqlite3`, `undici`, `zod`, `yaml`, tree-sitter…) | npmjs | Mirror npm |
| A4 | `better-sqlite3` | 12.10.1 | Historial SQLite (nativo) | Prebuilt de GitHub | **Compilado** en la etapa A2 (`build_from_source` + `nodedir`) |
| A5 | Seed `config/e2e` (`@playwright/test` 1.60.0, eslint, typescript…) | seed | `npm ci` por run en el `e2e/` del repo | npmjs | Mirror npm (en runtime, egress permitido) |
| A6 | `opencode-ai` | 1.17.7 | Runtime de agentes | npmjs | Mirror npm |
| A7 | `@playwright/mcp` | 0.0.76 | MCP de navegador (bin `playwright-mcp`) | npmjs | Mirror npm |
| A8 | Chromium | el de A1 | Navegador del MCP y de la ejecución | CDN de Playwright | **Reutilizado de A1** (`--executable-path`) |
| A9 | `codebase-memory-mcp` | v0.8.1 `linux-<arch>` | Grafo de código | GitHub Releases | `vendor/` |
| A10 | `engram` | 1.16.1 `linux_<arch>` | Memoria del agente | GitHub Releases (solo amd64) | `vendor/` (arquitectura correcta) |
| A11 | `uv` | fijar versión | Instalación de Serena | `astral.sh` | `vendor/` (binario de GitHub Releases) o PyPI |
| A12 | Python ≥ 3.11 | fijar | Runtime de Serena | GitHub vía uv | `vendor/` (python-build-standalone) **o** paquete del sistema (§5.3) |
| A13 | Serena | v1.5.3 | MCP de navegación | `git+https://github.com/...` | `vendor/` (ZIP del *tag*) + dependencias de PyPI |
| A14 | LS TypeScript para Serena | el que fije Serena v1.5.3 | Navegación TS/Angular | npm en runtime | **Build** (calentamiento con mirror npm) |
| A15 | JDTLS (VSIX `vscode-java`) + Gradle para Serena | los que fije Serena v1.5.3 | Navegación Java/Spring | GitHub + `services.gradle.org` en runtime | `vendor/` + colocación en build (§5.4) |
| A16 | CA corporativa | — | Confianza TLS | — | Exportada del llavero de macOS (§6.2) |

### 5.3 Rutas de construcción (se elige en la Fase 0)

```
¿Hay mirror PyPI?
 ├─ Sí ─► ¿Hay mirror apt (Ubuntu/Debian)?
 │         ├─ Sí ─► RUTA A: python3 del sistema vía apt; Serena desde su ZIP + PyPI.
 │         └─ No ─► RUTA B: Python gestionado por uv desde vendor/; Serena desde su ZIP + PyPI.
 └─ No ─► ¿Se pueden vendorizar wheels (descargados fuera) con aprobación?
           ├─ Sí ─► RUTA B': como B, con wheels locales (`--find-links vendor/wheels`, `--no-index`).
           └─ No ─► BLOQUEO de Serena: escalar. Quitar Serena degrada la calidad (explorer,
                    generator, proposer), así que NO es una opción silenciosa del plan.

Alternativa transversal — RUTA C: construir la imagen en GitLab CI del banco (los runners suelen
tener acceso a los mirrors, a veces también a un "generic remote" de GitHub Releases) y publicarla en
un registro interno. El Mac solo hace `docker pull`. Es la vía institucional y la preferible a medio plazo.
```

### 5.4 Serena: aprovisionamiento de *language servers* en build

Serena **no usa** los *language servers* globales: gestiona los suyos en un directorio de recursos
propio y los instala la primera vez que un proyecto los necesita. Para el LS de TypeScript ejecuta
`npm install` de `typescript` y `typescript-language-server`. Para Java descarga el VSIX de
`vscode-java` (con JRE, JDTLS y Lombok) y una distribución de Gradle, **solo desde una lista blanca de
hosts** (`github.com`, `*.githubusercontent.com`, `services.gradle.org`). Por eso no basta con apuntar a
un mirror: hay que **precolocarlos**.

Plan:
1. **TypeScript (con mirror npm).** Paso de *calentamiento* en build: crear un proyecto mínimo con un
   `.ts` y arrancar Serena contra él una vez, con el npmrc global apuntando al mirror. Serena instala el
   LS en su directorio de recursos y la imagen lo congela.
2. **Java (sin salida a GitHub).** Descargar con el navegador el VSIX de la plataforma
   (`linux-arm64` o `linux-x64`) y el ZIP de Gradle en las versiones exactas que fija Serena v1.5.3
   (`src/solidlsp/language_servers/eclipse_jdtls.py`). En build, extraerlos con la estructura que Serena
   espera, para que al arrancar los encuentre y no descargue nada. **La estructura exacta se verifica en
   la Fase 0 contra el código de v1.5.3**, porque cambia entre versiones (usa subdirectorios versionados).
3. **Persistencia.** El directorio de recursos de Serena vive en la imagen, **no** en un volumen: un
   volumen vacío taparía lo aprovisionado en build.
4. **Verificación.** Prueba de hermeticidad (§12, F1): comparar el árbol de ficheros del directorio de
   recursos antes y después de un run. Debe ser idéntico.

### 5.5 Arquitectura de CPU

Todo el inventario existe para `arm64` y `amd64`: Playwright y Node son multi-arquitectura; codebase-memory
publica `linux-amd64`/`linux-arm64`; el VSIX de Java existe para `linux-arm64`/`linux-x64`; OpenCode trae
binarios por plataforma. **Excepción conocida**: el `agents/Dockerfile` actual fija `engram …linux_amd64`.
En Slim, el nombre del artefacto se deriva de `TARGETARCH`. Que exista el asset `linux_arm64` de engram
1.16.1 se verifica en la Fase 0; si no existe, las alternativas son compilarlo con un proxy de módulos Go
o construir la imagen en `amd64` y ejecutarla con Rosetta en Docker Desktop (más lento).

### 5.6 Esqueleto del Dockerfile (diseño, no implementado)

```dockerfile
# slim/Dockerfile — imagen única, dos roles (orchestrator | agents). DISEÑO DE PLANIFICACIÓN.
# Invariante: toda adquisición ocurre AQUÍ, desde fuentes internas; el runtime no instala nada.
# (Dockerfile no admite comentarios al final de una instrucción: van siempre en su propia línea.)
# Imágenes base: se sobrescriben con --build-arg para apuntar al registro/proxy interno.
ARG PW_IMAGE=mcr.microsoft.com/playwright:v1.60.0-noble
ARG NODE_IMAGE=node:24-bookworm

# ── Etapa 1: dependencias Node (imagen con gcc/make/python3 para compilar nativos) ──────────
FROM ${NODE_IMAGE} AS deps
COPY slim/certs/corp-ca.pem /usr/local/share/ca-certificates/corp-ca.crt
RUN update-ca-certificates
ARG NPM_REGISTRY
# npmrc GLOBAL (/usr/local/etc/npmrc): lo lee cualquier npm, con cualquier HOME y entorno filtrado
RUN npm config set --location=global registry "$NPM_REGISTRY" \
 && npm config set --location=global cafile /etc/ssl/certs/ca-certificates.crt
# better-sqlite3: compilar contra las cabeceras locales (ni prebuilt de GitHub, ni cabeceras de nodejs.org)
ENV npm_config_build_from_source=true npm_config_nodedir=/usr/local
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY web/package.json ./web/package.json
# Lock exacto; se instalan también las devDependencies (tsx ejecuta el TypeScript en runtime)
RUN npm ci

# ── Etapa 2: imagen final ──────────────────────────────────────────────────────────────────
FROM ${PW_IMAGE}
ARG TARGETARCH
# Node 24 + npm + cabeceras + npmrc global, copiados de la etapa 1 (sin NodeSource ni `curl | bash`)
COPY --from=deps /usr/local/ /usr/local/
COPY slim/certs/corp-ca.pem /usr/local/share/ca-certificates/corp-ca.crt
RUN update-ca-certificates
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

# Binarios de GitHub descargados a mano: se verifican ANTES de usarlos (integridad de la cadena)
COPY slim/vendor/ /opt/vendor/
RUN cd /opt/vendor && sha256sum -c SHA256SUMS \
 && tar -C /usr/local/bin -xzf "codebase-memory-mcp-linux-${TARGETARCH}.tar.gz" codebase-memory-mcp \
 && tar -C /usr/local/bin -xzf "engram_1.16.1_linux_${TARGETARCH}.tar.gz" engram

# Agentes: versiones exactas (convención del repo); sin Codex
RUN npm install -g opencode-ai@1.17.7 @playwright/mcp@0.0.76
# El MCP reutiliza el Chromium de la imagen base: cero descargas de navegador
RUN ln -s "$(ls -d /ms-playwright/chromium-*/chrome-linux*/chrome | head -1)" /usr/local/bin/pw-chromium

# Serena + language servers: bloque según la ruta A/B/B' (§5.3) y aprovisionamiento (§5.4)
# ...

# Orquestador: usuario sin privilegios para el código no confiable (invariante de sandbox)
RUN useradd --create-home --uid 1002 --shell /usr/sbin/nologin sandbox
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
COPY agents/agent-supervisor.mjs /usr/local/bin/agent-supervisor.mjs
```

Puntos a verificar en la Fase 0: si la imagen A1 trae `git` (necesario en runtime para los clones) y
`python3`. Si no trae `git`, hacen falta apt (ruta A) o una base alternativa. El ZIP de GitHub no trae
`.git`, pero no afecta: la imagen actual ya se construye sin `.git` (`.dockerignore`).

---

## 6. Red dentro de los contenedores

### 6.1 DNS
El compose Slim **no declara `dns:`**. Los contenedores usan el DNS embebido de Docker, que reenvía al
resolver del host (VPN / *split DNS*). Así se resuelven GitLab, el mirror y DEV.

### 6.2 CA corporativa (inspección TLS)
- Exportación sin sudo: `security find-certificate -a -p /Library/Keychains/System.keychain > slim/certs/corp-ca.pem`
  (leer el llavero del sistema no requiere privilegios). Conviene filtrar solo las raíces corporativas.
- En la imagen: `update-ca-certificates` (lo usan git, curl y OpenSSL), `NODE_EXTRA_CA_CERTS` (Node y el
  runtime de OpenCode), `cafile` en el npmrc global (npm, incluido el que corre con entorno filtrado)
  y `UV_NATIVE_TLS=true` / `SSL_CERT_FILE` para uv y Python.

### 6.3 Proxy
- Preferible a nivel de usuario (sin sudo) en `~/.docker/config.json` → `"proxies": { "default": { … } }`.
  El CLI de Docker lo inyecta en `build` y en `run`.
- `NO_PROXY` debe incluir los hosts internos (GitLab, DEV, mirror) y los nombres de servicio del compose
  (`agents`, `orchestrator`, `localhost`).
- Si el proxy exige credenciales en la URL, estas pasan a ser **secretos**: ver C4.

### 6.4 npm: por qué configuración **global**
El `npm ci` del `e2e/` corre como usuario `sandbox`, con `HOME` propio y entorno filtrado por `scrubEnv`.
Un `.npmrc` de usuario o variables en mayúsculas no le llegan. El npmrc **global** (`/usr/local/etc/npmrc`)
se lee siempre, sea cual sea el usuario y el entorno. Así la POC no necesita tocar código (C4 queda como
opcional).

---

## 7. OpenCode hermético y proveedor LLM

### 7.1 Flags de entorno (servicio `agents`)

| Variable | Efecto |
|---|---|
| `OPENCODE_DISABLE_MODELS_FETCH=true` | No descarga el catálogo de `models.dev`; usa el embebido (o `OPENCODE_MODELS_PATH` con un JSON local) |
| `OPENCODE_DISABLE_AUTOUPDATE=true` | Sin comprobación ni descarga de actualizaciones |
| `OPENCODE_DISABLE_LSP_DOWNLOAD=true` | OpenCode no descarga LSPs al abrir `.java`/`.ts` (la navegación semántica la aporta Serena) |
| `OPENCODE_DISABLE_DEFAULT_PLUGINS=true` | No instala en caliente los *plugins* por defecto |

Estas variables se han verificado en el código fuente **actual** de OpenCode. **En la Fase 0 se verifica
que existen en la versión fijada 1.17.7** (p. ej. `strings "$(command -v opencode)" | grep OPENCODE_DISABLE`).

### 7.2 Overlay de configuración (sin editar `agents/opencode.json`)

```js
// slim/make-opencode-config.mjs — DISEÑO: deriva la config Slim de la real (mismos agentes y prompts)
import { readFileSync, writeFileSync } from "node:fs";
const c = JSON.parse(readFileSync("agents/opencode.json", "utf8"));
// Serena y engram SE CONSERVAN: alimentan explorer/generator/proposer (núcleo, §3.1)
c.mcp.playwright.command = [
  "playwright-mcp",                          // bin global instalado en build: sin npx ni resolución de registro
  ...c.mcp.playwright.command.slice(2),      // conserva --browser/--headless/timeouts originales
  "--executable-path", "/usr/local/bin/pw-chromium", // Chromium de la imagen base: sin descarga
];
c.autoupdate = false;
// Opción B de proveedor (§7.3): reescribir el "model" de cada agente al gateway corporativo
writeFileSync("slim/opencode.slim.json", JSON.stringify(c, null, 2));
```

El fichero resultante se monta **en los dos servicios**:
- En `agents`, sobre `/root/.config/opencode/opencode.json`.
- En `orchestrator`, sobre `/app/agents/opencode.json`, porque `model-window-catalog.ts` lee ese fichero
  para calcular el presupuesto de prompt por rol. Si difieren, el orquestador calcularía con modelos que
  no son los reales.

### 7.3 Proveedor LLM

| Opción | Requisitos | Consecuencias |
|---|---|---|
| **A. OpenCode Go/Zen** (actual, `opencode-go/*`) | Egress a `opencode.ai` y aprobación de cumplimiento para enviar código y diffs | Sin cambios de modelos |
| **B. Gateway corporativo** (Azure OpenAI, Bedrock, LiteLLM interno…) | Proveedor *custom* en `opencode.json` (compatible con OpenAI: `baseURL` + modelos con su `limit.context`) | (1) Reescribir `model` en **cada** agente, en `AGENT_*_MODEL` y en el modelo del *proposer* del stitcher (fijado en código, C7). (2) Registrar sus ventanas de contexto (C7): si no, el motor usa el valor por defecto de 32k tokens y **recorta el contexto**. (3) Generador y revisor en **familias distintas**. (4) Verificar que el paquete del proveedor viene incluido en OpenCode y no se instala en runtime |

**Cumplimiento.** El prompt que llega al LLM incluye diff, código y *snapshots* del DOM de DEV. El saneado
existente (`sanitize-text.ts`) redacta secretos, pero **no anonimiza código**. Enviar código del banco a un
proveedor es una decisión de cumplimiento, previa a cualquier trabajo técnico.

---

## 8. GitLab

### 8.1 Clonado
- `GIT_REMOTE_BASE=https://gitlab.<banco>` ya funciona para formar la URL (`<base>/<ruta>.git`).
- Los **subgrupos** están soportados: `repo: "grupo/subgrupo/proyecto"` → mirror `grupo__subgrupo__proyecto`.
- **Autenticación**: requiere C3 (hoy solo se reescribe `github.com`). Token mínimo: *Project/Group Access
  Token* con `read_repository` (o *Deploy Token*). El token nunca se escribe en `.git/config`; eso lo
  garantiza el mecanismo transitorio `-c url.<…>.insteadOf` que ya existe.
- **Limitación conocida**: el `git fetch origin` de refresco en `resolve-cross-repo-impact.use-case.ts` se
  lanza sin credenciales. Es *best-effort* y, si falla, usa el mirror que haya en disco. Se revisa en C3.

### 8.2 Disparo
- **POC**: CLI dentro del contenedor (`npm run qa -- --app … --sha …`). No hace falta webhook.
- **Después de la POC**: un *job* de GitLab CI **posterior al despliegue en DEV** que haga `curl` con el
  payload genérico `{ "repo": "$CI_PROJECT_PATH", "sha": "$CI_COMMIT_SHA" }` y firma HMAC
  (`x-hub-signature-256`, calculable con `openssl dgst -sha256 -hmac`). Ese payload ya lo acepta
  `src/server/webhook.ts`. Es semánticamente mejor que un webhook de *push*, porque el motor debe correr
  **después** del despliegue. El webhook nativo de GitLab (`X-Gitlab-Token`, `project.path_with_namespace`)
  es opcional (C8).

### 8.3 Publicación: exportación local
- El efector nuevo (C2) escribe en `data/exports/<app>/<runId>/`:
  - `decision.json`: veredicto, decisión, motivo y cobertura.
  - `MR.md` / `ISSUE.md`: el mismo cuerpo que se renderizaría para GitHub, ya saneado.
  - `e2e.patch`: diff binario de `e2e/`, incluidos ficheros nuevos, aplicable con `git apply`.
  - `files/`: copia de los specs, `manifest.json` y `context.json`.
- **Persistencia entre ejecuciones.** Cada run hace `git clean -fd` del mirror, así que lo generado y no
  subido se pierde. En Slim, **la fuente de verdad sigue siendo git**: una persona abre un MR con el
  parche exportado, y el run siguiente parte de lo fusionado. Esto aplica también al `context.json` del
  onboarding, que el *job* publica forzando `shadow:false` (con C1, ese camino también exporta).
- **Después de la POC**: MR automático con *push options* de GitLab
  (`git push -o merge_request.create -o merge_request.merge_when_pipeline_succeeds`), sin API; o un
  adaptador de API (C8).

### 8.4 Credenciales (mínimo privilegio)

| Credencial | Dónde | Permiso | ¿Llega al contenedor `agents`? |
|---|---|---|---|
| Token GitLab | `orchestrator` | `read_repository` | **No** |
| `QA_API_TOKEN` | `orchestrator` | Consola/API | **No** |
| Clave LLM | `agents` | Inferencia | Sí (solo aquí) |
| Credenciales de DEV (`DEV_*`) | ambos | Login de la app | Sí (necesarias para explorar) |

---

## 9. Cambios de código planificados (no implementados)

Todos respetan los invariantes de `CLAUDE.md`:
- Nada específico de una app en `src/`: el perfil es de **despliegue**, no de app.
- El agente sigue siendo de solo lectura.
- La cola sigue siendo secuencial.
- Los errores de integración se muestran, no se silencian.
- Todo dato saliente se sanea.

Puerta de calidad de cada cambio: `npm test` + `npm run typecheck` en verde y tests nuevos con
`node:test`.

| Id | Cambio | Ubicación | Diseño | Tests |
|---|---|---|---|---|
| **C1** | Perfil de despliegue `QAYABA_PROFILE=slim` | `src/server/rewritten-engine-factory.ts` (composition root), `src/index.ts` | En la raíz de composición: los *slots* de publicación (PR, Issue, *shadow*, *vcsWrite*) se cablean a C2; no se crea el *maintainer runtime*; se deshabilitan las rutas OAuth. **No se toca ningún servicio de dominio.** | Tests de cableado en `rewritten-engine-factory.test.ts` |
| **C2** | `LocalExportPublicationAdapter` | `qa-engine/src/contexts/workspace-and-publication/infrastructure/local-export.adapter.ts` | Implementa los puertos que ya consume `PublicationPortAdapter`. Escribe la estructura de §8.3. Reutiliza `render*`, `sanitize` y `containsSecret`. El git lo ejecuta el orquestador (diff con *intent-to-add*), nunca el agente | Unit con fs falso; contrato de puerto |
| **C3** | Autenticación git derivada de `GIT_REMOTE_BASE` | `src/integrations/repo-mirror.ts` | Host y protocolo desde `GIT_REMOTE_BASE`; token desde `GIT_TOKEN` (con `GITHUB_TOKEN` como alternativa); usuario `x-access-token` en github.com y `oauth2` en otros hosts (configurable). Se añaden `GIT_TOKEN`/`GITLAB_TOKEN` a `BLOCKED_ENV_PREFIX` de `scrub-env.ts` y el patrón `glpat-` al sanitizador | Casos en `repo-mirror.test.ts`, `scrub-env` y sanitizador |
| **C4** *(opcional)* | Paso de variables de red por `scrubEnv` | `qa-engine/src/shared-infrastructure/process-sandbox/scrub-env.ts` | Permitir `HTTP(S)_PROXY`, `NO_PROXY` (y minúsculas), `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`/`SSL_CERT_DIR`. **Contrapartida**: una URL de proxy con credenciales es un secreto que vería el código no confiable. Para la POC basta el npmrc global (§6.4) | Tests de allowlist |
| **C5** | Interruptor del auto-mantenimiento | `src/index.ts`, `src/server/maintainer-runtime.ts` | Con perfil `slim`, los incidentes se registran pero no se dispara `triggerMaintainer` | Unit |
| **C6** | Onboarding sin publicación remota | `src/index.ts` (`enqueueContextRun`) | Se cubre con C1: el `shadow:false` forzado cae en el exportador local. Solo hace falta verificarlo con un test | Test de integración del cableado |
| **C7** *(solo con la opción B de proveedor)* | Modelos corporativos | `qa-engine/.../prompt-builders/model-window-catalog.ts`, `src/server/onboarding/llm-profile-proposer.adapter.ts` | (1) Ventanas: mínimo, añadir entradas. Mejor, leer `limit.context` de la definición del proveedor en `agents/opencode.json`, para que las identidades de modelo sigan viviendo solo en `agents/`. `normalizeModelName` hoy solo quita el prefijo `opencode-go/`. (2) `PROPOSER_MODEL` (el modelo del *proposer* del stitcher) está fijado a `opencode-go/glm-5.3-flash`: debe ser configurable. Los modelos por rol de `src/agent-runtime/config.ts` ya se sobrescriben con `AGENT_*_MODEL` | Unit |
| **C8** *(después de la POC)* | GitLab nativo | `src/server/webhook.ts`; adaptadores MR/Issue en `workspace-and-publication` | Webhook con `X-Gitlab-Token` y `project.path_with_namespace`/`checkout_sha`; MR (`merge_when_pipeline_succeeds`) e Issue por API o *push options* | Unit + contrato |

**Explícitamente fuera de alcance:** cualquier cambio en `PublishDecisionService`, `DecideCoverageService`,
el stitcher (`service-topology/`), el clasificador, el *static gate* o los prompts.

---

## 10. Entregables de empaquetado

Ficheros **nuevos**; los existentes no se tocan:

```
slim/
├── README.md                    # runbook (§11) en versión operativa
├── Dockerfile                   # imagen única (§5.6)
├── compose.yml                  # autocontenido: dos servicios, misma imagen, sin dns:, puertos en 127.0.0.1
├── .env.example                 # variables Slim (ver abajo)
├── make-opencode-config.mjs     # genera opencode.slim.json (§7.2)
├── preflight.sh                 # sondas de entorno (Apéndice A)
├── certs/                       # corp-ca.pem (NO se versiona)
└── vendor/
    ├── MANIFEST.md              # qué descargar, de qué URL exacta, para qué arquitectura
    └── SHA256SUMS               # sumas esperadas (se verifican en build)
```

Variables del `.env` Slim (diseño):

```bash
# ── Orquestador ──
QAYABA_PROFILE=slim                      # C1: exportación local, sin maintainer ni OAuth
GIT_REMOTE_BASE=https://gitlab.banco.local
GIT_TOKEN=                               # read_repository; nunca llega a "agents"
QA_WEB_AUTO_LOGIN=true                   # consola local sin OAuth (puerto solo en 127.0.0.1)
NPM_REGISTRY=https://artifactory.banco.local/api/npm/npm-remote/
# ── Agentes ──
AGENT_RUNTIME_MODE=single
AGENT_SINGLE_PROVIDER=opencode
OPENCODE_API_KEY=                        # u opciones del proveedor corporativo (§7.3)
# ── DEV ──
DEV_ENV_USER=
DEV_ENV_PASS=
DEV_TEST_USER=
DEV_TEST_PASS=
```

Fragmento del compose (diseño):

```yaml
# slim/compose.yml — DISEÑO. Autocontenido: no hereda docker-compose.yml ni su override.
name: qayaba-slim
services:
  orchestrator:
    image: qayaba-slim:poc
    build: { context: .., dockerfile: slim/Dockerfile, args: { NPM_REGISTRY: "${NPM_REGISTRY}" } }
    command: ["npm", "run", "start"]
    # sin "dns:" → resolver del host/VPN
    # healthcheck, depends_on (agents healthy), stop_grace_period y límites: como en docker-compose.yml
    ports: ["127.0.0.1:8080:8080"]            # solo loopback: nunca expuesto a la red del banco
    environment:
      QAYABA_PROFILE: slim
      QA_WEB_AUTO_LOGIN: "true"               # consola local sin OAuth (seguro solo por el bind a 127.0.0.1)
      OPENCODE_SERVE_URL: http://agents:4096
      AGENT_SUPERVISOR_URL: http://agents:4097
      MIRROR_DIR: /app/.mirrors
      CBM_CACHE_DIR: /app/.codebase-memory
      CODE_SANDBOX_UID: "1002"
      GIT_REMOTE_BASE: ${GIT_REMOTE_BASE}
      GIT_TOKEN: ${GIT_TOKEN}
    volumes:
      - ../config:/app/config
      - ./opencode.slim.json:/app/agents/opencode.json:ro   # mismo modelo efectivo que "agents" (§7.2)
      - mirrors:/app/.mirrors
      - qa-data:/app/data                                   # historial + exports/
      - codebase-memory:/app/.codebase-memory
  agents:
    image: qayaba-slim:poc                    # MISMA imagen, otro rol
    command: ["node", "/usr/local/bin/agent-supervisor.mjs"]
    environment:
      OPENCODE_API_KEY: ${OPENCODE_API_KEY}   # NUNCA GIT_TOKEN ni QA_API_TOKEN aquí
      OPENCODE_DISABLE_MODELS_FETCH: "true"
      OPENCODE_DISABLE_AUTOUPDATE: "true"
      OPENCODE_DISABLE_LSP_DOWNLOAD: "true"
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "true"
      # … MIRROR_DIR, ENGRAM_DATA_DIR, AGENT_*, DEV_* como en docker-compose.yml
    volumes:
      - ../agents:/root/.config/opencode:ro
      - ./opencode.slim.json:/root/.config/opencode/opencode.json:ro
      - ../agent:/root/.config/agent:ro
      - mirrors:/app/.mirrors
      - engram-data:/data
      - opencode-data:/root/.local/share/opencode
volumes: { mirrors: {}, qa-data: {}, codebase-memory: {}, engram-data: {}, opencode-data: {} }
```

---

## 11. Runbook de la POC

| Paso | Acción | Resultado esperado |
|---|---|---|
| 0 | Ejecutar `slim/preflight.sh` (Apéndice A) | Informe de DNS, proxy, TLS y alcance → elección de ruta (§5.3) |
| 1 | Descargar el ZIP **de la rama**: `https://github.com/ArielFalcon/QAyaba/archive/refs/heads/<rama>.zip` | Código Slim en el Mac |
| 2 | Descargar con el navegador los artefactos de `slim/vendor/MANIFEST.md`; `shasum -a 256 -c SHA256SUMS` | `vendor/` íntegro |
| 3 | Exportar la CA (§6.2) a `slim/certs/corp-ca.pem` | Confianza TLS |
| 4 | Rellenar `slim/.env` y `config/apps/<app>.yaml` (`repo: grupo/proyecto`, `services:`, `dev.baseUrl`, sin `versionUrl` si no hay endpoint, `changeCoverage.mode: signal`) | Configuración |
| 5 | `node slim/make-opencode-config.mjs` y `docker compose -f slim/compose.yml build` | Imagen `qayaba-slim:poc` |
| 6 | `docker compose -f slim/compose.yml up -d` | Ambos servicios *healthy*; en los logs no aparece ninguna instalación |
| 7 | **Onboarding por job** (API con `Authorization: Bearer $(cat config/.api_token)`, o desde la consola): `POST /api/apps/<app>/boundaries/propose` con `{ "repo": "...", "services": [...] }` → consultar `.../propose/status` → revisar → `POST .../boundaries/confirm` `{ "confirm": true }` | Mirrors de **todos** los repos clonados e indexados; `boundaries:` escritas; *run* de contexto → export con `context.json` |
| 8 | MR manual en GitLab con el `context.json` exportado | El mapa FE↔BE queda en git |
| 9 | `docker compose -f slim/compose.yml exec orchestrator npm run qa -- --app <app> --sha <sha>` sobre 2–3 commits reales | Veredictos, specs y exports |
| 10 | Revisar la consola (`http://127.0.0.1:8080/app`) y `data/exports/…`; MR manual de los specs aprobados | Demostración |

**Métricas a presentar:** veredicto por run, nº de specs y su aprobación por el revisor, ratio de
cobertura de cambio (o `unknown` y por qué), enlaces del stitcher detectados, tiempo por run y coste
en tokens.

---

## 12. Fases y criterios de salida

| Fase | Contenido | Criterio de salida (verificable) |
|---|---|---|
| **F0 Descubrimiento** | Preflight; respuestas a §14; verificar: flags de OpenCode 1.17.7, estructura de LS de Serena v1.5.3, contenido de la imagen A1 (`git`, `python3`), asset arm64 de engram | BOM (§5.2) con **fuente confirmada para cada fila** y ruta elegida |
| **F1 Empaquetado** (sin código de `src/`) | `slim/*` completo | `build` correcto en el Mac con egress restringido; `up` *healthy*; **prueba de hermeticidad**: los árboles de `~/.serena`, caché de OpenCode y npm no cambian tras un run |
| **F2 Código mínimo** | C1, C2, C3, C5 (+C7 si se usa la opción B de proveedor) | `npm test` y `npm run typecheck` en verde; tests nuevos por cambio |
| **F3 Ejecución POC** | Runbook §11 | ≥ 1 run completo por cada veredicto relevante; exportación generada; cero descargas en runtime |
| **F4 Después de la POC** | C8 (MR/Issue/webhook GitLab), ruta C (GitLab CI + registro), elevar `changeCoverage` a `enforce` donde se lo gane | Según alcance acordado |

---

## 13. Riesgos y mitigaciones

| Id | Riesgo | Prob. | Impacto | Mitigación |
|---|---|---|---|---|
| K1 | Cumplimiento no aprueba enviar código al LLM | Media | **Bloqueante** | Gateway interno aprobado; acotar la POC a un repo no crítico |
| K2 | DEV con SSO/MFA | Media | Alto | Usuario técnico sin MFA en DEV o *bypass* de DEV |
| K3 | DEV sin *source maps* | Alta | Medio (cobertura `unknown`) | *Hidden source maps* en DEV |
| K4 | Recursos: los límites suman 10 GB de RAM | Media | Alto (OOM) | Ajustar la memoria de Docker Desktop y los límites del compose |
| K5 | Docker Desktop gestionado por IT | Media | Medio | Proxy en `~/.docker/config.json` (nivel usuario) |
| K6 | La estructura de LS de Serena difiere de lo previsto | Media | Medio | Fijar v1.5.3; verificar en F0; prueba de hermeticidad |
| K7 | La política impide vendorizar binarios de GitHub | Media | Alto | Aprobación explícita o ruta C (CI + *generic remote*) |
| K8 | Incompatibilidad del MCP (Playwright 1.61-alpha) con Chromium 1.60 | Baja | Medio | Fallback: instalar el navegador del MCP en build desde un mirror (`PLAYWRIGHT_DOWNLOAD_HOST`) |
| K9 | Falta el asset arm64 de engram | Baja | Bajo | Compilarlo con un proxy Go, o imagen amd64 con Rosetta |
| K10 | Modelos del gateway sin ventana registrada | Alta (opción B de proveedor) | Medio | C7 |
| K11 | Los contenedores no llegan a DEV/GitLab por la VPN | Media | **Bloqueante** | `NO_PROXY`, DNS del host; sondas del preflight |

---

## 14. Preguntas abiertas

Cada pregunta indica la fase a la que bloquea.

1. **(F0)** Mac Apple Silicon o Intel; RAM total.
2. **(F0)** Docker Desktop / Rancher / Colima / Podman; `docker compose version`; ¿puedes cambiar proxy y recursos?
3. **(F0)** El mirror: ¿Artifactory, Nexus u otro? ¿Proxifica Docker, apt, PyPI o GitHub Releases (*generic remote*)?
4. **(F0)** ¿Hay registro Docker interno con permiso de *push*/*pull* (incluido el Container Registry de GitLab)?
5. **(F0)** ¿Inspección TLS? (lo responde el preflight)
6. **(F0, bloqueante)** Proveedor LLM permitido y aprobación de cumplimiento para enviar código y diffs.
7. **(F1)** Stack del proyecto objetivo (¿Angular + Spring?), repos implicados (front + microservicios) y cómo se comunican (HTTP/eventos), para configurar `boundaries:`.
8. **(F3, bloqueante)** Acceso a DEV desde un contenedor; mecanismo de login (formulario, SSO, MFA).
9. **(F1)** GitLab: ¿self-managed (versión) o gitlab.com?; ¿HTTPS o solo SSH?; ¿se pueden crear *Access Tokens* `read_repository`?
10. **(F0)** Política: ¿se permite introducir binarios descargados de GitHub (vendorizados y con checksums) o imágenes construidas fuera?
11. **(F4)** ¿GitLab CI con *runners* capaces de construir imágenes (Kaniko/dind)?
12. **(F3)** ¿DEV sirve *source maps*?

---

## Apéndice A — Script de preflight

Contenido previsto de `slim/preflight.sh`. No requiere sudo y solo usa imágenes que ya estén en el registro.

```bash
#!/usr/bin/env bash
# slim/preflight.sh — DISEÑO. Mide qué permite el entorno ANTES de construir nada.
set -u
IMG=${IMG:-node:24-bookworm}            # cualquier imagen con curl/openssl ya disponible
# URLs internas: exportarlas antes de ejecutar (MIRROR_URL=https://… GITLAB_URL=… DEV_URL=… ./preflight.sh)
HOSTS=("${MIRROR_URL:-}" "${GITLAB_URL:-}" "${DEV_URL:-}" "https://opencode.ai" "https://github.com" \
       "https://pypi.org" "https://registry.npmjs.org")

echo "== Docker =="; docker version --format '{{.Server.Arch}} {{.Server.Version}}'; docker compose version
echo "== Proxy del CLI de Docker =="; grep -A6 '"proxies"' ~/.docker/config.json 2>/dev/null || echo "sin proxies"

docker run --rm -e HOSTS="${HOSTS[*]}" "$IMG" sh -c '
  echo "== Proxy visto dentro del contenedor =="; env | grep -i _proxy || echo "ninguno"
  echo "== Alcance (código HTTP; 000 = bloqueado/DNS) =="
  for u in $HOSTS; do printf "%-45s " "$u"; curl -sS -o /dev/null -m 10 -w "%{http_code}\n" "$u" 2>/dev/null || echo FALLA; done
  echo "== Inspección TLS (emisor del certificado de registry.npmjs.org) =="
  echo | openssl s_client -connect registry.npmjs.org:443 -servername registry.npmjs.org 2>/dev/null \
    | openssl x509 -noout -issuer 2>/dev/null || echo "no alcanzable"
'
echo "== Contenido de la imagen base de Playwright (si ya está en el registro) =="
docker run --rm mcr.microsoft.com/playwright:v1.60.0-noble sh -c 'node -v; git --version; python3 --version' 2>&1
```

**Interpretación:**
- Si el emisor TLS es el proxy del banco (Zscaler, Netskope…), la CA es obligatoria.
- `github.com` en 000 y el navegador descargando igualmente → confirma la ruta *vendor*.
- `pypi.org` en 000 sin mirror PyPI → rutas B' o C.

---

## Apéndice B — Referencias al código

| Tema | Fichero |
|---|---|
| Orquestación completa | `qa-engine/src/contexts/qa-run-orchestration/application/run-qa.use-case.ts` |
| Raíz de composición (perfil C1) | `src/server/rewritten-engine-factory.ts`, `qa-engine/src/contexts/qa-run-orchestration/composition/composition-root.ts` |
| Publicación y decisión | `qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/publication-port.adapter.ts`, `…/workspace-and-publication/infrastructure/shadow-log.adapter.ts` |
| Mirrors y auth git | `src/integrations/repo-mirror.ts`, `…/workspace-and-publication/infrastructure/mirror-provision.adapter.ts` |
| Filtrado de entorno | `qa-engine/src/shared-infrastructure/process-sandbox/scrub-env.ts`, `sandbox.ts` |
| Setup del `e2e/` | `qa-engine/src/contexts/workspace-and-publication/infrastructure/setup.adapter.ts` |
| Stitcher | `qa-engine/src/contexts/service-topology/` |
| Impacto entre repos + grafo | `…/service-topology/application/resolve-cross-repo-impact.use-case.ts`, `qa-engine/src/shared-infrastructure/code-graph/` |
| Onboarding | `src/server/onboarding/onboarding-job.ts`, `src/index.ts` (`indexRepoForOnboarding`, `enqueueContextRun`), rutas `/api/apps/:name/boundaries/*` en `src/server/api.ts` |
| Ventanas de modelo | `qa-engine/src/contexts/generation/infrastructure/prompt-builders/model-window-catalog.ts` |
| Webhook | `src/server/webhook.ts` |
| Auto-mantenimiento | `src/server/maintainer-runtime.ts`, `src/server/self-update.ts`, `boot-guard.mjs` |
| Imágenes y compose actuales | `Dockerfile`, `agents/Dockerfile`, `docker-compose.yml`, `agents/opencode.json`, `agents/agent-supervisor.mjs` |
