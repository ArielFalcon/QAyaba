# QAyaba slim — despliegue para una red restringida

Versión de QAyaba pensada para un portátil corporativo (macOS, sin sudo) con Docker, detrás de un
proxy con inspección TLS, con Artifactory como única fuente de paquetes y con GitLab como SCM. Está
centrada en E2E y no sacrifica calidad: todo mecanismo que alimenta una decisión se conserva (pipeline
completo, stitcher FE↔BE/BE↔BE, grafo de código, mapa `context.json`, cobertura de cambio, *grounding*
del DOM, revisor independiente, Serena, engram y aprendizaje entre ejecuciones). Lo que se retira es
periferia: la publicación remota (PR/Issue), el auto-mantenimiento y el login con GitHub.

El diseño completo, sus razones y los riesgos están en
[`docs/plans/slim-poc-entorno-restringido.md`](../docs/plans/slim-poc-entorno-restringido.md).
Para la revisión de seguridad, [`INVENTORIO.md`](INVENTORIO.md) lista cada componente con su versión y su
origen, los usuarios y puertos, los volúmenes, la salida de red (en el build y en ejecución) y el tratamiento
de los secretos; `./slim/qayaba.sh sbom` genera la lista real de paquetes de la imagen construida.

## Qué cambia respecto a la instalación completa

| Aspecto | Completa | Slim |
|---|---|---|
| Imágenes | 2 (orquestador + agentes) | 1 imagen, 2 servicios |
| Descargas en ejecución | Serena (LS de TS/Java), OpenCode (catálogo, plugins, LSP), `npx` | **Ninguna**: todo en el build |
| DNS | Fijado a 1.1.1.1/8.8.8.8 | El del host/VPN |
| CA corporativa | No contemplada | `slim/certs/*.crt` para todos los clientes |
| Publicación | PR con auto-merge + Issues en GitHub | **Exportación local** en `slim/exports/<app>/<run>/` (parche + MR.md/ISSUE.md) |
| SCM | GitHub | Cualquier host git (GitLab): `GIT_REMOTE_BASE` + `GIT_TOKEN` |
| Login de la consola | OAuth de GitHub | Token local (`config/.api_token`), sin login automático: `./slim/qayaba.sh console` lo copia al portapapeles |
| Auto-mantenimiento | Sí | No |
| Proveedores de agente | OpenCode y Codex | Solo OpenCode: la imagen no incluye Codex, y la API rechaza con 422 asignarlo o fijar su clave |

## Requisitos

- Docker Desktop (u otro motor con `docker compose` ≥ 2.24) con **≥ 8 GB de memoria** asignados: basta
  el valor por defecto de la máquina virtual (la mitad de la RAM del equipo, 8 GB en un portátil de 16 GB);
  no hace falta cambiar ningún ajuste de Docker Desktop (ver «Presupuesto de memoria»).
- Acceso de solo lectura a GitLab (un *Project/Group Access Token* con `read_repository`).
- Artifactory (o equivalente) con remotos para: imágenes Docker (mcr.microsoft.com, Docker Hub),
  npm, PyPI, Go, apt de Ubuntu (archive/security para amd64, ports para arm64), Maven Central y, si
  no se *vendorizan* a mano, genéricos para `github.com` y `download.eclipse.org`.
- Una pasarela de LLM compatible con OpenAI, declarada en `slim/opencode.override.json` (ver «LLM
  corporativo»), y su clave de API. La clave no hace falta para arrancar: si caduca a diario, se pega en la
  consola (ver «Clave diaria del LLM»).

## Puesta en marcha

```bash
# 0. Diagnóstico de red (sin sudo): proxy visto por los contenedores, alcance a cada destino, inspección TLS
cp slim/.env.example slim/.env        # y rellena las URLs de Artifactory y los datos de GitLab/DEV
./slim/qayaba.sh preflight            # incluye el alcance de la pasarela LLM del override (desde un contenedor, sin credenciales);
                                      # falla si no hay pasarela declarada

# 1. CA corporativa (si el preflight muestra un emisor TLS corporativo)
./slim/qayaba.sh export-ca            # escribe slim/certs/corporate-ca.crt desde el llavero del sistema

# 2. (Opcional) Artefactos sin remoto en Artifactory: descárgalos con el navegador a slim/vendor/
#    (lista y URLs en slim/vendor/README.md). Se verifican por SHA-256 en el build.

# 3. LLM corporativo (obligatorio): copia slim/opencode.override.example.json a slim/opencode.override.json
#    y ajusta el proveedor y los modelos. La clave no se declara aquí (solo como {env:OPENCODE_API_KEY}):
#    se pega en la consola (paso 5). Sin este fichero el build falla.

# 4. Construir (todas las descargas ocurren aquí) y arrancar
./slim/qayaba.sh build
./slim/qayaba.sh up
./slim/qayaba.sh check                # binarios, language servers y configuración: sin nada pendiente de descargar;
                                      # puerto de la consola solo en loopback y alcanzable desde la red de compose

# 5. Abre la consola web (el token local queda en el portapapeles: pégalo en la pantalla de acceso) y pega
#    la clave de la API del LLM del día en el panel «agent runtime · LLM gateway», o usa la pantalla
#    «agent runtime» de la TUI (tecla `a`).
./slim/qayaba.sh console OPENCODE_API_KEY en slim/.env es
#    opcional: la pila arranca sin ella y el agente espera la clave (ver «Clave diaria del LLM»).
```

## Dar de alta una aplicación

1. Crea `config/apps/<app>.yaml` a partir de `config/apps/example.yaml`:
   - `repo: "grupo/subgrupo/proyecto"` (ruta de GitLab) y `baseBranch`.
   - `services:` con los repos de los microservicios y, si los hay, sus globs de OpenAPI.
   - `dev.baseUrl` (sin `versionUrl` si DEV no expone `/version`).
   - `e2e.auth` si el login está en una web central (ver abajo).
   - `qa.shadow: false` → la decisión se **exporta** (en slim nada se publica en remoto).
2. Onboarding del stitcher. Clona e indexa **todos** los repos y propone `boundaries:`:
   ```bash
   ./slim/qayaba.sh onboard <app> grupo/front grupo/ms-pedidos grupo/ms-pagos
   ./slim/qayaba.sh onboard-status <app>      # revisa la propuesta
   ./slim/qayaba.sh onboard-confirm <app>     # escribe boundaries: en el YAML y lanza el run de contexto
   ```
   El run de contexto exporta `e2e/.qa/context.json` (el mapa FE↔BE). Súbelo con un MR (paso siguiente)
   para que las ejecuciones posteriores lo lean desde git.

## Ejecutar

```bash
./slim/qayaba.sh run <app> <sha|rama>                               # diff: el blast radius de un commit (se encola)
./slim/qayaba.sh run <app> <sha> manual --guidance "el alta de pedidos"
./slim/qayaba.sh tui                                                # consola de terminal
./slim/qayaba.sh console                                            # consola web: copia el token local y abre http://localhost:8080/app
./slim/qayaba.sh exports <app>                                      # resultados exportados
./slim/qayaba.sh sbom                                               # lista de paquetes de la imagen (para la revisión de seguridad)
```

Cada ejecución que decide publicar deja en `slim/exports/<app>/<run>/`:

- `files/`: los specs, el manifiesto y (en modo contexto) `context.json`;
- `changes.patch`: aplicable con `git apply --index`;
- `MR.md`: título, rama sugerida, rama destino, pasos para aplicarlo y la descripción del MR; si algún archivo quedó fuera, una sección «Left out» con su ruta y el motivo (nunca el contenido);
- `ISSUE.md`: cuando la decisión es abrir una incidencia;
- `export.json`: metadatos; `skipped` lista las rutas que no se exportaron y `leftOut` añade el motivo de cada una: archivos de CI, Dockerfiles o `.env` («denylisted path»), enlaces simbólicos y cualquier cosa que no sea un archivo regular dentro del mirror, y los archivos o fragmentos del parche donde se detectó un secreto («contains a secret»: el valor exacto de una variable de entorno con nombre de credencial, o un token con forma reconocible).

Un export vacío porque todo quedó fuera no significa «la suite ya cubre el cambio»: la nota de la ejecución dice cuántos archivos se dejaron fuera y por qué. Un export parcial se abre igualmente y nombra lo que faltó.

La fuente de verdad sigue siendo git: al fusionar el MR, la siguiente ejecución parte de la suite actualizada.

## Login en una web central (SSO con redirección)

Si la app redirige a un proveedor de identidad central (otro origen) y vuelve, decláralo en el YAML de
la app. Lo usan igual los tests (`authenticate()`), la captura de DOM que ancla selectores en rutas
autenticadas y el agente al explorar DEV:

```yaml
e2e:
  auth:
    loginUrl: "https://sso.banco.internal/"      # prefijo de la URL de la página de login
    passwordEntry: "text=Usuario y contraseña"   # si primero ofrece login con certificado
    successSelector: "[data-testid=user-menu]"   # visible solo con sesión iniciada (recomendado)
```

Las credenciales van en `DEV_TEST_USER`/`DEV_TEST_PASS` de `slim/.env`. El navegador automatizado no
tiene certificado de cliente: si el proveedor pide mTLS de forma opcional, continúa sin él y muestra el
formulario de usuario y contraseña (verificado contra un proveedor HTTPS que solicita certificado).
Si el proveedor **exige** certificado sin alternativa, hace falta un usuario técnico con contraseña en DEV.

## Consola web

La consola web **no inicia sesión sola**: pide el token local de la API (`config/.api_token`, generado al
arrancar por primera vez en el directorio `config/` del equipo). No hay login automático porque cualquier
contenedor de la red de compose —el de agentes incluido, cuyo código dirige un LLM— podría obtener una sesión
de operador con solo enviar `Host: localhost`.

```bash
./slim/qayaba.sh console           # copia el token al portapapeles (pbcopy), imprime la URL y la abre (open)
./slim/qayaba.sh console --print   # además imprime el token (sin portapapeles, o para verlo)
```

El token no se imprime salvo con `--print`. La consola lo guarda solo en `sessionStorage` (se borra al cerrar la
pestaña) y nunca lo pone en una URL.

## Clave diaria del LLM

La clave de la API de la pasarela de LLM caduca a diario, así que la pila **arranca sin ella**:
`OPENCODE_API_KEY` en `slim/.env` es opcional. Mientras no haya clave, el servicio de agentes queda en
espera (`needs_config`) y la consola lo muestra como «needs configuration».

1. Pega la clave del día en el panel **agent runtime · LLM gateway** de la consola web
   (`http://localhost:8080/app`, botón *Apply key*) o en la pantalla *agent runtime* de la TUI (tecla `a`).
2. El orquestador la entrega al servicio de agentes, que reinicia el proceso del agente con esa clave y
   comprueba que la pasarela la acepta (`GET <baseURL>/models` con esa clave). El estado pasa de `starting` a
   `healthy` en unos segundos, o a:
   - `failed` con «key rejected by the LLM gateway» (HTTP 401/403): la clave es incorrecta o ha caducado;
   - `failed` con «LLM gateway unreachable» y la causa (DNS, conexión, TLS): revisa la VPN, `EXTRA_NO_PROXY`
     y la CA corporativa, y vuelve a pulsar *Apply key* para repetir la comprobación;
   - `degraded` si la pasarela responde otra cosa (p. ej. HTTP 404 porque no ofrece `/models`): la clave no se
     ha podido verificar, pero el agente sigue en marcha.

Qué conviene tener presente:

- **Ejecución en curso.** Con una ejecución activa la clave no se aplica (la consola avisa de que hay una
  ejecución en curso): vuelve a pegarla cuando termine.
- **Clave caducada durante una ejecución.** Esa ejecución falla como `infra-error` (no es un fallo del
  código): pega la clave nueva y vuelve a lanzarla.
- **Reinicio de contenedores.** Si se reinicia el servicio de agentes (o la pila entera) la clave se
  pierde y hay que pegarla otra vez. Si solo se reinicia el orquestador, el servicio de agentes sigue con la
  suya, pero el orquestador también la necesita (para enmascararla en los registros y en los mensajes de
  error): la consola muestra «needs configuration» con el motivo y hay que pegarla otra vez. Si el
  orquestador no puede leer el estado del servicio de agentes, la consola lo muestra como «failed» con la
  causa, no como falta de clave.
- **Dónde queda la clave.** Solo en la memoria y en el entorno de los procesos del orquestador y del servicio
  de agentes: ningún fichero la conserva (el perfil slim no escribe `/app/.env`) y ningún volumen tampoco, así
  que se pierde al reiniciar. No se guarda en el navegador ni en ninguna URL, y se enmascara en los mensajes de
  error del agente y en las salidas que se registran.

## LLM corporativo

`slim/opencode.override.json` es **obligatorio** y se fusiona con `agents/opencode.json` durante el build.
Declara ahí el proveedor (compatible con OpenAI) y reasigna el `model` de cada agente. El orquestador lee esa
misma configuración, así que:

- los presupuestos de prompt usan el `limit.context` que declares para cada modelo;
- los modelos de generador, revisor y chat salen de sus agentes;
- el *proposer* del stitcher usa el modelo de `qa-proposer`.

Mantén **modelos distintos** para `qa-generator` y `qa-reviewer`: la independencia del revisor
depende de ello. Tras cambiar el override: `./slim/qayaba.sh build && ./slim/qayaba.sh up`.

OpenCode queda **limitado a los proveedores del override** (`enabled_providers`): ningún rol puede llamar a
otro destino de LLM. La compartición de sesiones (`share`) queda siempre desactivada. El build **falla** si:

- el override no existe o no declara ningún `provider`: la configuración base solo nombra un proveedor
  público, y ni el código ni la clave deben acabar allí;
- el `options.apiKey` de un proveedor no es una referencia `{env:VAR}`: el override se copia a las capas de la
  imagen, así que una clave literal quedaría grabada en ellas (el mensaje no la repite);
- `model`, `small_model` o el `model` de algún agente no apunta a un proveedor habilitado y a un modelo
  declarado en su `models`; el error lista cada clave afectada, de modo que un rol nunca llega a llamar en
  silencio a un proveedor inalcanzable.

## Presupuesto de memoria

En un equipo gestionado los ajustes de Docker Desktop suelen estar bloqueados, así que la máquina virtual
conserva su memoria por defecto: la mitad de la RAM del equipo (8 GiB con 16 GiB). Los límites por defecto
suman **6,6 GiB** y dejan **≈ 1,4 GiB** a la propia máquina virtual (kernel, motor de Docker, caché de
páginas); sin ese margen, el OOM-killer del kernel empieza a elegir víctimas fuera de los contenedores.

| Servicio | Límite por defecto | Qué corre | Variable |
|---|---|---|---|
| `orchestrator` | 2560m | Node (control plane y motor), Chromium de Playwright (specs y captura del DOM; nunca a la vez, la cola es secuencial), `npm ci`, `tsc` y ESLint del repositorio de pruebas, grafo de código | `ORCHESTRATOR_MEMORY` |
| `agents` | 4g | `opencode serve`, Serena, JDTLS (heap + ≈ 0,4 GiB nativos), servidor de lenguaje de TypeScript, Chromium del MCP de Playwright, engram | `AGENTS_MEMORY`, `JDTLS_XMX` |
| `tui` | 128m | Consola de terminal (solo mientras está abierta) | — |

- **`/dev/shm`.** Chromium no necesita `shm_size`: Playwright lo lanza con `--disable-dev-shm-usage`
  (comprobado en `playwright-core` 1.60.0), por lo que los 64 MB por defecto bastan para los specs, la
  captura del DOM y el MCP de Playwright.
- **Cómo subir el presupuesto.** Si Docker Desktop permite cambiarlo (*Settings → Resources → Memory*),
  sube la memoria de la máquina virtual y después los límites en `slim/.env` (`ORCHESTRATOR_MEMORY`,
  `AGENTS_MEMORY`; `./slim/qayaba.sh up` recrea los contenedores). `JDTLS_XMX` es un argumento de build:
  cambiarlo exige `./slim/qayaba.sh build`. Regla práctica: `AGENTS_MEMORY` ≥ `JDTLS_XMX` + 0,4 GiB + 2,5 GiB
  (el resto de procesos del contenedor), y la suma de límites ≤ memoria de la máquina virtual − 1 GiB.
- **Si no se puede subir.** Un repositorio Java muy grande puede necesitar más de 1 GiB de heap en JDTLS;
  sin margen en la máquina virtual, es preferible dejar los valores por defecto y limitar los repositorios
  que se indexan a la vez que ampliar el heap.

## Java y Maven

El *language server* de Java funciona en el modo "upstream JDTLS" de Serena: JDTLS, Lombok y el JDK
van en la imagen y no se descarga nada al abrir un `.java`. Para que resuelva dependencias de Maven
contra Artifactory, coloca un `settings.xml` con el mirror en `slim/maven/settings.xml`.

El directorio `slim/maven/` se monta en los agentes **de solo lectura** (`/root/.m2-settings`) y el arranque
enlaza el fichero en `~/.m2/settings.xml`, que es donde lo leen JDTLS y `mvn`; el fichero del anfitrión no se
puede reescribir desde el contenedor. El repositorio local de Maven (lo que se descarga) vive en el volumen
`maven-repository`, no en el anfitrión. Los agentes sí pueden **leer** el `settings.xml`, porque Maven lo
necesita: no pongas en él credenciales con más alcance del necesario (mejor un token de solo lectura del mirror).

## Solución de problemas

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| `opencode-config: the LLM gateway override is missing` o `no LLM provider is declared` en el build | Falta `slim/opencode.override.json` o no declara ningún `provider` | Cópialo desde `slim/opencode.override.example.json` y ajusta proveedor y modelos (ver «LLM corporativo») |
| `opencode-config: … apiKey: must be an {env:VAR} reference` en el build | La clave del proveedor está escrita en el override | Sustitúyela por `{env:OPENCODE_API_KEY}` y pega la clave en la consola |
| `certificate verify failed` / `SELF_SIGNED_CERT_IN_CHAIN` en el build | Falta la CA corporativa | `./slim/qayaba.sh export-ca` y reconstruir |
| `java-trust-ca: … holds no PEM certificate` o `… are not trusted by Java` en el build | Un `.crt` de `slim/certs/` no es PEM, o el almacén de Java no admite el certificado | Reexporta con `./slim/qayaba.sh export-ca` (PEM) y reconstruye; el build falla a propósito para que Java (Serena/JDTLS, Maven) no quede sin confiar en la CA |
| `fetch-artifact: cannot download …` | Host no permitido | Apunta su `*_BASE` a un remoto de Artifactory o vendoriza el fichero en `slim/vendor/` |
| `fetch-artifact: checksum mismatch` | Fichero distinto al fijado | Descarga exactamente la versión listada en `slim/vendor/SHA256SUMS` |
| `apt-get update` falla | Sin acceso a Ubuntu | `APT_MIRROR` (amd64) / `APT_PORTS_MIRROR` (arm64) |
| Los contenedores no resuelven hosts internos | DNS/VPN | Revisa que Docker Desktop use el DNS del sistema; añade los dominios internos a `EXTRA_NO_PROXY` |
| `authenticate(): the central login did not redirect back` | Credenciales o selectores | Revisa `DEV_TEST_*` y `e2e.auth` |
| Contenedores reiniciándose por memoria | La suma de límites no cabe en la máquina virtual de Docker Desktop | Revisa «Presupuesto de memoria»: sube la memoria de la máquina virtual o baja `AGENTS_MEMORY`/`JDTLS_XMX` |
| El panel *agent runtime* muestra «needs configuration» | No hay clave del día | Pégala (ver «Clave diaria del LLM») |
| Ejecución en `infra-error` con un mensaje de autenticación o de créditos del proveedor | La clave caducó o se agotó | Pega la clave nueva y vuelve a lanzar la ejecución |
| La consola web muestra «qayaba · login» | Es lo esperado: no hay login automático | `./slim/qayaba.sh console` copia el token local al portapapeles; pégalo en la pantalla de acceso |
| `preflight` marca la pasarela LLM como `UNREACHABLE` | DNS/VPN, proxy o CA corporativa | Sigue la línea `fix:` que imprime: conectar la VPN, `EXTRA_NO_PROXY` en `slim/.env` o `./slim/qayaba.sh export-ca` |
| `check` falla con «the tui service cannot reach the orchestrator» | El orquestador no está sano, no escucha en todas las interfaces o un proxy intercepta el nombre del servicio | `./slim/qayaba.sh ps` y `logs orchestrator`; revisa `EXTRA_NO_PROXY` |
| `check` falla con «published on every interface» | Se modificó `ports:` del orquestador | Restablece `127.0.0.1:${QAYABA_PORT:-8080}:8080` en `slim/compose.yml` |
